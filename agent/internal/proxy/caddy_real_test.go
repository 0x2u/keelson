package proxy

import (
	"context"
	"crypto/tls"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/0x2u/keelson/agent/internal/config"
)

// RealCaddy is a throwaway Caddy container on the host network, for tests that need the real thing. It is only
// started when KEELSON_CADDY_TEST is set (it needs Docker, the image caddy:2-alpine and free ports 80, 443 and 2019).
type RealCaddy struct {
	t    *testing.T
	Name string
}

// StartRealCaddy starts the container with each of mounts (host directory) read-only at the same path.
func StartRealCaddy(t *testing.T, mounts ...string) *RealCaddy {
	t.Helper()
	if os.Getenv("KEELSON_CADDY_TEST") == "" {
		t.Skip("set KEELSON_CADDY_TEST=1 to run against a real Caddy container")
	}
	c := &RealCaddy{t: t, Name: fmt.Sprintf("kv-caddy-%d", os.Getpid())}
	args := []string{"run", "-d", "--name", c.Name, "--network", "host"}
	for _, m := range mounts {
		args = append(args, "-v", m+":"+m+":ro")
	}
	args = append(args, "caddy:2-alpine")
	if out, err := exec.Command("docker", args...).CombinedOutput(); err != nil {
		t.Fatalf("docker run: %v: %s", err, out)
	}
	t.Cleanup(func() { exec.Command("docker", "rm", "-f", c.Name).Run() })
	c.WaitAdmin(30 * time.Second)
	return c
}

// WaitAdmin returns once the admin API answers.
func (c *RealCaddy) WaitAdmin(timeout time.Duration) {
	c.t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if resp, err := http.Get(config.DefaultProxyAdmin + "/config/"); err == nil {
			resp.Body.Close()
			return
		}
		time.Sleep(200 * time.Millisecond)
	}
	c.t.Fatal("caddy admin API did not come up")
}

// Restart kills the container's Caddy and starts it again: it comes back with its default, empty configuration.
func (c *RealCaddy) Restart() {
	c.t.Helper()
	if out, err := exec.Command("docker", "restart", "-t", "0", c.Name).CombinedOutput(); err != nil {
		c.t.Fatalf("docker restart: %v: %s", err, out)
	}
	c.WaitAdmin(30 * time.Second)
}

// Client returns an HTTP client that reaches the container's HTTPS port whatever the host name, accepts its
// internal certificates and does not follow redirects.
func (c *RealCaddy) Client() *http.Client {
	return &http.Client{
		Timeout: 20 * time.Second,
		Transport: &http.Transport{
			DialContext: func(ctx context.Context, network, _ string) (net.Conn, error) {
				return (&net.Dialer{}).DialContext(ctx, network, "127.0.0.1:443")
			},
			TLSClientConfig: &tls.Config{InsecureSkipVerify: true},
		},
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}
}

type reply struct {
	Status int
	Header http.Header
	Body   string
}

// Get requests https://host/path with extra headers. The first request of a host waits for its certificate.
func (c *RealCaddy) Get(host, path string, headers map[string]string) reply {
	c.t.Helper()
	var last error
	for i := 0; i < 30; i++ {
		req, _ := http.NewRequest("GET", "https://"+host+path, nil)
		for k, v := range headers {
			req.Header.Set(k, v)
		}
		resp, err := c.Client().Do(req)
		if err == nil {
			defer resp.Body.Close()
			b, _ := io.ReadAll(resp.Body)
			return reply{resp.StatusCode, resp.Header, string(b)}
		}
		last = err
		time.Sleep(500 * time.Millisecond)
	}
	c.t.Fatalf("GET %s%s: %v", host, path, last)
	return reply{}
}

