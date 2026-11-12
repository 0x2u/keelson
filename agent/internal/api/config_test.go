package api

import (
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/0x2u/keelson/agent/internal/config"
	"github.com/0x2u/keelson/agent/internal/confmgr"
	"github.com/0x2u/keelson/agent/internal/store"
)

type fakeConfig struct {
	err      error
	saved    []string
	meta     confmgr.Meta
	force    bool
	baseHash string
	editedBy string
}

func (f *fakeConfig) Document() (confmgr.Document, error) {
	return confmgr.Document{Content: "apps: []\n", Hash: "h1", ModifiedAt: time.Unix(1700000000, 0).UTC(), AppliedHash: "h1", Model: map[string]any{}}, f.err
}

func (f *fakeConfig) Validate(content []byte) ([]config.Issue, error) {
	if strings.Contains(string(content), "bad") {
		return []config.Issue{{Severity: "error", Path: "apps[x]", Line: 2, Message: "nope"}}, nil
	}
	return []config.Issue{{Severity: "warning", Path: "apps[y]", Code: "app_removed", Message: "gone"}}, nil
}

func (f *fakeConfig) Save(content []byte, baseHash string, force bool, meta confmgr.Meta) (confmgr.Outcome, error) {
	f.saved, f.baseHash, f.force, f.meta = append(f.saved, string(content)), baseHash, force, meta
	return confmgr.Outcome{Hash: "newhash", Version: 7}, f.err
}

func (f *fakeConfig) Edit(baseHash string, force bool, meta confmgr.Meta, edit func([]byte) ([]byte, []config.Issue, error)) (confmgr.Outcome, error) {
	f.baseHash, f.force, f.meta = baseHash, force, meta
	out, _, err := edit([]byte("apps:\n  - {name: shop, image: o/shop}\n"))
	if err != nil {
		// The real manager reports a failing edit as an invalid document.
		return confmgr.Outcome{}, &confmgr.InvalidError{Issues: []config.Issue{{Severity: "error", Path: "yaml", Message: err.Error()}}}
	}
	f.editedBy = string(out)
	return confmgr.Outcome{Hash: "edited"}, f.err
}

func (f *fakeConfig) RestoreVersion(id int64, baseHash string, force bool, actor string) (confmgr.Outcome, error) {
	f.baseHash, f.force = baseHash, force
	return confmgr.Outcome{Hash: "restored", Version: id + 1}, f.err
}

func (f *fakeConfig) Versions(limit int) ([]store.ConfigVersion, error) { return nil, f.err }

func (f *fakeConfig) Version(id int64) (store.ConfigVersion, string, error) {
	if id == 404 {
		return store.ConfigVersion{}, "", store.ErrNotFound
	}
	return store.ConfigVersion{ID: id, Hash: "vh", Source: "api"}, "apps: []\n", nil
}

type configEnv struct {
	srv *httptest.Server
	st  *store.Store
	cfg *fakeConfig
}

