package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"github.com/0x2u/keelson/agent/internal/postgres"
	"github.com/0x2u/keelson/agent/internal/store"
)

type fakePostgres struct {
	create  postgres.CreateRequest
	drop    postgres.DropRequest
	rotated string
	err     error
}

func (f *fakePostgres) Status(context.Context) (postgres.Status, error) {
	return postgres.Status{Exists: true, State: "running", Running: true, Container: "keelson-postgres", Volume: "keelson-postgres-data"}, f.err
}

func (f *fakePostgres) CreateDatabase(_ context.Context, req postgres.CreateRequest) (postgres.Result, error) {
	f.create = req
	if f.err != nil {
		return postgres.Result{}, f.err
	}
	return postgres.Result{
		Database:  postgres.DatabaseInfo{Name: req.Name, App: req.App},
		EnvKey:    "DATABASE_URL",
		Created:   true,
		BackupKey: "AGE-SECRET-KEY-1QQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQ",
	}, nil
}

func (f *fakePostgres) DropDatabase(_ context.Context, req postgres.DropRequest) error {
	f.drop = req
	return f.err
}

func (f *fakePostgres) RotatePassword(_ context.Context, name, _ string) (postgres.Result, error) {
	f.rotated = name
	return postgres.Result{Database: postgres.DatabaseInfo{Name: name}, EnvKey: "DATABASE_URL", RedeployRequired: true}, f.err
}

