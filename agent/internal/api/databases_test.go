package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/0x2u/keelson/agent/internal/databases"
	"github.com/0x2u/keelson/agent/internal/store"
)

type fakeDatabases struct {
	restore    databases.RestoreRequest
	restoreErr error
	liveErr    error
	backupsErr error

	// verify is what VerifyKey answers; verifyArgs what it was asked. test is the restore test StartRestoreTest starts.
	verify     databases.KeyCheck
	verifyErr  error
	verifyArgs [3]string
	testReq    databases.RestoreTestRequest
	testErr    error
	tests      []store.RestoreTest
}

func (f *fakeDatabases) Databases(context.Context) ([]databases.View, error) {
	return []databases.View{{Name: "shop", Engine: "postgres", Host: "127.0.0.1", Port: 5432, Database: "shop", User: "shop", Network: "host", HasPassword: true}}, nil
}

func (f *fakeDatabases) Live(_ context.Context, name string) (databases.Live, error) {
	if name == "ghost" {
		return databases.Live{}, databases.ErrUnknownDatabase
	}
	return databases.Live{ServerVersion: "16.4", SizeBytes: 123, ClientImage: "postgres:16-alpine"}, f.liveErr
}

func (f *fakeDatabases) Backups(_ context.Context, name string) ([]databases.Backup, error) {
	if name == "ghost" {
		return nil, databases.ErrUnknownDatabase
	}
	if f.backupsErr != nil {
		return nil, f.backupsErr
	}
	return []databases.Backup{{Key: "shop/shop-20260101T030000Z.dump.age", Name: "shop-20260101T030000Z.dump.age", SizeBytes: 9, CreatedAt: time.Date(2026, 1, 1, 3, 0, 0, 0, time.UTC)}}, nil
}

func (f *fakeDatabases) Restore(_ context.Context, req databases.RestoreRequest) (databases.RestoreStarted, error) {
	f.restore = req
	if f.restoreErr != nil {
		return databases.RestoreStarted{}, f.restoreErr
	}
	target := req.Target
	if target == "" {
		target = "shop_restore_20260101"
	}
	return databases.RestoreStarted{RunID: "run9", Target: target}, nil
}

func (f *fakeDatabases) Restores(_ context.Context, name string, _ int) ([]store.JobRun, error) {
	if name == "ghost" {
		return nil, databases.ErrUnknownDatabase
	}
	return nil, nil
}

