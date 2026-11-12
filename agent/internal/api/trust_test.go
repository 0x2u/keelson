package api

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/0x2u/keelson/agent/internal/databases"
	"github.com/0x2u/keelson/agent/internal/notify"
	"github.com/0x2u/keelson/agent/internal/store"
)

func (f *fakeDatabases) VerifyKey(_ context.Context, name, identity, backup string) (databases.KeyCheck, error) {
	f.verifyArgs = [3]string{name, identity, backup}
	if name == "ghost" {
		return databases.KeyCheck{}, databases.ErrUnknownDatabase
	}
	return f.verify, f.verifyErr
}

func (f *fakeDatabases) StartRestoreTest(_ context.Context, req databases.RestoreTestRequest) (store.RestoreTest, error) {
	f.testReq = req
	if f.testErr != nil {
		return store.RestoreTest{}, f.testErr
	}
	return store.RestoreTest{ID: "t9", Backup: "shop/shop-20260101T030000Z.dump.age"}, nil
}

func (f *fakeDatabases) RestoreTests(_ context.Context, name string, _ int) ([]store.RestoreTest, error) {
	if name == "ghost" {
		return nil, databases.ErrUnknownDatabase
	}
	return f.tests, nil
}

// fakeAlerts answers the test of the notification channels.
type fakeAlerts struct {
	channels []notify.ChannelResult
	err      error
}

func (f *fakeAlerts) Events(int) []notify.Record { return nil }

func (f *fakeAlerts) Test(context.Context) ([]notify.ChannelResult, error) { return f.channels, f.err }

type trustEnv struct {
	*configEnv
	fd     *fakeDatabases
	alerts *fakeAlerts
	logs   *bytes.Buffer
}

