package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"path/filepath"
	"reflect"
	"slices"
	"strings"
	"testing"
	"time"
)

func open(t *testing.T) *Store {
	t.Helper()
	s, err := Open(filepath.Join(t.TempDir(), "a.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s.Close() })
	return s
}

var ctx = context.Background()

func TestDeploymentLifecycle(t *testing.T) {
	s := open(t)
	start := time.Now().Truncate(time.Millisecond)
	if err := s.CreateDeployment(ctx, Deployment{ID: "d1", App: "web", Ref: "r:v1", Trigger: "api", StartedAt: start}); err != nil {
		t.Fatal(err)
	}
	got, err := s.Deployment(ctx, "d1")
	if err != nil || got.Status != StatusRunning || got.FinishedAt != nil || !got.StartedAt.Equal(start) {
		t.Fatalf("unexpected new deployment: %+v, %v", got, err)
	}

	if err := s.SetPreviousRef(ctx, "d1", "r:v0"); err != nil {
		t.Fatal(err)
	}
	end := start.Add(time.Second)
	if err := s.Finish(ctx, "d1", StatusRolledBack, "boom", "r:v0", end); err != nil {
		t.Fatal(err)
	}
	got, _ = s.Deployment(ctx, "d1")
	if got.Status != StatusRolledBack || got.Error != "boom" || got.PreviousRef != "r:v0" || got.FinishedAt == nil || !got.FinishedAt.Equal(end) {
		t.Errorf("unexpected finished deployment: %+v", got)
	}

	if _, err := s.Deployment(ctx, "nope"); !errors.Is(err, ErrNotFound) {
		t.Errorf("want ErrNotFound, got %v", err)
	}
}

func TestListingAndQueries(t *testing.T) {
	s := open(t)
	base := time.Now()
	add := func(id, app, status string, age time.Duration) {
		if err := s.CreateDeployment(ctx, Deployment{ID: id, App: app, Ref: "r:" + id, Trigger: "api", StartedAt: base.Add(-age)}); err != nil {
			t.Fatal(err)
		}
		if status != StatusRunning {
			s.Finish(ctx, id, status, "", "", base)
		}
	}
	add("old", "web", StatusSucceeded, 3*time.Hour)
	add("mid", "web", StatusFailed, 2*time.Hour)
	add("new", "web", StatusSucceeded, time.Hour)
	add("other", "api", StatusSucceeded, 30*time.Minute)
	add("live", "api", StatusRunning, time.Minute)

	all, _ := s.ListDeployments(ctx, "", 10)
	if len(all) != 5 || all[0].ID != "live" || all[4].ID != "old" {
		t.Errorf("newest-first listing wrong: %v", ids(all))
	}
	web, _ := s.ListDeployments(ctx, "web", 2)
	if got := ids(web); len(got) != 2 || got[0] != "new" || got[1] != "mid" {
		t.Errorf("app filter/limit wrong: %v", got)
	}
	ok, _ := s.Succeeded(ctx, "web", 10)
	if got := ids(ok); len(got) != 2 || got[0] != "new" || got[1] != "old" {
		t.Errorf("Succeeded must skip failed deployments: %v", got)
	}
	run, _ := s.Running(ctx)
	if got := ids(run); len(got) != 1 || got[0] != "live" {
		t.Errorf("Running: %v", got)
	}
}

func ids(ds []Deployment) []string {
	var out []string
	for _, d := range ds {
		out = append(out, d.ID)
	}
	return out
}

func TestEventsAreOrderedAndResumable(t *testing.T) {
	s := open(t)
	s.CreateDeployment(ctx, Deployment{ID: "d", App: "web", Ref: "r", Trigger: "api", StartedAt: time.Now()})
	s.CreateDeployment(ctx, Deployment{ID: "e", App: "web", Ref: "r", Trigger: "api", StartedAt: time.Now()})
	for _, m := range []string{"one", "two", "three"} {
		if err := s.AddEvent(ctx, "d", "info", m, time.Now()); err != nil {
			t.Fatal(err)
		}
	}
	s.AddEvent(ctx, "e", "info", "other deployment", time.Now())

	all, _ := s.Events(ctx, "d", 0)
	if len(all) != 3 || all[0].Message != "one" || all[2].Message != "three" {
		t.Fatalf("got %+v", all)
	}
	rest, _ := s.Events(ctx, "d", all[0].Seq)
	if len(rest) != 2 || rest[0].Message != "two" {
		t.Errorf("resuming after seq %d: %+v", all[0].Seq, rest)
	}
}

func TestRecordRequestRejectsReplaysUntilExpiry(t *testing.T) {
	s := open(t)
	now := time.Now()
	fresh, err := s.RecordRequest(ctx, "sig", now, now.Add(time.Minute))
	if err != nil || !fresh {
		t.Fatalf("first use must be fresh: %v, %v", fresh, err)
	}
	if fresh, _ := s.RecordRequest(ctx, "sig", now, now.Add(time.Minute)); fresh {
		t.Error("second use must be a replay")
	}
	if fresh, _ := s.RecordRequest(ctx, "other", now, now.Add(time.Minute)); !fresh {
		t.Error("a different signature is fresh")
	}
	later := now.Add(2 * time.Minute)
	if fresh, _ := s.RecordRequest(ctx, "sig", later, later.Add(time.Minute)); !fresh {
		t.Error("an expired signature is forgotten")
	}
}

func TestReopenKeepsData(t *testing.T) {
	path := filepath.Join(t.TempDir(), "a.db")
	s, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	s.CreateDeployment(ctx, Deployment{ID: "d", App: "web", Ref: "r", Trigger: "api", StartedAt: time.Now()})
	s.Close()

	s, err = Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if _, err := s.Deployment(ctx, "d"); err != nil {
		t.Errorf("data lost across reopen: %v", err)
	}
}

func TestAppStateUpsertAndList(t *testing.T) {
	s := open(t)
	now := time.Now()
	if _, err := s.AppState(ctx, "web"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("want ErrNotFound, got %v", err)
	}
	s.SetAppState(ctx, AppState{App: "web", Container: "web-1", HostPort: 40001, Ref: "r:v1"}, now)
	s.SetAppState(ctx, AppState{App: "api", Container: "api-1", HostPort: 40002, Ref: "r:a"}, now)
	s.SetAppState(ctx, AppState{App: "web", Container: "web-2", HostPort: 40003, Ref: "r:v2"}, now.Add(time.Second))

	got, err := s.AppState(ctx, "web")
	if err != nil || got.Container != "web-2" || got.HostPort != 40003 || got.Ref != "r:v2" {
		t.Errorf("upsert must replace the previous state: %+v, %v", got, err)
	}
	all, _ := s.AppStates(ctx)
	if len(all) != 2 || all[0].App != "api" || all[1].App != "web" {
		t.Errorf("want one row per app, ordered by name: %+v", all)
	}
}

func TestMigratesAVersion1Database(t *testing.T) {
	path := filepath.Join(t.TempDir(), "old.db")
	old, err := sql.Open("sqlite", "file:"+path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := old.Exec(migrations[0]); err != nil {
		t.Fatal(err)
	}
	old.Exec("PRAGMA user_version = 1")
	old.Exec(`INSERT INTO deployments (id, app, ref, status, trigger, started_at) VALUES ('d','web','r','succeeded','api',1)`)
	old.Close()

	s, err := Open(path)
	if err != nil {
		t.Fatalf("a v1 database must upgrade: %v", err)
	}
	defer s.Close()
	if _, err := s.Deployment(ctx, "d"); err != nil {
		t.Errorf("existing data lost in the upgrade: %v", err)
	}
	if err := s.SetAppState(ctx, AppState{App: "web", Container: "c", HostPort: 1, Ref: "r"}, time.Now()); err != nil {
		t.Errorf("app_state missing after the upgrade: %v", err)
	}
}

// A database written before phases existed upgrades with its deployments and events readable, without phases or a
// serving image, and records phases from then on.
func TestMigratesADatabaseWrittenBeforePhases(t *testing.T) {
	path := filepath.Join(t.TempDir(), "old.db")
	old, err := sql.Open("sqlite", "file:"+path)
	if err != nil {
		t.Fatal(err)
	}
	before := slices.IndexFunc(migrations, func(m string) bool { return strings.Contains(m, "CREATE TABLE deployment_phases") }) // the migration that adds phases
	for _, m := range migrations[:before] {
		if _, err := old.Exec(m); err != nil {
			t.Fatal(err)
		}
	}
	old.Exec(fmt.Sprintf("PRAGMA user_version = %d", before))
	old.Exec(`INSERT INTO deployments (id, app, ref, previous_ref, status, trigger, started_at, finished_at) VALUES ('d','web','r:v2','r:v1','rolled_back','api',1000,2000)`)
	old.Exec(`INSERT INTO deployment_events (deployment_id, time, level, message) VALUES ('d', 1500, 'error', 'it broke')`)
	old.Close()

	s, err := Open(path)
	if err != nil {
		t.Fatalf("a database from before phases must upgrade: %v", err)
	}
	defer s.Close()
	d, err := s.Deployment(ctx, "d")
	if err != nil || d.Status != StatusRolledBack || d.PreviousRef != "r:v1" || d.ServingRef != "" || len(d.Phases) != 0 {
		t.Fatalf("an old deployment reads as it was, with no phases: %+v, %v", d, err)
	}
	evs, err := s.Events(ctx, "d", 0)
	if err != nil || len(evs) != 1 || evs[0].Message != "it broke" || evs[0].Phase != "" {
		t.Fatalf("an old event reads as it was, outside any phase: %+v, %v", evs, err)
	}
	raw, _ := json.Marshal(d)
	if strings.Contains(string(raw), "phases") || strings.Contains(string(raw), "serving_ref") {
		t.Errorf("an old deployment must not show fields it never had: %s", raw)
	}

	if err := s.CreateDeployment(ctx, Deployment{ID: "n", App: "web", Ref: "r:v3", Trigger: "api", StartedAt: time.Now()}); err != nil {
		t.Fatal(err)
	}
	if err := s.BeginPhase(ctx, "n", PhaseRelease, time.Now()); err != nil {
		t.Fatal(err)
	}
	if n, _ := s.Deployment(ctx, "n"); len(n.Phases) != 1 || n.Phases[0].Name != PhaseRelease {
		t.Errorf("a phase is recorded after the upgrade: %+v", n.Phases)
	}
}

func TestPhasesRunOneAfterTheOtherAndFinishClosesTheRunningOne(t *testing.T) {
	s := open(t)
	t0 := time.Now().Truncate(time.Millisecond)
	at := func(sec int) time.Time { return t0.Add(time.Duration(sec) * time.Second) }
	for _, id := range []string{"ok", "bad", "other"} {
		if err := s.CreateDeployment(ctx, Deployment{ID: id, App: "web", Ref: "r:" + id, Trigger: "api", StartedAt: t0}); err != nil {
			t.Fatal(err)
		}
	}
	must := func(err error) {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
	}
	must(s.BeginPhase(ctx, "ok", PhaseRelease, at(0)))
	must(s.BeginPhase(ctx, "ok", PhaseSwitch, at(2)))
	must(s.BeginPhase(ctx, "ok", PhaseSoak, at(5)))
	must(s.EndPhase(ctx, "ok", PhaseSkipped, at(5)))
	must(s.BeginPhase(ctx, "ok", PhaseLive, at(5)))
	must(s.BeginPhase(ctx, "bad", PhaseRelease, at(1)))
	must(s.BeginPhase(ctx, "other", PhaseBuild, at(1)))

	d, _ := s.Deployment(ctx, "ok")
	want := []Phase{
		{Name: PhaseRelease, Status: PhaseDone, StartedAt: at(0).UTC(), FinishedAt: new(at(2).UTC())},
		{Name: PhaseSwitch, Status: PhaseDone, StartedAt: at(2).UTC(), FinishedAt: new(at(5).UTC())},
		{Name: PhaseSoak, Status: PhaseSkipped, StartedAt: at(5).UTC(), FinishedAt: new(at(5).UTC())},
		{Name: PhaseLive, Status: PhaseRunning, StartedAt: at(5).UTC()},
	}
	if !reflect.DeepEqual(d.Phases, want) {
		t.Fatalf("phases of a running deployment:\n got %+v\nwant %+v", d.Phases, want)
	}

	must(s.Finish(ctx, "ok", StatusSucceeded, "", "r:ok", at(6)))
	must(s.Finish(ctx, "bad", StatusRolledBack, "boom", "r:old", at(7)))
	all, _ := s.ListDeployments(ctx, "", 10)
	got := map[string]Deployment{}
	for _, d := range all {
		got[d.ID] = d
	}
	if ok := got["ok"]; ok.ServingRef != "r:ok" || ok.Phases[3].Status != PhaseDone || !ok.Phases[3].FinishedAt.Equal(at(6)) {
		t.Errorf("a success ends its running phase as done: %+v", ok)
	}
	if bad := got["bad"]; bad.ServingRef != "r:old" || len(bad.Phases) != 1 || bad.Phases[0].Status != PhaseFailed {
		t.Errorf("a failure ends its running phase as failed: %+v", bad)
	}
	if o := got["other"]; len(o.Phases) != 1 || o.Phases[0].Name != PhaseBuild || o.Phases[0].Status != PhaseRunning {
		t.Errorf("phases stay with their deployment in a listing: %+v", o)
	}
}

func TestAnEventRecordsThePhaseThatWasRunning(t *testing.T) {
	s := open(t)
	now := time.Now()
	s.CreateDeployment(ctx, Deployment{ID: "d", App: "web", Ref: "r", Trigger: "api", StartedAt: now})
	s.CreateDeployment(ctx, Deployment{ID: "e", App: "web", Ref: "r", Trigger: "api", StartedAt: now})
	s.AddEvent(ctx, "d", "info", "before any phase", now)
	s.BeginPhase(ctx, "d", PhaseRelease, now)
	s.BeginPhase(ctx, "e", PhaseSoak, now)
	s.AddEvent(ctx, "d", "info", "in release", now)
	s.BeginPhase(ctx, "d", PhaseSwitch, now)
	s.AddEvent(ctx, "d", "info", "in switch", now)
	s.Finish(ctx, "d", StatusFailed, "x", "", now)
	s.AddEvent(ctx, "d", "error", "after the end", now)

	evs, _ := s.Events(ctx, "d", 0)
	var got []string
	for _, e := range evs {
		got = append(got, e.Phase)
	}
	if want := []string{"", PhaseRelease, PhaseSwitch, ""}; !reflect.DeepEqual(got, want) {
		t.Errorf("phases of the events: got %q, want %q (another deployment's phase must not leak in)", got, want)
	}
}

func TestRefusesADatabaseFromANewerAgent(t *testing.T) {
	path := filepath.Join(t.TempDir(), "future.db")
	db, _ := sql.Open("sqlite", "file:"+path)
	db.Exec("PRAGMA user_version = 99")
	db.Close()
	if s, err := Open(path); err == nil {
		s.Close()
		t.Error("a schema newer than the agent must be refused, not downgraded")
	}
}

func TestJobRunsLifecycleOutputCapAndPruning(t *testing.T) {
	s := open(t)
	base := time.Now().Truncate(time.Millisecond)
	mk := func(id string, offset time.Duration) {
		if err := s.CreateJobRun(ctx, JobRun{ID: id, Job: "j", Trigger: "schedule", Status: JobRunning, StartedAt: base.Add(offset)}); err != nil {
			t.Fatal(err)
		}
	}
	mk("a", 0)
	run, err := s.JobRun(ctx, "a")
	if err != nil || run.Status != JobRunning || run.FinishedAt != nil {
		t.Fatalf("a new run is running: %+v, %v", run, err)
	}
	if running, _ := s.RunningJobRuns(ctx); len(running) != 1 {
		t.Errorf("RunningJobRuns: %v", running)
	}

	long := strings.Repeat("x", maxJobOutput) + "END"
	if err := s.FinishJobRun(ctx, "a", JobFailed, "HTTP 500", long, base.Add(time.Second)); err != nil {
		t.Fatal(err)
	}
	run, _ = s.JobRun(ctx, "a")
	if run.Status != JobFailed || run.Detail != "HTTP 500" || run.FinishedAt == nil || !strings.HasSuffix(run.Output, "END") || len(run.Output) > maxJobOutput+4 {
		t.Errorf("the output must keep its tail within the cap: %d bytes, %+v", len(run.Output), run.Status)
	}
	if running, _ := s.RunningJobRuns(ctx); len(running) != 0 {
		t.Error("a finished run is not running")
	}

	mk("b", time.Minute)
	mk("c", 2*time.Minute)
	s.CreateJobRun(ctx, JobRun{ID: "other", Job: "other", Trigger: "manual", Status: JobRunning, StartedAt: base})
	runs, _ := s.JobRuns(ctx, "j", 10)
	if len(runs) != 3 || runs[0].ID != "c" || runs[2].ID != "a" {
		t.Errorf("newest first, one job only: %+v", runs)
	}

	if err := s.PruneJobRuns(ctx, "j", 2); err != nil {
		t.Fatal(err)
	}
	runs, _ = s.JobRuns(ctx, "j", 10)
	if len(runs) != 2 || runs[1].ID != "b" {
		t.Errorf("pruning keeps the newest: %+v", runs)
	}
	if other, _ := s.JobRuns(ctx, "other", 10); len(other) != 1 {
		t.Error("pruning one job must not touch another")
	}
	if _, err := s.JobRun(ctx, "nope"); !errors.Is(err, ErrNotFound) {
		t.Errorf("want ErrNotFound, got %v", err)
	}
}

func TestPreviewsRoundTripAndKeepTheirCreationTime(t *testing.T) {
	s := open(t)
	t0 := time.Now().Truncate(time.Millisecond)
	mk := func(name, app string, pr int, ref string, exp time.Duration) Preview {
		return Preview{Name: name, App: app, PR: pr, Domain: "pr-" + name + ".example.com", Ref: ref, DeploymentID: "d-" + ref, ExpiresAt: t0.Add(exp)}
	}

	created, err := s.UpsertPreview(ctx, mk("shop-pr-2", "shop", 2, "r:a", time.Hour), t0)
	if err != nil || !created {
		t.Fatalf("created=%v err=%v", created, err)
	}
	if _, err := s.UpsertPreview(ctx, mk("shop-pr-1", "shop", 1, "r:b", time.Hour), t0.Add(time.Minute)); err != nil {
		t.Fatal(err)
	}

	created, err = s.UpsertPreview(ctx, mk("shop-pr-2", "shop", 2, "r:c", 2*time.Hour), t0.Add(2*time.Minute))
	if err != nil || created {
		t.Fatalf("a second upsert updates: created=%v err=%v", created, err)
	}
	p, err := s.Preview(ctx, "shop-pr-2")
	if err != nil || p.Ref != "r:c" || p.DeploymentID != "d-r:c" || !p.CreatedAt.Equal(t0) || !p.UpdatedAt.Equal(t0.Add(2*time.Minute)) || !p.ExpiresAt.Equal(t0.Add(2*time.Hour)) {
		t.Fatalf("%+v %v", p, err)
	}

	all, err := s.Previews(ctx)
	if err != nil || len(all) != 2 || all[0].Name != "shop-pr-2" || all[1].Name != "shop-pr-1" {
		t.Fatalf("listed oldest first by creation: %+v %v", all, err)
	}

	// (app, pr) is unique: another name for the same pull request is refused.
	if _, err := s.UpsertPreview(ctx, mk("other", "shop", 2, "r:z", time.Hour), t0); err == nil {
		t.Error("two instances of one pull request must be refused")
	}

	if err := s.DeletePreview(ctx, "shop-pr-2"); err != nil {
		t.Fatal(err)
	}
	if err := s.DeletePreview(ctx, "shop-pr-2"); err != nil {
		t.Errorf("deleting twice is fine: %v", err)
	}
	if _, err := s.Preview(ctx, "shop-pr-2"); !errors.Is(err, ErrNotFound) {
		t.Errorf("want ErrNotFound, got %v", err)
	}
}

func TestDeleteAppStateIsIdempotent(t *testing.T) {
	s := open(t)
	if err := s.SetAppState(ctx, AppState{App: "a", Container: "c", HostPort: 1, Ref: "r"}, time.Now()); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 2; i++ {
		if err := s.DeleteAppState(ctx, "a"); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := s.AppState(ctx, "a"); !errors.Is(err, ErrNotFound) {
		t.Errorf("want ErrNotFound, got %v", err)
	}
}

func TestBuiltHere(t *testing.T) {
	s := open(t)
	now := time.Now()
	for _, d := range []Deployment{
		{ID: "b1", App: "web", Ref: "r:a", Trigger: "build", StartedAt: now},
		{ID: "b2", App: "web", Ref: "r:b", Trigger: "build", StartedAt: now},
		{ID: "p1", App: "web", Ref: "r:c", Trigger: "api", StartedAt: now},
	} {
		if err := s.CreateDeployment(ctx, d); err != nil {
			t.Fatal(err)
		}
	}
	if err := s.Finish(ctx, "b1", StatusSucceeded, "", "", now); err != nil {
		t.Fatal(err)
	}
	if err := s.Finish(ctx, "b2", StatusFailed, "boom", "", now); err != nil {
		t.Fatal(err)
	}
	if err := s.Finish(ctx, "p1", StatusSucceeded, "", "", now); err != nil {
		t.Fatal(err)
	}
	for ref, want := range map[string]bool{"r:a": true, "r:b": false, "r:c": false, "r:none": false} {
		if got, err := s.BuiltHere(ctx, "web", ref); err != nil || got != want {
			t.Errorf("%s: got %v, %v", ref, got, err)
		}
	}
	if got, _ := s.BuiltHere(ctx, "other", "r:a"); got {
		t.Error("another app's build must not count")
	}
}

func TestClaimEnrolmentIsAtomicAndSingleUse(t *testing.T) {
	s := open(t)
	now := time.Now()
	const n = 16
	wins := make(chan bool, n)
	for range n {
		go func() {
			fresh, err := s.ClaimEnrolment(ctx, "h1", now.Add(time.Minute), now)
			if err != nil {
				t.Error(err)
			}
			wins <- fresh
		}()
	}
	won := 0
	for range n {
		if <-wins {
			won++
		}
	}
	if won != 1 {
		t.Fatalf("%d concurrent claims of one code succeeded, want exactly 1", won)
	}
	if fresh, _ := s.ClaimEnrolment(ctx, "h1", now.Add(time.Minute), now.Add(time.Second)); fresh {
		t.Error("a used code was claimed again")
	}
	if fresh, _ := s.ClaimEnrolment(ctx, "h2", now.Add(time.Minute), now); !fresh {
		t.Error("another code must be claimable")
	}
	at, ok, err := s.EnrolmentUsed(ctx, "h1")
	if err != nil || !ok || !at.Equal(now.Truncate(time.Millisecond).UTC()) {
		t.Errorf("EnrolmentUsed = %v %v %v", at, ok, err)
	}
	if _, ok, _ := s.EnrolmentUsed(ctx, "nope"); ok {
		t.Error("an unknown code was reported used")
	}
}

func TestPruneEnrolmentsDropsOnlyExpiredRows(t *testing.T) {
	s := open(t)
	now := time.Now()
	s.ClaimEnrolment(ctx, "old", now.Add(-time.Second), now.Add(-time.Hour))
	s.ClaimEnrolment(ctx, "live", now.Add(time.Hour), now)
	if err := s.PruneEnrolments(ctx, now); err != nil {
		t.Fatal(err)
	}
	if _, ok, _ := s.EnrolmentUsed(ctx, "old"); ok {
		t.Error("an expired row was kept")
	}
	if _, ok, _ := s.EnrolmentUsed(ctx, "live"); !ok {
		t.Error("a live row was pruned")
	}
}

func TestStoresOnlyTheHashColumnsOfEnrolments(t *testing.T) {
	s := open(t)
	rows, err := s.db.Query(`SELECT name FROM pragma_table_info('enrolments') ORDER BY cid`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var cols []string
	for rows.Next() {
		var c string
		rows.Scan(&c)
		cols = append(cols, c)
	}
	if strings.Join(cols, ",") != "hash,expires_at,used_at" {
		t.Errorf("enrolments columns = %v", cols)
	}
}

func TestAnImportedImageIsLocalLikeABuiltOne(t *testing.T) {
	s := open(t)
	ctx := context.Background()
	const ref = "keelson-local/shop:0123456789abcdef0123456789abcdef01234567"
	if local, err := s.BuiltHere(ctx, "shop", ref); err != nil || local {
		t.Fatalf("an unknown image is not local: %v %v", local, err)
	}
	if err := s.RecordImport(ctx, "shop", ref, time.Now()); err != nil {
		t.Fatal(err)
	}
	if err := s.RecordImport(ctx, "shop", ref, time.Now()); err != nil {
		t.Fatalf("receiving the same image again is not an error: %v", err)
	}
	if local, err := s.BuiltHere(ctx, "shop", ref); err != nil || !local {
		t.Errorf("a received image exists nowhere else: %v %v", local, err)
	}
	if local, _ := s.BuiltHere(ctx, "api", ref); local {
		t.Error("an image is received for one app, not for any")
	}
	if local, _ := s.BuiltHere(ctx, "shop", ref+"x"); local {
		t.Error("only that ref")
	}
}
