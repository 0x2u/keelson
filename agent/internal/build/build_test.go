package build

import (
	"bytes"
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/0x2u/keelson/agent/internal/config"
	"github.com/0x2u/keelson/agent/internal/docker"
)

const (
	testSHA   = "0123456789abcdef0123456789abcdef01234567"
	testToken = "ghs_SuperSecretInstallationToken123"
)

// fakeEngine records what the builder handed to the engine, and answers as configured.
type fakeEngine struct {
	mu      sync.Mutex
	opts    []docker.BuildOptions
	raw     []byte
	lines   []string
	err     error
	block   bool // wait for the context to end instead of finishing
	readErr error
}

func (f *fakeEngine) Build(ctx context.Context, opt docker.BuildOptions, r io.Reader, out func(string)) error {
	f.mu.Lock()
	f.opts = append(f.opts, opt)
	f.mu.Unlock()
	b, err := io.ReadAll(r)
	f.mu.Lock()
	f.raw, f.readErr = b, err
	f.mu.Unlock()
	if err != nil {
		return fmt.Errorf("engine could not read the context: %w", err)
	}
	for _, l := range f.lines {
		out(l)
	}
	if f.block {
		<-ctx.Done()
		return ctx.Err()
	}
	return f.err
}

// recorder collects what Build reports.
type recorder struct {
	mu   sync.Mutex
	msgs []string
}

func (r *recorder) emit(level, msg string) {
	r.mu.Lock()
	r.msgs = append(r.msgs, level+": "+msg)
	r.mu.Unlock()
}
func (r *recorder) all() string { r.mu.Lock(); defer r.mu.Unlock(); return strings.Join(r.msgs, "\n") }

// site is a TLS server that stands for every host of a test: requests to any name are dialed to it, and its handler
// tells the hosts apart by r.Host.
type site struct {
	srv  *httptest.Server
	mu   sync.Mutex
	seen []seenRequest
}

type seenRequest struct{ host, path, auth string }

func newSite(t *testing.T, h func(w http.ResponseWriter, r *http.Request)) *site {
	s := &site{}
	s.srv = httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		s.mu.Lock()
		s.seen = append(s.seen, seenRequest{r.Host, r.URL.Path, r.Header.Get("Authorization")})
		s.mu.Unlock()
		h(w, r)
	}))
	t.Cleanup(s.srv.Close)
	return s
}

func (s *site) client() *http.Client {
	addr := s.srv.Listener.Addr().String()
	return &http.Client{Transport: &http.Transport{
		TLSClientConfig: &tls.Config{InsecureSkipVerify: true},
		DialContext: func(ctx context.Context, network, _ string) (net.Conn, error) {
			var d net.Dialer
			return d.DialContext(ctx, network, addr)
		},
	}}
}

func (s *site) requests() []seenRequest {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]seenRequest(nil), s.seen...)
}

func testConfig() *config.Build {
	return &config.Build{
		Dockerfile: "Dockerfile", Context: ".", Args: map[string]string{"NODE_ENV": "production"}, Target: "runner",
		Timeout: config.D(5 * time.Second), Memory: config.S(512 << 20), CPUs: fl(1.5), MaxSource: config.S(1 << 20), Network: "host", Platform: "linux/amd64",
		SourceHosts: []string{"api.github.com", "codeload.github.com"},
	}
}

func standardArchive(t testing.TB) []byte {
	return archive(t, dir("o-r-abc/"), file("o-r-abc/Dockerfile", "FROM scratch\n"), file("o-r-abc/app.txt", "hello"))
}

func serveArchive(data []byte) func(http.ResponseWriter, *http.Request) {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/x-gzip")
		w.Write(data)
	}
}

func newBuilder(eng Engine, s *site) *Builder {
	b := New(eng)
	if s != nil {
		b.http = s.client()
	}
	return b
}

func request(cfg *config.Build) Request {
	return Request{Image: "ghcr.io/o/shop", SHA: testSHA, Config: cfg, Source: Source{URL: "https://api.github.com/repos/o/r/tarball/" + testSHA, Token: testToken}}
}

