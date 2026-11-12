package databases

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"strconv"
	"strings"
	"time"

	"filippo.io/age"

	"github.com/0x2u/keelson/agent/internal/config"
	"github.com/0x2u/keelson/agent/internal/store"
)

const (
	// maxTestTables caps the tables a restore test counts, in each database.
	maxTestTables = 200
	// keepRestoreTests is how many tests of a database are kept.
	keepRestoreTests = 20
	// dropTimeout is how long the scratch database has to go, whatever happened to the test (an agent that is shutting down
	// included).
	dropTimeout = time.Minute
	// sweepAttempts bounds how often a start tries to drop the scratch databases of a crashed run: the server may be coming
	// up as well.
	sweepAttempts = 3
)

// defaultSweepWait is how long a start waits between those attempts.
const defaultSweepWait = 20 * time.Second

// RestoreTestRequest asks for a backup to be restored into a scratch database and compared with the live one. Identity is the
// age secret key that opens the backup: held in memory for the run, never logged, stored or passed to a container.
type RestoreTestRequest struct {
	Database string
	// Backup is the key of the backup to test; empty means the newest scheduled one.
	Backup   string
	Identity string
}

// scratchName is the name of the throwaway database of a test: "<database>_rt_<8 hex>".
func scratchName(database string) string { return identWithSuffix(database, "_rt_"+store.NewID()[:8]) }

// StartRestoreTest checks a request and runs the test in the background; the result is read with RestoreTests. It refuses
// before anything exists when the database has no backup, the identity is not an age key, the backup is not one of this
// database's, or a restore, a test or a backup of the database is running now.
func (s *Service) StartRestoreTest(ctx context.Context, req RestoreTestRequest) (store.RestoreTest, error) {
	db, err := s.database(req.Database)
	if err != nil {
		return store.RestoreTest{}, err
	}
	if db.Backups == nil {
		return store.RestoreTest{}, &RequestError{fmt.Sprintf("database %s has no backup section: there is nothing to test", db.Name)}
	}
	id, err := age.ParseX25519Identity(strings.TrimSpace(req.Identity))
	if err != nil {
		return store.RestoreTest{}, &RequestError{"identity must be an age secret key (AGE-SECRET-KEY-1...)"}
	}
	if req.Backup != "" {
		if _, ok := ParseKey(db.Name, req.Backup); !ok {
			return store.RestoreTest{}, &RequestError{"backup is not the key of a backup of this database"}
		}
	}

	s.mu.Lock()
	switch {
	case s.closed:
		s.mu.Unlock()
		return store.RestoreTest{}, ErrShuttingDown
	case s.restoring[db.Name]:
		s.mu.Unlock()
		return store.RestoreTest{}, ErrRestoreBusy
	case s.testing[db.Name]:
		s.mu.Unlock()
		return store.RestoreTest{}, ErrTestBusy
	case s.backups[db.Name] > 0:
		s.mu.Unlock()
		return store.RestoreTest{}, fmt.Errorf("restore test of %s refused: %w", db.Name, ErrBackupBusy)
	}
	s.testing[db.Name] = true
	s.wg.Add(1)
	s.mu.Unlock()

	key, at, err := s.pickBackup(ctx, db, req.Backup)
	if errors.Is(err, errNoBackup) {
		err = &RequestError{fmt.Sprintf("database %s has no scheduled backup to test yet", db.Name)}
	}
	t := store.RestoreTest{ID: store.NewID(), Database: db.Name, Backup: key, BackupTime: at, Scratch: scratchName(db.Database), StartedAt: s.now()}
	if err == nil {
		err = s.store.CreateRestoreTest(ctx, t)
	}
	if err != nil {
		s.endTest(db.Name)
		return store.RestoreTest{}, err
	}
	go s.runRestoreTest(db, t, id)
	return t, nil
}

func (s *Service) endTest(name string) {
	s.mu.Lock()
	delete(s.testing, name)
	s.mu.Unlock()
	s.wg.Done()
}

// RestoreTests returns the recent restore tests of a database, newest first.
func (s *Service) RestoreTests(ctx context.Context, name string, limit int) ([]store.RestoreTest, error) {
	if _, err := s.database(name); err != nil {
		return nil, err
	}
	return s.store.RestoreTests(ctx, name, limit)
}

