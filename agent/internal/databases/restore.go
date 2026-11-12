package databases

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"filippo.io/age"

	"github.com/0x2u/keelson/agent/internal/config"
	"github.com/0x2u/keelson/agent/internal/store"
)

const (
	// maxRowCountTables caps the final row-count line.
	maxRowCountTables = 50
	maxRestoreLines   = 200
	maxTargetLen      = 63
)

var targetPattern = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]{0,62}$`)

// ValidTarget reports whether name is a plain identifier a restore may create.
func ValidTarget(name string) bool { return targetPattern.MatchString(name) }

// RestoreRequest asks for one backup to be restored. Identity is the age secret key that can read it: it is held in
// memory for the run and is never logged, stored, written to disk or passed to a container.
type RestoreRequest struct {
	Database string
	Backup   string
	Identity string
	// Target is the database to restore into; empty means a new "<database>_restore_<YYYYMMDD>".
	Target string
	// Overwrite and Confirm are both needed to restore over the live database: Confirm must be its name.
	Overwrite bool
	Confirm   string
}

// RestoreStarted is what a accepted restore reports at once.
type RestoreStarted struct {
	RunID  string
	Target string
}

// restoreJob is a validated request: the identity is parsed, the target resolved.
type restoreJob struct {
	key      string
	identity age.Identity
	target   string
	live     bool
}

// Restore checks a request and starts the restore in the background. It refuses before any run exists when the
// request is wrong: an unknown backup, a key that is not an age key, a target that is not a plain name, the live
// database without overwrite and its name as confirmation, or a restore already running for this database.
func (s *Service) Restore(ctx context.Context, req RestoreRequest) (RestoreStarted, error) {
	db, err := s.database(req.Database)
	if err != nil {
		return RestoreStarted{}, err
	}
	if db.Backups == nil {
		return RestoreStarted{}, &RequestError{fmt.Sprintf("database %s has no backup section: there is nothing to restore from", db.Name)}
	}
	if _, ok := ParseKey(db.Name, req.Backup); !ok {
		return RestoreStarted{}, &RequestError{"backup is not the key of a backup of this database"}
	}
	id, err := age.ParseX25519Identity(strings.TrimSpace(req.Identity))
	if err != nil {
		return RestoreStarted{}, &RequestError{"identity must be an age secret key (AGE-SECRET-KEY-1...)"}
	}

	job := restoreJob{key: req.Backup, identity: id, target: req.Target}
	if job.target == "" {
		job.target = defaultTarget(db.Database, s.now())
	}
	job.live = job.target == db.Database
	switch {
	case job.live:
		if !req.Overwrite || req.Confirm != db.Database {
			return RestoreStarted{}, &RequestError{fmt.Sprintf("restoring over the live database needs overwrite: true and confirm: %q", db.Database)}
		}
	case !targetPattern.MatchString(job.target):
		return RestoreStarted{}, &RequestError{fmt.Sprintf("target must match %s", targetPattern)}
	}

	s.mu.Lock()
	switch {
	case s.closed:
		s.mu.Unlock()
		return RestoreStarted{}, ErrShuttingDown
	case s.restoring[db.Name]:
		s.mu.Unlock()
		return RestoreStarted{}, ErrRestoreBusy
	case s.testing[db.Name]:
		s.mu.Unlock()
		return RestoreStarted{}, ErrTestBusy
	case s.backups[db.Name] > 0:
		s.mu.Unlock()
		return RestoreStarted{}, fmt.Errorf("restore of %s refused: %w", db.Name, ErrBackupBusy)
	}
	s.restoring[db.Name] = true
	s.wg.Add(1)
	s.mu.Unlock()

	runID := store.NewID()
	startedAt := s.now()
	if err := s.store.CreateJobRun(ctx, store.JobRun{ID: runID, Job: restoreJobName(db.Name), Trigger: "manual", Status: store.JobRunning, StartedAt: startedAt}); err != nil {
		s.endRestore(db.Name)
		s.wg.Done()
		return RestoreStarted{}, err
	}
	go s.runRestore(runID, db, job)
	return RestoreStarted{RunID: runID, Target: job.target}, nil
}

// defaultTarget names the database a restore creates when none is asked for. The name is made a plain identifier.
func defaultTarget(database string, now time.Time) string {
	return identWithSuffix(database, "_restore_"+now.UTC().Format("20060102"))
}

// identWithSuffix is database made a plain identifier (a name that starts with a digit gets a prefix), cut so that with the
// suffix it fits a PostgreSQL database name.
func identWithSuffix(database, suffix string) string {
	base := strings.Map(func(r rune) rune {
		if r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || r == '_' {
			return r
		}
		return '_'
	}, database)
	if base[0] >= '0' && base[0] <= '9' {
		base = "db_" + base
	}
	if len(base)+len(suffix) > maxTargetLen {
		base = base[:maxTargetLen-len(suffix)]
	}
	return base + suffix
}

func (s *Service) endRestore(name string) {
	s.mu.Lock()
	delete(s.restoring, name)
	s.mu.Unlock()
}

// output keeps the last lines of a run.
type output struct {
	mu    sync.Mutex
	lines []string
}

func (o *output) add(line string) {
	o.mu.Lock()
	defer o.mu.Unlock()
	o.lines = append(o.lines, line)
	if len(o.lines) > maxRestoreLines {
		o.lines = o.lines[len(o.lines)-maxRestoreLines:]
	}
}

func (o *output) String() string {
	o.mu.Lock()
	defer o.mu.Unlock()
	return strings.Join(o.lines, "\n")
}

// runRestore runs a restore to its end and records how it went. A restore is not cancelled by a configuration
// reload: it works with the definition it started with. It is cancelled when the agent shuts down.
func (s *Service) runRestore(runID string, db config.Database, job restoreJob) {
	defer s.wg.Done()
	defer s.endRestore(db.Name)
	ctx, cancel := context.WithTimeout(s.ctx, restoreTimeout)
	defer cancel()

	var out output
	err := s.restore(ctx, db, job, out.add)
	status, detail := store.JobSucceeded, ""
	if err != nil {
		status, detail = store.JobFailed, err.Error()
		if errors.Is(ctx.Err(), context.DeadlineExceeded) {
			detail = fmt.Sprintf("timed out after %s", restoreTimeout)
		} else if s.ctx.Err() != nil {
			detail = "cancelled: the agent is shutting down"
		}
	}
	bg := context.Background()
	if ferr := s.store.FinishJobRun(bg, runID, status, detail, out.String(), s.now()); ferr != nil {
		s.log.Error("record restore run", "database", db.Name, "run", runID, "err", ferr)
	}
	if perr := s.store.PruneJobRuns(bg, restoreJobName(db.Name), keepRestoreRuns); perr != nil {
		s.log.Warn("prune restore runs", "database", db.Name, "err", perr)
	}
	s.log.Info("restore finished", "database", db.Name, "run", runID, "backup", job.key, "target", job.target, "status", status, "detail", detail)
}

// stagedDump is a backup fetched, decrypted and checked, waiting in a private staging directory for pg_restore.
type stagedDump struct {
	dir, image, password string
	entries              int
}

// stageDump brings a backup to the point where it can be restored: the client image is there, the object is fetched from
// the first destination that has it, decrypted with the identity and read to its end with pg_restore. Nothing on the
// server is touched. The caller removes the staging directory with the returned function once it is done with the dump;
// on an error it is removed here and the function is nil.
func (s *Service) stageDump(ctx context.Context, db config.Database, key string, identity age.Identity, out func(string)) (d stagedDump, cleanup func(), err error) {
	dests, err := s.newDests(db.Backups)
	if err != nil {
		return d, nil, err
	}
	if d.password, err = readPassword(db); err != nil {
		return d, nil, err
	}
	if d.image, err = s.clientImage(ctx, db, d.password); err != nil {
		return d, nil, err
	}
	if err := s.ensureImage(ctx, d.image, out); err != nil {
		return d, nil, err
	}
	dir, remove, err := s.stage()
	if err != nil {
		return d, nil, err
	}
	d.dir = dir
	defer func() {
		if err != nil {
			remove()
		}
	}()

	encrypted := filepath.Join(d.dir, "dump.age")
	var getErr error
	for _, dest := range dests { // every destination holds every backup: the first that answers will do
		if getErr = dest.dest.Get(ctx, key, encrypted); getErr == nil {
			break
		}
	}
	if getErr != nil {
		return d, nil, fmt.Errorf("fetch %s: %w", key, getErr)
	}
	if err = decryptFile(encrypted, filepath.Join(d.dir, "dump"), identity); err != nil {
		return d, nil, err
	}
	if err = os.Remove(encrypted); err != nil {
		return d, nil, err
	}
	out("the backup is fetched and decrypted")

	// Nothing is created or dropped before the dump is known to be readable.
	if d.entries, err = s.verifyDump(ctx, db, d.password, d.image, d.dir); err != nil {
		return d, nil, err
	}
	out(fmt.Sprintf("the dump is verified: %d objects", d.entries))
	return d, remove, nil
}

// createDatabase creates an empty database on the server.
func (s *Service) createDatabase(ctx context.Context, db config.Database, d stagedDump, name string) error {
	create := append([]string{"psql"}, conn(db, "postgres")...)
	create = append(create, "-X", "-v", "ON_ERROR_STOP=1", "-c", `CREATE DATABASE "`+name+`"`)
	_, err := s.pg(ctx, db, d.password, d.image, nil, create)
	return err
}

// dropDatabase removes a database if it exists.
func (s *Service) dropDatabase(ctx context.Context, db config.Database, password, image, name string) error {
	drop := append([]string{"psql"}, conn(db, "postgres")...)
	drop = append(drop, "-X", "-v", "ON_ERROR_STOP=1", "-c", `DROP DATABASE IF EXISTS "`+name+`"`)
	_, err := s.pg(ctx, db, password, image, nil, drop)
	return err
}

// pgRestore loads the staged dump into target. Into the live database it replaces what is there, in one transaction.
func (s *Service) pgRestore(ctx context.Context, db config.Database, d stagedDump, target string, live bool) ([]string, error) {
	restore := append([]string{"pg_restore"}, conn(db, target)...)
	restore = append(restore, "--exit-on-error", "--no-owner", "--no-privileges")
	if live {
		// One transaction: a failure leaves the live database as it was instead of half dropped and half restored.
		restore = append(restore, "--clean", "--if-exists", "--single-transaction")
	}
	restore = append(restore, "/in/dump")
	return s.pg(ctx, db, d.password, d.image, []string{d.dir + ":/in:ro"}, restore)
}

func (s *Service) restore(ctx context.Context, db config.Database, job restoreJob, out func(string)) error {
	out(fmt.Sprintf("restoring %s into %s on %s:%d", job.key, job.target, db.Host, db.Port))
	d, cleanup, err := s.stageDump(ctx, db, job.key, job.identity, out)
	if err != nil {
		return err
	}
	defer cleanup()

	// Over the live database nothing can be undone by this restore alone: a backup of what is there now comes first, and
	// without it nothing is overwritten.
	if job.live {
		out("taking a safety backup of the live database before it is overwritten")
		if err := s.doBackup(ctx, db, KindPreRestore, out); err != nil {
			return fmt.Errorf("the safety backup before the restore failed, so nothing was overwritten: %w", err)
		}
	}

	created := false
	if !job.live {
		if err := s.createDatabase(ctx, db, d, job.target); err != nil {
			if strings.Contains(err.Error(), "already exists") {
				return fmt.Errorf("database %s already exists: nothing was changed, pick another target", job.target)
			}
			return fmt.Errorf("create database %s: %w", job.target, err)
		}
		created = true
		out("created database " + job.target)
	}

	lines, err := s.pgRestore(ctx, db, d, job.target, job.live)
	for _, l := range lines {
		out(l)
	}
	if err != nil {
		if created {
			return fmt.Errorf("pg_restore: %w (database %s was created and is left as it is)", err, job.target)
		}
		return fmt.Errorf("pg_restore: %w", err)
	}
	out(fmt.Sprintf("restored %s into %s", job.key, job.target))
	out(s.rowCounts(ctx, db, d.password, d.image, job.target))
	return nil
}

// rowCounts is the last line of a restore: the rows of each table of the public schema, to compare with the source.
// It never fails the restore, which has already succeeded.
func (s *Service) rowCounts(ctx context.Context, db config.Database, password, image, target string) string {
	query := `select case when table_schema = 'public' then table_name else table_schema || '.' || table_name end || '|' || (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from %I.%I', table_schema, table_name), false, true, '')))[1]::text || '|' || count(*) over () ` +
		`from information_schema.tables where table_schema not in ('pg_catalog', 'information_schema', 'pg_toast') and table_type = 'BASE TABLE' order by table_schema, table_name limit ` + strconv.Itoa(maxRowCountTables)
	cmd := append([]string{"psql"}, conn(db, target)...)
	cmd = append(cmd, "-X", "-At", "-v", "ON_ERROR_STOP=1", "-c", query)
	lines, err := s.pg(ctx, db, password, image, nil, cmd)
	if err != nil {
		return "row counts unavailable: " + err.Error()
	}
	var counts []string
	total := 0
	for _, l := range lines {
		rest, totalText, ok1 := cutLast(strings.TrimSpace(l), "|")
		name, rows, ok2 := cutLast(rest, "|")
		n, err := strconv.Atoi(totalText)
		if !ok1 || !ok2 || err != nil {
			continue
		}
		total = n
		counts = append(counts, name+"="+rows)
	}
	if len(counts) == 0 {
		return "row counts: no table"
	}
	head := fmt.Sprintf("row counts (%d tables, public ones by name, the others as schema.table)", total)
	if total > len(counts) {
		head = fmt.Sprintf("row counts (first %d of %d tables, public ones by name, the others as schema.table)", len(counts), total)
	}
	return head + ": " + strings.Join(counts, ", ")
}

func cutLast(s, sep string) (before, after string, ok bool) {
	i := strings.LastIndex(s, sep)
	if i < 0 {
		return s, "", false
	}
	return s[:i], s[i+len(sep):], true
}