func newConfigEnv(t *testing.T) *configEnv {
	t.Helper()
	st, err := store.Open(filepath.Join(t.TempDir(), "a.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	fc := &fakeConfig{}
	h, err := New(&fakeDocker{}, Options{
		Token: testToken, Logger: slog.New(slog.NewTextHandler(io.Discard, nil)),
		Deploy: &DeployOptions{Deployments: &fakeDeployments{}, Secret: testSecret, Replays: st, Config: fc, Audit: st},
	})
	if err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(h)
	t.Cleanup(srv.Close)
	return &configEnv{srv: srv, st: st, cfg: fc}
}

var nonce int

// signed sends a request signed with the deploy secret. Each call gets its own timestamp, so no signature repeats.
func (e *configEnv) signed(t *testing.T, method, path, body, actor string) (*http.Response, string) {
	t.Helper()
	nonce++
	ts := time.Now().Add(time.Duration(nonce) * time.Second).Unix() // a different second each time: no signature repeats
	req, _ := http.NewRequest(method, e.srv.URL+path, strings.NewReader(body))
	req.Header.Set(HeaderTimestamp, strconv.FormatInt(ts, 10))
	req.Header.Set(HeaderSignature, Sign(testSecret, ts, method, path, []byte(body)))
	if actor != "" {
		req.Header.Set(HeaderActor, actor)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	b, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	return resp, string(b)
}

func TestEveryChangingConfigRouteNeedsASignatureNotTheReadToken(t *testing.T) {
	e := newConfigEnv(t)
	for _, c := range []struct{ method, path string }{
		{"PUT", "/v1/config"}, {"POST", "/v1/config/validate"}, {"PUT", "/v1/config/apps/web"}, {"DELETE", "/v1/config/apps/web"},
		{"PUT", "/v1/config/jobs/j"}, {"DELETE", "/v1/config/jobs/j"}, {"PUT", "/v1/config/notifications"}, {"POST", "/v1/config/versions/1/restore"},
	} {
		req, _ := http.NewRequest(c.method, e.srv.URL+c.path, strings.NewReader("{}"))
		req.Header.Set("Authorization", "Bearer "+testToken)
		resp, _ := http.DefaultClient.Do(req)
		resp.Body.Close()
		if resp.StatusCode != 401 {
			t.Errorf("%s %s with only the read token: %d", c.method, c.path, resp.StatusCode)
		}
	}
	if len(e.cfg.saved) != 0 {
		t.Error("nothing may reach the manager")
	}
	for _, path := range []string{"/v1/config", "/v1/config/versions", "/v1/config/versions/3", "/v1/audit"} {
		if got := do(t, "GET", e.srv.URL+path, "").StatusCode; got != 401 {
			t.Errorf("GET %s without a token: %d", path, got)
		}
		if got := do(t, "GET", e.srv.URL+path, testToken).StatusCode; got != 200 {
			t.Errorf("GET %s with the read token: %d", path, got)
		}
	}
}

func TestGetConfigShape(t *testing.T) {
	e := newConfigEnv(t)
	var got map[string]any
	json.NewDecoder(do(t, "GET", e.srv.URL+"/v1/config", testToken).Body).Decode(&got)
	if got["content"] != "apps: []\n" || got["hash"] != "h1" || got["applied_hash"] != "h1" || got["modified_at"] != "2023-11-14T22:13:20Z" || got["model"] == nil {
		t.Errorf("%+v", got)
	}
	if _, ok := got["error"]; ok {
		t.Error("no error key when the file is fine")
	}
}

func TestValidateAnswersWithIssuesAndOkFlag(t *testing.T) {
	e := newConfigEnv(t)
	for _, c := range []struct {
		content string
		ok      bool
	}{{"bad", false}, {"fine", true}} {
		resp, body := e.signed(t, "POST", "/v1/config/validate", `{"content":"`+c.content+`"}`, "dashboard")
		var out struct {
			OK     bool           `json:"ok"`
			Issues []config.Issue `json:"issues"`
		}
		json.Unmarshal([]byte(body), &out)
		if resp.StatusCode != 200 || out.OK != c.ok || len(out.Issues) != 1 {
			t.Errorf("%s: %d %+v", c.content, resp.StatusCode, out)
		}
	}
}

func TestPutConfigPassesItsRequestAndIsAudited(t *testing.T) {
	e := newConfigEnv(t)
	resp, body := e.signed(t, "PUT", "/v1/config", `{"content":"apps: []","base_hash":"h1","comment":"bump","force":true}`, "dashboard")
	if resp.StatusCode != 200 || !strings.Contains(body, `"hash":"newhash"`) || !strings.Contains(body, `"version":7`) || !strings.Contains(body, `"issues":[]`) {
		t.Fatalf("%d %s", resp.StatusCode, body)
	}
	if e.cfg.baseHash != "h1" || !e.cfg.force || e.cfg.meta.Comment != "bump" || e.cfg.meta.Actor != "dashboard" || e.cfg.meta.Source != store.SourceAPI {
		t.Errorf("request not passed through: %+v", e.cfg)
	}
	log, _ := e.st.Audit(t.Context(), 10, 0)
	if len(log) != 1 || log[0].Action != "config.update" || log[0].Status != 200 || log[0].Actor != "dashboard" || log[0].Detail != "hash newhash" || log[0].IP == "" {
		t.Errorf("audit: %+v", log)
	}
}

func TestConfigRefusalsMapToStatusAndBody(t *testing.T) {
	e := newConfigEnv(t)
	cases := []struct {
		err    error
		status int
		want   string
	}{
		{&confmgr.InvalidError{Issues: []config.Issue{{Severity: "error", Path: "apps[a]", Message: "bad"}}}, 400, `"error":"invalid"`},
		{&confmgr.ConflictError{Hash: "cur"}, 409, `"error":"changed","hash":"cur"`},
		{&confmgr.NeedsAckError{Issues: []config.Issue{{Code: "app_removed", Message: "x"}}}, 409, `"error":"needs_acknowledgement"`},
		{&confmgr.BusyError{Reason: "deploying"}, 409, `"error":"busy","message":"deploying"`},
		{errors.New("disk exploded"), 500, `"error":"internal error"`},
	}
	for i, c := range cases {
		e.cfg.err = c.err
		resp, body := e.signed(t, "PUT", "/v1/config", `{"content":"x","base_hash":"h"}`, "")
		time.Sleep(time.Millisecond)
		if resp.StatusCode != c.status || !strings.Contains(body, c.want) {
			t.Errorf("case %d: %d %s", i, resp.StatusCode, body)
		}
		if strings.Contains(body, "disk exploded") {
			t.Error("internal errors must not leak their text")
		}
	}
	log, _ := e.st.Audit(t.Context(), 10, 0)
	if len(log) != len(cases) || log[0].Status != 500 {
		t.Errorf("refused changes are audited with their status: %+v", log)
	}
}

func TestEntityRoutesEditTheDocumentThroughTheManager(t *testing.T) {
	e := newConfigEnv(t)
	resp, body := e.signed(t, "PUT", "/v1/config/apps/web", `{"app":{"name":"web","image":"ghcr.io/me/web","port":3000.0},"base_hash":"h1"}`, "dashboard")
	if resp.StatusCode != 200 || !strings.Contains(e.cfg.editedBy, "name: web") || !strings.Contains(e.cfg.editedBy, "port: 3000") {
		t.Fatalf("%d %s\n%s", resp.StatusCode, body, e.cfg.editedBy)
	}
	if resp, _ := e.signed(t, "PUT", "/v1/config/apps/web", `{"app":{"name":"other","image":"x"},"base_hash":"h1"}`, ""); resp.StatusCode != 400 {
		t.Errorf("a body name different from the URL's must be refused, got %d", resp.StatusCode)
	}
	if resp, _ := e.signed(t, "PUT", "/v1/config/apps/web", `{"base_hash":"h1"}`, ""); resp.StatusCode != 400 {
		t.Errorf("a missing app object is a bad request, got %d", resp.StatusCode)
	}
	if resp, _ := e.signed(t, "PUT", "/v1/config/jobs/j", `{"job":{"name":"j","schedule":"@daily","run":["x"]},"base_hash":"h1","unknown":1}`, ""); resp.StatusCode != 400 {
		t.Errorf("unknown fields are refused, got %d", resp.StatusCode)
	}
	if resp, _ := e.signed(t, "PUT", "/v1/config/notifications", `{"notifications":null,"base_hash":"h1"}`, ""); resp.StatusCode != 200 {
		t.Errorf("null removes the section: %d", resp.StatusCode)
	}
}

func TestVersionRoutes(t *testing.T) {
	e := newConfigEnv(t)
	var versions []store.ConfigVersion
	json.NewDecoder(do(t, "GET", e.srv.URL+"/v1/config/versions", testToken).Body).Decode(&versions)
	if versions == nil {
		t.Error("no versions must serialize as [], not null")
	}
	if got := do(t, "GET", e.srv.URL+"/v1/config/versions?limit=0", testToken).StatusCode; got != 400 {
		t.Errorf("bad limit: %d", got)
	}
	var v map[string]any
	json.NewDecoder(do(t, "GET", e.srv.URL+"/v1/config/versions/3", testToken).Body).Decode(&v)
	if v["id"] != float64(3) || v["content"] != "apps: []\n" {
		t.Errorf("%+v", v)
	}
	for _, p := range []string{"/v1/config/versions/404", "/v1/config/versions/abc"} {
		if got := do(t, "GET", e.srv.URL+p, testToken).StatusCode; got != 404 {
			t.Errorf("%s: %d", p, got)
		}
	}
	resp, body := e.signed(t, "POST", "/v1/config/versions/3/restore", `{"base_hash":"h1","force":true}`, "dashboard")
	if resp.StatusCode != 200 || !strings.Contains(body, `"version":4`) {
		t.Errorf("%d %s", resp.StatusCode, body)
	}
}

func TestAuditRecordsAuthenticatedRequestsOnlyAndPages(t *testing.T) {
	e := newConfigEnv(t)
	// Neither a rejected signature nor a validation is recorded.
	req, _ := http.NewRequest("PUT", e.srv.URL+"/v1/config", strings.NewReader(`{}`))
	req.Header.Set(HeaderTimestamp, strconv.FormatInt(time.Now().Unix(), 10))
	req.Header.Set(HeaderSignature, strings.Repeat("0", 64))
	resp, _ := http.DefaultClient.Do(req)
	resp.Body.Close()
	e.signed(t, "POST", "/v1/config/validate", `{"content":"x"}`, "")
	if log, _ := e.st.Audit(t.Context(), 10, 0); len(log) != 0 {
		t.Fatalf("nothing to record yet: %+v", log)
	}

	for i := range 3 {
		e.signed(t, "PUT", "/v1/config/jobs/j", `{"job":{"name":"j","schedule":"@daily","run":["x"]},"base_hash":"`+strconv.Itoa(i)+`"}`, "  dashboard  ")
	}
	var entries []store.AuditEntry
	json.NewDecoder(do(t, "GET", e.srv.URL+"/v1/audit?limit=2", testToken).Body).Decode(&entries)
	if len(entries) != 2 || entries[0].Action != "job.save" || entries[0].Actor != "dashboard" || entries[0].Detail != "hash edited" {
		t.Fatalf("%+v", entries)
	}
	var older []store.AuditEntry
	json.NewDecoder(do(t, "GET", e.srv.URL+"/v1/audit?before="+strconv.FormatInt(entries[1].ID, 10), testToken).Body).Decode(&older)
	if len(older) != 1 || older[0].ID >= entries[1].ID {
		t.Errorf("paging with before: %+v", older)
	}
	for _, q := range []string{"limit=0", "limit=201", "before=x", "before=0"} {
		if got := do(t, "GET", e.srv.URL+"/v1/audit?"+q, testToken).StatusCode; got != 400 {
			t.Errorf("%s: %d", q, got)
		}
	}
}