func writeFiles(t *testing.T, root string, files map[string]string) {
	t.Helper()
	for name, content := range files {
		p := filepath.Join(root, name)
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
}

// echoUpstream answers with what it received.
type echoUpstream struct {
	*httptest.Server
	mu   sync.Mutex
	last http.Header
}

func newEchoUpstream(t *testing.T) *echoUpstream {
	u := &echoUpstream{}
	u.Server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		u.mu.Lock()
		u.last = r.Header.Clone()
		u.mu.Unlock()
		w.Header().Set("X-Upstream", "yes")
		fmt.Fprintf(w, "upstream %s", r.URL.Path)
	}))
	t.Cleanup(u.Close)
	return u
}

func (u *echoUpstream) Header(name string) string {
	u.mu.Lock()
	defer u.mu.Unlock()
	return u.last.Get(name)
}

func realSites(root string, upstream string) config.Proxy {
	return config.Proxy{
		TLS:            "internal",
		TrustedProxies: []string{"127.0.0.0/8"},
		ClientIPHeader: "CF-Connecting-IP",
		Sites: []config.Site{
			{
				Hosts: []string{"www.kv-static.test"}, Root: root, NotFound: "404.html", Index: "index.html",
				TryFiles:  config.DefaultTryFiles,
				Headers:   map[string]string{"X-Content-Type-Options": "nosniff", "X-Frame-Options": "DENY", "Referrer-Policy": "strict-origin-when-cross-origin"},
				Immutable: []string{"/_next/static/*", "*.png"},
			},
			{Hosts: []string{"kv-static.test"}, Redirect: &config.SiteRedirect{To: "https://www.kv-static.test{uri}", Code: 301}},
			{Hosts: []string{"app.kv-static.test"}, Upstream: upstream, Headers: map[string]string{"X-Site": "app"}},
		},
	}
}

