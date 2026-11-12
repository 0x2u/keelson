package store

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"time"
)

const snapshotPrefix, snapshotSuffix = "agent-", ".db"

// Snapshot writes a consistent copy of the database to dest (VACUUM INTO: it works while the agent writes, and leaves the
// copy compacted). An existing file at dest is replaced. The copy is readable by the agent's user only.
func (s *Store) Snapshot(ctx context.Context, dest string) error {
	if err := os.Remove(dest); err != nil && !os.IsNotExist(err) {
		return err
	}
	if _, err := s.db.ExecContext(ctx, "VACUUM INTO '"+strings.ReplaceAll(dest, "'", "''")+"'"); err != nil {
		return fmt.Errorf("snapshot of the database: %w", err)
	}
	return os.Chmod(dest, 0o600)
}

// SnapshotInto keeps a few dated copies of the database in dir: it writes one unless the newest is younger than every
// (so an agent that restarts in a loop does not push the good copies out with copies of whatever it found), then removes the
// oldest beyond keep. It returns the path written, or "" when the newest copy was recent enough.
//
// agent.db holds the deployment history, the state of what serves (app_state), the previews and the replay and enrolment
// ledgers. Without it the agent starts blank: the apps file still says what to run, but not what was serving.
func (s *Store) SnapshotInto(ctx context.Context, dir string, now time.Time, every time.Duration, keep int) (string, error) {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", err
	}
	names, err := snapshotNames(dir)
	if err != nil {
		return "", err
	}
	if n := len(names); n > 0 {
		if info, err := os.Stat(filepath.Join(dir, names[n-1])); err == nil && now.Sub(info.ModTime()) < every {
			return "", nil
		}
	}
	path := filepath.Join(dir, snapshotPrefix+now.UTC().Format("20060102-150405")+snapshotSuffix)
	if err := s.Snapshot(ctx, path); err != nil {
		return "", err
	}
	names = append(names, filepath.Base(path))
	slices.Sort(names)
	names = slices.Compact(names)
	for len(names) > keep {
		if err := os.Remove(filepath.Join(dir, names[0])); err != nil && !os.IsNotExist(err) {
			return path, err
		}
		names = names[1:]
	}
	return path, nil
}

// snapshotNames lists the snapshots in dir, oldest first (the names sort by time).
func snapshotNames(dir string) ([]string, error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
	}
	var names []string
	for _, e := range entries {
		if n := e.Name(); !e.IsDir() && strings.HasPrefix(n, snapshotPrefix) && strings.HasSuffix(n, snapshotSuffix) {
			names = append(names, n)
		}
	}
	slices.Sort(names)
	return names, nil
}
