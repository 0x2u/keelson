package install

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func writeAged(t *testing.T, path, content string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	old := time.Now().Add(-48 * time.Hour)
	if err := os.Chtimes(path, old, old); err != nil {
		t.Fatal(err)
	}
}

// migratingStart makes the first start of the new version do what the agent's store does: copy the database aside,
// migrate it (the file and its journal change) and then fail to come up.
func migratingStart(t *testing.T, p Paths, snapshot string) func() {
	return func() {
		dir := p.DataDir()
		for name, content := range map[string]string{snapshot: "before the upgrade", "agent.db": "migrated", "agent.db-wal": "journal of the migrated file"} {
			if err := os.WriteFile(filepath.Join(dir, name), []byte(content), 0o600); err != nil {
				t.Error(err)
			}
		}
	}
}

func stoppedBeforeLastRestart(r *rig) bool {
	first, stop, last := -1, -1, -1
	for i, c := range r.sys.ctl {
		switch strings.Join(c, " ") {
		case "restart keelson-agent.service":
			if first < 0 {
				first = i
			}
			last = i
		case "stop keelson-agent.service":
			stop = i
		}
	}
	return first >= 0 && first < stop && stop < last
}

func TestAFailedUpgradeRestoresTheAgentDatabaseTheNewVersionMigrated(t *testing.T) {
	r := newRig(t)
	r.install()
	p := Paths{r.root}
	db := filepath.Join(p.DataDir(), "agent.db")
	os.WriteFile(db, []byte("data at v2"), 0o600)
	// Copies of earlier upgrades are not what this upgrade made: one is left alone, one is rewritten by this start.
	writeAged(t, filepath.Join(p.DataDir(), "agent.db.before-upgrade-from-v1"), "ancient")
	writeAged(t, filepath.Join(p.DataDir(), "agent.db.before-upgrade-from-v2"), "stale")

	r.sys.onRestart = migratingStart(t, p, "agent.db.before-upgrade-from-v2")
	r.opts.HealthCheck = func(string, []byte, Leaf) error { return errors.New("connection refused") }
	ctx, cancel := context.WithTimeout(context.Background(), 600*time.Millisecond)
	defer cancel()
	var log []string
	r.opts.Log = func(f string, a ...any) { log = append(log, f) }
	if _, err := Install(ctx, r.opts); err == nil || !strings.Contains(err.Error(), "previous version was restored") {
		t.Fatalf("got %v", err)
	}
	if got := r.read("var/lib/keelson/agent.db"); got != "before the upgrade" {
		t.Errorf("the database must be the copy made by the failed start, got %q", got)
	}
	if exists(db + "-wal") {
		t.Error("the migrated file's journal must not stay beside the restored database")
	}
	if got := r.read("var/lib/keelson/agent.db.before-upgrade-from-v1"); got != "ancient" {
		t.Errorf("another upgrade's copy is untouched: %q", got)
	}
	if mode(t, db) != 0o600 {
		t.Errorf("mode %o", mode(t, db))
	}
	if r.sys.owners[db] != "keelson:keelson" {
		t.Errorf("owner %q", r.sys.owners[db])
	}
	if !stoppedBeforeLastRestart(r) {
		t.Errorf("the failed version is stopped before the database goes back and the previous one starts: %v", r.sys.ctl)
	}
	if !strings.Contains(strings.Join(log, "\n"), "restored the agent database") {
		t.Errorf("the restore is logged: %v", log)
	}
}

func TestAFailedUpgradeThatDidNotMigrateLeavesTheDatabaseAlone(t *testing.T) {
	r := newRig(t)
	r.install()
	p := Paths{r.root}
	db := filepath.Join(p.DataDir(), "agent.db")
	os.WriteFile(db, []byte("data"), 0o600)
	writeAged(t, filepath.Join(p.DataDir(), "agent.db.before-upgrade-from-v1"), "ancient")

	r.opts.HealthCheck = func(string, []byte, Leaf) error { return errors.New("connection refused") }
	ctx, cancel := context.WithTimeout(context.Background(), 600*time.Millisecond)
	defer cancel()
	if _, err := Install(ctx, r.opts); err == nil || !strings.Contains(err.Error(), "previous version was restored") {
		t.Fatalf("got %v", err)
	}
	if got := r.read("var/lib/keelson/agent.db"); got != "data" {
		t.Errorf("no copy was made by this start, so the database stays: %q", got)
	}
	for _, c := range r.sys.ctl {
		if c[0] == "stop" {
			t.Errorf("nothing to restore, nothing to stop: %v", r.sys.ctl)
		}
	}
}

func TestAFailedConnectedUpgradeRestoresTheAgentDatabase(t *testing.T) {
	r, g := connectRig(t)
	if _, err := r.connect(g); err != nil {
		t.Fatal(err)
	}
	p := Paths{r.root}
	os.WriteFile(filepath.Join(p.DataDir(), "agent.db"), []byte("data at v2"), 0o600)

	r.sys.stillActive = false
	r.sys.onRestart = migratingStart(t, p, "agent.db.before-upgrade-from-v2")
	r.opts = Options{Root: r.root, Binary: r.opts.Binary, Version: "1.3.0", Sys: r.sys, Upgrade: true, settle: time.Nanosecond}
	if _, err := InstallConnected(context.Background(), r.opts, nil); err == nil || !strings.Contains(err.Error(), "previous version was restored") {
		t.Fatalf("got %v", err)
	}
	if got := r.read("var/lib/keelson/agent.db"); got != "before the upgrade" {
		t.Errorf("the database must be the copy made by the failed start, got %q", got)
	}
	if exists(filepath.Join(p.DataDir(), "agent.db-wal")) {
		t.Error("the migrated file's journal must not stay")
	}
	if !stoppedBeforeLastRestart(r) {
		t.Errorf("stop, restore, then restart: %v", r.sys.ctl)
	}
}