func newDatabasesEnv(t *testing.T) (*configEnv, *fakeDatabases) {
	t.Helper()
	st, err := store.Open(filepath.Join(t.TempDir(), "a.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	fc, fd := &fakeConfig{}, &fakeDatabases{}
	h, err := New(&fakeDocker{}, Options{
		Token: testToken, Logger: slog.New(slog.NewTextHandler(io.Discard, nil)),
		Deploy: &DeployOptions{Deployments: &fakeDeployments{}, Secret: testSecret, Replays: st, Config: fc, Audit: st, Databases: fd},
	})
	if err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(h)
	t.Cleanup(srv.Close)
	return &configEnv{srv: srv, st: st, cfg: fc}, fd
}

func TestDatabaseReadRoutes(t *testing.T) {
	e, _ := newDatabasesEnv(t)
	for _, path := range []string{"/v1/databases", "/v1/databases/shop/live", "/v1/databases/shop/backups", "/v1/databases/shop/restores"} {
		if got := do(t, "GET", e.srv.URL+path, "").StatusCode; got != 401 {
			t.Errorf("%s without a token: %d", path, got)
		}
		if got := do(t, "GET", e.srv.URL+path, testToken).StatusCode; got != 200 {
			t.Errorf("%s with the read token: %d", path, got)
		}
	}
	for _, path := range []string{"/v1/databases/ghost/live", "/v1/databases/ghost/backups", "/v1/databases/ghost/restores"} {
		if got := do(t, "GET", e.srv.URL+path, testToken).StatusCode; got != 404 {
			t.Errorf("%s: want 404, got %d", path, got)
		}
	}

	var list []map[string]any
	json.NewDecoder(do(t, "GET", e.srv.URL+"/v1/databases", testToken).Body).Decode(&list)
	if len(list) != 1 || list[0]["has_password"] != true || list[0]["backup"] != nil {
		t.Errorf("list: %+v", list)
	}
	if _, leaked := list[0]["password_file"]; leaked {
		t.Error("the list must stay minimal")
	}
	var runs []store.JobRun
	json.NewDecoder(do(t, "GET", e.srv.URL+"/v1/databases/shop/restores", testToken).Body).Decode(&runs)
	if runs == nil {
		t.Error("no restores must serialize as [], not null")
	}
	if got := do(t, "GET", e.srv.URL+"/v1/databases/shop/restores?limit=0", testToken).StatusCode; got != 400 {
		t.Errorf("bad limit: %d", got)
	}

}

// The detail of a remote failure (paths of secret files, hosts, what PostgreSQL or the store printed) goes to the
// agent's log; the caller gets a stable sentence for the kind of failure.
func TestRemoteFailuresAreStableSentencesWithoutInternalDetail(t *testing.T) {
	e, fd := newDatabasesEnv(t)
	secretPath := "/etc/keelson/db-shop-password"
	cases := []struct {
		route string
		set   func(error)
		err   error
		want  string
	}{
		{"live", func(err error) { fd.liveErr = err }, fmt.Errorf("%w: read the password: open %s: no such file", databases.ErrSecret, secretPath), "a secret file of this database could not be read: see the agent log"},
		{"live", func(err error) { fd.liveErr = err }, fmt.Errorf("%w: psql exited with code 2: FATAL:  password authentication failed for user \"shop\"", databases.ErrServer), "the database server could not be queried: see the agent log"},
		{"backups", func(err error) { fd.backupsErr = err }, fmt.Errorf("%w: s3 GET: 403 AccessDenied: Access Denied", databases.ErrDestination), "the backup destination could not be read: see the agent log"},
		{"backups", func(err error) { fd.backupsErr = err }, fmt.Errorf("%w: read s3 secret key: open %s: permission denied", databases.ErrSecret, secretPath), "a secret file of this database could not be read: see the agent log"},
		{"backups", func(err error) { fd.backupsErr = err }, errors.New("open /var/backups/keelson/shop: permission denied"), "the request could not be completed: see the agent log"},
	}
	for _, c := range cases {
		fd.liveErr, fd.backupsErr = nil, nil
		c.set(c.err)
		resp := do(t, "GET", e.srv.URL+"/v1/databases/shop/"+c.route, testToken)
		var body map[string]string
		json.NewDecoder(resp.Body).Decode(&body)
		if resp.StatusCode != 502 || body["error"] != c.want {
			t.Errorf("%v: %d %v, want 502 %q", c.err, resp.StatusCode, body, c.want)
		}
		for _, leak := range []string{secretPath, "/var/backups", "FATAL", "AccessDenied", "permission denied"} {
			if strings.Contains(body["error"], leak) {
				t.Errorf("%q leaked into the answer: %q", leak, body["error"])
			}
		}
	}
}

func TestDatabaseRoutesAbsentWithoutTheService(t *testing.T) {
	e := newConfigEnv(t)
	if got := do(t, "GET", e.srv.URL+"/v1/databases", testToken).StatusCode; got != 404 {
		t.Errorf("want 404 when the agent has no database service, got %d", got)
	}
}

const identityText = "AGE-SECRET-KEY-1QQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQ"

func TestRestoreNeedsASignatureAndTheAuditNeverHoldsTheKey(t *testing.T) {
	e, fd := newDatabasesEnv(t)
	body := `{"backup":"shop/shop-20260101T030000Z.dump.age","identity":"` + identityText + `","target":"shop_check","overwrite":false}`

	resp := do(t, "POST", e.srv.URL+"/v1/databases/shop/restore", testToken)
	if resp.StatusCode != 401 || fd.restore.Database != "" {
		t.Fatalf("the read token must not start a restore: %d", resp.StatusCode)
	}

	resp, out := e.signed(t, "POST", "/v1/databases/shop/restore", body, "dashboard")
	if resp.StatusCode != 202 || !strings.Contains(out, `"run_id":"run9"`) {
		t.Fatalf("%d %s", resp.StatusCode, out)
	}
	if fd.restore.Database != "shop" || fd.restore.Identity != identityText || fd.restore.Target != "shop_check" || fd.restore.Backup != "shop/shop-20260101T030000Z.dump.age" {
		t.Errorf("the request must reach the service intact: %+v", fd.restore)
	}

	log, _ := e.st.Audit(t.Context(), 10, 0)
	if len(log) != 1 || log[0].Action != "database.restore" || log[0].Status != 202 || log[0].Actor != "dashboard" {
		t.Fatalf("audit: %+v", log)
	}
	if want := "shop backup=shop/shop-20260101T030000Z.dump.age target=shop_check overwrite=false"; log[0].Detail != want {
		t.Errorf("audit detail %q, want %q", log[0].Detail, want)
	}
	for _, field := range []string{log[0].Detail, log[0].Path, log[0].Action} {
		if strings.Contains(field, "AGE-SECRET-KEY") {
			t.Errorf("the key reached the audit log: %q", field)
		}
	}

	// A default target is recorded as the one the service chose.
	e.signed(t, "POST", "/v1/databases/shop/restore", `{"backup":"b","identity":"`+identityText+`"}`, "")
	log, _ = e.st.Audit(t.Context(), 10, 0)
	if !strings.Contains(log[0].Detail, "target=shop_restore_20260101 overwrite=false") {
		t.Errorf("audit detail %q", log[0].Detail)
	}
}

func TestRestoreAuditCarriesOnlyValuesThatPassedValidation(t *testing.T) {
	const key = "shop/shop-20260101T030000Z.dump.age"
	long := strings.Repeat("A", 5000)
	cases := []struct {
		name, backup, target, want string
	}{
		{"shop", key, "shop_check", "shop backup=" + key + " target=shop_check overwrite=true"},
		{"shop", key, "shop", "shop backup=" + key + " target=shop overwrite=true"},
		{"shop", "forged\nbackup=x " + long, "t;drop", "shop backup=(invalid) target=(invalid) overwrite=true"},
		{"shop", "other/other-20260101T030000Z.dump.age", "", "shop backup=(invalid) target= overwrite=true"},
		{"Sh\nop " + long, key, "", "(invalid) backup=(invalid) target= overwrite=true"},
	}
	for _, c := range cases {
		got := restoreDetail(c.name, c.backup, c.target, true)
		if got != c.want {
			t.Errorf("restoreDetail(%q, %.20q, %q) = %.120q, want %q", c.name, c.backup, c.target, got, c.want)
		}
	}

	// And through the handler: a refused request with a hostile backup and target is audited as "(invalid)".
	e, fd := newDatabasesEnv(t)
	fd.restoreErr = &databases.RequestError{Msg: "backup is not the key of a backup of this database"}
	body := `{"backup":"x\ninjected target=` + long + `","identity":"` + identityText + `","target":"bad name"}`
	if resp, _ := e.signed(t, "POST", "/v1/databases/shop/restore", body, ""); resp.StatusCode != 400 {
		t.Fatalf("status %d", resp.StatusCode)
	}
	log, _ := e.st.Audit(t.Context(), 1, 0)
	if want := "shop backup=(invalid) target=(invalid) overwrite=false"; len(log) != 1 || log[0].Detail != want {
		t.Errorf("audit: %+v, want detail %q", log, want)
	}
}

func TestRestoreRefusalsAreAudited(t *testing.T) {
	e, fd := newDatabasesEnv(t)
	cases := []struct {
		err    error
		status int
		want   string
	}{
		{&databases.RequestError{Msg: `restoring over the live database needs overwrite: true and confirm: "shop"`}, 400, "needs overwrite"},
		{databases.ErrRestoreBusy, 409, "already running"},
		{databases.ErrUnknownDatabase, 404, "not found"},
		{errors.New("disk exploded"), 500, "internal error"},
	}
	for _, c := range cases {
		fd.restoreErr = c.err
		resp, body := e.signed(t, "POST", "/v1/databases/shop/restore", `{"backup":"b","identity":"`+identityText+`","target":"shop"}`, "")
		if resp.StatusCode != c.status || !strings.Contains(body, c.want) || strings.Contains(body, "disk exploded") || strings.Contains(body, "AGE-SECRET-KEY") {
			t.Errorf("%v: %d %s", c.err, resp.StatusCode, body)
		}
	}
	if resp, _ := e.signed(t, "POST", "/v1/databases/shop/restore", `{"backup":"b","identity":"x","password":"y"}`, ""); resp.StatusCode != 400 {
		t.Errorf("an unknown field is a bad request, got %d", resp.StatusCode)
	}
	log, _ := e.st.Audit(t.Context(), 10, 0)
	if len(log) != len(cases)+1 || log[0].Status != 400 || log[1].Status != 500 {
		t.Errorf("refused restores are audited with their status: %+v", log)
	}
	for _, entry := range log {
		if strings.Contains(entry.Detail, "AGE-SECRET-KEY") {
			t.Errorf("the key reached the audit log: %q", entry.Detail)
		}
	}
}

func TestDatabaseConfigRoutesEditTheDocumentAndNeedASignature(t *testing.T) {
	e, _ := newDatabasesEnv(t)
	for _, method := range []string{"PUT", "DELETE"} {
		resp := do(t, method, e.srv.URL+"/v1/config/databases/shop", testToken)
		if resp.StatusCode != 401 {
			t.Errorf("%s with only the read token: %d", method, resp.StatusCode)
		}
	}
	put := `{"database":{"name":"shop","host":"127.0.0.1","database":"shop","user":"shop","port":5432.0},"base_hash":"h1"}`
	resp, body := e.signed(t, "PUT", "/v1/config/databases/shop", put, "dashboard")
	if resp.StatusCode != 200 || !strings.Contains(e.cfg.editedBy, "databases:") || !strings.Contains(e.cfg.editedBy, "name: shop") || e.cfg.baseHash != "h1" {
		t.Fatalf("%d %s\n%s", resp.StatusCode, body, e.cfg.editedBy)
	}
	if resp, _ := e.signed(t, "PUT", "/v1/config/databases/shop", `{"database":{"name":"other"},"base_hash":"h1"}`, ""); resp.StatusCode != 400 {
		t.Errorf("a body name different from the URL's must be refused, got %d", resp.StatusCode)
	}
	if resp, _ := e.signed(t, "PUT", "/v1/config/databases/shop", `{"base_hash":"h1"}`, ""); resp.StatusCode != 400 {
		t.Errorf("a missing database object is a bad request, got %d", resp.StatusCode)
	}
	// The fake manager edits a document with no databases: deleting one is refused as an invalid edit.
	if resp, _ := e.signed(t, "DELETE", "/v1/config/databases/shop", `{"base_hash":"h1"}`, ""); resp.StatusCode != 400 {
		t.Errorf("deleting what is not in the document: %d", resp.StatusCode)
	}
	log, _ := e.st.Audit(t.Context(), 10, 0)
	if len(log) != 4 || log[len(log)-1].Action != "database.save" || log[0].Action != "database.delete" {
		t.Errorf("audit: %+v", log)
	}
}
