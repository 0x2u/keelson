package store

import (
	"context"
	"os"
	"path/filepath"
	"testing"
)

// testdata/agent-v0.1.0.db is an agent.db written by the v0.1.0 release: four deployments (succeeded, succeeded,
// rolled back, still running), an app state, an imported image, a configuration version, an audit entry and a job
// run. It is never regenerated: every later version must open it and keep what it holds, which is what an operator
// who updates the agent expects.
func TestTheDatabaseOfTheFirstReleaseOpensAndKeepsItsHistory(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "agent.db")
	fixture, err := os.ReadFile("testdata/agent-v0.1.0.db")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, fixture, 0o600); err != nil {
		t.Fatal(err)
	}
	st, err := Open(path)
	if err != nil {
		t.Fatalf("this version cannot open the database of v0.1.0: %v", err)
	}
	defer st.Close()

	var v int
	if err := st.db.QueryRow("PRAGMA user_version").Scan(&v); err != nil || v != len(migrations) {
		t.Fatalf("schema version %d (%v), want %d", v, err, len(migrations))
	}

	deps, err := st.ListDeployments(ctx, "web", 10)
	if err != nil || len(deps) != 4 {
		t.Fatalf("deployments: %d (%v), want 4", len(deps), err)
	}
	byID := map[string]Deployment{}
	for _, d := range deps {
		byID[d.ID] = d
	}
	const repo = "ghcr.io/acme/web"
	if d := byID["d-0002"]; d.Status != StatusSucceeded || d.Ref != repo+":2" || d.PreviousRef != repo+":1" || d.ServingRef != repo+":2" {
		t.Errorf("a succeeded deployment changed: %+v", d)
	}
	if d := byID["d-0003"]; d.Status != StatusRolledBack || d.Error != "container exited with code 1" || d.ServingRef != repo+":2" {
		t.Errorf("a rolled back deployment changed: %+v", d)
	}
	if d := byID["d-0001"]; len(d.Phases) != 2 || d.Phases[0].Name != PhaseRelease {
		t.Errorf("the phases of a deployment were lost: %+v", d.Phases)
	}
	if ev, err := st.Events(ctx, "d-0001", 0); err != nil || len(ev) != 1 {
		t.Errorf("events: %v (%v)", ev, err)
	}

	// What a restart after the update does with the deployment the old agent left running.
	if running, err := st.Running(ctx); err != nil || len(running) != 1 || running[0].ID != "d-0004" {
		t.Errorf("the interrupted deployment must still be found: %v (%v)", running, err)
	}
	if ok, err := st.BuiltHere(ctx, "web", repo+":local"); err != nil || !ok {
		t.Errorf("an image built here must still be known: %v (%v)", ok, err)
	}
	if s, err := st.AppState(ctx, "web"); err != nil || s.Container != "web-d-0002" || s.HostPort != 8101 || s.Ref != repo+":2" {
		t.Errorf("app state: %+v (%v)", s, err)
	}
	if c, err := st.LatestConfigVersion(ctx); err != nil || c.Hash != "abc123" || c.Content == "" {
		t.Errorf("configuration version: %+v (%v)", c, err)
	}
	if a, err := st.Audit(ctx, 10, 0); err != nil || len(a) != 1 || a[0].Action != "deploy" {
		t.Errorf("audit: %+v (%v)", a, err)
	}
	if r, err := st.JobRuns(ctx, "daily-report", 10); err != nil || len(r) != 1 || r[0].Status != "succeeded" {
		t.Errorf("job runs: %+v (%v)", r, err)
	}

	// And the database keeps working: a new deployment is written next to the old ones.
	if err := st.CreateDeployment(ctx, Deployment{ID: "d-0005", App: "web", Ref: repo + ":5", Trigger: "api", StartedAt: deps[0].StartedAt}); err != nil {
		t.Errorf("a new deployment after the upgrade: %v", err)
	}
}