func newTrustEnv(t *testing.T, withProofs bool) *trustEnv {
	t.Helper()
	st, err := store.Open(filepath.Join(t.TempDir(), "a.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	e := &trustEnv{fd: &fakeDatabases{}, alerts: &fakeAlerts{}, logs: &bytes.Buffer{}}
	d := &DeployOptions{Deployments: &fakeDeployments{}, Secret: testSecret, Replays: st, Config: &fakeConfig{}, Audit: st, Databases: e.fd, Alerts: e.alerts}
	if withProofs {
		d.Proofs = st
	}
	h, err := New(&fakeDocker{}, Options{Token: testToken, Logger: slog.New(slog.NewTextHandler(e.logs, nil)), Deploy: d})
	if err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(h)
	t.Cleanup(srv.Close)
	e.configEnv = &configEnv{srv: srv, st: st, cfg: &fakeConfig{}}
	return e
}

const backupKey = "shop/shop-20260101T030000Z.dump.age"

func TestVerifyKeyAnswersExactlyAndTheAuditNeverHoldsTheIdentity(t *testing.T) {
	e := newTrustEnv(t, true)
	body := `{"identity":"` + identityText + `"}`

	if resp := do(t, "POST", e.srv.URL+"/v1/databases/shop/verify-key", testToken); resp.StatusCode != 401 || e.fd.verifyArgs != [3]string{} {
		t.Fatalf("the read token must not try a key: %d", resp.StatusCode)
	}

	e.fd.verify = databases.KeyCheck{OK: true, Backup: backupKey, BackupTime: time.Date(2026, 1, 1, 3, 0, 0, 0, time.UTC)}
	resp, out := e.signed(t, "POST", "/v1/databases/shop/verify-key", body, "dashboard")
	if resp.StatusCode != 200 || strings.TrimSpace(out) != `{"ok":true,"backup":"`+backupKey+`","backup_time":"2026-01-01T03:00:00Z"}` {
		t.Fatalf("%d %s", resp.StatusCode, out)
	}
	if e.fd.verifyArgs != [3]string{"shop", identityText, ""} {
		t.Errorf("the request reaches the service intact: %v", e.fd.verifyArgs)
	}

	e.fd.verify = databases.KeyCheck{Reason: databases.ReasonWrongKey, Backup: backupKey}
	resp, out = e.signed(t, "POST", "/v1/databases/shop/verify-key", `{"identity":"`+identityText+`","backup":"`+backupKey+`"}`, "")
	if resp.StatusCode != 200 || strings.TrimSpace(out) != `{"ok":false,"reason":"wrong_key"}` {
		t.Fatalf("a key that does not open the backup is an answer, not an error: %d %s", resp.StatusCode, out)
	}
	e.fd.verify = databases.KeyCheck{Reason: databases.ReasonNoBackup}
	if _, out = e.signed(t, "POST", "/v1/databases/shop/verify-key", body, ""); strings.TrimSpace(out) != `{"ok":false,"reason":"no_backup"}` {
		t.Errorf("%s", out)
	}

	log, _ := e.st.Audit(t.Context(), 10, 0)
	if len(log) != 3 || log[2].Action != "database.verify_key" || log[2].Status != 200 || log[2].Actor != "dashboard" {
		t.Fatalf("audit: %+v", log)
	}
	for i, want := range []string{"shop backup=(none)", "shop backup=" + backupKey, "shop backup=" + backupKey} {
		if log[i].Detail != want {
			t.Errorf("audit detail %d: %q, want %q", i, log[i].Detail, want)
		}
	}
	for _, entry := range log {
		if strings.Contains(entry.Detail+entry.Path+entry.Action, "AGE-SECRET-KEY") {
			t.Errorf("the identity reached the audit log: %+v", entry)
		}
	}
	if strings.Contains(e.logs.String(), "AGE-SECRET-KEY") {
		t.Errorf("the identity reached the log:\n%s", e.logs)
	}
}

func TestVerifyKeyRefusalsAreStatusesNotAnswers(t *testing.T) {
	e := newTrustEnv(t, true)
	for name, tc := range map[string]struct {
		path   string
		body   string
		err    error
		status int
		want   string
	}{
		"unknown database":  {"/v1/databases/ghost/verify-key", `{"identity":"x"}`, nil, 404, "not found"},
		"bad identity":      {"/v1/databases/shop/verify-key", `{"identity":"nope"}`, &databases.RequestError{Msg: "identity must be an age secret key (AGE-SECRET-KEY-1...)"}, 400, "identity must be an age secret key"},
		"unknown field":     {"/v1/databases/shop/verify-key", `{"identity":"x","password":"y"}`, nil, 400, "invalid request body"},
		"not json":          {"/v1/databases/shop/verify-key", `identity`, nil, 400, "invalid request body"},
		"proof not written": {"/v1/databases/shop/verify-key", `{"identity":"` + identityText + `"}`, errors.New("record the proof: disk full " + identityText), 500, "internal error"},
	} {
		e.fd.verifyErr = tc.err
		resp, out := e.signed(t, "POST", tc.path, tc.body, "")
		if resp.StatusCode != tc.status || !strings.Contains(out, tc.want) || strings.Contains(out, "disk full") || strings.Contains(out, "AGE-SECRET-KEY-1QQ") {
			t.Errorf("%s: %d %s", name, resp.StatusCode, out)
		}
	}
}

func TestRestoreTestIsStartedAsyncAndRefusalsAreStableSentences(t *testing.T) {
	e := newTrustEnv(t, true)
	body := `{"identity":"` + identityText + `"}`
	if resp := do(t, "POST", e.srv.URL+"/v1/databases/shop/restore-test", testToken); resp.StatusCode != 401 || e.fd.testReq.Database != "" {
		t.Fatalf("the read token must not start a test: %d", resp.StatusCode)
	}
	resp, out := e.signed(t, "POST", "/v1/databases/shop/restore-test", body, "dashboard")
	if resp.StatusCode != 202 || strings.TrimSpace(out) != `{"test_id":"t9"}` {
		t.Fatalf("%d %s", resp.StatusCode, out)
	}
	if e.fd.testReq != (databases.RestoreTestRequest{Database: "shop", Identity: identityText}) {
		t.Errorf("%+v", e.fd.testReq)
	}
	log, _ := e.st.Audit(t.Context(), 10, 0)
	if len(log) != 1 || log[0].Action != "database.restore_test" || log[0].Status != 202 || log[0].Detail != "shop backup="+backupKey {
		t.Fatalf("audit: %+v", log)
	}

	for _, tc := range []struct {
		err    error
		status int
		want   string
	}{
		{databases.ErrTestBusy, 409, "restore test is already running"},
		{databases.ErrRestoreBusy, 409, "restore is already running"},
		{databases.ErrBackupBusy, 409, "backup is running"},
		{databases.ErrUnknownDatabase, 404, "not found"},
		{&databases.RequestError{Msg: "database shop has no scheduled backup to test yet"}, 400, "no scheduled backup"},
		{databases.ErrShuttingDown, 503, "shutting down"},
		{errors.Join(databases.ErrDestination, errors.New("dial tcp 10.0.0.5:9000: connection refused")), 502, "the backup destination could not be read: see the agent log"},
		{errors.New("disk exploded"), 500, "internal error"},
	} {
		e.fd.testErr = tc.err
		resp, out := e.signed(t, "POST", "/v1/databases/shop/restore-test", body, "")
		if resp.StatusCode != tc.status || !strings.Contains(out, tc.want) || strings.Contains(out, "10.0.0.5") || strings.Contains(out, "exploded") || strings.Contains(out, "AGE-SECRET-KEY") {
			t.Errorf("%v: %d %s", tc.err, resp.StatusCode, out)
		}
	}
	log, _ = e.st.Audit(t.Context(), 20, 0)
	for _, entry := range log {
		if strings.Contains(entry.Detail, "AGE-SECRET-KEY") {
			t.Errorf("the identity reached the audit log: %q", entry.Detail)
		}
	}
}

func TestRestoreTestsAreListedNewestFirstWithNullsAndAsAnEmptyListWhenNone(t *testing.T) {
	e := newTrustEnv(t, true)
	url := e.srv.URL + "/v1/databases/shop/restore-tests"
	if do(t, "GET", url, "").StatusCode != 401 {
		t.Error("the list needs the token")
	}
	resp := do(t, "GET", url, testToken)
	if raw, _ := io.ReadAll(resp.Body); resp.StatusCode != 200 || strings.TrimSpace(string(raw)) != "[]" {
		t.Errorf("none is [], not null: %d %s", resp.StatusCode, raw)
	}
	one, two := int64(3), int64(0)
	fin := time.Date(2026, 1, 1, 3, 1, 0, 0, time.UTC)
	e.fd.tests = []store.RestoreTest{{
		ID: "t1", Backup: backupKey, BackupTime: time.Date(2026, 1, 1, 3, 0, 0, 0, time.UTC), StartedAt: time.Date(2026, 1, 1, 3, 0, 30, 0, time.UTC), FinishedAt: &fin, Status: store.TestPassed,
		Tables: []store.TableCount{{Name: "public.products", BackupRows: &one}, {Name: "public.legacy", LiveRows: &two}},
	}}
	resp = do(t, "GET", url+"?limit=5", testToken)
	raw, _ := io.ReadAll(resp.Body)
	want := `[{"id":"t1","backup":"` + backupKey + `","backup_time":"2026-01-01T03:00:00Z","started_at":"2026-01-01T03:00:30Z","finished_at":"2026-01-01T03:01:00Z","status":"passed","tables":[{"name":"public.products","backup_rows":3,"live_rows":null},{"name":"public.legacy","backup_rows":null,"live_rows":0}]}]`
	if strings.TrimSpace(string(raw)) != want {
		t.Errorf("\n got  %s\n want %s", raw, want)
	}
	if do(t, "GET", url+"?limit=0", testToken).StatusCode != 400 || do(t, "GET", e.srv.URL+"/v1/databases/ghost/restore-tests", testToken).StatusCode != 404 {
		t.Error("a bad limit is 400, an unknown database 404")
	}
}

func TestTheNotificationTestIsSignedAuditedAndNeverQuotesAnError(t *testing.T) {
	e := newTrustEnv(t, true)
	if resp := do(t, "POST", e.srv.URL+"/v1/notifications/test", testToken); resp.StatusCode != 401 {
		t.Fatalf("the read token must not send a message: %d", resp.StatusCode)
	}
	e.alerts.channels = []notify.ChannelResult{{Channel: "webhook", OK: true}, {Channel: "telegram", Reason: "rejected"}}
	resp, out := e.signed(t, "POST", "/v1/notifications/test", "", "dashboard")
	if resp.StatusCode != 200 || strings.TrimSpace(out) != `{"channels":[{"channel":"webhook","ok":true},{"channel":"telegram","ok":false,"reason":"rejected"}]}` {
		t.Fatalf("%d %s", resp.StatusCode, out)
	}
	e.alerts.channels = nil
	if _, out = e.signed(t, "POST", "/v1/notifications/test", "", ""); strings.TrimSpace(out) != `{"channels":[]}` {
		t.Errorf("no channel is an empty list: %s", out)
	}
	e.alerts.err = errors.New("write proof: https://hooks.example.com/SECRET")
	resp, out = e.signed(t, "POST", "/v1/notifications/test", "", "")
	if resp.StatusCode != 500 || strings.Contains(out, "SECRET") || !strings.Contains(out, "internal error") {
		t.Errorf("%d %s", resp.StatusCode, out)
	}

	log, _ := e.st.Audit(t.Context(), 10, 0)
	if len(log) != 3 || log[2].Action != "notifications.test" || log[2].Detail != "2 channels, 1 failed" || log[1].Detail != "0 channels, 0 failed" || log[2].Actor != "dashboard" {
		t.Errorf("audit: %+v", log)
	}
}

func TestProofsAreServedToTheTokenAndTheRouteIsAbsentWithoutTheStore(t *testing.T) {
	e := newTrustEnv(t, true)
	url := e.srv.URL + "/v1/proofs"
	if do(t, "GET", url, "").StatusCode != 401 {
		t.Error("proofs need the token")
	}
	resp := do(t, "GET", url, testToken)
	if raw, _ := io.ReadAll(resp.Body); resp.StatusCode != 200 || strings.TrimSpace(string(raw)) != "[]" {
		t.Errorf("none is [], not null: %d %s", resp.StatusCode, raw)
	}
	at := time.Date(2026, 1, 1, 3, 0, 0, 0, time.UTC)
	e.st.RecordProof(t.Context(), store.ProofKey, "shop", at)
	e.st.RecordProof(t.Context(), store.ProofAlert, "", at.Add(time.Hour))
	var got []store.Proof
	json.NewDecoder(do(t, "GET", url, testToken).Body).Decode(&got)
	if len(got) != 2 || got[0].Kind != "alert" || got[0].Subject != "" || !got[0].At.Equal(at.Add(time.Hour)) || got[1].Kind != "key" || got[1].Subject != "shop" {
		t.Errorf("%+v", got)
	}
	if resp := do(t, "POST", url, testToken); resp.StatusCode == 200 {
		t.Error("proofs are read-only")
	}

	if got := do(t, "GET", newTrustEnv(t, false).srv.URL+"/v1/proofs", testToken).StatusCode; got != 404 {
		t.Errorf("without the store the route does not exist: %d", got)
	}
}