func TestBuildDownloadsBuildsAndTags(t *testing.T) {
	s := newSite(t, serveArchive(standardArchive(t)))
	eng := &fakeEngine{lines: []string{"Step 1/2 : FROM scratch", "Successfully built abc"}}
	var rec recorder
	ref, err := newBuilder(eng, s).Build(context.Background(), request(testConfig()), rec.emit)
	if err != nil {
		t.Fatal(err)
	}
	if ref != "ghcr.io/o/shop:"+testSHA {
		t.Errorf("ref = %q", ref)
	}
	if reqs := s.requests(); len(reqs) != 1 || reqs[0].host != "api.github.com" || reqs[0].auth != "Bearer "+testToken || reqs[0].path != "/repos/o/r/tarball/"+testSHA {
		t.Errorf("requests: %+v", reqs)
	}
	if len(eng.opts) != 1 {
		t.Fatalf("%d builds", len(eng.opts))
	}
	o := eng.opts[0]
	if o.Tag != ref || o.Dockerfile != "Dockerfile" || o.Target != "runner" || o.Args["NODE_ENV"] != "production" || o.MemoryBytes != 512<<20 || o.CPUs != 1.5 || o.Network != "host" || o.Platform != "linux/amd64" {
		t.Errorf("options: %+v", o)
	}
	if o.Labels["org.opencontainers.image.revision"] != testSHA {
		t.Errorf("labels: %v", o.Labels)
	}
	if got := readContext(t, eng.raw); !slices.Equal(got.names, []string{"Dockerfile", "app.txt"}) || got.files["app.txt"] != "hello" || got.files["Dockerfile"] != "FROM scratch\n" {
		t.Errorf("context: %+v", got.names)
	}
	want := []string{
		"info: downloading source from api.github.com", "info: building " + ref,
		"info: Step 1/2 : FROM scratch", "info: Successfully built abc", "info: built " + ref,
	}
	if got := rec.all(); got != strings.Join(want, "\n") {
		t.Errorf("events:\n%s", got)
	}
}

// Whatever the outcome, the token appears nowhere the agent can write: events, errors, engine options and the context.
func TestTheTokenNeverLeaks(t *testing.T) {
	cases := map[string]struct {
		handler func(w http.ResponseWriter, r *http.Request)
		eng     *fakeEngine
	}{
		"success":       {serveArchive(standardArchive(t)), &fakeEngine{lines: []string{"ok"}}},
		"engine fails":  {serveArchive(standardArchive(t)), &fakeEngine{err: &docker.BuildError{Message: "the engine says " + testToken}}},
		"engine echoes": {serveArchive(standardArchive(t)), &fakeEngine{lines: []string{"token is " + testToken + " ok"}}},
		"http 401":      {func(w http.ResponseWriter, r *http.Request) { http.Error(w, "bad credentials "+testToken, 401) }, &fakeEngine{}},
		"bad archive":   {serveArchive([]byte("nope " + testToken)), &fakeEngine{}},
		"server error":  {func(w http.ResponseWriter, r *http.Request) { http.Error(w, testToken, 500) }, &fakeEngine{}},
		"engine plain":  {serveArchive(standardArchive(t)), &fakeEngine{err: errors.New("boom " + testToken)}},
		"redirect closed": {func(w http.ResponseWriter, r *http.Request) {
			http.Redirect(w, r, "https://evil.example.org/"+testToken, 302)
		}, &fakeEngine{}},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			s := newSite(t, tc.handler)
			var rec recorder
			_, err := newBuilder(tc.eng, s).Build(context.Background(), request(testConfig()), rec.emit)
			if name == "success" && err != nil {
				t.Fatal(err)
			}
			blob := rec.all()
			if err != nil {
				blob += "\n" + err.Error()
			}
			tc.eng.mu.Lock()
			for _, o := range tc.eng.opts {
				j, _ := json.Marshal(o)
				blob += "\n" + string(j)
			}
			blob += "\n" + string(tc.eng.raw)
			tc.eng.mu.Unlock()
			if strings.Contains(blob, testToken) {
				t.Errorf("the token leaked:\n%s", blob)
			}
		})
	}
}

