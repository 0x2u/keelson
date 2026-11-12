// Package store keeps the agent's local history in SQLite: deployments, their
// event logs, and the signatures of already-served signed requests.
package store

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
	"time"

	_ "modernc.org/sqlite" // pure-Go driver: keeps the agent a static binary
)

// Deployment statuses.
const (
	StatusRunning        = "running"
	StatusSucceeded      = "succeeded"
	StatusFailed         = "failed"          // failed before the running container was touched, or no previous version existed
	StatusRolledBack     = "rolled_back"     // failed, previous version restored and healthy
	StatusRollbackFailed = "rollback_failed" // failed and the previous version could not be restored
)

// ErrNotFound is returned when a record does not exist.
var ErrNotFound = errors.New("not found")

// Phases of a deployment, in pipeline order. A deployment records only the phases it reached or deliberately skipped.
const (
	PhaseSource  = "source"  // downloading the source archive of a build
	PhaseBuild   = "build"   // the image build
	PhaseRelease = "release" // fetching the image and running the release steps
	PhaseSwitch  = "switch"  // starting the new version, its health gate, the traffic switch and the drain
	PhaseSoak    = "soak"    // watching the new version after the switch
	PhaseLive    = "live"    // final cleanup, until the deployment is recorded
)

// Phase statuses.
const (
	PhaseRunning = "running"
	PhaseDone    = "done"
	PhaseFailed  = "failed"
	PhaseSkipped = "skipped"
)

// Deployment is one attempt to put a new image into service.
type Deployment struct {
	ID          string `json:"id"`
	App         string `json:"app"`
	Ref         string `json:"ref"`
	PreviousRef string `json:"previous_ref,omitempty"`
	// ServingRef is the image that serves once the deployment is over (empty while it runs, and when nothing known
	// serves).
	ServingRef string     `json:"serving_ref,omitempty"`
	Status     string     `json:"status"`
	Trigger    string     `json:"trigger"` // "api", "cli", "rollback"
	Error      string     `json:"error,omitempty"`
	StartedAt  time.Time  `json:"started_at"`
	FinishedAt *time.Time `json:"finished_at,omitempty"`
	// Phases are the pipeline phases reached, in order; none for a deployment recorded before phases existed.
	Phases []Phase `json:"phases,omitempty"`
}

// Phase is one step of a deployment's pipeline.
type Phase struct {
	Name       string     `json:"name"`
	Status     string     `json:"status"`
	StartedAt  time.Time  `json:"started_at"`
	FinishedAt *time.Time `json:"finished_at,omitempty"`
}

// Event is one line of a deployment's progress log.
type Event struct {
	Seq     int64     `json:"seq"`
	Time    time.Time `json:"time"`
	Level   string    `json:"level"` // "info", "warn", "error"
	Message string    `json:"message"`
	// Phase is the pipeline phase that was running when the line was written; empty outside any phase.
	Phase string `json:"phase,omitempty"`
}

// Store is the agent's SQLite database.
type Store struct {
	db   *sql.DB
	path string
}