func newPostgresEnv(t *testing.T) (*configEnv, *fakePostgres, *strings.Builder) {
	t.Helper()
	st, err := store.Open(filepath.Join(t.TempDir(), "a.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	var logs strings.Builder
	fc, fp := &fakeConfig{}, &fakePostgres{}
	h, err := New(&fakeDocker{}, Options{
		Token: testToken, Logger: slog.New(slog.NewTextHandler(&logs, nil)),
		Deploy: &DeployOptions{Deployments: &fakeDeployments{}, Secret: testSecret, Replays: st, Config: fc, Audit: st, Postgres: fp},
	})
	if err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(h)
	t.Cleanup(srv.Close)
	return &configEnv{srv: srv, st: st, cfg: fc}, fp, &logs
}

func TestPostgresRoutesAreAbsentWithoutTheService(t *testing.T) {
	e := newConfigEnv(t)
	if got := do(t, "GET", e.srv.URL+"/v1/postgres", testToken).StatusCode; got != 404 {
		t.Errorf("want 404 on an agent without the manager, got %d", got)
	}
}

func TestPostgresReadsNeedTheTokenAndWritesNeedASignature(t *testing.T) {
	e, fp, _ := newPostgresEnv(t)
	if got := do(t, "GET", e.srv.URL+"/v1/postgres", "").StatusCode; got != 401 {
		t.Errorf("status without a token: %d", got)
	}
	if got := do(t, "GET", e.srv.URL+"/v1/postgres", testToken).StatusCode; got != 200 {
		t.Errorf("status with the read token: %d", got)
	}
	// The read token alone never changes anything.
	for _, c := range []struct{ method, path string }{
		{"POST", "/v1/postgres/databases"},
		{"DELETE", "/v1/postgres/databases/shop"},
		{"POST", "/v1/postgres/databases/shop/password"},
	} {
		if got := do(t, c.method, e.srv.URL+c.path, testToken).StatusCode; got != 401 {
			t.Errorf("%s %s with the read token: %d", c.method, c.path, got)
		}
	}
	if fp.create.App != "" || fp.drop.Name != "" || fp.rotated != "" {
		t.Errorf("the service was reached without a signature: %+v %+v %q", fp.create, fp.drop, fp.rotated)
	}
}

// What the audit log keeps is the names the request was about. The backup key is in the answer, once, and nowhere
// else; a hostile name never writes a line break into the log.
func TestPostgresAuditHoldsNamesOnlyAndTheBackupKeyIsAnswerOnly(t *testing.T) {
	e, fp, logs := newPostgresEnv(t)
	resp, out := e.signed(t, "POST", "/v1/postgres/databases", `{"app":"web","name":"shop","env_key":"DATABASE_URL"}`, "dashboard")
	if resp.StatusCode != 200 || !strings.Contains(out, `"backup_key":"AGE-SECRET-KEY-1`) {
		t.Fatalf("%d %s", resp.StatusCode, out)
	}
	if fp.create.App != "web" || fp.create.Name != "shop" || fp.create.Actor != "dashboard" {
		t.Errorf("request: %+v", fp.create)
	}
	e.signed(t, "POST", "/v1/postgres/databases", "{\"app\":\"web\\n2026-01-01 forged entry\",\"name\":\"a b\",\"env_key\":\"X\\ny\"}", "")
	log, _ := e.st.Audit(t.Context(), 10, 0)
	if len(log) != 2 {
		t.Fatalf("audit: %+v", log)
	}
	if log[1].Action != "postgres.create" || log[1].Detail != "shop app=web env_key=DATABASE_URL" {
		t.Errorf("detail %q (action %q)", log[1].Detail, log[1].Action)
	}
	for _, l := range log {
		if strings.ContainsAny(l.Detail, "\n\r") || strings.Contains(l.Detail, "forged") || strings.Contains(l.Detail+l.Path+l.Action, "AGE-SECRET-KEY") {
			t.Errorf("audit entry %+v", l)
		}
	}
	if strings.Contains(logs.String(), "AGE-SECRET-KEY") {
		t.Error("the backup key reached the agent's log")
	}
}

func TestPostgresDeleteAndRotateReachTheService(t *testing.T) {
	e, fp, _ := newPostgresEnv(t)
	if resp, out := e.signed(t, "DELETE", "/v1/postgres/databases/shop", `{"confirm":"shop"}`, "dashboard"); resp.StatusCode != 200 || !strings.Contains(out, `"dropped":true`) {
		t.Fatalf("%d %s", resp.StatusCode, out)
	}
	if fp.drop.Name != "shop" || fp.drop.Confirm != "shop" || fp.drop.Actor != "dashboard" {
		t.Errorf("drop: %+v", fp.drop)
	}
	if resp, out := e.signed(t, "POST", "/v1/postgres/databases/shop/password", "", ""); resp.StatusCode != 200 || !strings.Contains(out, `"redeploy_required":true`) || fp.rotated != "shop" {
		t.Errorf("rotate: %d %s %q", resp.StatusCode, out, fp.rotated)
	}
	if resp, _ := e.signed(t, "DELETE", "/v1/postgres/databases/shop", `not json`, ""); resp.StatusCode != 400 {
		t.Errorf("a body that is not JSON: %d", resp.StatusCode)
	}
}

// Each kind of failure has its status. The detail of an engine or server failure goes to the agent's log; the answer
// says what kind it was and never repeats a password, a statement or a verifier.
func TestPostgresFailuresMapToStatusesWithoutLeakingDetail(t *testing.T) {
	e, fp, _ := newPostgresEnv(t)
	secret := "ALTER ROLE shop PASSWORD 'SCRAM-SHA-256$4096:abc$def:ghi' hunter2"
	cases := []struct {
		name   string
		err    error
		status int
		exact  string // the whole answer, when it is stable
	}{
		{"bad request", &postgres.RequestError{Msg: "name must match the pattern"}, 400, "name must match the pattern"},
		{"unknown app", postgres.ErrUnknownApp, 404, "no such app"},
		{"unknown database", postgres.ErrUnknownDatabase, 404, "no such managed database"},
		{"name clash", &postgres.ConflictError{Msg: "database shop belongs to app other"}, 409, "database shop belongs to app other"},
		{"busy", postgres.ErrBusy, 409, ""},
		{"shutting down", postgres.ErrShuttingDown, 503, "the agent is shutting down"},
		{"foreign container", postgres.ErrForeign, 409, ""},
		{"password lost", postgres.ErrPasswordLost, 409, ""},
		{"instance", &postgres.InstanceError{Msg: "the image could not be pulled"}, 502, "the managed PostgreSQL could not be brought up: the image could not be pulled"},
		{"server", &postgres.ServerError{Err: errors.New(secret)}, 502, "the PostgreSQL server refused a command: see the agent log"},
		{"anything else", fmt.Errorf("open /etc/keelson/x: %s", secret), 500, "internal error"},
	}
	for _, c := range cases {
		fp.err = c.err
		resp, out := e.signed(t, "POST", "/v1/postgres/databases/shop/password", "", "")
		var body map[string]string
		json.NewDecoder(strings.NewReader(out)).Decode(&body)
		if resp.StatusCode != c.status || (c.exact != "" && body["error"] != c.exact) {
			t.Errorf("%s: %d %q, want %d %q", c.name, resp.StatusCode, body["error"], c.status, c.exact)
		}
		for _, leak := range []string{"hunter2", "SCRAM-SHA-256", "PASSWORD", "/etc/keelson"} {
			if strings.Contains(out, leak) {
				t.Errorf("%s: %q leaked into the answer %q", c.name, leak, out)
			}
		}
	}
}