func TestSourceNeverPrintsItsToken(t *testing.T) {
	src := Source{URL: "https://api.github.com/x", Token: testToken}
	var logs bytes.Buffer
	slog.New(slog.NewJSONHandler(&logs, nil)).Info("build", "source", src)
	j, _ := json.Marshal(map[string]any{"s": src, "p": &src})
	for _, s := range []string{fmt.Sprint(src), fmt.Sprintf("%v %+v %#v %s", src, src, src, &src), logs.String(), string(j)} {
		if strings.Contains(s, testToken) {
			t.Errorf("leaked: %s", s)
		}
	}
	// Decoding is unaffected: the request body carries the token in.
	var in Source
	if err := json.Unmarshal([]byte(`{"url":"https://h/x","token":"abc"}`), &in); err != nil || in.Token != "abc" {
		t.Errorf("%+v %v", in, err)
	}
}

func TestSourceHostAllowList(t *testing.T) {
	bad := map[string]string{
		"http":              "http://api.github.com/x",
		"other host":        "https://github.example.org/x",
		"subdomain":         "https://evil.api.github.com/x",
		"suffix trick":      "https://api.github.com.evil.example/x",
		"userinfo":          "https://api.github.com@evil.example/x",
		"userinfo password": "https://user:pw@api.github.com/x",
		"port":              "https://api.github.com:8443/x",
		"no host":           "https:///x",
		"ip":                "https://127.0.0.1/x",
		"file":              "file:///etc/passwd",
		"empty":             "",
		"opaque":            "https:api.github.com/x",
	}
	for name, u := range bad {
		t.Run(name, func(t *testing.T) {
			s := newSite(t, serveArchive(standardArchive(t)))
			req := request(testConfig())
			req.Source.URL = u
			eng := &fakeEngine{}
			_, err := newBuilder(eng, s).Build(context.Background(), req, (&recorder{}).emit)
			if !errors.Is(err, ErrSourceHost) {
				t.Fatalf("got %v", err)
			}
			if len(s.requests()) != 0 || len(eng.opts) != 0 {
				t.Error("nothing may be requested or built for a refused source")
			}
		})
	}

	// The match is on the host name, case-insensitively; 443 is the default port.
	s := newSite(t, serveArchive(standardArchive(t)))
	req := request(testConfig())
	req.Source.URL = "https://API.GitHub.com:443/x"
	if _, err := newBuilder(&fakeEngine{}, s).Build(context.Background(), req, (&recorder{}).emit); err != nil {
		t.Errorf("%v", err)
	}
	// An operator's own host (GitHub Enterprise Server).
	cfg := testConfig()
	cfg.SourceHosts = []string{"ghe.example.com"}
	req = request(cfg)
	req.Source.URL = "https://ghe.example.com/api/v3/repos/o/r/tarball/" + testSHA
	if _, err := newBuilder(&fakeEngine{}, s).Build(context.Background(), req, (&recorder{}).emit); err != nil {
		t.Errorf("%v", err)
	}
	req.Source.URL = "https://api.github.com/x"
	if _, err := newBuilder(&fakeEngine{}, s).Build(context.Background(), req, (&recorder{}).emit); !errors.Is(err, ErrSourceHost) {
		t.Errorf("a host that is not listed must be refused even when it is a default: %v", err)
	}
}