// migrations[i] upgrades the schema from version i to i+1. Entries are never
// edited once released: a change is a new entry.
var migrations = []string{`
CREATE TABLE deployments (
  id           TEXT PRIMARY KEY,
  app          TEXT NOT NULL,
  ref          TEXT NOT NULL,
  previous_ref TEXT NOT NULL DEFAULT '',
  status       TEXT NOT NULL,
  trigger      TEXT NOT NULL,
  error        TEXT NOT NULL DEFAULT '',
  started_at   INTEGER NOT NULL,
  finished_at  INTEGER
);
CREATE INDEX deployments_app_started ON deployments (app, started_at DESC);
CREATE TABLE deployment_events (
  seq           INTEGER PRIMARY KEY AUTOINCREMENT,
  deployment_id TEXT NOT NULL REFERENCES deployments (id) ON DELETE CASCADE,
  time          INTEGER NOT NULL,
  level         TEXT NOT NULL,
  message       TEXT NOT NULL
);
CREATE INDEX deployment_events_dep ON deployment_events (deployment_id, seq);
CREATE TABLE seen_requests (
  signature  TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL
);
`, `
CREATE TABLE app_state (
  app        TEXT PRIMARY KEY,
  container  TEXT NOT NULL,
  host_port  INTEGER NOT NULL,
  ref        TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
`, `
CREATE TABLE job_runs (
  id          TEXT PRIMARY KEY,
  job         TEXT NOT NULL,
  trigger     TEXT NOT NULL,
  status      TEXT NOT NULL,
  detail      TEXT NOT NULL DEFAULT '',
  output      TEXT NOT NULL DEFAULT '',
  started_at  INTEGER NOT NULL,
  finished_at INTEGER
);
CREATE INDEX job_runs_job_started ON job_runs (job, started_at DESC);
`, `
CREATE TABLE config_versions (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  at      INTEGER NOT NULL,
  hash    TEXT NOT NULL,
  source  TEXT NOT NULL,
  actor   TEXT NOT NULL DEFAULT '',
  comment TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL
);
CREATE TABLE audit_log (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  at     INTEGER NOT NULL,
  actor  TEXT NOT NULL DEFAULT '',
  ip     TEXT NOT NULL DEFAULT '',
  method TEXT NOT NULL,
  path   TEXT NOT NULL,
  action TEXT NOT NULL,
  status INTEGER NOT NULL,
  detail TEXT NOT NULL DEFAULT ''
);
`, `
-- Resource history, one row per running container per sampling cycle. series is the app a container belongs to (so the
-- history follows the app across deployments, each of which is a new container) or its name.
CREATE TABLE stats (
  ts        INTEGER NOT NULL,
  series    TEXT NOT NULL,
  container TEXT NOT NULL,
  cpu       REAL NOT NULL,
  mem       INTEGER NOT NULL,
  mem_limit INTEGER NOT NULL
);
CREATE INDEX stats_series_ts ON stats (series, ts);
CREATE INDEX stats_container_ts ON stats (container, ts DESC);
`, `
-- Ephemeral preview environments, one row per instance ("<app>-pr-<n>"). They are not in the apps file.
CREATE TABLE previews (
  name          TEXT PRIMARY KEY,
  app           TEXT NOT NULL,
  pr            INTEGER NOT NULL,
  domain        TEXT NOT NULL,
  ref           TEXT NOT NULL,
  deployment_id TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL,
  UNIQUE (app, pr)
);
`, `
-- One-time enrolment codes that have been redeemed. A code is only ever kept as its SHA-256 hash. A pending code is a
-- root-owned file under the enrolment directory, not a row: the CLI that creates codes runs as root and must not open
-- this database (the agent owns it). The row is inserted by the redemption itself, so the primary key makes "used
-- exactly once" an atomic decision. Rows are pruned once expires_at has passed: an expired code is refused anyway.
CREATE TABLE enrolments (
  hash       TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL,
  used_at    INTEGER NOT NULL
);
`, `
-- Images that were loaded into this server from another one (an image built on a build server and sent here). Like a built
-- image, such an image is in no registry: a deployment of it must not pull.
CREATE TABLE imported_images (
  app TEXT NOT NULL,
  ref TEXT NOT NULL,
  at  INTEGER NOT NULL,
  PRIMARY KEY (app, ref)
);
`, `
-- The pipeline of a deployment: one row per phase reached, in order. serving_ref is what serves once it is over. An event
-- records the phase that was running when it was written.
ALTER TABLE deployments ADD COLUMN serving_ref TEXT NOT NULL DEFAULT '';
ALTER TABLE deployment_events ADD COLUMN phase TEXT NOT NULL DEFAULT '';
CREATE TABLE deployment_phases (
  seq           INTEGER PRIMARY KEY AUTOINCREMENT,
  deployment_id TEXT NOT NULL REFERENCES deployments (id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  status        TEXT NOT NULL,
  started_at    INTEGER NOT NULL,
  finished_at   INTEGER
);
CREATE INDEX deployment_phases_dep ON deployment_phases (deployment_id, seq);
`, `
-- What the readiness checklist is computed from: the latest successful proof per (kind, subject), where kind is "key" (an
-- identity decrypted a backup), "restore" (a backup restored into a scratch database) or "alert" (every notification channel
-- delivered a test). subject is the database, empty for an alert.
CREATE TABLE proofs (
  kind    TEXT NOT NULL,
  subject TEXT NOT NULL DEFAULT '',
  at      INTEGER NOT NULL,
  PRIMARY KEY (kind, subject)
);
-- One restore test of a backup into a scratch database. scratch is the database created for it until it is dropped (empty
-- after): a test cut short by a crash leaves it here for the next start to drop. tables is the JSON list of row counts.
CREATE TABLE restore_tests (
  id          TEXT PRIMARY KEY,
  database    TEXT NOT NULL,
  backup      TEXT NOT NULL,
  backup_time INTEGER NOT NULL,
  scratch     TEXT NOT NULL,
  status      TEXT NOT NULL,
  error       TEXT NOT NULL DEFAULT '',
  tables      TEXT NOT NULL DEFAULT '[]',
  started_at  INTEGER NOT NULL,
  finished_at INTEGER
);
CREATE INDEX restore_tests_database_started ON restore_tests (database, started_at DESC);
`, `
-- The host's own load, memory and disk, one row per sampling cycle (the same 30 s cycle as stats). A part the machine does
-- not expose is NULL.
CREATE TABLE host_stats (
  ts         INTEGER PRIMARY KEY,
  load1      REAL,
  mem_total  INTEGER,
  mem_avail  INTEGER,
  disk_total INTEGER,
  disk_free  INTEGER
);
`, `
-- When an app went down and came back, as the app watcher decided it (the same consecutive-observation threshold as the
-- app.down alert). state is "up" or "down". The first row of an app is when the watcher first judged it, which is where its
-- availability starts to be known.
CREATE TABLE app_transitions (
  id    INTEGER PRIMARY KEY AUTOINCREMENT,
  app   TEXT NOT NULL,
  ts    INTEGER NOT NULL,
  state TEXT NOT NULL
);
CREATE INDEX app_transitions_app_ts ON app_transitions (app, ts);
`}