func TestRealCaddyServesSites(t *testing.T) {
	root := t.TempDir()
	if err := os.Chmod(root, 0o755); err != nil {
		t.Fatal(err)
	}
	writeFiles(t, root, map[string]string{
		"index.html":            "home",
		"404.html":              "custom not found",
		"about.html":            "about page",
		"blog/index.html":       "blog index",
		"_next/static/chunk.js": "chunk",
		"logo.png":              "png",
		"other.txt":             "plain",
	})
	up := newEchoUpstream(t)
	caddy := StartRealCaddy(t, root)

	settings := realSites(root, strings.TrimPrefix(up.URL, "http://"))
	drv := New(settings)
	apps := []Route{{App: "web", Hosts: []string{"web.kv-static.test"}, Upstream: strings.TrimPrefix(up.URL, "http://")}}
	if err := drv.Apply(context.Background(), apps); err != nil {
		t.Fatal(err)
	}

	const www = "www.kv-static.test"
	check := func(name, path string, status int, body string) reply {
		t.Helper()
		r := caddy.Get(www, path, nil)
		if r.Status != status || (body != "" && r.Body != body) {
			t.Errorf("%s: GET %s = %d %q, want %d %q", name, path, r.Status, r.Body, status, body)
		}
		return r
	}
	home := check("index", "/", 200, "home")
	for h, want := range map[string]string{"X-Content-Type-Options": "nosniff", "X-Frame-Options": "DENY", "Referrer-Policy": "strict-origin-when-cross-origin"} {
		if got := home.Header.Get(h); got != want {
			t.Errorf("header %s = %q, want %q", h, got, want)
		}
	}
	if cc := home.Header.Get("Cache-Control"); cc != "" {
		t.Errorf("the home page is not immutable: %q", cc)
	}
	check("try_files .html", "/about", 200, "about page")
	check("exact file", "/other.txt", 200, "plain")
	check("directory index", "/blog/", 200, "blog index")
	// A directory asked without its slash is redirected to it, as every static server does.
	if r := caddy.Get(www, "/blog", nil); r.Status != 308 || r.Header.Get("Location") != "/blog/" {
		t.Errorf("directory without slash = %d %q", r.Status, r.Header.Get("Location"))
	}

	chunk := check("immutable prefix", "/_next/static/chunk.js", 200, "chunk")
	if cc := chunk.Header.Get("Cache-Control"); cc != config.ImmutableCacheControl {
		t.Errorf("immutable path Cache-Control = %q", cc)
	}
	if png := check("immutable suffix", "/logo.png", 200, "png"); png.Header.Get("Cache-Control") != config.ImmutableCacheControl {
		t.Errorf("png Cache-Control = %q", png.Header.Get("Cache-Control"))
	}
	if chunk.Header.Get("X-Frame-Options") != "DENY" {
		t.Error("immutable responses keep the site headers")
	}

	nf := check("not found page", "/nope", 404, "custom not found")
	if nf.Header.Get("X-Frame-Options") != "DENY" {
		t.Error("the not found page carries the site headers")
	}
	check("traversal is not served", "/../../etc/passwd", 404, "custom not found")

	// Redirect, keeping path and query.
	r := caddy.Get("kv-static.test", "/a/b?x=1", nil)
	if r.Status != 301 || r.Header.Get("Location") != "https://www.kv-static.test/a/b?x=1" {
		t.Errorf("redirect = %d %q", r.Status, r.Header.Get("Location"))
	}

	// Upstream behind trusted proxies: the real client, never what the client wrote.
	r = caddy.Get("app.kv-static.test", "/hello", map[string]string{"CF-Connecting-IP": "203.0.113.7", "X-Forwarded-For": "6.6.6.6"})
	if r.Status != 200 || r.Body != "upstream /hello" || r.Header.Get("X-Site") != "app" {
		t.Errorf("upstream site = %d %q %v", r.Status, r.Body, r.Header)
	}
	if got := up.Header("X-Forwarded-For"); got != "203.0.113.7" {
		t.Errorf("upstream saw X-Forwarded-For %q, want exactly 203.0.113.7", got)
	}
	// The app route next to the sites behaves the same.
	caddy.Get("web.kv-static.test", "/", map[string]string{"CF-Connecting-IP": "198.51.100.9", "X-Forwarded-For": "6.6.6.6"})
	if got := up.Header("X-Forwarded-For"); got != "198.51.100.9" {
		t.Errorf("app upstream saw X-Forwarded-For %q, want 198.51.100.9", got)
	}

	// The agent finds what it applied in sync, then finds a restarted Caddy empty.
	if got := drv.Inspect(context.Background(), apps); got.InSync == nil || !*got.InSync {
		t.Errorf("after Apply the proxy must be in sync: %+v", got)
	}
	caddy.Restart()
	if got := drv.Inspect(context.Background(), apps); got.InSync == nil || *got.InSync {
		t.Errorf("a restarted Caddy is empty, so not in sync: %+v", got)
	}
	if err := drv.Apply(context.Background(), apps); err != nil {
		t.Fatal(err)
	}
	if got := drv.Inspect(context.Background(), apps); got.InSync == nil || !*got.InSync {
		t.Errorf("after re-applying the proxy must be in sync: %+v", got)
	}
	check("served again", "/about", 200, "about page")
}

func TestRealCaddyIgnoresForwardedHeadersFromUntrustedPeers(t *testing.T) {
	up := newEchoUpstream(t)
	caddy := StartRealCaddy(t)
	settings := config.Proxy{
		TLS:            "internal",
		TrustedProxies: []string{"10.255.255.0/24"}, // the test client is 127.0.0.1: not trusted
		ClientIPHeader: "CF-Connecting-IP",
		Sites:          []config.Site{{Hosts: []string{"app.kv-static.test"}, Upstream: strings.TrimPrefix(up.URL, "http://")}},
	}
	if err := New(settings).Apply(context.Background(), nil); err != nil {
		t.Fatal(err)
	}
	caddy.Get("app.kv-static.test", "/", map[string]string{"CF-Connecting-IP": "203.0.113.7", "X-Forwarded-For": "6.6.6.6"})
	if got := up.Header("X-Forwarded-For"); got != "127.0.0.1" {
		t.Errorf("an untrusted peer must not choose the client address: upstream saw %q, want 127.0.0.1", got)
	}
}
