package store

import (
	"context"
	"database/sql"
	"errors"
	"time"
)

// Where a configuration version came from.
const (
	SourceStartup = "startup" // the file as the agent found it at start
	SourceAPI     = "api"     // saved through the API (the dashboard)
	SourceFile    = "file"    // edited on the server by hand and picked up
	SourceRestore = "restore" // an older version put back
)

// keepConfigVersions bounds the history. The newest are kept.
const keepConfigVersions = 100

// ConfigVersion is one state of the apps file. Content is the raw file, secrets included: it never leaves
// the agent unredacted.
type ConfigVersion struct {
	ID      int64     `json:"id"`
	At      time.Time `json:"at"`
	Hash    string    `json:"hash"`
	Source  string    `json:"source"`
	Actor   string    `json:"actor,omitempty"`
	Comment string    `json:"comment,omitempty"`
	Content string    `json:"-"`
}

// AddConfigVersion records a state of the file and trims the history to the newest versions.
func (s *Store) AddConfigVersion(ctx context.Context, v ConfigVersion) (int64, error) {
	res, err := s.db.ExecContext(ctx,
		`INSERT INTO config_versions (at, hash, source, actor, comment, content) VALUES (?,?,?,?,?,?)`,
		ms(v.At), v.Hash, v.Source, v.Actor, v.Comment, v.Content)
	if err != nil {
		return 0, err
	}
	id, err := res.LastInsertId()
	if err != nil {
		return 0, err
	}
	_, err = s.db.ExecContext(ctx,
		`DELETE FROM config_versions WHERE id NOT IN (SELECT id FROM config_versions ORDER BY id DESC LIMIT ?)`, keepConfigVersions)
	return id, err
}

func scanConfigVersion(r scanner) (ConfigVersion, error) {
	var v ConfigVersion
	var at int64
	if err := r.Scan(&v.ID, &at, &v.Hash, &v.Source, &v.Actor, &v.Comment, &v.Content); err != nil {
		return ConfigVersion{}, err
	}
	v.At = time.UnixMilli(at).UTC()
	return v, nil
}

const configVersionColumns = `id, at, hash, source, actor, comment, content`

// ConfigVersions lists the history, newest first. Content is not loaded.
func (s *Store) ConfigVersions(ctx context.Context, limit int) ([]ConfigVersion, error) {
	rows, err := s.db.QueryContext(ctx,
		`SELECT id, at, hash, source, actor, comment, '' FROM config_versions ORDER BY id DESC LIMIT ?`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []ConfigVersion
	for rows.Next() {
		v, err := scanConfigVersion(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, v)
	}
	return out, rows.Err()
}

// ConfigVersion returns one version with its content.
func (s *Store) ConfigVersion(ctx context.Context, id int64) (ConfigVersion, error) {
	v, err := scanConfigVersion(s.db.QueryRowContext(ctx, `SELECT `+configVersionColumns+` FROM config_versions WHERE id = ?`, id))
	if errors.Is(err, sql.ErrNoRows) {
		return ConfigVersion{}, ErrNotFound
	}
	return v, err
}

// LatestConfigVersion returns the newest version, or ErrNotFound when there is none yet.
func (s *Store) LatestConfigVersion(ctx context.Context) (ConfigVersion, error) {
	v, err := scanConfigVersion(s.db.QueryRowContext(ctx, `SELECT `+configVersionColumns+` FROM config_versions ORDER BY id DESC LIMIT 1`))
	if errors.Is(err, sql.ErrNoRows) {
		return ConfigVersion{}, ErrNotFound
	}
	return v, err
}

// AuditEntry is one request the agent acted on: a signed call, whether it was accepted or not.
type AuditEntry struct {
	ID     int64     `json:"id"`
	At     time.Time `json:"at"`
	Actor  string    `json:"actor,omitempty"`
	IP     string    `json:"ip,omitempty"`
	Method string    `json:"method"`
	Path   string    `json:"path"`
	Action string    `json:"action"`
	Status int       `json:"status"`
	Detail string    `json:"detail,omitempty"`
}

// keepAudit bounds the log: the newest entries are kept.
const keepAudit = 5000

// AddAudit records a request.
func (s *Store) AddAudit(ctx context.Context, e AuditEntry) error {
	if _, err := s.db.ExecContext(ctx,
		`INSERT INTO audit_log (at, actor, ip, method, path, action, status, detail) VALUES (?,?,?,?,?,?,?,?)`,
		ms(e.At), e.Actor, e.IP, e.Method, e.Path, e.Action, e.Status, e.Detail); err != nil {
		return err
	}
	// Trim occasionally rather than at every insert.
	_, err := s.db.ExecContext(ctx,
		`DELETE FROM audit_log WHERE id <= (SELECT MAX(id) FROM audit_log) - ?`, keepAudit)
	return err
}

// Audit lists entries newest first. before, when above zero, returns only entries with a smaller id.
func (s *Store) Audit(ctx context.Context, limit int, before int64) ([]AuditEntry, error) {
	q := `SELECT id, at, actor, ip, method, path, action, status, detail FROM audit_log`
	args := []any{}
	if before > 0 {
		q += ` WHERE id < ?`
		args = append(args, before)
	}
	q += ` ORDER BY id DESC LIMIT ?`
	args = append(args, limit)
	rows, err := s.db.QueryContext(ctx, q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []AuditEntry
	for rows.Next() {
		var e AuditEntry
		var at int64
		if err := rows.Scan(&e.ID, &at, &e.Actor, &e.IP, &e.Method, &e.Path, &e.Action, &e.Status, &e.Detail); err != nil {
			return nil, err
		}
		e.At = time.UnixMilli(at).UTC()
		out = append(out, e)
	}
	return out, rows.Err()
}
