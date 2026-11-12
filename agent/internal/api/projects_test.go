package api

import (
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"github.com/0x2u/keelson/agent/internal/config"
	"github.com/0x2u/keelson/agent/internal/confmgr"
	"github.com/0x2u/keelson/agent/internal/store"
)

const projMain = `apps:
  - name: web
    image: ghcr.io/me/web
jobs:
  - name: backup
    schedule: "@daily"
    host: [/bin/true]
`

const projShop = `# The shop.
apps:
  - name: shop
    image: ghcr.io/me/shop
    env:
      DATABASE_URL: postgres://u:pw@db/shop
jobs:
  - name: shop-job
    schedule: "@daily"
    container: {app: shop, command: [x]}
`

// projEnv serves the configuration routes over a real manager and real files.
type projEnv struct {
	*configEnv
	dir  string
	apps string
	mgr  *confmgr.Manager
}

func newProjEnv(t *testing.T, main string, projects map[string]string) *projEnv {
	t.Helper()
	dir := t.TempDir()
	apps := filepath.Join(dir, "apps.yaml")
	if err := os.WriteFile(apps, []byte(main), 0o640); err != nil {
		t.Fatal(err)
	}
	loc := config.DefaultLocation(apps)
	for n, c := range projects {
		os.MkdirAll(loc.ProjectsDir, 0o700)
		if err := os.WriteFile(loc.ProjectPath(n), []byte(c), 0o640); err != nil {
			t.Fatal(err)
		}
	}
	st, err := store.Open(filepath.Join(dir, "a.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	cfg, err := config.LoadFrom(loc)
	if err != nil {
		t.Fatal(err)
	}
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	mgr, err := confmgr.New(apps, st, cfg, log)
	if err != nil {
		t.Fatal(err)
	}
	h, err := New(&fakeDocker{}, Options{
		Token: testToken, Logger: log,
		Deploy: &DeployOptions{Deployments: &fakeDeployments{}, Secret: testSecret, Replays: st, Config: mgr, Audit: st},
	})
	if err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(h)
	t.Cleanup(srv.Close)
	return &projEnv{configEnv: &configEnv{srv: srv, st: st}, dir: dir, apps: apps, mgr: mgr}
}

func (e *projEnv) get(t *testing.T, path string) map[string]any {
	t.Helper()
	resp := do(t, "GET", e.srv.URL+path, testToken)
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		b, _ := io.ReadAll(resp.Body)
		t.Fatalf("GET %s: %d %s", path, resp.StatusCode, b)
	}
	var out map[string]any
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		t.Fatal(err)
	}
	return out
}

func (e *projEnv) list(t *testing.T) []map[string]any {
	t.Helper()
	resp := do(t, "GET", e.srv.URL+"/v1/projects", testToken)
	defer resp.Body.Close()
	var out []map[string]any
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil || resp.StatusCode != 200 {
		t.Fatalf("%d %v", resp.StatusCode, err)
	}
	return out
}

func (e *projEnv) send(t *testing.T, method, path string, body any) (int, map[string]any) {
	t.Helper()
	raw, _ := json.Marshal(body)
	resp, text := e.signed(t, method, path, string(raw), "dashboard")
	var out map[string]any
	json.Unmarshal([]byte(text), &out)
	return resp.StatusCode, out
}

