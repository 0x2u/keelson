package api

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"
	"time"

	"github.com/0x2u/keelson/agent/internal/jobs"
	"github.com/0x2u/keelson/agent/internal/store"
)

type fakeJobs struct {
	triggered []string
	err       error
}

func (f *fakeJobs) Jobs(context.Context) ([]jobs.Status, error) {
	return []jobs.Status{{Name: "monitoring", Schedule: "*/5 * * * *", Kind: "http", Target: "GET http://127.0.0.1:3000/x"}}, nil
}

func (f *fakeJobs) Runs(_ context.Context, name string, limit int) ([]store.JobRun, error) {
	if name == "ghost" {
		return nil, jobs.ErrUnknownJob
	}
	if name == "empty" {
		return nil, nil
	}
	return []store.JobRun{{ID: "r1", Job: name, Status: store.JobSucceeded}}, nil
}

func (f *fakeJobs) Trigger(name string) (string, <-chan struct{}, error) {
	if f.err != nil {
		return "", nil, f.err
	}
	f.triggered = append(f.triggered, name)
	return "run1", nil, nil
}

func newJobsEnv(t *testing.T) (*deployEnv, *fakeJobs) {
	t.Helper()
	st, err := store.Open(filepath.Join(t.TempDir(), "a.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	fj := &fakeJobs{}
	fake := &fakeDeployments{dep: store.Deployment{ID: "dep1", App: "web", Status: store.StatusSucceeded}}
	h, err := New(&fakeDocker{}, Options{
		Token: testToken, Logger: slog.New(slog.NewTextHandler(io.Discard, nil)),
		Deploy: &DeployOptions{Deployments: fake, Secret: testSecret, Replays: st, Jobs: fj},
	})
	if err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(h)
	t.Cleanup(srv.Close)
	return &deployEnv{srv: srv, fake: fake, st: st}, fj
}

func TestJobRoutesNeedTheReadTokenToReadAndASignatureToRun(t *testing.T) {
	e, fj := newJobsEnv(t)

	for _, path := range []string{"/v1/jobs", "/v1/jobs/monitoring/runs"} {
		if got := do(t, "GET", e.srv.URL+path, "").StatusCode; got != 401 {
			t.Errorf("%s without a token: %d", path, got)
		}
		if got := do(t, "GET", e.srv.URL+path, testToken).StatusCode; got != 200 {
			t.Errorf("%s with the read token: %d", path, got)
		}
	}
	var list []jobs.Status
	json.NewDecoder(do(t, "GET", e.srv.URL+"/v1/jobs", testToken).Body).Decode(&list)
	if len(list) != 1 || list[0].Name != "monitoring" {
		t.Errorf("unexpected list: %+v", list)
	}

	// Running a job is a change: the read token is not enough.
	req, _ := http.NewRequest("POST", e.srv.URL+"/v1/jobs/monitoring/run", nil)
	req.Header.Set("Authorization", "Bearer "+testToken)
	resp, _ := http.DefaultClient.Do(req)
	resp.Body.Close()
	if resp.StatusCode != 401 || len(fj.triggered) != 0 {
		t.Errorf("the read token must not run jobs: %d %v", resp.StatusCode, fj.triggered)
	}

	resp = e.post(t, "/v1/jobs/monitoring/run", "", testSecret, time.Now())
	var out map[string]string
	json.NewDecoder(resp.Body).Decode(&out)
	if resp.StatusCode != 202 || out["run_id"] != "run1" || len(fj.triggered) != 1 || fj.triggered[0] != "monitoring" {
		t.Errorf("signed run: %d %v %v", resp.StatusCode, out, fj.triggered)
	}
}

func TestJobRouteErrors(t *testing.T) {
	e, fj := newJobsEnv(t)
	if got := do(t, "GET", e.srv.URL+"/v1/jobs/ghost/runs", testToken).StatusCode; got != 404 {
		t.Errorf("unknown job: %d", got)
	}
	if got := do(t, "GET", e.srv.URL+"/v1/jobs/monitoring/runs?limit=0", testToken).StatusCode; got != 400 {
		t.Errorf("bad limit: %d", got)
	}
	var runs []store.JobRun
	json.NewDecoder(do(t, "GET", e.srv.URL+"/v1/jobs/empty/runs", testToken).Body).Decode(&runs)
	if runs == nil {
		t.Error("no runs must serialize as [], not null")
	}

	fj.err = jobs.ErrUnknownJob
	if got := e.post(t, "/v1/jobs/ghost/run", "", testSecret, time.Now()).StatusCode; got != 404 {
		t.Errorf("unknown job: %d", got)
	}
	fj.err = jobs.ErrBusy
	if got := e.post(t, "/v1/jobs/monitoring/run", "", testSecret, time.Now().Add(time.Second)).StatusCode; got != 409 {
		t.Errorf("busy job: %d", got)
	}
}

func TestJobRoutesAbsentWithoutJobs(t *testing.T) {
	e := newDeployServer(t) // no Jobs service configured
	if got := do(t, "GET", e.srv.URL+"/v1/jobs", testToken).StatusCode; got != 404 {
		t.Errorf("want 404 when the agent has no jobs, got %d", got)
	}
}