func TestRedirectsStayOnAllowedHostsAndDropTheToken(t *testing.T) {
	s := newSite(t, func(w http.ResponseWriter, r *http.Request) {
		switch r.Host {
		case "api.github.com":
			http.Redirect(w, r, "https://codeload.github.com/o/r/legacy.tar.gz/"+testSHA+"?token=presigned", http.StatusFound)
		case "codeload.github.com":
			serveArchive(standardArchive(t))(w, r)
		default:
			http.Error(w, "unexpected host "+r.Host, 500)
		}
	})
	if _, err := newBuilder(&fakeEngine{}, s).Build(context.Background(), request(testConfig()), (&recorder{}).emit); err != nil {
		t.Fatal(err)
	}
	reqs := s.requests()
	if len(reqs) != 2 || reqs[0].auth != "Bearer "+testToken {
		t.Fatalf("%+v", reqs)
	}
	if reqs[1].host != "codeload.github.com" || reqs[1].auth != "" {
		t.Errorf("the Authorization header must not follow a redirect to another host: %+v", reqs[1])
	}

	// A redirect to a subdomain of the first host is another host: the standard client would forward the header
	// there, this one must not.
	s = newSite(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Host == "ghe.example.com" {
			http.Redirect(w, r, "https://assets.ghe.example.com/archive.tgz", http.StatusFound)
			return
		}
		serveArchive(standardArchive(t))(w, r)
	})
	cfg := testConfig()
	cfg.SourceHosts = []string{"ghe.example.com", "assets.ghe.example.com"}
	req := request(cfg)
	req.Source.URL = "https://ghe.example.com/api/v3/repos/o/r/tarball/" + testSHA
	if _, err := newBuilder(&fakeEngine{}, s).Build(context.Background(), req, (&recorder{}).emit); err != nil {
		t.Fatal(err)
	}
	if reqs := s.requests(); len(reqs) != 2 || reqs[0].auth == "" || reqs[1].host != "assets.ghe.example.com" || reqs[1].auth != "" {
		t.Errorf("the token must not follow a redirect to a subdomain: %+v", reqs)
	}

	// A redirect inside the same host keeps it.
	s = newSite(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/first" {
			http.Redirect(w, r, "/second", http.StatusFound)
			return
		}
		serveArchive(standardArchive(t))(w, r)
	})
	req = request(testConfig())
	req.Source.URL = "https://api.github.com/first"
	if _, err := newBuilder(&fakeEngine{}, s).Build(context.Background(), req, (&recorder{}).emit); err != nil {
		t.Fatal(err)
	}
	if reqs := s.requests(); len(reqs) != 2 || reqs[1].auth != "Bearer "+testToken {
		t.Errorf("%+v", reqs)
	}
}

func TestRedirectsToOtherPlacesAreRefused(t *testing.T) {
	targets := map[string]string{
		"unlisted host":   "https://evil.example.org/x",
		"plain http":      "http://codeload.github.com/x",
		"internal":        "https://169.254.169.254/latest/meta-data",
		"look-alike host": "https://codeload.github.com.evil.example/x",
		"credentials":     "https://u:p@codeload.github.com/x",
	}
	for name, target := range targets {
		t.Run(name, func(t *testing.T) {
			s := newSite(t, func(w http.ResponseWriter, r *http.Request) { http.Redirect(w, r, target, http.StatusFound) })
			eng := &fakeEngine{}
			_, err := newBuilder(eng, s).Build(context.Background(), request(testConfig()), (&recorder{}).emit)
			if err == nil || !strings.Contains(err.Error(), "not allowed") {
				t.Fatalf("got %v", err)
			}
			if reqs := s.requests(); len(reqs) != 1 {
				t.Errorf("the redirect target must not be requested: %+v", reqs)
			}
			if len(eng.opts) != 0 {
				t.Error("nothing may be built")
			}
		})
	}

	// A loop ends.
	s := newSite(t, func(w http.ResponseWriter, r *http.Request) { http.Redirect(w, r, r.URL.Path+"x", http.StatusFound) })
	if _, err := newBuilder(&fakeEngine{}, s).Build(context.Background(), request(testConfig()), (&recorder{}).emit); err == nil || !strings.Contains(err.Error(), "redirects") {
		t.Errorf("got %v", err)
	}
}

