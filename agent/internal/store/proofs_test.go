package store

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"
)

func i64(n int64) *int64 { return &n }

func TestOnlyTheLatestProofOfAKindAndSubjectIsKept(t *testing.T) {
	s := open(t)
	t0 := time.Now().Truncate(time.Millisecond)
	for _, p := range []Proof{
		{ProofKey, "shop", t0},
		{ProofKey, "shop", t0.Add(time.Hour)},
		{ProofKey, "shop", t0.Add(-time.Hour)}, // an older proof never replaces a newer one
		{ProofKey, "blog", t0},
		{ProofRestore, "shop", t0.Add(2 * time.Hour)},
		{ProofAlert, "", t0.Add(3 * time.Hour)},
	} {
		if err := s.RecordProof(ctx, p.Kind, p.Subject, p.At); err != nil {
			t.Fatal(err)
		}
	}
	got, err := s.Proofs(ctx)
	if err != nil {
		t.Fatal(err)
	}
	var lines []string
	for _, p := range got {
		lines = append(lines, p.Kind+"/"+p.Subject+"@"+p.At.Sub(t0).String())
	}
	want := []string{"alert/@3h0m0s", "key/blog@0s", "key/shop@1h0m0s", "restore/shop@2h0m0s"}
	if !slices.Equal(lines, want) {
		t.Errorf("\n got  %v\n want %v", lines, want)
	}
	var shape struct {
		Kind, Subject string
		At            string
	}
	raw, _ := json.Marshal(got[0])
	if err := json.Unmarshal(raw, &shape); err != nil || shape.Kind != "alert" || shape.Subject != "" || !strings.HasSuffix(shape.At, "Z") || !strings.Contains(string(raw), `"at":"`) {
		t.Errorf("shape: %s", raw)
	}
}

func TestProofsOfAFreshStoreIsAnEmptyListNotNull(t *testing.T) {
	got, err := open(t).Proofs(ctx)
	if err != nil || got == nil || len(got) != 0 {
		t.Fatalf("%v %v", got, err)
	}
	if raw, _ := json.Marshal(got); string(raw) != "[]" {
		t.Errorf("%s", raw)
	}
}

func TestProofsSurviveARestartOfTheAgent(t *testing.T) {
	path := filepath.Join(t.TempDir(), "a.db")
	s, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	at := time.Now().Truncate(time.Millisecond)
	s.RecordProof(ctx, ProofRestore, "shop", at)
	s.Close()

	s, err = Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	got, _ := s.Proofs(ctx)
	if len(got) != 1 || got[0].Kind != ProofRestore || got[0].Subject != "shop" || !got[0].At.Equal(at) {
		t.Errorf("%+v", got)
	}
}

// An agent.db written before proofs existed upgrades with what it held, and takes proofs and restore tests from then on.
func TestMigratesADatabaseWrittenBeforeProofs(t *testing.T) {
	path := filepath.Join(t.TempDir(), "old.db")
	old, err := sql.Open("sqlite", "file:"+path)
	if err != nil {
		t.Fatal(err)
	}
	before := slices.IndexFunc(migrations, func(m string) bool { return strings.Contains(m, "CREATE TABLE proofs") }) // the migration that adds proofs
	if before < 1 {
		t.Fatal("no migration adds proofs")
	}
	for _, m := range migrations[:before] {
		if _, err := old.Exec(m); err != nil {
			t.Fatal(err)
		}
	}
	old.Exec(fmt.Sprintf("PRAGMA user_version = %d", before))
	old.Exec(`INSERT INTO deployments (id, app, ref, previous_ref, status, trigger, started_at, finished_at) VALUES ('d','web','r:v2','r:v1','succeeded','api',1000,2000)`)
	old.Exec(`INSERT INTO job_runs (id, job, trigger, status, started_at) VALUES ('j','backup-shop','schedule','succeeded',1000)`)
	old.Close()

	s, err := Open(path)
	if err != nil {
		t.Fatalf("a database from before proofs must upgrade: %v", err)
	}
	defer s.Close()
	if d, err := s.Deployment(ctx, "d"); err != nil || d.Ref != "r:v2" {
		t.Fatalf("what the old database held is still there: %+v %v", d, err)
	}
	if runs, err := s.JobRuns(ctx, "backup-shop", 5); err != nil || len(runs) != 1 {
		t.Fatalf("%+v %v", runs, err)
	}
	if p, err := s.Proofs(ctx); err != nil || len(p) != 0 {
		t.Fatalf("no proof yet: %v %v", p, err)
	}
	if err := s.RecordProof(ctx, ProofKey, "shop", time.Now()); err != nil {
		t.Fatal(err)
	}
	if err := s.CreateRestoreTest(ctx, RestoreTest{ID: "x", Database: "shop", Backup: "shop/k", BackupTime: time.Now(), StartedAt: time.Now()}); err != nil {
		t.Fatal(err)
	}
	// The upgrade copied the old file first, so that going back to the previous agent is possible.
	if matches, _ := filepath.Glob(path + ".before-upgrade-from-v*"); len(matches) != 1 {
		t.Errorf("the old database is kept aside: %v", matches)
	}
}