// Open opens (creating if needed) the database at path.
func Open(path string) (*Store, error) {
	// WAL lets readers (SSE pollers) proceed while a deployment writes.
	dsn := "file:" + path + "?_pragma=journal_mode(WAL)&_pragma=busy_timeout(5000)&_pragma=foreign_keys(1)"
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1) // one writer; the workload is tiny
	s := &Store{db: db, path: path}
	if err := s.migrate(); err != nil {
		db.Close()
		return nil, err
	}
	return s, nil
}

// SchemaVersion is the schema version this agent writes and the newest it can open.
func SchemaVersion() int { return len(migrations) }

// ReadSchemaVersion reads the schema version of the database at path without changing it (Open would migrate it, and copy
// it first): what a check wants to know before an agent starts on it.
func ReadSchemaVersion(path string) (int, error) {
	db, err := sql.Open("sqlite", "file:"+path+"?mode=ro&_pragma=busy_timeout(2000)")
	if err != nil {
		return 0, err
	}
	defer db.Close()
	var v int
	if err := db.QueryRow("PRAGMA user_version").Scan(&v); err != nil {
		return 0, err
	}
	return v, nil
}

func (s *Store) migrate() error {
	var v int
	if err := s.db.QueryRow("PRAGMA user_version").Scan(&v); err != nil {
		return err
	}
	if v > len(migrations) {
		return fmt.Errorf("database schema version %d is newer than this agent supports", v)
	}
	// An existing database about to change shape is copied first: a schema upgrade is forward-only, and an older agent
	// refuses a newer schema, so this copy is what going back to the previous version restores. Best effort: a full disk
	// must not stop an agent that would otherwise start.
	if v > 0 && v < len(migrations) {
		_ = s.Snapshot(context.Background(), fmt.Sprintf("%s.before-upgrade-from-v%d", s.path, v))
	}
	for ; v < len(migrations); v++ {
		tx, err := s.db.Begin()
		if err != nil {
			return err
		}
		if _, err := tx.Exec(migrations[v]); err != nil {
			tx.Rollback()
			return fmt.Errorf("migrate schema to version %d: %w", v+1, err)
		}
		// PRAGMA does not accept bound parameters.
		if _, err := tx.Exec(fmt.Sprintf("PRAGMA user_version = %d", v+1)); err != nil {
			tx.Rollback()
			return err
		}
		if err := tx.Commit(); err != nil {
			return err
		}
	}
	return nil
}

