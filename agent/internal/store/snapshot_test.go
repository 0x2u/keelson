package store

import (
	"database/sql"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func countRows(t *testing.T, path, query string) int {
	t.Helper()
	db, err := sql.Open("sqlite", "file:"+path+"?mode=ro")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	var n int
	if err := db.QueryRow(query).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

func TestSnapshotIsAConsistentPrivateCopy(t *testing.T) {
	s, err := Open(filepath.Join(t.TempDir(), "a.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if err := s.SetAppState(ctx, AppState{App: "web", Container: "web-0123456789abcdef", HostPort: 3000, Ref: "r"}, time.Now()); err != nil {
		t.Fatal(err)
	}
	dest := filepath.Join(t.TempDir(), "copy.db")
	for range 2 { // the second replaces the first
		if err := s.Snapshot(ctx, dest); err != nil {
			t.Fatal(err)
		}
	}
	if n := countRows(t, dest, "SELECT count(*) FROM app_state WHERE container = 'web-0123456789abcdef'"); n != 1 {
		t.Errorf("the copy must hold what was serving: %d rows", n)
	}
	if info, _ := os.Stat(dest); info.Mode().Perm() != 0o600 {
		t.Errorf("the copy holds deployment history and ledgers: mode %v", info.Mode().Perm())
	}
}

// One copy per period, the oldest beyond keep removed: and a restart loop must not push the good copies out.
func TestSnapshotIntoKeepsDatedCopiesAndIsNotFooledByARestartLoop(t *testing.T) {
	s, err := Open(filepath.Join(t.TempDir(), "a.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	dir := filepath.Join(t.TempDir(), "snapshots")
	day := 24 * time.Hour
	t0 := time.Date(2026, 10, 1, 3, 0, 0, 0, time.UTC)

	// The files' own times are what "younger than every" reads: make them follow the clock of the test.
	write := func(now time.Time) string {
		t.Helper()
		p, err := s.SnapshotInto(ctx, dir, now, 20*time.Hour, 3)
		if err != nil {
			t.Fatal(err)
		}
		if p != "" {
			os.Chtimes(p, now, now)
		}
		return p
	}
	if write(t0) == "" {
		t.Fatal("the first copy must be written")
	}
	for i := 1; i <= 5; i++ { // an agent restarting in a loop, minutes apart
		if p := write(t0.Add(time.Duration(i) * time.Minute)); p != "" {
			t.Fatalf("a copy %d minutes after the last must not be taken: %s", i, p)
		}
	}
	for d := 1; d <= 4; d++ {
		if write(t0.Add(time.Duration(d)*day)) == "" {
			t.Fatalf("day %d: a copy is due", d)
		}
	}
	names, err := snapshotNames(dir)
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"agent-20261002-030000.db", "agent-20261003-030000.db", "agent-20261004-030000.db", "agent-20261005-030000.db"}[1:]
	if len(names) != 3 || names[0] != want[0] || names[2] != want[2] {
		t.Errorf("only the newest three stay: %v", names)
	}
}

// A schema upgrade is forward-only and an older agent refuses a newer schema: the database as it was is kept next to it.
func TestAnUpgradeOfAnExistingDatabaseKeepsTheOldOneBesideIt(t *testing.T) {
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
		t.Fatal(err)
	}
	s.Close()
	kept := path + ".before-upgrade-from-v1"
	if n := countRows(t, kept, "SELECT count(*) FROM deployments"); n != 1 {
		t.Errorf("the copy must hold the data as it was: %d", n)
	}
	if v := countRows(t, kept, "PRAGMA user_version"); v != 1 {
		t.Errorf("the copy must keep the old schema, so that the previous agent can use it: version %d", v)
	}

	// An up to date database, and a new one, are not copied.
	s, err = Open(path)
	if err != nil {
		t.Fatal(err)
	}
	s.Close()
	fresh := filepath.Join(t.TempDir(), "fresh.db")
	s, err = Open(fresh)
	if err != nil {
		t.Fatal(err)
	}
	s.Close()
	if _, err := os.Stat(fresh + ".before-upgrade-from-v0"); !os.IsNotExist(err) {
		t.Errorf("a new database has nothing to keep: %v", err)
	}
	if entries, _ := filepath.Glob(path + ".before-upgrade-*"); len(entries) != 1 {
		t.Errorf("an up to date database is not copied again: %v", entries)
	}
}