// runRestoreTest runs a test to its end and records it. A passed test is also a proof that the database can be restored.
func (s *Service) runRestoreTest(db config.Database, t store.RestoreTest, identity age.Identity) {
	defer s.endTest(db.Name)
	ctx, cancel := context.WithTimeout(s.ctx, restoreTimeout)
	defer cancel()

	tables, err := s.restoreTest(ctx, db, t, identity)
	if err == nil {
		err = verdict(tables)
	}
	status, detail := store.TestPassed, ""
	if err != nil {
		status, detail = store.TestFailed, err.Error()
		if errors.Is(ctx.Err(), context.DeadlineExceeded) {
			detail = fmt.Sprintf("timed out after %s", restoreTimeout)
		} else if s.ctx.Err() != nil {
			detail = "cancelled: the agent is shutting down"
		}
	}
	bg := context.Background()
	at := s.now()
	if ferr := s.store.FinishRestoreTest(bg, t.ID, status, detail, tables, at); ferr != nil {
		s.log.Error("record restore test", "database", db.Name, "test", t.ID, "err", ferr)
	} else if status == store.TestPassed {
		if perr := s.store.RecordProof(bg, store.ProofRestore, db.Name, at); perr != nil {
			s.log.Error("record the proof of a restore test", "database", db.Name, "test", t.ID, "err", perr)
		}
	}
	if perr := s.store.PruneRestoreTests(bg, db.Name, keepRestoreTests); perr != nil {
		s.log.Warn("prune restore tests", "database", db.Name, "err", perr)
	}
	s.log.Info("restore test finished", "database", db.Name, "test", t.ID, "backup", t.Backup, "status", status, "detail", detail)
}

// restoreTest restores the backup into the scratch database of t, counts the rows of every table there and in the live
// database, and drops the scratch database whatever happened. A scratch database that cannot be dropped fails the test:
// it is a stray database on the server, and its name stays recorded for the next start.
func (s *Service) restoreTest(ctx context.Context, db config.Database, t store.RestoreTest, identity age.Identity) (tables []store.TableCount, err error) {
	d, cleanup, err := s.stageDump(ctx, db, t.Backup, identity, func(string) {})
	if err != nil {
		s.clearScratch(t.ID) // nothing was created
		return nil, err
	}
	defer cleanup()

	// From here the scratch database may exist, even when creating it reports a failure (a cut connection).
	defer func() {
		dctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), dropTimeout)
		defer cancel()
		if derr := s.dropDatabase(dctx, db, d.password, d.image, t.Scratch); derr != nil {
			derr = fmt.Errorf("the scratch database %s could not be dropped, drop it by hand: %w", t.Scratch, derr)
			if err == nil {
				err = derr
			} else {
				err = fmt.Errorf("%w; %v", err, derr)
			}
			return
		}
		s.clearScratch(t.ID)
	}()
	if err := s.createDatabase(ctx, db, d, t.Scratch); err != nil {
		return nil, fmt.Errorf("create the scratch database: %w", err)
	}
	if _, err := s.pgRestore(ctx, db, d, t.Scratch, false); err != nil {
		return nil, fmt.Errorf("pg_restore: %w", err)
	}
	backup, backupCapped, err := s.tableCounts(ctx, db, d, t.Scratch)
	if err != nil {
		return nil, fmt.Errorf("count the rows of the restored database: %w", err)
	}
	live, liveCapped, err := s.tableCounts(ctx, db, d, db.Database)
	if err != nil {
		return nil, fmt.Errorf("count the rows of the live database: %w", err)
	}
	return mergeCounts(backup, live, backupCapped, liveCapped), nil
}

func (s *Service) clearScratch(id string) {
	if err := s.store.ClearScratch(context.Background(), id); err != nil {
		s.log.Error("record that the scratch database of a restore test is gone", "test", id, "err", err)
	}
}

// tableCount is the rows of one table, named "schema.table".
type tableCount struct {
	name string
	rows int64
}

// tableCounts counts the rows of every table of a database, at most maxTestTables of them, in the byte order of their
// names. capped says there were more: only the first ones are returned.
func (s *Service) tableCounts(ctx context.Context, db config.Database, d stagedDump, dbname string) (counts []tableCount, capped bool, err error) {
	query := `select table_schema || '.' || table_name || '|' || (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from %I.%I', table_schema, table_name), false, true, '')))[1]::text ` +
		`from information_schema.tables where table_schema not in ('pg_catalog', 'information_schema', 'pg_toast') and table_type = 'BASE TABLE' ` +
		`order by (table_schema || '.' || table_name) collate "C" limit ` + strconv.Itoa(maxTestTables+1)
	cmd := append([]string{"psql"}, conn(db, dbname)...)
	cmd = append(cmd, "-X", "-At", "-v", "ON_ERROR_STOP=1", "-c", query)
	lines, err := s.pg(ctx, db, d.password, d.image, nil, cmd)
	if err != nil {
		return nil, false, err
	}
	for _, l := range lines {
		name, rows, ok := cutLast(strings.TrimSpace(l), "|")
		n, perr := strconv.ParseInt(rows, 10, 64)
		if !ok || perr != nil {
			continue
		}
		counts = append(counts, tableCount{name, n})
	}
	if len(counts) > maxTestTables {
		return counts[:maxTestTables], true, nil
	}
	return counts, false, nil
}