// Close closes the database.
func (s *Store) Close() error { return s.db.Close() }

// NewID returns a random deployment ID.
func NewID() string {
	var b [8]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic(err) // crypto/rand does not fail on supported platforms
	}
	return hex.EncodeToString(b[:])
}

func ms(t time.Time) int64 { return t.UnixMilli() }

// CreateDeployment inserts a deployment in the running state.
func (s *Store) CreateDeployment(ctx context.Context, d Deployment) error {
	_, err := s.db.ExecContext(ctx,
		`INSERT INTO deployments (id, app, ref, previous_ref, status, trigger, started_at) VALUES (?,?,?,?,?,?,?)`,
		d.ID, d.App, d.Ref, d.PreviousRef, StatusRunning, d.Trigger, ms(d.StartedAt))
	return err
}

// SetPreviousRef records the image that was running before the deployment.
func (s *Store) SetPreviousRef(ctx context.Context, id, ref string) error {
	_, err := s.db.ExecContext(ctx, `UPDATE deployments SET previous_ref = ? WHERE id = ?`, ref, id)
	return err
}

// BeginPhase starts a phase of a deployment. The phase that was running ends as done: phases run one after the other.
func (s *Store) BeginPhase(ctx context.Context, id, name string, at time.Time) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.ExecContext(ctx, closePhase, PhaseDone, ms(at), id, PhaseRunning); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx,
		`INSERT INTO deployment_phases (deployment_id, name, status, started_at) VALUES (?,?,?,?)`, id, name, PhaseRunning, ms(at)); err != nil {
		return err
	}
	return tx.Commit()
}

// EndPhase ends the running phase of a deployment with status (done, failed or skipped). Nothing running is no error.
func (s *Store) EndPhase(ctx context.Context, id, status string, at time.Time) error {
	_, err := s.db.ExecContext(ctx, closePhase, status, ms(at), id, PhaseRunning)
	return err
}

const closePhase = `UPDATE deployment_phases SET status = ?, finished_at = ? WHERE deployment_id = ? AND status = ?`

// Finish records the final status of a deployment and the image that serves after it (empty: none known to). The phase
// still running ends with it: done for a success, failed for anything else.
func (s *Store) Finish(ctx context.Context, id, status, errMsg, servingRef string, at time.Time) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	phase := PhaseDone
	if status != StatusSucceeded {
		phase = PhaseFailed
	}
	if _, err := tx.ExecContext(ctx, closePhase, phase, ms(at), id, PhaseRunning); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx,
		`UPDATE deployments SET status = ?, error = ?, serving_ref = ?, finished_at = ? WHERE id = ?`, status, errMsg, servingRef, ms(at), id); err != nil {
		return err
	}
	return tx.Commit()
}

const depColumns = `id, app, ref, previous_ref, serving_ref, status, trigger, error, started_at, finished_at`

type scanner interface{ Scan(dest ...any) error }

func scanDeployment(r scanner) (Deployment, error) {
	var d Deployment
	var started int64
	var finished sql.NullInt64
	if err := r.Scan(&d.ID, &d.App, &d.Ref, &d.PreviousRef, &d.ServingRef, &d.Status, &d.Trigger, &d.Error, &started, &finished); err != nil {
		return Deployment{}, err
	}
	d.StartedAt = time.UnixMilli(started).UTC()
	if finished.Valid {
		t := time.UnixMilli(finished.Int64).UTC()
		d.FinishedAt = &t
	}
	return d, nil
}

// Deployment returns one deployment.
func (s *Store) Deployment(ctx context.Context, id string) (Deployment, error) {
	list, err := s.query(ctx, `SELECT `+depColumns+` FROM deployments WHERE id = ?`, id)
	if err != nil {
		return Deployment{}, err
	}
	if len(list) == 0 {
		return Deployment{}, ErrNotFound
	}
	return list[0], nil
}

