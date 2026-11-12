package install

import (
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"
)

const (
	agentDB         = "agent.db"
	upgradeCopyGlob = agentDB + ".before-upgrade-from-v*"
)

// snapshotsOf lists the copies of the agent's database that an upgrade of the schema leaves in the data directory
// (see the store), with their modification times. Taken before the new binary starts, it tells which copy a start made.
func snapshotsOf(p Paths) map[string]time.Time {
	found := map[string]time.Time{}
	matches, _ := filepath.Glob(filepath.Join(p.DataDir(), upgradeCopyGlob))
	for _, m := range matches {
		if info, err := os.Stat(m); err == nil && info.Mode().IsRegular() {
			found[m] = info.ModTime()
		}
	}
	return found
}

// restoreDatabase puts the agent's database back as it was before the failed upgrade started it. The new version
// migrates agent.db on its first start, after copying it aside; the previous version refuses a schema it does not know,
// so restarting it over the migrated file would leave it crash-looping. It stops the failed agent, replaces agent.db with
// the copy that start made (the newest one that is new or changed since before) and removes the migrated file's
// journal. Best effort: with no such copy the database was not migrated and is left alone, and every problem is logged,
// not returned, because the caller is already undoing a failed upgrade.
func restoreDatabase(sys System, p Paths, before map[string]time.Time, log func(string, ...any)) {
	var copyPath string
	var newest time.Time
	for path, mod := range snapshotsOf(p) {
		if old, existed := before[path]; existed && old.Equal(mod) {
			continue
		}
		if copyPath == "" || mod.After(newest) {
			copyPath, newest = path, mod
		}
	}
	if copyPath == "" {
		return
	}
	log("stopping the new version to put the agent database back as it was before the upgrade")
	if err := sys.Systemctl("stop", unitName); err != nil {
		log("could not stop the new version: %v (the database was not restored: restore %s over %s yourself)", err, copyPath, filepath.Join(p.DataDir(), agentDB))
		return
	}
	db := filepath.Join(p.DataDir(), agentDB)
	if err := copyFileTo(copyPath, db, 0o600); err != nil {
		log("could not restore the agent database from %s: %v (restore it over %s yourself)", copyPath, err, db)
		return
	}
	_ = sys.Chown(db, ServiceUser, ServiceUser)
	for _, journal := range []string{db + "-wal", db + "-shm"} {
		if err := os.Remove(journal); err != nil && !os.IsNotExist(err) {
			log("could not remove %s: %v", journal, err)
		}
	}
	log("restored the agent database from %s", strings.TrimPrefix(copyPath, p.DataDir()+string(filepath.Separator)))
}

// copyFileTo replaces to with a copy of from, written whole under a temporary name first.
func copyFileTo(from, to string, mode os.FileMode) error {
	src, err := os.Open(from)
	if err != nil {
		return err
	}
	defer src.Close()
	tmp, err := os.CreateTemp(filepath.Dir(to), ".restoring-*")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	if _, err := io.Copy(tmp, src); err != nil {
		tmp.Close()
		return fmt.Errorf("copy: %w", err)
	}
	if err := tmp.Chmod(mode); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), to)
}
