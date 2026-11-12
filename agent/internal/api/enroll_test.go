package api

import (
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"io"
	"log"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/0x2u/keelson/agent/internal/appenv"
	"github.com/0x2u/keelson/agent/internal/config"
	"github.com/0x2u/keelson/agent/internal/docker"
	"github.com/0x2u/keelson/agent/internal/enroll"
	"github.com/0x2u/keelson/agent/internal/install"
	"github.com/0x2u/keelson/agent/internal/store"
)

const (
	forbiddenBody = `{"error":"invalid or expired code"}` + "\n"
	gateBody      = `{"error":"client certificate required"}` + "\n"
	clientKeyText = "ENROLL-CLIENT-KEY-MARKER"
)

// enrolRig is an API with enrolment on, over plain HTTP: enough for the handler's behaviour (the gate and the
// handshake are exercised over real TLS below).
type enrolRig struct {
	t    *testing.T
	srv  *httptest.Server
	st   *store.Store
	dir  string
	logs *syncBuffer
	svc  *enroll.Service
	now  func() time.Time
}

type syncBuffer struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (s *syncBuffer) Write(p []byte) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.Write(p)
}

func (s *syncBuffer) String() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.String()
}

type clock struct {
	mu sync.Mutex
	t  time.Time
}

func (c *clock) now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.t
}

func (c *clock) advance(d time.Duration) {
	c.mu.Lock()
	c.t = c.t.Add(d)
	c.mu.Unlock()
}

func newEnrolService(t *testing.T, st *store.Store, dir string, logger *slog.Logger, now func() time.Time) *enroll.Service {
	t.Helper()
	svc, err := enroll.New(enroll.Options{
		Dir: dir, CAPEM: "CA-PEM-TEXT", Token: testToken, DeploySecret: testSecret, Ledger: st, Log: logger, Now: now,
	})
	if err != nil {
		t.Fatal(err)
	}
	return svc
}