// query runs a deployment query and attaches the phases of what it found.
func (s *Store) query(ctx context.Context, q string, args ...any) ([]Deployment, error) {
	rows, err := s.db.QueryContext(ctx, q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Deployment
	for rows.Next() {
		d, err := scanDeployment(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, d)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	rows.Close() // the single connection is needed for the phases
	return out, s.attachPhases(ctx, out)
}

func (s *Store) attachPhases(ctx context.Context, deps []Deployment) error {
	if len(deps) == 0 {
		return nil
	}
	at := make(map[string]int, len(deps))
	args := make([]any, len(deps))
	marks := make([]string, len(deps))
	for i, d := range deps {
		at[d.ID], args[i], marks[i] = i, d.ID, "?"
	}
	rows, err := s.db.QueryContext(ctx,
		`SELECT deployment_id, name, status, started_at, finished_at FROM deployment_phases WHERE deployment_id IN (`+strings.Join(marks, ",")+`) ORDER BY seq`, args...)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var id string
		var p Phase
		var started int64
		var finished sql.NullInt64
		if err := rows.Scan(&id, &p.Name, &p.Status, &started, &finished); err != nil {
			return err
		}
		p.StartedAt = time.UnixMilli(started).UTC()
		if finished.Valid {
			t := time.UnixMilli(finished.Int64).UTC()
			p.FinishedAt = &t
		}
		deps[at[id]].Phases = append(deps[at[id]].Phases, p)
	}
	return rows.Err()
}

// ListDeployments returns the most recent deployments, newest first,
// optionally restricted to one app.
func (s *Store) ListDeployments(ctx context.Context, app string, limit int) ([]Deployment, error) {
	if app == "" {
		return s.query(ctx, `SELECT `+depColumns+` FROM deployments ORDER BY started_at DESC, rowid DESC LIMIT ?`, limit)
	}
	return s.query(ctx, `SELECT `+depColumns+` FROM deployments WHERE app = ? ORDER BY started_at DESC, rowid DESC LIMIT ?`, app, limit)
}

// Running returns deployments that were never finished.
func (s *Store) Running(ctx context.Context) ([]Deployment, error) {
	return s.query(ctx, `SELECT `+depColumns+` FROM deployments WHERE status = ? ORDER BY started_at`, StatusRunning)
}

// Succeeded returns an app's successful deployments, newest first.
func (s *Store) Succeeded(ctx context.Context, app string, limit int) ([]Deployment, error) {
	return s.query(ctx, `SELECT `+depColumns+` FROM deployments WHERE app = ? AND status = ? ORDER BY started_at DESC, rowid DESC LIMIT ?`,
		app, StatusSucceeded, limit)
}

// BuiltHere reports whether ref is an image of the app that exists nowhere but on this server: a build finished here
// (RecordImport, which a build records as soon as the image exists, whatever becomes of its deployment), a successful
// deployment of that kind recorded before builds did that, or it was loaded here from another server. Either way it was
// never pushed to a registry, and a redeployment of it must not pull.
func (s *Store) BuiltHere(ctx context.Context, app, ref string) (bool, error) {
	var one int
	err := s.db.QueryRowContext(ctx, `SELECT 1 FROM deployments WHERE app = ? AND ref = ? AND trigger = ? AND status = ?
		UNION ALL SELECT 1 FROM imported_images WHERE app = ? AND ref = ? LIMIT 1`,
		app, ref, "build", StatusSucceeded, app, ref).Scan(&one)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	return err == nil, err
}

// BuiltAnywhere reports whether ref was built or received here for any app name (see BuiltHere): what a build requested
// without an app of this server's file leaves behind.
func (s *Store) BuiltAnywhere(ctx context.Context, ref string) (bool, error) {
	var one int
	err := s.db.QueryRowContext(ctx, `SELECT 1 FROM deployments WHERE ref = ? AND trigger = ? AND status = ?
		UNION ALL SELECT 1 FROM imported_images WHERE ref = ? LIMIT 1`,
		ref, "build", StatusSucceeded, ref).Scan(&one)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	return err == nil, err
}

// RecordImport notes that ref, an image of the app, exists on this server and nowhere else: loaded from another server, or
// built here.
func (s *Store) RecordImport(ctx context.Context, app, ref string, at time.Time) error {
	_, err := s.db.ExecContext(ctx, `INSERT INTO imported_images (app, ref, at) VALUES (?,?,?)
		ON CONFLICT(app, ref) DO UPDATE SET at = excluded.at`, app, ref, ms(at))
	return err
}

// AddEvent appends a line to a deployment's log, marked with the phase that is running.
func (s *Store) AddEvent(ctx context.Context, depID, level, msg string, at time.Time) error {
	_, err := s.db.ExecContext(ctx,
		`INSERT INTO deployment_events (deployment_id, time, level, message, phase) VALUES (?,?,?,?,
		  COALESCE((SELECT name FROM deployment_phases WHERE deployment_id = ? AND status = ? ORDER BY seq DESC LIMIT 1), ''))`,
		depID, ms(at), level, msg, depID, PhaseRunning)
	return err
}

// Events returns a deployment's log lines with seq greater than after.
func (s *Store) Events(ctx context.Context, depID string, after int64) ([]Event, error) {
	rows, err := s.db.QueryContext(ctx,
		`SELECT seq, time, level, message, phase FROM deployment_events WHERE deployment_id = ? AND seq > ? ORDER BY seq`, depID, after)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Event
	for rows.Next() {
		var e Event
		var t int64
		if err := rows.Scan(&e.Seq, &t, &e.Level, &e.Message, &e.Phase); err != nil {
			return nil, err
		}
		e.Time = time.UnixMilli(t).UTC()
		out = append(out, e)
	}
	return out, rows.Err()
}

// RecordRequest remembers a signature until expires. It reports false when the
// signature was already recorded: the request is a replay.
func (s *Store) RecordRequest(ctx context.Context, signature string, now, expires time.Time) (fresh bool, err error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return false, err
	}
	defer tx.Rollback()
	if _, err := tx.ExecContext(ctx, `DELETE FROM seen_requests WHERE expires_at < ?`, ms(now)); err != nil {
		return false, err
	}
	res, err := tx.ExecContext(ctx, `INSERT OR IGNORE INTO seen_requests (signature, expires_at) VALUES (?, ?)`, signature, ms(expires))
	if err != nil {
		return false, err
	}
	n, err := res.RowsAffected()
	if err != nil {
		return false, err
	}
	return n == 1, tx.Commit()
}