func TestDownloadFailuresFailTheBuild(t *testing.T) {
	cases := map[string]struct {
		handler func(w http.ResponseWriter, r *http.Request)
		want    string
	}{
		"not found":  {func(w http.ResponseWriter, r *http.Request) { http.NotFound(w, r) }, "HTTP 404"},
		"forbidden":  {func(w http.ResponseWriter, r *http.Request) { http.Error(w, "no", 403) }, "HTTP 403"},
		"not a gzip": {serveArchive([]byte("<html>login</html>")), "not a gzip archive"},
		"too large by header": {func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Length", "99999999")
			w.WriteHeader(200)
		}, "max_source"},
		"too large streaming": {func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(200)
			fl := w.(http.Flusher)
			chunk := bytes.Repeat([]byte{0x1f}, 64<<10)
			for range 40 { // 2.5 MiB without a Content-Length, against a 1 MiB limit
				if _, err := w.Write(chunk); err != nil {
					return
				}
				fl.Flush()
			}
		}, ""},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			s := newSite(t, tc.handler)
			eng := &fakeEngine{}
			_, err := newBuilder(eng, s).Build(context.Background(), request(testConfig()), (&recorder{}).emit)
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("got %v, want %q", err, tc.want)
			}
		})
	}

	// A bomb: small compressed, huge unpacked.
	big := archive(t, file("o-r-abc/Dockerfile", "FROM scratch"), file("o-r-abc/zeros", strings.Repeat("\x00", 9<<20)))
	if len(big) >= 1<<20 {
		t.Fatalf("test archive is not small: %d", len(big))
	}
	s := newSite(t, serveArchive(big))
	if _, err := newBuilder(&fakeEngine{}, s).Build(context.Background(), request(testConfig()), (&recorder{}).emit); !errors.Is(err, ErrArchive) || !strings.Contains(err.Error(), "add up to more than") {
		t.Errorf("an archive that unpacks to more than 8x max_source must be refused: %v", err)
	}
}

func TestARefusedArchiveIsReportedNotTheEnginesComplaint(t *testing.T) {
	s := newSite(t, serveArchive(archive(t, file("o-r-abc/Dockerfile", "FROM scratch"), sym("o-r-abc/x", "/etc/shadow"))))
	eng := &fakeEngine{}
	_, err := newBuilder(eng, s).Build(context.Background(), request(testConfig()), (&recorder{}).emit)
	if !errors.Is(err, ErrArchive) || !strings.Contains(err.Error(), "absolute path") {
		t.Fatalf("got %v", err)
	}
}

func TestEngineFailureIsReportedAndNothingIsBuilt(t *testing.T) {
	s := newSite(t, serveArchive(standardArchive(t)))
	eng := &fakeEngine{lines: []string{"Step 2/2 : RUN false"}, err: &docker.BuildError{Message: "The command 'false' returned a non-zero code: 1"}}
	var rec recorder
	ref, err := newBuilder(eng, s).Build(context.Background(), request(testConfig()), rec.emit)
	if err == nil || ref != "" || !strings.Contains(err.Error(), "build failed: The command 'false' returned a non-zero code: 1") {
		t.Fatalf("got %q %v", ref, err)
	}
	if strings.Contains(rec.all(), "built ") {
		t.Errorf("a failed build must not say it built:\n%s", rec.all())
	}
	if !strings.Contains(rec.all(), "RUN false") {
		t.Errorf("the output of a failed build is kept:\n%s", rec.all())
	}
}

func TestBuildTimesOut(t *testing.T) {
	s := newSite(t, serveArchive(standardArchive(t)))
	cfg := testConfig()
	cfg.Timeout = config.D(80 * time.Millisecond)
	eng := &fakeEngine{block: true}
	start := time.Now()
	_, err := newBuilder(eng, s).Build(context.Background(), request(cfg), (&recorder{}).emit)
	if err == nil || !strings.Contains(err.Error(), "timed out after 80ms") {
		t.Fatalf("got %v", err)
	}
	if time.Since(start) > 3*time.Second {
		t.Error("the timeout did not stop the build")
	}

	// A stalled download is bound by the same timeout.
	slow := newSite(t, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(200)
		w.(http.Flusher).Flush()
		<-r.Context().Done()
	})
	if _, err := newBuilder(&fakeEngine{}, slow).Build(context.Background(), request(cfg), (&recorder{}).emit); err == nil || !strings.Contains(err.Error(), "timed out") {
		t.Errorf("got %v", err)
	}

	// Canceling the parent (the agent stopping) is not a timeout.
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	cfg.Timeout = config.D(time.Minute)
	if _, err := newBuilder(&fakeEngine{block: true}, s).Build(ctx, request(cfg), (&recorder{}).emit); err == nil || strings.Contains(err.Error(), "timed out") {
		t.Errorf("got %v", err)
	}
}