func newEnrolRig(t *testing.T) (*enrolRig, *clock) {
	t.Helper()
	st, err := store.Open(filepath.Join(t.TempDir(), "a.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	clk := &clock{t: time.Now()}
	logs := &syncBuffer{}
	logger := slog.New(slog.NewTextHandler(logs, nil))
	dir := t.TempDir()
	svc := newEnrolService(t, st, dir, logger, clk.now)
	h, err := New(&fakeDocker{}, Options{
		Token: testToken, Version: "test", Logger: logger, RequireClientCert: true, Enroller: svc,
		Deploy: &DeployOptions{Deployments: &fakeDeployments{}, Secret: testSecret, Replays: st, Audit: st},
	})
	if err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(h)
	t.Cleanup(srv.Close)
	return &enrolRig{t: t, srv: srv, st: st, dir: dir, logs: logs, svc: svc, now: clk.now}, clk
}

// pending leaves a code that lives for ttl and returns it.
func (r *enrolRig) pending(ttl time.Duration) string {
	r.t.Helper()
	code, err := enroll.NewCode()
	if err != nil {
		r.t.Fatal(err)
	}
	r.write(code, ttl)
	return code
}

func (r *enrolRig) write(code string, ttl time.Duration) {
	r.t.Helper()
	p := enroll.NewPending(code, r.now(), ttl, []byte("CLIENT-CERT-PEM"), []byte(clientKeyText))
	b, _ := json.Marshal(p)
	if err := os.WriteFile(enroll.PendingFile(r.dir, p.Hash), b, 0o640); err != nil {
		r.t.Fatal(err)
	}
}

type answer struct {
	status  int
	body    string
	headers http.Header
}

func post(t *testing.T, url, body string) answer {
	t.Helper()
	resp, err := http.Post(url, "application/json", strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	return answer{resp.StatusCode, string(b), resp.Header}
}

func redeemBody(code string) string {
	b, _ := json.Marshal(map[string]string{"code": code})
	return string(b)
}

func TestNewRefusesEnrolmentWithoutMutualTLS(t *testing.T) {
	st, _ := store.Open(filepath.Join(t.TempDir(), "a.db"))
	defer st.Close()
	svc := newEnrolService(t, st, t.TempDir(), slog.New(slog.NewTextHandler(io.Discard, nil)), time.Now)
	if _, err := New(&fakeDocker{}, Options{Token: testToken, Enroller: svc}); err == nil {
		t.Fatal("enrolment without the client-certificate gate must be refused: it would leave only the bearer token")
	}
}

func TestRedeemingOverHTTP(t *testing.T) {
	r, _ := newEnrolRig(t)
	code := r.pending(time.Minute)

	a := post(t, r.srv.URL+"/v1/enroll", redeemBody(code))
	if a.status != 200 {
		t.Fatalf("status %d: %s", a.status, a.body)
	}
	if cc := a.headers.Get("Cache-Control"); cc != "no-store" {
		t.Errorf("Cache-Control %q", cc)
	}
	if ct := a.headers.Get("Content-Type"); ct != "application/json" {
		t.Errorf("Content-Type %q", ct)
	}
	var got map[string]string
	if err := json.Unmarshal([]byte(a.body), &got); err != nil {
		t.Fatal(err)
	}
	want := map[string]string{"ca_pem": "CA-PEM-TEXT", "client_cert_pem": "CLIENT-CERT-PEM", "client_key_pem": clientKeyText, "token": testToken, "deploy_secret": testSecret}
	if len(got) != len(want) {
		t.Errorf("fields: %v", got)
	}
	for k, v := range want {
		if got[k] != v {
			t.Errorf("%s = %q, want %q", k, got[k], v)
		}
	}
	if _, err := os.Stat(enroll.PendingFile(r.dir, enroll.Hash(code))); err == nil {
		t.Error("the pending file survived the redemption")
	}

	second := post(t, r.srv.URL+"/v1/enroll", redeemBody(code))
	if second.status != http.StatusForbidden || second.body != forbiddenBody {
		t.Errorf("second redemption: %d %q", second.status, second.body)
	}
}

func TestUnknownUsedAndExpiredCodesGetTheSameAnswer(t *testing.T) {
	r, clk := newEnrolRig(t)

	unknown, _ := enroll.NewCode()
	aUnknown := post(t, r.srv.URL+"/v1/enroll", redeemBody(unknown))

	used := r.pending(time.Hour)
	post(t, r.srv.URL+"/v1/enroll", redeemBody(used))
	r.write(used, time.Hour) // the file survived: the ledger refuses
	aUsed := post(t, r.srv.URL+"/v1/enroll", redeemBody(used))

	expired := r.pending(time.Minute)
	clk.advance(2 * time.Minute)
	aExpired := post(t, r.srv.URL+"/v1/enroll", redeemBody(expired))

	for name, a := range map[string]answer{"unknown": aUnknown, "used": aUsed, "expired": aExpired} {
		if a.status != http.StatusForbidden || a.body != forbiddenBody {
			t.Errorf("%s: %d %q", name, a.status, a.body)
		}
		if a.headers.Get("Content-Type") != aUnknown.headers.Get("Content-Type") || a.headers.Get("Cache-Control") != "no-store" || a.headers.Get("Retry-After") != "" {
			t.Errorf("%s: headers differ: %v", name, a.headers)
		}
	}
}

func TestMalformedEnrolmentRequestsAre400(t *testing.T) {
	r, _ := newEnrolRig(t)
	for name, body := range map[string]string{
		"empty":         "",
		"not json":      "code=abc",
		"no code":       "{}",
		"empty code":    `{"code":""}`,
		"number":        `{"code":12}`,
		"array":         `["x"]`,
		"unknown field": `{"code":"abc","extra":1}`,
		"trailing":      `{"code":"abc"} {"code":"abc"}`,
		"too large":     `{"code":"` + strings.Repeat("a", 5000) + `"}`,
	} {
		a := post(t, r.srv.URL+"/v1/enroll", body)
		if a.status != http.StatusBadRequest {
			t.Errorf("%s: status %d, want 400 (%s)", name, a.status, a.body)
		}
	}
	// None of those is a failed redemption: the rate limit is still untouched.
	good := r.pending(time.Minute)
	if a := post(t, r.srv.URL+"/v1/enroll", redeemBody(good)); a.status != 200 {
		t.Errorf("malformed requests were counted as failures: %d", a.status)
	}
}

func TestOnlyPOSTRedeems(t *testing.T) {
	r, _ := newEnrolRig(t)
	for _, m := range []string{"GET", "PUT", "DELETE", "PATCH"} {
		req, _ := http.NewRequest(m, r.srv.URL+"/v1/enroll", strings.NewReader(redeemBody("x")))
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		// Over plain HTTP in this rig there is no certificate: the gate answers first.
		if resp.StatusCode != http.StatusUnauthorized {
			t.Errorf("%s /v1/enroll: %d", m, resp.StatusCode)
		}
	}
}

func TestFiveFailuresAnywhereThenTooManyRequests(t *testing.T) {
	r, clk := newEnrolRig(t)
	good := r.pending(time.Hour)
	for i := range 5 {
		bad, _ := enroll.NewCode()
		if a := post(t, r.srv.URL+"/v1/enroll", redeemBody(bad)); a.status != http.StatusForbidden {
			t.Fatalf("failure %d: %d", i, a.status)
		}
	}
	a := post(t, r.srv.URL+"/v1/enroll", redeemBody(good))
	if a.status != http.StatusTooManyRequests {
		t.Fatalf("status %d, want 429: %s", a.status, a.body)
	}
	secs, err := strconv.Atoi(a.headers.Get("Retry-After"))
	if err != nil || secs < 1 || secs > 60 {
		t.Errorf("Retry-After %q", a.headers.Get("Retry-After"))
	}
	if strings.Contains(a.body, good) {
		t.Error("the 429 body echoes the code")
	}
	clk.advance(time.Minute + time.Second)
	if a := post(t, r.srv.URL+"/v1/enroll", redeemBody(good)); a.status != 200 {
		t.Errorf("after the wait the code still works: %d %s", a.status, a.body)
	}
}

func TestOfConcurrentRequestsExactlyOneRedeems(t *testing.T) {
	// Five callers keep the failures under the rate limit, so only single use decides.
	for round := range 20 {
		r, _ := newEnrolRig(t)
		code := r.pending(time.Minute)
		var wg sync.WaitGroup
		statuses := make(chan int, 5)
		start := make(chan struct{})
		for range 5 {
			wg.Add(1)
			go func() {
				defer wg.Done()
				<-start
				statuses <- post(t, r.srv.URL+"/v1/enroll", redeemBody(code)).status
			}()
		}
		close(start)
		wg.Wait()
		close(statuses)
		ok, forbidden := 0, 0
		for s := range statuses {
			switch s {
			case 200:
				ok++
			case 403:
				forbidden++
			}
		}
		if ok != 1 || forbidden != 4 {
			t.Fatalf("round %d: %d x 200, %d x 403", round, ok, forbidden)
		}
	}
}

func TestEnrolmentIsAuditedWithoutTheCode(t *testing.T) {
	r, clk := newEnrolRig(t)
	ctx := context.Background()

	guess, _ := enroll.NewCode()
	post(t, r.srv.URL+"/v1/enroll", redeemBody(guess))
	code := r.pending(time.Hour)
	post(t, r.srv.URL+"/v1/enroll", redeemBody(code))
	r.write(code, time.Hour)
	post(t, r.srv.URL+"/v1/enroll", redeemBody(code)) // used
	old := r.pending(time.Minute)
	clk.advance(time.Hour + time.Minute) // r.write above is then expired too
	post(t, r.srv.URL+"/v1/enroll", redeemBody(old))

	entries, err := r.st.Audit(ctx, 50, 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 3 {
		t.Fatalf("%d audit entries, want 3 (redeemed, used, expired; a plain guess is not recorded): %+v", len(entries), entries)
	}
	id := enroll.ID(enroll.Hash(code))
	byStatus := map[int]int{}
	for _, e := range entries {
		byStatus[e.Status]++
		if e.Action != "enroll" || e.Method != "POST" || e.Path != "/v1/enroll" || e.IP != "127.0.0.1" {
			t.Errorf("entry: %+v", e)
		}
	}
	if byStatus[200] != 1 || byStatus[403] != 2 {
		t.Errorf("statuses: %v", byStatus)
	}
	var redeemed store.AuditEntry
	for _, e := range entries {
		if e.Status == 200 {
			redeemed = e
		}
	}
	if redeemed.Detail != "code "+id+" redeemed" {
		t.Errorf("detail %q", redeemed.Detail)
	}
	all, _ := json.Marshal(entries)
	for _, secret := range []string{code, enroll.Hash(code), guess, old, testToken, testSecret, clientKeyText} {
		if strings.Contains(string(all), secret) {
			t.Errorf("the audit log contains %q", secret)
		}
	}
}

func TestNothingSecretReachesTheLog(t *testing.T) {
	r, _ := newEnrolRig(t)
	code := r.pending(time.Minute)
	bad, _ := enroll.NewCode()
	post(t, r.srv.URL+"/v1/enroll", redeemBody(code))
	post(t, r.srv.URL+"/v1/enroll", redeemBody(code))
	post(t, r.srv.URL+"/v1/enroll", redeemBody(bad))
	post(t, r.srv.URL+"/v1/enroll", `{"code":"`+bad+`","x":1}`)
	logs := r.logs.String()
	if !strings.Contains(logs, "/v1/enroll") {
		t.Fatalf("the request log is empty: %q", logs)
	}
	for _, secret := range []string{code, bad, enroll.Hash(code), testToken, testSecret, clientKeyText, "CLIENT-CERT-PEM", "CA-PEM-TEXT"} {
		if strings.Contains(logs, secret) {
			t.Errorf("the log contains %q:\n%s", secret, logs)
		}
	}
}

// --- the client-certificate gate and the TLS handshake, for real ---

type tlsRig struct {
	t        *testing.T
	srv      *httptest.Server
	ca       *install.CA
	pool     *x509.CertPool
	other    *install.CA // a second authority the server does not trust
	svc      *enroll.Service
	rig      *enrolRig
	dockerFn *countingDocker
}

// countingDocker counts engine calls: a request refused by the gate must never reach a handler.
type countingDocker struct {
	fakeDocker
	calls atomic.Int32
}

func (c *countingDocker) Ping(ctx context.Context) error {
	c.calls.Add(1)
	return c.fakeDocker.Ping(ctx)
}
func (c *countingDocker) ListContainers(ctx context.Context, all bool) ([]docker.Container, error) {
	c.calls.Add(1)
	return c.fakeDocker.ListContainers(ctx, all)
}
func (c *countingDocker) Inspect(ctx context.Context, id string) (*docker.Detail, error) {
	c.calls.Add(1)
	return c.fakeDocker.Inspect(ctx, id)
}

func newTLSRig(t *testing.T, withEnrolment bool) *tlsRig {
	t.Helper()
	now := time.Now()
	ca, _, err := install.NewCA("test", now)
	if err != nil {
		t.Fatal(err)
	}
	other, _, err := install.NewCA("other", now)
	if err != nil {
		t.Fatal(err)
	}
	serverLeaf, err := ca.IssueServer([]string{"127.0.0.1", "localhost"}, now)
	if err != nil {
		t.Fatal(err)
	}
	serverCert, err := tls.X509KeyPair(serverLeaf.CertPEM, serverLeaf.KeyPEM)
	if err != nil {
		t.Fatal(err)
	}
	cfg, err := ServerTLSConfig(ca.PEM, withEnrolment)
	if err != nil {
		t.Fatal(err)
	}
	cfg.Certificates = []tls.Certificate{serverCert}

	st, err := store.Open(filepath.Join(t.TempDir(), "a.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	dir := t.TempDir()
	envStore, err := appenv.Open(filepath.Join(t.TempDir(), "env"))
	if err != nil {
		t.Fatal(err)
	}
	opts := Options{
		Token: testToken, Version: "test", Logger: logger, RequireClientCert: true,
		// Env is wired so that the routes of the variables are really registered behind the gate under test.
		Deploy: &DeployOptions{Deployments: &fakeDeployments{}, Secret: testSecret, Replays: st, Audit: st, Env: &appenv.Service{
			Store: envStore, Config: func() *config.Config { return &config.Config{} },
		}},
	}
	rig := &enrolRig{t: t, st: st, dir: dir, now: time.Now}
	var svc *enroll.Service
	if withEnrolment {
		svc = newEnrolService(t, st, dir, logger, time.Now)
		opts.Enroller = svc
		rig.svc = svc
	}
	cd := &countingDocker{}
	h, err := New(cd, opts)
	if err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewUnstartedServer(h)
	srv.TLS = cfg
	srv.Config.ErrorLog = log.New(io.Discard, "", 0) // failed handshakes are expected here
	srv.StartTLS()
	t.Cleanup(srv.Close)
	pool := x509.NewCertPool()
	pool.AddCert(ca.Cert)
	return &tlsRig{t: t, srv: srv, ca: ca, pool: pool, other: other, svc: svc, rig: rig, dockerFn: cd}
}

// client builds an HTTP client that trusts the agent, presenting leaf (none when nil).
func (r *tlsRig) client(leaf *install.Leaf) *http.Client {
	r.t.Helper()
	cfg := &tls.Config{RootCAs: r.pool, MinVersion: tls.VersionTLS13}
	if leaf != nil {
		cert, err := tls.X509KeyPair(leaf.CertPEM, leaf.KeyPEM)
		if err != nil {
			r.t.Fatal(err)
		}
		cfg.Certificates = []tls.Certificate{cert}
	}
	tr := &http.Transport{TLSClientConfig: cfg, DisableKeepAlives: true}
	r.t.Cleanup(tr.CloseIdleConnections)
	return &http.Client{Transport: tr, Timeout: 5 * time.Second}
}

func (r *tlsRig) leaf(ca *install.CA) *install.Leaf {
	r.t.Helper()
	l, err := ca.IssueClient(time.Now())
	if err != nil {
		r.t.Fatal(err)
	}
	return &l
}

func (r *tlsRig) do(c *http.Client, method, path, body string, auth bool) (int, string, error) {
	var rd io.Reader
	if body != "" {
		rd = strings.NewReader(body)
	}
	req, err := http.NewRequest(method, r.srv.URL+path, rd)
	if err != nil {
		r.t.Fatal(err)
	}
	if auth {
		req.Header.Set("Authorization", "Bearer "+testToken)
	}
	resp, err := c.Do(req)
	if err != nil {
		return 0, "", err
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, string(b), nil
}

// everyRoute reads the patterns the API registers from its own source, so that a route added later is covered too.
func everyRoute(t *testing.T) []string {
	t.Helper()
	files, _ := filepath.Glob("*.go")
	re := regexp.MustCompile(`HandleFunc\("([A-Z]+) (/[^"]*)"`)
	param := regexp.MustCompile(`\{[^}]*\}`)
	seen := map[string]bool{}
	var paths []string
	for _, f := range files {
		if strings.HasSuffix(f, "_test.go") {
			continue
		}
		b, err := os.ReadFile(f)
		if err != nil {
			t.Fatal(err)
		}
		for _, m := range re.FindAllStringSubmatch(string(b), -1) {
			p := param.ReplaceAllString(m[2], "x")
			if !seen[p] {
				seen[p] = true
				paths = append(paths, p)
			}
		}
	}
	if len(paths) < 30 {
		t.Fatalf("found only %d routes in the source: the pattern no longer matches how routes are registered", len(paths))
	}
	return paths
}

var allMethods = []string{"GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"}

func TestWithoutACertificateOnlyRedeemingIsReachable(t *testing.T) {
	r := newTLSRig(t, true)
	c := r.client(nil)

	paths := append(everyRoute(t), "/", "/v1", "/v1/", "/v1/nope", "/v1/health/", "/v1/enroll/", "/v1/enroll/x", "//v1/enroll", "/V1/ENROLL", "/v1/enrol", "/v1/containers/../enroll", "/admin", "/v1/enroll?x=1")
	for _, p := range paths {
		for _, m := range allMethods {
			if m == "POST" && (p == "/v1/enroll" || p == "/v1/enroll?x=1") {
				continue
			}
			for _, auth := range []bool{false, true} {
				status, body, err := r.do(c, m, p, `{"code":"x"}`, auth)
				if err != nil {
					t.Fatalf("%s %s: %v", m, p, err)
				}
				// A HEAD answer has no body, and path cleaning may redirect first: what matters is that no handler
				// ran, so the status is the gate's.
				if m != "HEAD" && body != gateBody {
					t.Errorf("%s %s (token %v) without a certificate: %d %q, want the gate's 401", m, p, auth, status, body)
				}
				if status != http.StatusUnauthorized && !(status == http.StatusMovedPermanently || status == http.StatusPermanentRedirect) {
					t.Errorf("%s %s (token %v) without a certificate: status %d", m, p, auth, status)
				}
			}
		}
	}
	if n := r.dockerFn.calls.Load(); n != 0 {
		t.Errorf("%d engine calls were made for requests that carried no certificate", n)
	}
	// What the gate lets through is only the redemption (POST /v1/enroll, with or without a query).
	status, body, err := r.do(c, "POST", "/v1/enroll", `{"code":"nope"}`, false)
	if err != nil || status != http.StatusForbidden || body != forbiddenBody {
		t.Errorf("redeeming without a certificate: %d %q %v", status, body, err)
	}
	status, _, err = r.do(c, "POST", "/v1/enroll", `{}`, false)
	if err != nil || status != http.StatusBadRequest {
		t.Errorf("a malformed redemption without a certificate: %d %v", status, err)
	}
}

func TestTheGateAnswerIsNotCacheable(t *testing.T) {
	r := newTLSRig(t, true)
	resp, err := r.client(nil).Get(r.srv.URL + "/v1/info")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 401 || resp.Header.Get("Cache-Control") != "no-store" || resp.Header.Get("Content-Type") != "application/json" {
		t.Errorf("%d %v", resp.StatusCode, resp.Header)
	}
}

func TestWithAValidCertificateEverythingWorksAsBefore(t *testing.T) {
	for _, withEnrolment := range []bool{true, false} {
		r := newTLSRig(t, withEnrolment)
		c := r.client(r.leaf(r.ca))

		if status, _, err := r.do(c, "GET", "/v1/health", "", false); err != nil || status != 200 {
			t.Errorf("enrolment=%v: health: %d %v", withEnrolment, status, err)
		}
		if status, _, err := r.do(c, "GET", "/v1/info", "", true); err != nil || status != 200 {
			t.Errorf("enrolment=%v: info with the token: %d %v", withEnrolment, status, err)
		}
		// The certificate does not replace the token.
		if status, body, err := r.do(c, "GET", "/v1/info", "", false); err != nil || status != 401 || strings.Contains(body, "certificate") {
			t.Errorf("enrolment=%v: info without the token: %d %q %v", withEnrolment, status, body, err)
		}
		if status, _, err := r.do(c, "GET", "/v1/nope", "", true); err != nil || status != 404 {
			t.Errorf("enrolment=%v: unknown path: %d %v", withEnrolment, status, err)
		}
		// Every route is reachable past the gate: it answers with its own errors, never the gate's.
		for _, p := range everyRoute(t) {
			for _, m := range allMethods {
				status, body, err := r.do(c, m, p, "", false)
				if err != nil {
					t.Fatalf("%s %s: %v", m, p, err)
				}
				if body == gateBody {
					t.Errorf("enrolment=%v: %s %s (%d) with a certificate got the gate's answer", withEnrolment, m, p, status)
				}
			}
		}
	}
}

func TestACertificateFromAnotherAuthorityIsRefused(t *testing.T) {
	for _, withEnrolment := range []bool{true, false} {
		r := newTLSRig(t, withEnrolment)
		foreign := r.leaf(r.other)

		// A client that insists on presenting it: the handshake fails, whatever the route.
		cert, err := tls.X509KeyPair(foreign.CertPEM, foreign.KeyPEM)
		if err != nil {
			t.Fatal(err)
		}
		forced := &http.Client{Timeout: 5 * time.Second, Transport: &http.Transport{DisableKeepAlives: true, TLSClientConfig: &tls.Config{
			RootCAs: r.pool, MinVersion: tls.VersionTLS13,
			GetClientCertificate: func(*tls.CertificateRequestInfo) (*tls.Certificate, error) { return &cert, nil },
		}}}
		for _, rt := range [][2]string{{"GET", "/v1/health"}, {"GET", "/v1/info"}, {"POST", "/v1/enroll"}} {
			if status, body, err := r.do(forced, rt[0], rt[1], `{"code":"x"}`, true); err == nil {
				t.Errorf("enrolment=%v: %s %s with a forced foreign certificate was served: %d %q", withEnrolment, rt[0], rt[1], status, body)
			}
		}

		// A client that offers it only where it is acceptable (Go's default: the server names the authorities it
		// trusts) sends nothing at all, which is the no-certificate case: refused everywhere but at the redemption.
		polite := r.client(foreign)
		status, body, err := r.do(polite, "GET", "/v1/health", "", true)
		if withEnrolment {
			if err != nil || status != 401 || body != gateBody {
				t.Errorf("enrolment=true: health with a foreign certificate: %d %q %v", status, body, err)
			}
		} else if err == nil {
			t.Errorf("enrolment=false: health with a foreign certificate was served: %d %q", status, body)
		}
	}
}

func TestAServerCertificateCannotBeUsedAsAClientCertificate(t *testing.T) {
	r := newTLSRig(t, true)
	leaf, err := r.ca.IssueServer([]string{"127.0.0.1"}, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if status, body, err := r.do(r.client(&leaf), "GET", "/v1/health", "", true); err == nil {
		t.Errorf("a serverAuth-only certificate was accepted as a client certificate: %d %q", status, body)
	}
}

func TestWithoutEnrolmentTheHandshakeItselfNeedsTheCertificate(t *testing.T) {
	r := newTLSRig(t, false)
	c := r.client(nil)
	for _, m := range allMethods {
		if status, body, err := r.do(c, m, "/v1/enroll", `{"code":"x"}`, false); err == nil {
			t.Errorf("%s without a certificate got an answer with enrolment off: %d %q", m, status, body)
		}
	}
	// With a certificate, the route does not exist as far as enrolment goes.
	status, body, err := r.do(r.client(r.leaf(r.ca)), "POST", "/v1/enroll", `{"code":"x"}`, false)
	if err != nil || status != http.StatusNotFound || !strings.Contains(body, "enrolment is not enabled") {
		t.Errorf("enrolment off: %d %q %v", status, body, err)
	}
}

func TestRedeemingOverRealTLSThenUsingTheIssuedCertificate(t *testing.T) {
	r := newTLSRig(t, true)
	leaf := r.leaf(r.ca) // what the CLI pre-issues
	code, _ := enroll.NewCode()
	p := enroll.NewPending(code, time.Now(), time.Minute, leaf.CertPEM, leaf.KeyPEM)
	b, _ := json.Marshal(p)
	if err := os.WriteFile(enroll.PendingFile(r.rig.dir, p.Hash), b, 0o640); err != nil {
		t.Fatal(err)
	}

	status, body, err := r.do(r.client(nil), "POST", "/v1/enroll", redeemBody(code), false)
	if err != nil || status != 200 {
		t.Fatalf("redeem: %d %v %s", status, err, body)
	}
	var creds enroll.Credentials
	if err := json.Unmarshal([]byte(body), &creds); err != nil {
		t.Fatal(err)
	}
	// What came back is enough to talk to the agent.
	issued := install.Leaf{CertPEM: []byte(creds.ClientCertPEM), KeyPEM: []byte(creds.ClientKeyPEM)}
	c := r.client(&issued)
	req, _ := http.NewRequest("GET", r.srv.URL+"/v1/info", nil)
	req.Header.Set("Authorization", "Bearer "+creds.Token)
	resp, err := c.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Errorf("the issued credentials do not work: %d", resp.StatusCode)
	}
	if status, _, _ := r.do(r.client(nil), "POST", "/v1/enroll", redeemBody(code), false); status != 403 {
		t.Errorf("the second redemption: %d", status)
	}
}

func TestServerTLSConfig(t *testing.T) {
	ca, _, _ := install.NewCA("x", time.Now())
	off, err := ServerTLSConfig(ca.PEM, false)
	if err != nil || off.ClientAuth != tls.RequireAndVerifyClientCert || off.MinVersion != tls.VersionTLS13 || off.ClientCAs == nil {
		t.Errorf("without enrolment: %+v %v", off, err)
	}
	on, err := ServerTLSConfig(ca.PEM, true)
	if err != nil || on.ClientAuth != tls.VerifyClientCertIfGiven || on.MinVersion != tls.VersionTLS13 {
		t.Errorf("with enrolment: %+v %v", on, err)
	}
	if _, err := ServerTLSConfig([]byte("not pem"), true); err == nil {
		t.Error("a CA file without a certificate must be refused")
	}
}