func TestARestoreTestRoundTripsAndKeepsItsScratchNameOutOfTheJSON(t *testing.T) {
	s := open(t)
	t0 := time.Now().Truncate(time.Millisecond)
	test := RestoreTest{ID: "t1", Database: "shop", Backup: "shop/shop-20261020T030000Z.dump.age", BackupTime: t0.Add(-time.Hour), Scratch: "shop_rt_0badc0de", StartedAt: t0}
	if err := s.CreateRestoreTest(ctx, test); err != nil {
		t.Fatal(err)
	}
	got, err := s.RestoreTests(ctx, "shop", 10)
	if err != nil || len(got) != 1 || got[0].Status != TestRunning || got[0].FinishedAt != nil || got[0].Tables == nil {
		t.Fatalf("%+v %v", got, err)
	}
	raw, _ := json.Marshal(got[0])
	if strings.Contains(string(raw), "scratch") || strings.Contains(string(raw), "shop_rt_") || strings.Contains(string(raw), "finished_at") || strings.Contains(string(raw), `"error"`) || !strings.Contains(string(raw), `"tables":[]`) {
		t.Errorf("a running test: %s", raw)
	}
	if left, _ := s.Scratches(ctx); len(left) != 1 || left[0].Scratch != "shop_rt_0badc0de" || left[0].Database != "shop" {
		t.Errorf("%+v", left)
	}

	tables := []TableCount{{Name: "public.a", BackupRows: i64(3), LiveRows: nil}, {Name: "public.b", BackupRows: nil, LiveRows: i64(0)}}
	if err := s.FinishRestoreTest(ctx, "t1", TestPassed, "", tables, t0.Add(time.Minute)); err != nil {
		t.Fatal(err)
	}
	s.ClearScratch(ctx, "t1")
	got, _ = s.RestoreTests(ctx, "shop", 10)
	raw, _ = json.Marshal(got[0])
	want := `"status":"passed"`
	if !strings.Contains(string(raw), want) || !strings.Contains(string(raw), `"tables":[{"name":"public.a","backup_rows":3,"live_rows":null},{"name":"public.b","backup_rows":null,"live_rows":0}]`) || !strings.Contains(string(raw), `"finished_at"`) {
		t.Errorf("shape: %s", raw)
	}
	if left, _ := s.Scratches(ctx); len(left) != 0 {
		t.Errorf("%+v", left)
	}
	if other, _ := s.RestoreTests(ctx, "blog", 10); other == nil || len(other) != 0 {
		t.Errorf("another database has none, as []: %v", other)
	}
}

func TestAbandoningRestoreTestsFailsOnlyTheRunningOnes(t *testing.T) {
	s := open(t)
	now := time.Now()
	for _, id := range []string{"a", "b"} {
		s.CreateRestoreTest(ctx, RestoreTest{ID: id, Database: "shop", Backup: "k", BackupTime: now, StartedAt: now})
	}
	s.FinishRestoreTest(ctx, "a", TestPassed, "", nil, now)
	if err := s.AbandonRestoreTests(ctx, "interrupted", now.Add(time.Minute)); err != nil {
		t.Fatal(err)
	}
	got, _ := s.RestoreTests(ctx, "shop", 10)
	status := map[string]string{}
	for _, x := range got {
		status[x.ID] = x.Status + ":" + x.Error
		if x.FinishedAt == nil {
			t.Errorf("%s has no end", x.ID)
		}
	}
	if status["a"] != "passed:" || status["b"] != "failed:interrupted" {
		t.Errorf("%v", status)
	}
}
