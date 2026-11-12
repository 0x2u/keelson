package api

import (
	"bytes"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/0x2u/keelson/agent/internal/appenv"
	"github.com/0x2u/keelson/agent/internal/config"
	"github.com/0x2u/keelson/agent/internal/store"
)

const (
	envSecret  = "pa55-w0rd-Zq81-managed"
	envSecret2 = "Other-Secret-7731-xyz"
)

type lockedBuffer struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (l *lockedBuffer) Write(p []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.b.Write(p)
}
func (l *lockedBuffer) String() string { l.mu.Lock(); defer l.mu.Unlock(); return l.b.String() }

type envEnv struct {
	*configEnv
	svc  *appenv.Service
	logs *lockedBuffer
	dir  string
}

func newEnvEnv(t *testing.T) *envEnv {
	t.Helper()
	st, err := store.Open(filepath.Join(t.TempDir(), "a.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	dir := t.TempDir()
	envFile := filepath.Join(dir, "web.env")
	if err := os.WriteFile(envFile, []byte("DATABASE_URL=postgres://production\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	cfg, issues := config.Parse([]byte("apps:\n  - {name: web, image: o/web, env_file: " + envFile + ", env: {FROM_ENV: x}}\n  - {name: plain, image: o/plain}\n"))
	if cfg == nil {
		t.Fatal(issues)
	}
	vars, err := appenv.Open(filepath.Join(dir, "env"))
	if err != nil {
		t.Fatal(err)
	}
	svc := &appenv.Service{Store: vars, Config: func() *config.Config { return cfg }}
	logs := &lockedBuffer{}
	h, err := New(&fakeDocker{}, Options{
		Token: testToken, Logger: slog.New(slog.NewTextHandler(logs, &slog.HandlerOptions{Level: slog.LevelDebug})),
		Deploy: &DeployOptions{Deployments: &fakeDeployments{}, Secret: testSecret, Replays: st, Config: &fakeConfig{}, Audit: st, Env: svc},
	})
	if err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(h)
	t.Cleanup(srv.Close)
	return &envEnv{configEnv: &configEnv{srv: srv, st: st}, svc: svc, logs: logs, dir: dir}
}

func decodeMap(t *testing.T, body string) map[string]any {
	t.Helper()
	var m map[string]any
	if err := json.Unmarshal([]byte(body), &m); err != nil {
		t.Fatalf("%v in %q", err, body)
	}
	return m
}

func (e *envEnv) get(t *testing.T, path string) (int, string) {
	t.Helper()
	resp := do(t, "GET", e.srv.URL+path, testToken)
	b, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, string(b)
}

func TestEnvListHasTheContractShapeAndNoValue(t *testing.T) {
	e := newEnvEnv(t)
	status, body := e.get(t, "/v1/apps/web/env")
	if status != 200 || strings.TrimSpace(body) != `{"scope":"app","vars":[],"last_changed":null}` {
		t.Fatalf("%d %s", status, body)
	}
	resp, body := e.signed(t, "PUT", "/v1/apps/web/env", `{"scope":"app","set":{"DATABASE_URL":"`+envSecret+`","NEW":"`+envSecret2+`"},"build":["NEW"]}`, "dashboard")
	if resp.StatusCode != 200 {
		t.Fatalf("%d %s", resp.StatusCode, body)
	}
	status, body = e.get(t, "/v1/apps/web/env?scope=app")
	if status != 200 {
		t.Fatal(status, body)
	}
	if strings.Contains(body, envSecret) || strings.Contains(body, envSecret2) {
		t.Fatalf("the listing carries a value: %s", body)
	}
	out := decodeMap(t, body)
	vars := out["vars"].([]any)
	if out["scope"] != "app" || len(vars) != 2 || out["last_changed"] == nil {
		t.Fatalf("%v", out)
	}
	first, second := vars[0].(map[string]any), vars[1].(map[string]any)
	if first["key"] != "DATABASE_URL" || first["shadows"] != "env_file" || first["build"] != false ||
		second["key"] != "NEW" || second["shadows"] != nil || second["build"] != true {
		t.Errorf("%v %v", first, second)
	}
	if _, err := time.Parse(time.RFC3339, first["updated_at"].(string)); err != nil {
		t.Errorf("updated_at: %v", err)
	}
	// The other scope is empty; a bad scope is a 400, not an empty list.
	if _, body := e.get(t, "/v1/apps/web/env?scope=preview"); !strings.Contains(body, `"scope":"preview","vars":[]`) {
		t.Errorf("%s", body)
	}
	if status, body := e.get(t, "/v1/apps/web/env?scope=prod"); status != 400 || !strings.Contains(body, "scope must be app or preview") {
		t.Errorf("%d %s", status, body)
	}
}

func TestEnvPutAndDeleteAnswersAndAudit(t *testing.T) {
	e := newEnvEnv(t)
	resp, body := e.signed(t, "PUT", "/v1/apps/web/env", `{"set":{"B":"`+envSecret+`","A":"x"},"build":["A"],"unset":["NOPE"]}`, "dashboard")
	if resp.StatusCode != 200 || strings.TrimSpace(body) != `{"scope":"app","changed":["A","B"],"removed":[]}` {
		t.Fatalf("%d %s", resp.StatusCode, body)
	}
	_, body = e.signed(t, "PUT", "/v1/apps/web/env", `{"unset":["A","B"]}`, "dashboard")
	if strings.TrimSpace(body) != `{"scope":"app","changed":[],"removed":["A","B"]}` {
		t.Errorf("%s", body)
	}
	_, _ = e.signed(t, "PUT", "/v1/apps/web/env", `{"scope":"preview","set":{"P":"`+envSecret2+`"}}`, "dashboard")
	resp, body = e.signed(t, "DELETE", "/v1/apps/web/env?scope=preview", ``, "dashboard")
	if resp.StatusCode != 200 || strings.TrimSpace(body) != `{"removed":["P"],"scope":"preview"}` {
		t.Fatalf("%d %s", resp.StatusCode, body)
	}
	if _, body := e.get(t, "/v1/apps/web/env?scope=preview"); !strings.Contains(body, `"vars":[]`) {
		t.Errorf("%s", body)
	}

	log, _ := e.st.Audit(t.Context(), 10, 0) // newest first
	var got []string
	for _, a := range log {
		got = append(got, a.Action+" "+a.Method+" "+a.Path+" "+itoa(a.Status)+" "+a.Actor+" | "+a.Detail)
		if strings.Contains(a.Detail+a.Path, envSecret) || strings.Contains(a.Detail+a.Path, envSecret2) {
			t.Errorf("a value is in the audit log: %+v", a)
		}
	}
	want := []string{
		"env.delete DELETE /v1/apps/web/env 200 dashboard | web scope=preview unset=P",
		"env.set PUT /v1/apps/web/env 200 dashboard | web scope=preview set=P",
		"env.unset PUT /v1/apps/web/env 200 dashboard | web scope=app unset=A,B",
		"env.set PUT /v1/apps/web/env 200 dashboard | web scope=app set=A,B unset=NOPE build=A",
	}
	if strings.Join(got, "\n") != strings.Join(want, "\n") {
		t.Errorf("audit:\n%s\nwant:\n%s", strings.Join(got, "\n"), strings.Join(want, "\n"))
	}
	// Reads are not audited.
	for _, a := range log {
		if a.Method == "GET" {
			t.Errorf("%+v", a)
		}
	}
}

func TestEnvAuditNeverCopiesAKeyThatIsNotAName(t *testing.T) {
	e := newEnvEnv(t)
	// Someone pastes "NAME=value" into the key field.
	resp, body := e.signed(t, "PUT", "/v1/apps/web/env", `{"set":{"DB_PASSWORD=`+envSecret+`":"x","OK":"1"},"unset":["also `+envSecret2+`"]}`, "dashboard")
	if resp.StatusCode != 400 {
		t.Fatalf("%d %s", resp.StatusCode, body)
	}
	log, _ := e.st.Audit(t.Context(), 10, 0)
	if len(log) != 1 || log[0].Status != 400 || log[0].Action != "env.set" {
		t.Fatalf("%+v", log)
	}
	if d := log[0].Detail; strings.Contains(d, envSecret) || strings.Contains(d, envSecret2) || d != "web scope=app set=OK invalid=2" {
		t.Errorf("audit detail: %q", d)
	}
	if strings.Contains(e.logs.String(), envSecret) || strings.Contains(e.logs.String(), envSecret2) {
		t.Errorf("the agent's log has a value:\n%s", e.logs.String())
	}
}

func TestEnvRefusalsListEveryIssueAndWriteNothing(t *testing.T) {
	e := newEnvEnv(t)
	long := strings.Repeat("K", 300)
	resp, body := e.signed(t, "PUT", "/v1/apps/web/env", `{"set":{"PATH":"x","1bad":"y","`+long+`":"z","OK":"1"},"build":["MISSING"]}`, "")
	if resp.StatusCode != 400 {
		t.Fatalf("%d %s", resp.StatusCode, body)
	}
	out := decodeMap(t, body)
	issues := out["issues"].([]any)
	if out["error"] != "invalid" || out["message"] == "" || len(issues) != 4 {
		t.Fatalf("%s", body)
	}
	keys := map[string]bool{}
	for _, i := range issues {
		m := i.(map[string]any)
		if m["message"] == "" {
			t.Errorf("%v", m)
		}
		k := m["key"].(string)
		keys[k] = true
		if len([]rune(k)) > 65 {
			t.Errorf("a key the sender made up is echoed whole (%d characters)", len(k))
		}
	}
	if !keys["PATH"] || !keys["1bad"] || !keys["MISSING"] || len(keys) != 4 {
		t.Errorf("%v", keys)
	}
	if _, body := e.get(t, "/v1/apps/web/env"); !strings.Contains(body, `"vars":[]`) {
		t.Errorf("nothing may be written: %s", body)
	}

	for name, req := range map[string]string{
		"unknown field": `{"set":{"A":"1"},"extra":1}`, "not json": `{`, "wrong type": `{"set":{"A":1}}`, "list": `[]`, "build string": `{"build":"A"}`,
	} {
		resp, body := e.signed(t, "PUT", "/v1/apps/web/env", req, "")
		if resp.StatusCode != 400 || !strings.Contains(body, "invalid request body") {
			t.Errorf("%s: %d %s", name, resp.StatusCode, body)
		}
	}
	if resp, body := e.signed(t, "PUT", "/v1/apps/web/env", `{"scope":"nope","set":{"A":"1"}}`, ""); resp.StatusCode != 400 || !strings.Contains(body, "scope must be app or preview") {
		t.Errorf("%d %s", resp.StatusCode, body)
	}
	if resp, _ := e.signed(t, "DELETE", "/v1/apps/web/env?scope=nope", ``, ""); resp.StatusCode != 400 {
		t.Errorf("%d", resp.StatusCode)
	}
}

func TestEnvUnknownAppsAre404AndOrphanedVariablesAreReportedAndRemovable(t *testing.T) {
	e := newEnvEnv(t)
	for _, path := range []string{"/v1/apps/nope/env", "/v1/apps/UPPER/env", "/v1/apps/..%2Fx/env", "/v1/apps/a.b/env"} {
		if status, body := e.get(t, path); status != 404 || strings.Contains(body, "orphan") {
			t.Errorf("GET %s: %d %s", path, status, body)
		}
		if resp, _ := e.signed(t, "PUT", path, `{"set":{"A":"1"}}`, ""); resp.StatusCode != 404 {
			t.Errorf("PUT %s: %d", path, resp.StatusCode)
		}
		if resp, _ := e.signed(t, "DELETE", path, ``, ""); resp.StatusCode != 404 {
			t.Errorf("DELETE %s: %d", path, resp.StatusCode)
		}
	}
	if resp, _ := e.signed(t, "PUT", "/v1/apps/ghost/env", `{"set":{"A":"1"}}`, ""); resp.StatusCode != 404 {
		t.Errorf("a change for an app that is not in the file: %d", resp.StatusCode)
	}
	if entries, _ := os.ReadDir(e.svc.Store.Dir()); len(entries) != 0 {
		t.Errorf("nothing may be created for an unknown app: %v", entries)
	}

	// An app that left the apps file but kept its variables.
	if err := e.svc.Store.Update("ghost", appenv.ScopeApp, time.Now(), func(sc *appenv.Scope) (bool, error) {
		sc.Entries["SECRET"] = appenv.Entry{Value: envSecret}
		return true, nil
	}); err != nil {
		t.Fatal(err)
	}
	status, body := e.get(t, "/v1/apps/ghost/env")
	if status != 404 || strings.TrimSpace(body) != `{"error":"not found","orphan_scopes":["app"]}` {
		t.Errorf("%d %s", status, body)
	}
	resp, body := e.signed(t, "DELETE", "/v1/apps/ghost/env", ``, "dashboard")
	if resp.StatusCode != 200 || !strings.Contains(body, `"removed":["SECRET"]`) {
		t.Errorf("%d %s", resp.StatusCode, body)
	}
	if status, body := e.get(t, "/v1/apps/ghost/env"); status != 404 || strings.Contains(body, "orphan") {
		t.Errorf("%d %s", status, body)
	}
	log, _ := e.st.Audit(t.Context(), 1, 0)
	if len(log) != 1 || log[0].Action != "env.delete" || log[0].Detail != "ghost scope=app unset=SECRET" {
		t.Errorf("%+v", log)
	}
}

func TestEnvReadsNeedTheTokenAndChangesNeedASignature(t *testing.T) {
	e := newEnvEnv(t)
	if got := do(t, "GET", e.srv.URL+"/v1/apps/web/env", "").StatusCode; got != 401 {
		t.Errorf("no token: %d", got)
	}
	if got := do(t, "GET", e.srv.URL+"/v1/apps/web/env", testSecret).StatusCode; got != 401 {
		t.Errorf("the deploy secret does not read: %d", got)
	}
	for _, method := range []string{"PUT", "DELETE"} {
		for name, setup := range map[string]func(*http.Request){
			"no credentials": func(*http.Request) {},
			"read token":     func(r *http.Request) { r.Header.Set("Authorization", "Bearer "+testToken) },
			"bad signature": func(r *http.Request) {
				ts := time.Now().Unix()
				r.Header.Set(HeaderTimestamp, itoa(int(ts)))
				r.Header.Set(HeaderSignature, Sign(testToken, ts, method, r.URL.RequestURI(), []byte(`{"set":{"A":"1"}}`)))
			},
		} {
			req, _ := http.NewRequest(method, e.srv.URL+"/v1/apps/web/env", strings.NewReader(`{"set":{"A":"1"}}`))
			setup(req)
			resp, err := http.DefaultClient.Do(req)
			if err != nil {
				t.Fatal(err)
			}
			resp.Body.Close()
			if resp.StatusCode != 401 {
				t.Errorf("%s %s: %d", method, name, resp.StatusCode)
			}
		}
	}
	if _, body := e.get(t, "/v1/apps/web/env"); !strings.Contains(body, `"vars":[]`) {
		t.Errorf("an unauthenticated change was applied: %s", body)
	}
	// A query is signed too: another scope than the one signed is a bad signature.
	ts := time.Now().Unix()
	req, _ := http.NewRequest("DELETE", e.srv.URL+"/v1/apps/web/env?scope=preview", nil)
	req.Header.Set(HeaderTimestamp, itoa(int(ts)))
	req.Header.Set(HeaderSignature, Sign(testSecret, ts, "DELETE", "/v1/apps/web/env?scope=app", nil))
	if resp, _ := http.DefaultClient.Do(req); resp.StatusCode != 401 {
		t.Errorf("%d", resp.StatusCode)
	}
}

func TestEnvBodyLimitIsLargerThanOtherSignedRoutes(t *testing.T) {
	e := newEnvEnv(t)
	// 8 values of just under 32 KiB: 256 KiB, far above the 64 KiB every other signed request is held to.
	set := map[string]string{}
	for i := 0; i < 8; i++ {
		set["BIG"+itoa(i)] = strings.Repeat("x", appenv.MaxValueBytes-8)
	}
	b, _ := json.Marshal(map[string]any{"set": set})
	if len(b) < 200<<10 {
		t.Fatal(len(b))
	}
	if resp, body := e.signed(t, "PUT", "/v1/apps/web/env", string(b), ""); resp.StatusCode != 200 {
		t.Fatalf("%d %.200s", resp.StatusCode, body)
	}
	// ... and the cap is still a cap.
	huge := `{"set":{"A":"` + strings.Repeat("y", 3<<20) + `"}}`
	if resp, _ := e.signed(t, "PUT", "/v1/apps/web/env", huge, ""); resp.StatusCode != http.StatusRequestEntityTooLarge {
		t.Errorf("%d", resp.StatusCode)
	}
	// Another signed route keeps its 64 KiB.
	if resp, _ := e.signed(t, "POST", "/v1/apps/web/deploy", `{"tag":"`+strings.Repeat("a", 100<<10)+`"}`, ""); resp.StatusCode != http.StatusRequestEntityTooLarge {
		t.Errorf("%d", resp.StatusCode)
	}
	for name, ok := range map[string]bool{"/v1/apps/web/env": true, "/v1/apps/web/deploy": false, "/v1/apps//env": false, "/v1/apps/a/b/env": false, "/v1/apps/web/envx": false} {
		r := httptest.NewRequest("PUT", name, nil)
		if isEnvChange(r) != ok {
			t.Errorf("isEnvChange(%s) = %v", name, !ok)
		}
	}
}

func TestEnvRoutesAreAbsentWithoutAStore(t *testing.T) {
	e, _ := newPreviewsEnv(t)
	if status := do(t, "GET", e.srv.URL+"/v1/apps/web/env", testToken).StatusCode; status != 404 {
		t.Errorf("%d", status)
	}
	if resp, _ := e.signed(t, "PUT", "/v1/apps/web/env", `{}`, ""); resp.StatusCode != 404 {
		t.Errorf("%d", resp.StatusCode)
	}
}

// What the agent logs about requests (path, status) never includes a body: a value sent and refused, or accepted, is
// in no log line.
func TestEnvValuesAreInNoLogLineWhateverTheOutcome(t *testing.T) {
	e := newEnvEnv(t)
	e.signed(t, "PUT", "/v1/apps/web/env", `{"set":{"OK":"`+envSecret+`"}}`, "")
	e.signed(t, "PUT", "/v1/apps/web/env", `{"set":{"PATH":"`+envSecret+`"}}`, "")
	e.signed(t, "PUT", "/v1/apps/nope/env", `{"set":{"OK":"`+envSecret+`"}}`, "")
	e.signed(t, "PUT", "/v1/apps/web/env", `{"set":{"OK":"`+envSecret+`"`, "")
	e.get(t, "/v1/apps/web/env")
	if strings.Contains(e.logs.String(), envSecret) {
		t.Errorf("a value is in the log:\n%s", e.logs.String())
	}
	if !strings.Contains(e.logs.String(), "/v1/apps/web/env") {
		t.Error("the requests are logged")
	}
	all, _ := e.st.Audit(t.Context(), 50, 0)
	for _, a := range all {
		if strings.Contains(a.Detail+a.Path+a.Actor, envSecret) {
			t.Errorf("%+v", a)
		}
	}
}

func TestEveryEnvRouteIsAmongTheOnesTheGateTestCovers(t *testing.T) {
	seen := map[string]bool{}
	for _, p := range everyRoute(t) {
		seen[p] = true
	}
	if !seen["/v1/apps/x/env"] {
		t.Errorf("the gate tests read the routes from the source: /v1/apps/{app}/env is missing from %v", seen)
	}
}
