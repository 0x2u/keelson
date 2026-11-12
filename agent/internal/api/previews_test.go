package api

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/0x2u/keelson/agent/internal/deploy"
	"github.com/0x2u/keelson/agent/internal/store"
)

type fakePreviews struct {
	err     error
	started []string // "app:pr:tag"
	removed []string // "app:pr"
	evicted []string
	builds  []buildCall
}

func (f *fakePreviews) Previews(context.Context) ([]deploy.PreviewStatus, error) {
	if f.err != nil {
		return nil, f.err
	}
	return []deploy.PreviewStatus{{
		Name: "shop-pr-12", App: "shop", PR: 12, Domain: "pr-12-shop.example.com", URL: "https://pr-12-shop.example.com",
		Ref: "ghcr.io/o/shop:abc", Status: deploy.PreviewRunning, DeploymentID: "d1",
		CreatedAt: time.Unix(1700000000, 0).UTC(), UpdatedAt: time.Unix(1700000100, 0).UTC(), ExpiresAt: time.Unix(1700600000, 0).UTC(),
	}}, nil
}

func (f *fakePreviews) StartPreview(_ context.Context, app string, pr int, t deploy.Target) (deploy.PreviewStarted, <-chan struct{}, error) {
	if f.err != nil {
		return deploy.PreviewStarted{}, nil, f.err
	}
	f.started = append(f.started, app+":"+itoa(pr)+":"+t.Tag+t.Digest)
	return deploy.PreviewStarted{DeploymentID: "d2", Name: app + "-pr-" + itoa(pr), URL: "https://pr-" + itoa(pr) + "-shop.example.com", Evicted: f.evicted}, nil, nil
}

func (f *fakePreviews) RemovePreview(_ context.Context, app string, pr int) error {
	if f.err != nil {
		return f.err
	}
	f.removed = append(f.removed, app+":"+itoa(pr))
	return nil
}

func itoa(n int) string { b, _ := json.Marshal(n); return string(b) }

