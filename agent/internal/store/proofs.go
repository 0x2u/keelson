package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"time"
)

// Kinds of proof. A proof is a fact the agent saw once: a person handed it the secret key and it decrypted a backup, a
// backup restored into a scratch database, every notification channel delivered a test.
const (
	ProofKey     = "key"
	ProofRestore = "restore"
	ProofAlert   = "alert"
)

// Proof is the latest successful proof of a kind for a subject: a database, or empty for an alert.
type Proof struct {
	Kind    string    `json:"kind"`
	Subject string    `json:"subject"`
	At      time.Time `json:"at"`
}

// RecordProof notes a successful proof. Only the latest one per (kind, subject) is kept: an older time never replaces a
// newer one.
func (s *Store) RecordProof(ctx context.Context, kind, subject string, at time.Time) error {
	_, err := s.db.ExecContext(ctx, `INSERT INTO proofs (kind, subject, at) VALUES (?,?,?)
		ON CONFLICT(kind, subject) DO UPDATE SET at = MAX(at, excluded.at)`, kind, subject, ms(at))
	return err
}

// Proofs returns every proof, ordered by kind then subject.
func (s *Store) Proofs(ctx context.Context) ([]Proof, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT kind, subject, at FROM proofs ORDER BY kind, subject`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Proof{}
	for rows.Next() {
		var p Proof
		var at int64
		if err := rows.Scan(&p.Kind, &p.Subject, &at); err != nil {
			return nil, err
		}
		p.At = time.UnixMilli(at).UTC()
		out = append(out, p)
	}
	return out, rows.Err()
}

// Restore test statuses.
const (
	TestRunning = "running"
	TestPassed  = "passed"
	TestFailed  = "failed"
)

// TableCount is the rows of one table in the restored backup and in the live database; null on the side that has no such
// table.
type TableCount struct {
	Name       string `json:"name"`
	BackupRows *int64 `json:"backup_rows"`
	LiveRows   *int64 `json:"live_rows"`
}

// RestoreTest is one restore of a backup into a scratch database and what it found.
type RestoreTest struct {
	ID         string       `json:"id"`
	Database   string       `json:"-"`
	Backup     string       `json:"backup"`
	BackupTime time.Time    `json:"backup_time"`
	StartedAt  time.Time    `json:"started_at"`
	FinishedAt *time.Time   `json:"finished_at,omitempty"`
	Status     string       `json:"status"`
	Error      string       `json:"error,omitempty"`
	Tables     []TableCount `json:"tables"`
	// Scratch is the database created for the test while it still exists; it is not part of the API.
	Scratch string `json:"-"`
}

// CreateRestoreTest records a test that is starting. Its scratch database is named before it is created, so that a crash
// at any point leaves the name for the next start to drop.
func (s *Store) CreateRestoreTest(ctx context.Context, t RestoreTest) error {
	_, err := s.db.ExecContext(ctx,
		`INSERT INTO restore_tests (id, database, backup, backup_time, scratch, status, started_at) VALUES (?,?,?,?,?,?,?)`,
		t.ID, t.Database, t.Backup, ms(t.BackupTime), t.Scratch, TestRunning, ms(t.StartedAt))
	return err
}

// FinishRestoreTest records how a test ended.
func (s *Store) FinishRestoreTest(ctx context.Context, id, status, errMsg string, tables []TableCount, at time.Time) error {
	if tables == nil {
		tables = []TableCount{}
	}
	b, err := json.Marshal(tables)
	if err != nil {
		return err
	}
	_, err = s.db.ExecContext(ctx, `UPDATE restore_tests SET status = ?, error = ?, tables = ?, finished_at = ? WHERE id = ?`,
		status, errMsg, string(b), ms(at), id)
	return err
}

// ClearScratch records that the scratch database of a test no longer exists.
func (s *Store) ClearScratch(ctx context.Context, id string) error {
	_, err := s.db.ExecContext(ctx, `UPDATE restore_tests SET scratch = '' WHERE id = ?`, id)
	return err
}

// AbandonRestoreTests ends the tests that were never finished (the agent stopped while they ran) as failed with reason.
func (s *Store) AbandonRestoreTests(ctx context.Context, reason string, at time.Time) error {
	_, err := s.db.ExecContext(ctx, `UPDATE restore_tests SET status = ?, error = ?, finished_at = ? WHERE status = ?`,
		TestFailed, reason, ms(at), TestRunning)
	return err
}

// Scratches returns the tests whose scratch database may still exist: id, database (the name in the apps file) and the
// name of the scratch database, in the Scratch field.
func (s *Store) Scratches(ctx context.Context) ([]RestoreTest, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT id, database, scratch FROM restore_tests WHERE scratch <> '' ORDER BY started_at`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []RestoreTest
	for rows.Next() {
		var t RestoreTest
		if err := rows.Scan(&t.ID, &t.Database, &t.Scratch); err != nil {
			return nil, err
		}
		out = append(out, t)
	}
	return out, rows.Err()
}

// RestoreTests returns the newest tests of a database, newest first.
func (s *Store) RestoreTests(ctx context.Context, database string, limit int) ([]RestoreTest, error) {
	rows, err := s.db.QueryContext(ctx,
		`SELECT id, database, backup, backup_time, scratch, status, error, tables, started_at, finished_at
		 FROM restore_tests WHERE database = ? ORDER BY started_at DESC, rowid DESC LIMIT ?`, database, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []RestoreTest{}
	for rows.Next() {
		var t RestoreTest
		var tables string
		var backupTime, started int64
		var finished sql.NullInt64
		if err := rows.Scan(&t.ID, &t.Database, &t.Backup, &backupTime, &t.Scratch, &t.Status, &t.Error, &tables, &started, &finished); err != nil {
			return nil, err
		}
		if err := json.Unmarshal([]byte(tables), &t.Tables); err != nil {
			return nil, err
		}
		if t.Tables == nil {
			t.Tables = []TableCount{}
		}
		t.BackupTime, t.StartedAt = time.UnixMilli(backupTime).UTC(), time.UnixMilli(started).UTC()
		if finished.Valid {
			f := time.UnixMilli(finished.Int64).UTC()
			t.FinishedAt = &f
		}
		out = append(out, t)
	}
	return out, rows.Err()
}

// PruneRestoreTests keeps only the newest keep tests of a database. A test whose scratch database may still exist stays: the
// next start needs its name.
func (s *Store) PruneRestoreTests(ctx context.Context, database string, keep int) error {
	_, err := s.db.ExecContext(ctx,
		`DELETE FROM restore_tests WHERE database = ? AND scratch = '' AND id NOT IN
		   (SELECT id FROM restore_tests WHERE database = ? ORDER BY started_at DESC, rowid DESC LIMIT ?)`, database, database, keep)
	return err
}