func (e *projEnv) file(t *testing.T, project string) string {
	t.Helper()
	path := e.apps
	if project != "" {
		path = config.DefaultLocation(e.apps).ProjectPath(project)
	}
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func TestProjectRoutesExistOnlyWhenTheServiceHasProjectFiles(t *testing.T) {
	e := newConfigEnv(t) // a service that only knows the apps file
	for _, path := range []string{"/v1/projects", "/v1/projects/shop/config"} {
		if got := do(t, "GET", e.srv.URL+path, testToken).StatusCode; got != 404 {
			t.Errorf("GET %s: %d", path, got)
		}
	}
	// Its entity routes work as they did, on the apps file.
	resp, body := e.signed(t, "PUT", "/v1/config/apps/web", `{"app":{"name":"web","image":"o/web"}}`, "dashboard")
	if resp.StatusCode != 200 || !strings.Contains(e.cfg.editedBy, "name: web") {
		t.Errorf("%d %s %q", resp.StatusCode, body, e.cfg.editedBy)
	}
}

func TestProjectRoutesAreAuthenticatedLikeTheConfigRoutes(t *testing.T) {
	e := newProjEnv(t, projMain, map[string]string{"shop": projShop})
	for _, c := range []struct{ method, path string }{
		{"PUT", "/v1/projects/shop/config"}, {"DELETE", "/v1/projects/shop/config"}, {"POST", "/v1/projects/shop/split"}, {"POST", "/v1/projects/shop/config/validate"},
	} {
		req, _ := http.NewRequest(c.method, e.srv.URL+c.path, strings.NewReader("{}"))
		req.Header.Set("Authorization", "Bearer "+testToken)
		resp, _ := http.DefaultClient.Do(req)
		resp.Body.Close()
		if resp.StatusCode != 401 {
			t.Errorf("%s %s with only the read token: %d", c.method, c.path, resp.StatusCode)
		}
	}
	for _, path := range []string{"/v1/projects", "/v1/projects/shop/config"} {
		if got := do(t, "GET", e.srv.URL+path, "").StatusCode; got != 401 {
			t.Errorf("GET %s without a token: %d", path, got)
		}
	}
	if e.file(t, "shop") != projShop {
		t.Error("nothing was written")
	}
}

func TestListAndGetProjectsShowFilesHashesCountsAndHideSecrets(t *testing.T) {
	e := newProjEnv(t, projMain, map[string]string{"shop": projShop})
	list := e.list(t)
	if len(list) != 1 {
		t.Fatalf("%+v", list)
	}
	p := list[0]
	if p["name"] != "shop" || p["path"] != "projects.d/shop.yaml" || p["hash"] != config.Hash([]byte(projShop)) || p["applied_hash"] != p["hash"] ||
		p["apps"] != float64(1) || p["jobs"] != float64(1) || p["databases"] != float64(0) || p["previews"] != float64(0) {
		t.Errorf("%+v", p)
	}
	// No project file: an empty list, not null.
	if empty := newProjEnv(t, projMain, nil).list(t); empty == nil || len(empty) != 0 {
		t.Errorf("%#v", empty)
	}

	doc := e.get(t, "/v1/projects/shop/config")
	content, _ := doc["content"].(string)
	if strings.Contains(content, "pw@db") || !strings.Contains(content, config.Hidden) || !strings.Contains(content, "# The shop.") ||
		doc["project"] != "shop" || doc["hash"] != p["hash"] || doc["applied_hash"] != p["hash"] || doc["config_hash"] == nil || doc["model"] == nil || doc["modified_at"] == nil {
		t.Errorf("%+v", doc)
	}
	if _, ok := doc["error"]; ok {
		t.Error("no error key when the file is fine")
	}
	if got := do(t, "GET", e.srv.URL+"/v1/projects/ghost/config", testToken).StatusCode; got != 404 {
		t.Errorf("GET unknown project: %d", got)
	}
}

func TestGetConfigListsTheFilesAndModelsEveryProjectEntity(t *testing.T) {
	e := newProjEnv(t, projMain, map[string]string{"shop": projShop})
	got := e.get(t, "/v1/config")
	files, _ := got["files"].([]any)
	if len(files) != 2 {
		t.Fatalf("%+v", got["files"])
	}
	main, shop := files[0].(map[string]any), files[1].(map[string]any)
	if main["path"] != "apps.yaml" || main["project"] != "" || main["hash"] != config.Hash([]byte(projMain)) ||
		shop["path"] != "projects.d/shop.yaml" || shop["project"] != "shop" || shop["hash"] != config.Hash([]byte(projShop)) {
		t.Errorf("%+v", files)
	}
	if got["content"] != projMain || got["hash"] == main["hash"] || got["hash"] != got["applied_hash"] {
		t.Errorf("the content is the apps file's, the hash is the configuration's: %+v", got)
	}
	model := got["model"].(map[string]any)
	byName := map[string]map[string]any{}
	for _, a := range model["apps"].([]any) {
		m := a.(map[string]any)
		byName[m["name"].(string)] = m
	}
	if byName["shop"]["project"] != "shop" || byName["web"]["project"] != nil {
		t.Errorf("the model carries the project of each entry of a project file: %+v", byName)
	}
	if env := byName["shop"]["env"].(map[string]any); env["DATABASE_URL"] != config.Hidden {
		t.Errorf("secrets are hidden in the model: %+v", env)
	}
	if jobs := model["jobs"].([]any); len(jobs) != 2 || jobs[1].(map[string]any)["project"] != "shop" {
		t.Errorf("%+v", jobs)
	}

	// Without project files the answer has exactly the shape it always had, with the one file.
	plain := newProjEnv(t, projMain, nil).get(t, "/v1/config")
	if f := plain["files"].([]any); len(f) != 1 || plain["hash"] != config.Hash([]byte(projMain)) {
		t.Errorf("%+v", plain)
	}
}

func TestPutProjectCreatesTheFileAndAnswersWithItsHash(t *testing.T) {
	e := newProjEnv(t, projMain, nil)
	status, out := e.send(t, "PUT", "/v1/projects/shop/config", map[string]any{"content": projShop, "comment": "new project"})
	if status != 200 || out["hash"] != config.Hash([]byte(projShop)) || out["config_hash"] == nil || out["version"] == nil || out["issues"] == nil {
		t.Fatalf("%d %+v", status, out)
	}
	if e.file(t, "shop") != projShop {
		t.Error("the file is written")
	}
	if out["config_hash"] != e.get(t, "/v1/config")["hash"] {
		t.Error("config_hash is the configuration's hash")
	}

	// Editing needs the file's hash; a stale one is a conflict that says the current one.
	status, out = e.send(t, "PUT", "/v1/projects/shop/config", map[string]any{"content": projShop + "# x\n", "base_hash": "stale"})
	if status != 409 || out["error"] != "changed" || out["hash"] != config.Hash([]byte(projShop)) {
		t.Errorf("%d %+v", status, out)
	}
	// The document read back is saved back: secrets stay, the edit lands.
	doc := e.get(t, "/v1/projects/shop/config")
	edited := strings.Replace(doc["content"].(string), "ghcr.io/me/shop", "ghcr.io/me/shop2", 1)
	status, out = e.send(t, "PUT", "/v1/projects/shop/config", map[string]any{"content": edited, "base_hash": doc["hash"]})
	if status != 200 {
		t.Fatalf("%d %+v", status, out)
	}
	if got := e.file(t, "shop"); !strings.Contains(got, "pw@db/shop") || !strings.Contains(got, "shop2") || strings.Contains(got, config.Hidden) {
		t.Errorf("%s", got)
	}
	// A name that is not a project name.
	if status, out = e.send(t, "PUT", "/v1/projects/Not-A-Name/config", map[string]any{"content": "apps: []\n"}); status != 400 || out["error"] != "invalid" {
		t.Errorf("%d %+v", status, out)
	}
	log, _ := e.st.Audit(t.Context(), 10, 0)
	actions := map[string]bool{}
	for _, l := range log {
		actions[l.Action] = true
	}
	if !actions["project.save"] {
		t.Errorf("audit: %+v", log)
	}
}

func TestPutProjectRefusalsCarryTheFileAndLine(t *testing.T) {
	e := newProjEnv(t, projMain, map[string]string{"shop": projShop})
	status, out := e.send(t, "PUT", "/v1/projects/shop/config", map[string]any{"content": "apps:\n  - {name: web, image: o/dup}\n", "base_hash": config.Hash([]byte(projShop))})
	if status != 400 || out["error"] != "invalid" {
		t.Fatalf("%d %+v", status, out)
	}
	var issue map[string]any
	for _, is := range out["issues"].([]any) {
		if m := is.(map[string]any); m["severity"] == "error" {
			issue = m
		}
	}
	if issue["file"] != "projects.d/shop.yaml" || issue["project"] != "shop" || issue["line"] != float64(2) || issue["path"] != "apps[web]" || !strings.Contains(issue["message"].(string), "duplicate name") {
		t.Errorf("%+v", issue)
	}
	if e.file(t, "shop") != projShop {
		t.Error("nothing was written")
	}
	// Validation answers the same without writing.
	status, out = e.send(t, "POST", "/v1/projects/shop/config/validate", map[string]any{"content": "apps:\n  - {name: web, image: o/dup}\n"})
	if status != 200 || out["ok"] != false || len(out["issues"].([]any)) == 0 {
		t.Errorf("%d %+v", status, out)
	}
	status, out = e.send(t, "POST", "/v1/projects/shop/config/validate", map[string]any{"content": projShop})
	if status != 200 || out["ok"] != true {
		t.Errorf("%d %+v", status, out)
	}
}

func TestDeleteProjectNeedsTheAcknowledgementForRunningApps(t *testing.T) {
	e := newProjEnv(t, projMain, map[string]string{"shop": projShop})
	status, out := e.send(t, "DELETE", "/v1/projects/shop/config", map[string]any{})
	if status != 409 || out["error"] != "needs_acknowledgement" {
		t.Fatalf("%d %+v", status, out)
	}
	codes := map[string]bool{}
	for _, is := range out["issues"].([]any) {
		codes[is.(map[string]any)["code"].(string)] = true
	}
	if !codes["app_removed"] || !codes["job_removed"] {
		t.Errorf("%+v", out)
	}
	if e.file(t, "shop") != projShop {
		t.Fatal("still there")
	}
	status, out = e.send(t, "DELETE", "/v1/projects/shop/config", map[string]any{"force": true, "comment": "drop it"})
	if status != 200 || out["config_hash"] == nil || out["hash"] != "" {
		t.Fatalf("%d %+v", status, out)
	}
	if _, err := os.Stat(config.DefaultLocation(e.apps).ProjectPath("shop")); !os.IsNotExist(err) {
		t.Error("the file is gone")
	}
	if status, _ = e.send(t, "DELETE", "/v1/projects/shop/config", map[string]any{"force": true}); status != 404 {
		t.Errorf("deleting what is not there: %d", status)
	}
	log, _ := e.st.Audit(t.Context(), 10, 0)
	found := false
	for _, l := range log {
		found = found || (l.Action == "project.delete" && l.Status == 200)
	}
	if !found {
		t.Errorf("audit: %+v", log)
	}
}

func TestEntitySavesGoToTheFileThatHoldsTheEntity(t *testing.T) {
	e := newProjEnv(t, projMain, map[string]string{"shop": projShop})
	hash := e.get(t, "/v1/config")["hash"]
	status, out := e.send(t, "PUT", "/v1/config/jobs/shop-job", map[string]any{"base_hash": hash, "job": map[string]any{"name": "shop-job", "schedule": "@hourly", "container": map[string]any{"app": "shop", "command": []string{"x"}}}})
	if status != 200 {
		t.Fatalf("%d %+v", status, out)
	}
	if !strings.Contains(e.file(t, "shop"), "@hourly") || e.file(t, "") != projMain {
		t.Errorf("the job lives in the project file:\n%s", e.file(t, "shop"))
	}
	// A stale bundle hash is a conflict, whatever file was edited meanwhile.
	if status, out = e.send(t, "PUT", "/v1/config/jobs/shop-job", map[string]any{"base_hash": hash, "job": map[string]any{"name": "shop-job", "schedule": "@daily", "container": map[string]any{"app": "shop", "command": []string{"x"}}}}); status != 409 {
		t.Errorf("%d %+v", status, out)
	}
	// New: labelled with a project that has a file, goes into it.
	status, out = e.send(t, "PUT", "/v1/config/databases/shop-db", map[string]any{"database": map[string]any{"name": "shop-db", "project": "shop", "host": "db", "database": "shop", "user": "shop"}})
	if status != 200 {
		t.Fatalf("%d %+v", status, out)
	}
	if !strings.Contains(e.file(t, "shop"), "shop-db") || strings.Contains(e.file(t, ""), "shop-db") {
		t.Errorf("%s", e.file(t, "shop"))
	}
	// An app that a job calls cannot be removed from under it, wherever the two are written; a job asks for the acknowledgement.
	if status, out = e.send(t, "DELETE", "/v1/config/apps/shop", map[string]any{}); status != 400 || out["issues"].([]any)[0].(map[string]any)["file"] != "projects.d/shop.yaml" {
		t.Errorf("%d %+v", status, out)
	}
	if status, out = e.send(t, "DELETE", "/v1/config/jobs/shop-job", map[string]any{}); status != 409 || out["error"] != "needs_acknowledgement" {
		t.Errorf("%d %+v", status, out)
	}
	if status, out = e.send(t, "DELETE", "/v1/config/databases/shop-db", map[string]any{}); status != 200 {
		t.Errorf("%d %+v", status, out)
	}
	if strings.Contains(e.file(t, "shop"), "shop-db") {
		t.Error("deleted from the file that held it")
	}
	// The statuses of jobs and databases do not need the dashboard to know the files: the model says it.
	got := e.get(t, "/v1/config")
	for _, j := range got["model"].(map[string]any)["jobs"].([]any) {
		if m := j.(map[string]any); m["name"] == "shop-job" && m["project"] != "shop" {
			t.Errorf("%+v", m)
		}
	}
}

func TestPutConfigIsValidatedWithTheProjectFiles(t *testing.T) {
	e := newProjEnv(t, projMain, map[string]string{"shop": projShop})
	doc := e.get(t, "/v1/config")
	dup := strings.Replace(doc["content"].(string), "apps:\n", "apps:\n  - {name: shop, image: o/x}\n", 1)
	status, out := e.send(t, "PUT", "/v1/config", map[string]any{"content": dup, "base_hash": doc["hash"]})
	if status != 400 {
		t.Fatalf("%d %+v", status, out)
	}
	issue := out["issues"].([]any)[0].(map[string]any)
	if issue["file"] != "projects.d/shop.yaml" || !strings.Contains(issue["message"].(string), "first defined in apps.yaml") {
		t.Errorf("%+v", issue)
	}
	ok := doc["content"].(string) + "# comment\n"
	if status, out = e.send(t, "PUT", "/v1/config", map[string]any{"content": ok, "base_hash": doc["hash"]}); status != 200 {
		t.Errorf("%d %+v", status, out)
	}
	if e.file(t, "shop") != projShop {
		t.Error("the project file is untouched")
	}
}

func TestSplitThroughTheAPI(t *testing.T) {
	mono := "apps:\n  # The shop.\n  - {name: shop, project: shop, image: ghcr.io/me/shop}\n  - {name: web, image: ghcr.io/me/web}\njobs:\n  - {name: shop-job, schedule: '@daily', container: {app: shop, command: [x]}}\n  - {name: backup, schedule: '@daily', host: [/bin/true]}\n"
	e := newProjEnv(t, mono, nil)
	hash := e.get(t, "/v1/config")["hash"]

	status, out := e.send(t, "POST", "/v1/projects/shop/split", map[string]any{"base_hash": hash, "dry_run": true})
	plan, _ := out["plan"].(map[string]any)
	if status != 200 || out["dry_run"] != true || plan["file"] != "projects.d/shop.yaml" || len(plan["apps"].([]any)) != 1 || len(plan["jobs"].([]any)) != 1 ||
		len(plan["databases"].([]any)) != 0 || len(plan["previews"].([]any)) != 0 || len(plan["kept"].([]any)) != 0 {
		t.Fatalf("%d %+v", status, out)
	}
	if e.file(t, "") != mono {
		t.Fatal("a dry run writes nothing")
	}

	status, out = e.send(t, "POST", "/v1/projects/shop/split", map[string]any{"base_hash": "stale"})
	if status != 409 || out["error"] != "changed" {
		t.Errorf("%d %+v", status, out)
	}
	status, out = e.send(t, "POST", "/v1/projects/ghost/split", map[string]any{})
	if status != 400 || out["error"] != "invalid" || !strings.Contains(out["issues"].([]any)[0].(map[string]any)["message"].(string), "nothing belongs") {
		t.Errorf("%d %+v", status, out)
	}

	status, out = e.send(t, "POST", "/v1/projects/shop/split", map[string]any{"base_hash": hash, "comment": "split shop"})
	if status != 200 || out["dry_run"] != false || out["version"] == nil || out["file_hash"] != config.Hash([]byte(e.file(t, "shop"))) || out["hash"] == hash {
		t.Fatalf("%d %+v", status, out)
	}
	if !strings.Contains(e.file(t, "shop"), "shop-job") || strings.Contains(e.file(t, ""), "shop") || !strings.Contains(e.file(t, "shop"), "# The shop.") {
		t.Errorf("main:\n%s\nproject:\n%s", e.file(t, ""), e.file(t, "shop"))
	}
	list := e.list(t)
	if len(list) != 1 || list[0]["apps"] != float64(1) || list[0]["jobs"] != float64(1) {
		t.Errorf("%+v", list)
	}
	log, _ := e.st.Audit(t.Context(), 10, 0)
	found := false
	for _, l := range log {
		found = found || (l.Action == "project.split" && l.Status == 200)
	}
	if !found {
		t.Errorf("audit: %+v", log)
	}

	// The version before the split can be read and restored.
	versions := e.mgr
	vs, _ := versions.Versions(10)
	if len(vs) != 2 {
		t.Fatalf("%+v", vs)
	}
	v := e.get(t, "/v1/config/versions/"+itoa64(vs[0].ID))
	files, _ := v["files"].([]any)
	if len(files) != 1 || files[0].(map[string]any)["project"] != "shop" || v["content"] == nil {
		t.Errorf("a version with project files lists them: %+v", v)
	}
	if v = e.get(t, "/v1/config/versions/"+itoa64(vs[1].ID)); v["files"] != nil {
		t.Errorf("a version without project files has no files key: %+v", v)
	}
	status, out = e.send(t, "POST", "/v1/config/versions/"+itoa64(vs[1].ID)+"/restore", map[string]any{})
	if status != 200 || e.file(t, "") != mono {
		t.Errorf("%d %+v\n%s", status, out, e.file(t, ""))
	}
	if _, err := os.Stat(config.DefaultLocation(e.apps).ProjectPath("shop")); !os.IsNotExist(err) {
		t.Error("restoring the version without project files removes the file")
	}
}

func itoa64(n int64) string { return strconv.FormatInt(n, 10) }