// AppState is where a proxied app is currently served from.
type AppState struct {
	App       string    `json:"app"`
	Container string    `json:"container"`
	HostPort  int       `json:"host_port"`
	Ref       string    `json:"ref"`
	UpdatedAt time.Time `json:"updated_at"`
}

// SetAppState records which container serves an app.
func (s *Store) SetAppState(ctx context.Context, st AppState, at time.Time) error {
	_, err := s.db.ExecContext(ctx,
		`INSERT INTO app_state (app, container, host_port, ref, updated_at) VALUES (?,?,?,?,?)
		 ON CONFLICT(app) DO UPDATE SET container = excluded.container, host_port = excluded.host_port, ref = excluded.ref, updated_at = excluded.updated_at`,
		st.App, st.Container, st.HostPort, st.Ref, ms(at))
	return err
}

// AppState returns where an app is currently served from.
func (s *Store) AppState(ctx context.Context, app string) (AppState, error) {
	var st AppState
	var at int64
	err := s.db.QueryRowContext(ctx, `SELECT app, container, host_port, ref, updated_at FROM app_state WHERE app = ?`, app).
		Scan(&st.App, &st.Container, &st.HostPort, &st.Ref, &at)
	if errors.Is(err, sql.ErrNoRows) {
		return AppState{}, ErrNotFound
	}
	st.UpdatedAt = time.UnixMilli(at).UTC()
	return st, err
}

// DeleteAppState forgets where an app is served from. Nothing is an error: deleting what is not there is a no-op.
func (s *Store) DeleteAppState(ctx context.Context, app string) error {
	_, err := s.db.ExecContext(ctx, `DELETE FROM app_state WHERE app = ?`, app)
	return err
}