func newPreviewsEnv(t *testing.T) (*configEnv, *fakePreviews) {
	t.Helper()
	st, err := store.Open(filepath.Join(t.TempDir(), "a.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	fc, fp := &fakeConfig{}, &fakePreviews{}
	h, err := New(&fakeDocker{}, Options{
		Token: testToken, Logger: slog.New(slog.NewTextHandler(io.Discard, nil)),
		Deploy: &DeployOptions{Deployments: &fakeDeployments{}, Secret: testSecret, Replays: st, Config: fc, Audit: st, Previews: fp},
	})
	if err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(h)
	t.Cleanup(srv.Close)
	return &configEnv{srv: srv, st: st, cfg: fc}, fp
}

func TestPreviewsListNeedsTheReadTokenAndHasTheContractShape(t *testing.T) {
	e, _ := newPreviewsEnv(t)
	if got := do(t, "GET", e.srv.URL+"/v1/previews", "").StatusCode; got != 401 {
		t.Errorf("without a token: %d", got)
	}
	if got := do(t, "GET", e.srv.URL+"/v1/previews", testSecret).StatusCode; got != 401 {
		t.Errorf("the deploy secret does not read: %d", got)
	}
	resp := do(t, "GET", e.srv.URL+"/v1/previews", testToken)
	if resp.StatusCode != 200 {
		t.Fatal(resp.StatusCode)
	}
	var out struct {
		Previews []map[string]any `json:"previews"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil || len(out.Previews) != 1 {
		t.Fatalf("%+v %v", out, err)
	}
	p := out.Previews[0]
	for _, k := range []string{"name", "app", "pr", "domain", "url", "ref", "status", "deployment_id", "created_at", "updated_at", "expires_at"} {
		if _, ok := p[k]; !ok {
			t.Errorf("missing %q in %v", k, p)
		}
	}
	if p["name"] != "shop-pr-12" || p["pr"] != float64(12) || p["status"] != "running" || p["expires_at"] != "2023-11-21T20:53:20Z" {
		t.Errorf("%v", p)
	}
}

func TestPreviewsAreEmptyAsAListNotNull(t *testing.T) {
	// A service may hand back a nil slice: the handler must still send [].
	srv := &server{deploy: &DeployOptions{Previews: &nilPreviews{}}, log: slog.New(slog.NewTextHandler(io.Discard, nil))}
	rec := httptest.NewRecorder()
	srv.listPreviews(rec, httptest.NewRequest("GET", "/v1/previews", nil))
	if strings.TrimSpace(rec.Body.String()) != `{"previews":[]}` {
		t.Errorf("%s", rec.Body.String())
	}
}

type nilPreviews struct{ fakePreviews }

func (*nilPreviews) Previews(context.Context) ([]deploy.PreviewStatus, error) { return nil, nil }

func TestPutPreviewStartsADeploymentAndIsAudited(t *testing.T) {
	e, fp := newPreviewsEnv(t)
	fp.evicted = []string{"shop-pr-3"}
	tag := strings.Repeat("ab", 20)
	resp, body := e.signed(t, "PUT", "/v1/previews/shop/12", `{"tag":"`+tag+`"}`, "dashboard")
	if resp.StatusCode != http.StatusAccepted {
		t.Fatalf("%d %s", resp.StatusCode, body)
	}
	var out map[string]any
	json.Unmarshal([]byte(body), &out)
	if out["deployment_id"] != "d2" || out["name"] != "shop-pr-12" || out["url"] != "https://pr-12-shop.example.com" {
		t.Errorf("%v", out)
	}
	if ev, _ := out["evicted"].([]any); len(ev) != 1 || ev[0] != "shop-pr-3" {
		t.Errorf("evicted: %v", out["evicted"])
	}
	if len(fp.started) != 1 || fp.started[0] != "shop:12:"+tag {
		t.Errorf("%v", fp.started)
	}
	log, _ := e.st.Audit(t.Context(), 10, 0)
	if len(log) != 1 || log[0].Action != "preview.deploy" || log[0].Method != "PUT" || log[0].Actor != "dashboard" || log[0].Status != 202 ||
		log[0].Detail != "shop-pr-12 tag="+tag+" evicted=shop-pr-3" {
		t.Errorf("audit: %+v", log)
	}

	fp.evicted = nil
	_, body = e.signed(t, "PUT", "/v1/previews/shop/13", `{"tag":"`+tag+`"}`, "")
	if !strings.Contains(body, `"evicted":[]`) {
		t.Errorf("evicted is a list, never null: %s", body)
	}
}

func TestDeletePreviewIs204AndAudited(t *testing.T) {
	e, fp := newPreviewsEnv(t)
	resp, body := e.signed(t, "DELETE", "/v1/previews/shop/12", ``, "dashboard")
	if resp.StatusCode != http.StatusNoContent || body != "" {
		t.Fatalf("%d %q", resp.StatusCode, body)
	}
	if len(fp.removed) != 1 || fp.removed[0] != "shop:12" {
		t.Errorf("%v", fp.removed)
	}
	log, _ := e.st.Audit(t.Context(), 10, 0)
	if len(log) != 1 || log[0].Action != "preview.remove" || log[0].Method != "DELETE" || log[0].Detail != "shop-pr-12" || log[0].Status != 204 {
		t.Errorf("audit: %+v", log)
	}
}

func TestPreviewWritesNeedASignatureNotTheReadToken(t *testing.T) {
	e, fp := newPreviewsEnv(t)
	for _, method := range []string{"PUT", "DELETE"} {
		for name, setup := range map[string]func(*http.Request){
			"no credentials": func(*http.Request) {},
			"read token":     func(r *http.Request) { r.Header.Set("Authorization", "Bearer "+testToken) },
			"bad signature": func(r *http.Request) {
				ts := time.Now().Unix()
				r.Header.Set(HeaderTimestamp, itoa(int(ts)))
				r.Header.Set(HeaderSignature, Sign(testToken, ts, method, r.URL.RequestURI(), []byte(`{"tag":"abc"}`)))
			},
		} {
			req, _ := http.NewRequest(method, e.srv.URL+"/v1/previews/shop/12", strings.NewReader(`{"tag":"abc"}`))
			setup(req)
			resp, err := http.DefaultClient.Do(req)
			if err != nil {
				t.Fatal(err)
			}
			resp.Body.Close()
			if resp.StatusCode != http.StatusUnauthorized {
				t.Errorf("%s %s: want 401, got %d", method, name, resp.StatusCode)
			}
		}
	}
	if len(fp.started)+len(fp.removed) != 0 {
		t.Errorf("an unsigned request reached the deployer: %v %v", fp.started, fp.removed)
	}
	if log, _ := e.st.Audit(t.Context(), 10, 0); len(log) != 0 {
		t.Errorf("unauthenticated calls are not audited: %+v", log)
	}
}

func TestPreviewRequestsAreValidatedAndErrorsMapToStatuses(t *testing.T) {
	e, fp := newPreviewsEnv(t)
	tag := `{"tag":"` + strings.Repeat("c", 40) + `"}`

	for _, pr := range []string{"0", "-1", "abc", "1000000", "007", "+5", "1.5"} {
		if resp, _ := e.signed(t, "PUT", "/v1/previews/shop/"+pr, tag, ""); resp.StatusCode != 400 {
			t.Errorf("PUT pr %q: want 400, got %d", pr, resp.StatusCode)
		}
		if resp, _ := e.signed(t, "DELETE", "/v1/previews/shop/"+pr, "", ""); resp.StatusCode != 400 {
			t.Errorf("DELETE pr %q: want 400, got %d", pr, resp.StatusCode)
		}
	}
	for name, body := range map[string]string{
		"extra field": `{"tag":"abc","digest":"sha256:` + strings.Repeat("a", 64) + `"}`,
		"unknown":     `{"tag":"abc","x":1}`,
		"not json":    `tag=abc`,
		"empty":       ``,
	} {
		if resp, _ := e.signed(t, "PUT", "/v1/previews/shop/1", body, ""); resp.StatusCode != 400 {
			t.Errorf("%s: want 400, got %d", name, resp.StatusCode)
		}
	}
	if len(fp.started)+len(fp.removed) != 0 {
		t.Errorf("refused requests reached the service: %v %v", fp.started, fp.removed)
	}

	cases := []struct {
		err    error
		status int
	}{
		{deploy.ErrNoPreview, 404},
		{deploy.ErrInvalidTarget, 400},
		{deploy.ErrInvalidPR, 400},
		{deploy.ErrBusy, 409},
		{deploy.ErrShuttingDown, 503},
		{io.ErrUnexpectedEOF, 500},
	}
	for _, c := range cases {
		fp.err = c.err
		resp, body := e.signed(t, "PUT", "/v1/previews/shop/1", tag, "")
		if resp.StatusCode != c.status {
			t.Errorf("PUT %v: want %d, got %d", c.err, c.status, resp.StatusCode)
		}
		if c.status == 500 && strings.Contains(body, "unexpected EOF") {
			t.Error("internal errors must not leak their text")
		}
		if c.err != deploy.ErrNoPreview && c.err != deploy.ErrInvalidTarget {
			resp, _ = e.signed(t, "DELETE", "/v1/previews/shop/1", "", "")
			if resp.StatusCode != c.status && !(c.err == deploy.ErrInvalidPR && resp.StatusCode == 400) {
				t.Errorf("DELETE %v: want %d, got %d", c.err, c.status, resp.StatusCode)
			}
		}
	}
}

func TestPreviewRoutesAreAbsentWithoutTheService(t *testing.T) {
	e := newConfigEnv(t) // no Previews service
	if got := do(t, "GET", e.srv.URL+"/v1/previews", testToken).StatusCode; got != 404 {
		t.Errorf("want 404, got %d", got)
	}
}

func TestPreviewTemplateRoutesEditTheDocumentAndAreAudited(t *testing.T) {
	e, _ := newPreviewsEnv(t)
	resp, body := e.signed(t, "PUT", "/v1/config/previews/shop", `{"preview":{"app":"shop","domain":"pr-{pr}-shop.example.com","max":3},"base_hash":"h1"}`, "dashboard")
	if resp.StatusCode != 200 || !strings.Contains(e.cfg.editedBy, "name: shop") || !strings.Contains(e.cfg.editedBy, "max: 3") || !strings.Contains(e.cfg.editedBy, "previews:") || strings.Contains(e.cfg.editedBy, "app: shop") {
		t.Fatalf("%d %s\n%s", resp.StatusCode, body, e.cfg.editedBy)
	}
	if resp, _ := e.signed(t, "PUT", "/v1/config/previews/shop", `{"preview":{"app":"other","domain":"x"},"base_hash":"h1"}`, ""); resp.StatusCode != 200 || strings.Contains(e.cfg.editedBy, "other") {
		t.Errorf("the template belongs to the app of the URL, a body app is dropped, got %d", resp.StatusCode)
	}
	if resp, _ := e.signed(t, "PUT", "/v1/config/previews/shop", `{"base_hash":"h1"}`, ""); resp.StatusCode != 400 {
		t.Errorf("a missing preview object is a bad request, got %d", resp.StatusCode)
	}
	// The fake document has no previews section: deleting what is not there is refused as an invalid edit.
	if resp, _ := e.signed(t, "DELETE", "/v1/config/previews/shop", `{"base_hash":"h1"}`, ""); resp.StatusCode != 400 {
		t.Errorf("deleting what is not there: %d", resp.StatusCode)
	}
	log, _ := e.st.Audit(t.Context(), 10, 0)
	if len(log) == 0 || log[len(log)-1].Action != "preview.save" {
		t.Errorf("audit: %+v", log)
	}
	if got := do(t, "PUT", e.srv.URL+"/v1/config/previews/shop", testToken).StatusCode; got != 401 {
		t.Errorf("the read token does not edit: %d", got)
	}
}