func TestBuildOutputIsBounded(t *testing.T) {
	s := newSite(t, serveArchive(standardArchive(t)))
	const n = 10000
	lines := make([]string, n)
	for i := range lines {
		lines[i] = fmt.Sprintf("line %05d", i)
	}
	eng := &fakeEngine{lines: lines, err: &docker.BuildError{Message: "the end"}}
	var rec recorder
	_, err := newBuilder(eng, s).Build(context.Background(), request(testConfig()), rec.emit)
	if err == nil {
		t.Fatal("expected the build error")
	}
	if got := len(rec.msgs); got > maxLiveLines+maxTailLines+8 {
		t.Errorf("%d events for %d lines", got, n)
	}
	all := rec.all()
	for _, want := range []string{"line 00000", fmt.Sprintf("line %05d", maxLiveLines-1), fmt.Sprintf("line %05d", n-1), "build output truncated"} {
		if !strings.Contains(all, want) {
			t.Errorf("missing %q", want)
		}
	}
	if strings.Contains(all, fmt.Sprintf("line %05d", maxLiveLines+1)) && !strings.Contains(all, "omitted") {
		t.Error("the omission must be announced")
	}
	if strings.Contains(all, fmt.Sprintf("line %05d\n", maxLiveLines+10)) {
		t.Error("a line from the omitted middle is present")
	}
	// In order.
	if strings.Index(all, fmt.Sprintf("line %05d", n-1)) < strings.Index(all, "build output truncated") {
		t.Error("the tail must follow the notice")
	}
}

func TestBuildOutputByteBound(t *testing.T) {
	var rec recorder
	o := newOutput(rec.emit)
	long := strings.Repeat("x", 4000)
	for range 400 { // 1.6 MB
		o.add(long)
	}
	o.finish()
	total := 0
	for _, m := range rec.msgs {
		total += len(m)
	}
	if total > maxLiveBytes+maxTailBytes+4096 {
		t.Errorf("%d bytes kept", total)
	}
}

func TestOnlyOneBuildAtATime(t *testing.T) {
	b := New(&fakeEngine{})
	release, ok := b.TryAcquire()
	if !ok {
		t.Fatal("the first build must get the slot")
	}
	if _, ok := b.TryAcquire(); ok {
		t.Fatal("a second build must be refused while the first holds the slot")
	}
	release()
	release() // twice is harmless: it must not free a slot someone else holds
	r2, ok := b.TryAcquire()
	if !ok {
		t.Fatal("the slot must be free after release")
	}
	release()
	if _, ok := b.TryAcquire(); ok {
		t.Error("a stale release freed the slot of another build")
	}
	r2()
}

func TestValidateRefusesBadRequests(t *testing.T) {
	b := New(&fakeEngine{})
	req := request(testConfig())
	if err := b.Validate(req); err != nil {
		t.Fatal(err)
	}
	for _, sha := range []string{"", "abc", strings.ToUpper(testSHA), testSHA + "0", "main", strings.Repeat("g", 40)} {
		r := req
		r.SHA = sha
		if err := b.Validate(r); !errors.Is(err, ErrBadSHA) {
			t.Errorf("%q: %v", sha, err)
		}
	}
	r := req
	r.Config = nil
	if err := b.Validate(r); !errors.Is(err, ErrNoConfig) {
		t.Errorf("%v", err)
	}
	for _, tok := range []string{"a b", "line\nbreak", "tab\t", "é", strings.Repeat("a", 5000)} {
		r := req
		r.Source.Token = tok
		if err := b.Validate(r); !errors.Is(err, ErrSourceToken) {
			t.Errorf("%q: %v", tok, err)
		}
	}
	// A public source may need no token.
	r = req
	r.Source.Token = ""
	if err := b.Validate(r); err != nil {
		t.Errorf("%v", err)
	}
}