// AppStates returns the state of every proxied app that has one.
func (s *Store) AppStates(ctx context.Context) ([]AppState, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT app, container, host_port, ref, updated_at FROM app_state ORDER BY app`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []AppState
	for rows.Next() {
		var st AppState
		var at int64
		if err := rows.Scan(&st.App, &st.Container, &st.HostPort, &st.Ref, &at); err != nil {
			return nil, err
		}
		st.UpdatedAt = time.UnixMilli(at).UTC()
		out = append(out, st)
	}
	return out, rows.Err()
}

// Job run statuses.
const (
	JobRunning   = "running"
	JobSucceeded = "succeeded"
	JobFailed    = "failed"
	// JobSkipped records a firing that was dropped because the previous run of
	// the same job was still going.
	JobSkipped = "skipped"
	// JobMissed records scheduled runs that did not happen because the agent, or the server, was not running.
	JobMissed = "missed"
)

// maxJobOutput bounds the output kept per run.
const maxJobOutput = 4096

// JobRun is one execution of a scheduled job.
type JobRun struct {
	ID         string     `json:"id"`
	Job        string     `json:"job"`
	Trigger    string     `json:"trigger"` // "schedule" or "manual"
	Status     string     `json:"status"`
	Detail     string     `json:"detail,omitempty"` // "HTTP 500", "exit status 3", "timed out after 1m"
	Output     string     `json:"output,omitempty"` // the tail of what it printed, or the start of the HTTP body
	StartedAt  time.Time  `json:"started_at"`
	FinishedAt *time.Time `json:"finished_at,omitempty"`
}

// CreateJobRun records the start of a run.
func (s *Store) CreateJobRun(ctx context.Context, r JobRun) error {
	_, err := s.db.ExecContext(ctx,
		`INSERT INTO job_runs (id, job, trigger, status, detail, started_at) VALUES (?,?,?,?,?,?)`,
		r.ID, r.Job, r.Trigger, r.Status, r.Detail, ms(r.StartedAt))
	return err
}

// FinishJobRun records how a run ended. The output is cut to its last 4 KiB.
func (s *Store) FinishJobRun(ctx context.Context, id, status, detail, output string, at time.Time) error {
	if len(output) > maxJobOutput {
		output = "…" + output[len(output)-maxJobOutput:]
	}
	_, err := s.db.ExecContext(ctx,
		`UPDATE job_runs SET status = ?, detail = ?, output = ?, finished_at = ? WHERE id = ?`,
		status, detail, output, ms(at), id)
	return err
}

func scanJobRun(r scanner) (JobRun, error) {
	var j JobRun
	var started int64
	var finished sql.NullInt64
	if err := r.Scan(&j.ID, &j.Job, &j.Trigger, &j.Status, &j.Detail, &j.Output, &started, &finished); err != nil {
		return JobRun{}, err
	}
	j.StartedAt = time.UnixMilli(started).UTC()
	if finished.Valid {
		t := time.UnixMilli(finished.Int64).UTC()
		j.FinishedAt = &t
	}
	return j, nil
}

const jobColumns = `id, job, trigger, status, detail, output, started_at, finished_at`

func (s *Store) queryJobRuns(ctx context.Context, q string, args ...any) ([]JobRun, error) {
	rows, err := s.db.QueryContext(ctx, q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []JobRun
	for rows.Next() {
		r, err := scanJobRun(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// JobRuns returns a job's most recent runs, newest first.
func (s *Store) JobRuns(ctx context.Context, job string, limit int) ([]JobRun, error) {
	return s.queryJobRuns(ctx, `SELECT `+jobColumns+` FROM job_runs WHERE job = ? ORDER BY started_at DESC, rowid DESC LIMIT ?`, job, limit)
}

// JobRun returns one run.
func (s *Store) JobRun(ctx context.Context, id string) (JobRun, error) {
	r, err := scanJobRun(s.db.QueryRowContext(ctx, `SELECT `+jobColumns+` FROM job_runs WHERE id = ?`, id))
	if errors.Is(err, sql.ErrNoRows) {
		return JobRun{}, ErrNotFound
	}
	return r, err
}

// RunningJobRuns returns runs that were never finished.
func (s *Store) RunningJobRuns(ctx context.Context) ([]JobRun, error) {
	return s.queryJobRuns(ctx, `SELECT `+jobColumns+` FROM job_runs WHERE status = ? ORDER BY started_at`, JobRunning)
}

// PruneJobRuns keeps only the newest keep runs of a job.
func (s *Store) PruneJobRuns(ctx context.Context, job string, keep int) error {
	_, err := s.db.ExecContext(ctx,
		`DELETE FROM job_runs WHERE job = ? AND id NOT IN
		   (SELECT id FROM job_runs WHERE job = ? ORDER BY started_at DESC, rowid DESC LIMIT ?)`, job, job, keep)
	return err
}