// mergeCounts lines up the tables of the restored backup and of the live database by name. A table that only one of them has
// carries null on the other side. When a side was capped the tables after its last one are not known there: they are left
// out of both, so that a table is never reported missing only because of where the cap fell.
func mergeCounts(backup, live []tableCount, backupCapped, liveCapped bool) []store.TableCount {
	limit, limited := "", false
	for _, side := range []struct {
		counts []tableCount
		capped bool
	}{{backup, backupCapped}, {live, liveCapped}} {
		if side.capped {
			if last := side.counts[len(side.counts)-1].name; !limited || last < limit {
				limit, limited = last, true
			}
		}
	}
	byName := map[string]*store.TableCount{}
	add := func(counts []tableCount, set func(*store.TableCount, *int64)) {
		for _, c := range counts {
			if limited && c.name > limit {
				continue
			}
			t := byName[c.name]
			if t == nil {
				t = &store.TableCount{Name: c.name}
				byName[c.name] = t
			}
			rows := c.rows
			set(t, &rows)
		}
	}
	add(backup, func(t *store.TableCount, n *int64) { t.BackupRows = n })
	add(live, func(t *store.TableCount, n *int64) { t.LiveRows = n })
	out := make([]store.TableCount, 0, len(byName))
	for _, t := range byName {
		out = append(out, *t)
	}
	slices.SortFunc(out, func(a, b store.TableCount) int { return strings.Compare(a.Name, b.Name) })
	return out
}

// verdict says whether a restore test passed: the restore ended without an error (the caller checks that), the restored
// database has at least one table, and either the live database holds no row at all or the restored one holds at least one.
// The two counts differ as a rule (the backup is older): the difference is reported, not judged. A nil result is a pass.
func verdict(tables []store.TableCount) error {
	var backupTables int
	var backupRows, liveRows int64
	for _, t := range tables {
		if t.BackupRows != nil {
			backupTables++
			backupRows += *t.BackupRows
		}
		if t.LiveRows != nil {
			liveRows += *t.LiveRows
		}
	}
	switch {
	case backupTables == 0:
		return errors.New("the restored database has no table")
	case liveRows > 0 && backupRows == 0:
		return fmt.Errorf("the restored database holds no row, and the live database holds %d", liveRows)
	}
	return nil
}

// RecoverRestoreTests settles what a stop of the agent left of restore tests: a test that was running is failed, and the
// scratch databases that may still exist (a test cut short, or one that could not drop its own) are dropped in the
// background. It runs once at start, before the API takes requests.
func (s *Service) RecoverRestoreTests(ctx context.Context) error {
	if err := s.store.AbandonRestoreTests(ctx, "interrupted: the agent stopped while the test ran", s.now()); err != nil {
		return err
	}
	stale, err := s.store.Scratches(ctx)
	if err != nil {
		return err
	}
	if len(stale) > 0 {
		s.wg.Add(1)
		go s.sweepScratches(stale)
	}
	return nil
}

func (s *Service) sweepScratches(stale []store.RestoreTest) {
	defer s.wg.Done()
	for _, t := range stale {
		var err error
		for attempt := range sweepAttempts {
			if attempt > 0 {
				select {
				case <-s.ctx.Done():
					return
				case <-time.After(s.sweepWait):
				}
			}
			if err = s.sweepScratch(t); err == nil {
				break
			}
		}
		if err != nil {
			s.log.Warn("could not drop a scratch database left by a restore test: it is tried again at the next start", "database", t.Database, "scratch", t.Scratch, "err", err)
		}
	}
}

// sweepScratch drops one scratch database. One that cannot be dropped because the database it belongs to is no longer
// configured is forgotten: there is no server to reach.
func (s *Service) sweepScratch(t store.RestoreTest) error {
	db, ok := s.config().Database(t.Database)
	if !ok || !targetPattern.MatchString(t.Scratch) {
		s.log.Warn("a scratch database left by a restore test cannot be dropped: its database is not configured", "database", t.Database, "scratch", t.Scratch)
		return s.store.ClearScratch(s.ctx, t.ID)
	}
	ctx, cancel := context.WithTimeout(s.ctx, dropTimeout)
	defer cancel()
	password, err := readPassword(db)
	if err != nil {
		return err
	}
	image, err := s.clientImage(ctx, db, password)
	if err != nil {
		return err
	}
	if err := s.ensureImage(ctx, image, nil); err != nil {
		return err
	}
	if err := s.dropDatabase(ctx, db, password, image, t.Scratch); err != nil {
		return err
	}
	s.log.Info("dropped a scratch database left by a restore test", "database", t.Database, "scratch", t.Scratch)
	return s.store.ClearScratch(s.ctx, t.ID)
}