func presetRequest(t *testing.T, build string) Request {
	t.Helper()
	b, app := presetBuild(t, build, "")
	b.Timeout, b.MaxSource = config.D(5*time.Second), config.S(1<<20)
	b.SourceHosts = []string{"api.github.com", "codeload.github.com"}
	b.Args = map[string]string{"NEXT_PUBLIC_URL": "https://x.example"}
	r := request(b)
	r.Port, r.HealthPath = app.ContainerPort, "/up"
	return r
}

func TestBuildWithAPresetGeneratesTheDockerfileIntoTheContext(t *testing.T) {
	repo := archive(t, dir("o-r-abc/"), file("o-r-abc/package.json", `{"scripts":{"build":"x"}}`), file("o-r-abc/pnpm-lock.yaml", "lockfileVersion: '9.0'\n"), file("o-r-abc/src/app.js", "1"))
	s := newSite(t, serveArchive(repo))
	eng := &fakeEngine{}
	var rec recorder
	if _, err := newBuilder(eng, s).Build(context.Background(), presetRequest(t, "      preset: nextjs\n"), rec.emit); err != nil {
		t.Fatalf("%v\n%s", err, rec.all())
	}
	if o := eng.opts[0]; o.Dockerfile != ".keelson.Dockerfile" || o.Target != "" || o.Args["NEXT_PUBLIC_URL"] != "https://x.example" {
		t.Errorf("options: %+v", o)
	}
	got := readContext(t, eng.raw)
	if !slices.Equal(got.names, []string{"package.json", "pnpm-lock.yaml", "src/app.js", ".keelson.Dockerfile", ".dockerignore"}) {
		t.Fatalf("context: %v", got.names)
	}
	text := got.files[".keelson.Dockerfile"]
	for _, want := range []string{"pnpm install --frozen-lockfile", "ARG NEXT_PUBLIC_URL", "PORT=3000", `HEALTH_PATH="/up"`, "USER node"} {
		if !strings.Contains(text, want) {
			t.Errorf("the Dockerfile lacks %q:\n%s", want, text)
		}
	}
	if got.files["package.json"] != `{"scripts":{"build":"x"}}` || got.hdrs[".keelson.Dockerfile"].Mode != 0o644 {
		t.Errorf("the repository files are untouched, the generated one is a plain file: %+v", got.hdrs[".keelson.Dockerfile"])
	}
}

// A build variable kept in the agent's store (Request.Args) is declared by the generated Dockerfile like one of the apps
// file's `args`: without its ARG line Docker would silently drop it.
func TestBuildWithAPresetDeclaresStoredBuildVariables(t *testing.T) {
	repo := archive(t, dir("o-r-abc/"), file("o-r-abc/package.json", `{"scripts":{"build":"x"}}`), file("o-r-abc/package-lock.json", "{}"))
	s := newSite(t, serveArchive(repo))
	eng := &fakeEngine{}
	req := presetRequest(t, "      preset: nextjs\n")
	req.Args = map[string]string{"NEXT_PUBLIC_STORED": "from-the-store", "NEXT_PUBLIC_URL": "the-apps-file-wins"}
	if _, err := newBuilder(eng, s).Build(context.Background(), req, (&recorder{}).emit); err != nil {
		t.Fatal(err)
	}
	o := eng.opts[0]
	if o.Args["NEXT_PUBLIC_STORED"] != "from-the-store" || o.Args["NEXT_PUBLIC_URL"] != "https://x.example" {
		t.Errorf("args: %+v", o.Args)
	}
	text := readContext(t, eng.raw).files[".keelson.Dockerfile"]
	for _, want := range []string{"ARG NEXT_PUBLIC_STORED\n", "ARG NEXT_PUBLIC_URL\n"} {
		if !strings.Contains(text, want) {
			t.Errorf("the Dockerfile lacks %q:\n%s", want, text)
		}
	}
}

func TestBuildWithAPresetNeverOverwritesARepositoryFile(t *testing.T) {
	repo := archive(t, dir("o-r-abc/"), file("o-r-abc/package.json", "{}"), file("o-r-abc/.keelson.Dockerfile", "FROM evil\n"))
	s := newSite(t, serveArchive(repo))
	eng := &fakeEngine{}
	_, err := newBuilder(eng, s).Build(context.Background(), presetRequest(t, "      preset: node\n"), (&recorder{}).emit)
	if !errors.Is(err, ErrArchive) || !strings.Contains(err.Error(), ".keelson.Dockerfile") {
		t.Fatalf("%v", err)
	}
	// The engine got a context without a tar trailer: it cannot build anything from it.
	if got := readContext(t, eng.raw); strings.Contains(got.files[".keelson.Dockerfile"], "node:") {
		t.Errorf("a generated file replaced the repository's: %q", got.files[".keelson.Dockerfile"])
	}
}

func TestBuildWithAPresetKeepsTheRepositorysDockerignore(t *testing.T) {
	repo := archive(t, dir("o-r-abc/"), file("o-r-abc/package.json", "{}"), file("o-r-abc/.dockerignore", "secrets\n"))
	s := newSite(t, serveArchive(repo))
	eng := &fakeEngine{}
	if _, err := newBuilder(eng, s).Build(context.Background(), presetRequest(t, "      preset: node\n"), (&recorder{}).emit); err != nil {
		t.Fatal(err)
	}
	got := readContext(t, eng.raw)
	if got.files[".dockerignore"] != "secrets\n" || strings.Count(strings.Join(got.names, ","), ".dockerignore") != 1 {
		t.Errorf("%v %q", got.names, got.files[".dockerignore"])
	}
}

func TestBuildWithAPresetNeedsNoDockerfileButOneWithoutPresetStillDoes(t *testing.T) {
	repo := archive(t, dir("o-r-abc/"), file("o-r-abc/package.json", "{}"))
	s := newSite(t, serveArchive(repo))
	if _, err := newBuilder(&fakeEngine{}, s).Build(context.Background(), request(testConfig()), (&recorder{}).emit); !errors.Is(err, ErrArchive) || !strings.Contains(err.Error(), "Dockerfile") {
		t.Fatalf("a build without a preset needs the repository's Dockerfile: %v", err)
	}
	if _, err := newBuilder(&fakeEngine{}, s).Build(context.Background(), presetRequest(t, "      preset: node\n"), (&recorder{}).emit); err != nil {
		t.Fatalf("a preset writes its own: %v", err)
	}
}

func TestBuildWithAPresetInAContextSubdirectoryFindsTheLockfileThere(t *testing.T) {
	repo := archive(t, dir("o-r-abc/"), file("o-r-abc/yarn.lock", "root"), file("o-r-abc/web/package.json", "{}"), file("o-r-abc/web/package-lock.json", "{}"))
	s := newSite(t, serveArchive(repo))
	eng := &fakeEngine{}
	req := presetRequest(t, "      preset: node\n      context: web\n")
	if _, err := newBuilder(eng, s).Build(context.Background(), req, (&recorder{}).emit); err != nil {
		t.Fatal(err)
	}
	text := readContext(t, eng.raw).files[".keelson.Dockerfile"]
	if !strings.Contains(text, "npm ci") || strings.Contains(text, "yarn") {
		t.Errorf("the lockfile of the context decides:\n%s", text)
	}
}

func TestBuildWithAPresetWithoutPackageJSONFailsBeforeTheEngineBuilds(t *testing.T) {
	repo := archive(t, dir("o-r-abc/"), file("o-r-abc/README.md", "x"))
	s := newSite(t, serveArchive(repo))
	_, err := newBuilder(&fakeEngine{}, s).Build(context.Background(), presetRequest(t, "      preset: vite\n"), (&recorder{}).emit)
	if !errors.Is(err, ErrArchive) || !strings.Contains(err.Error(), "package.json") {
		t.Fatalf("%v", err)
	}
}

func fl(f float64) *float64 { return &f }
