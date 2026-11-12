package store

import (
	"context"
	"database/sql"
	"errors"
	"time"
)

// Preview is one ephemeral environment: the instance of an app's previews template for a pull request.
type Preview struct {
	Name string `json:"name"`
	App  string `json:"app"`
	PR   int    `json:"pr"`
	// Domain is the host the instance was last deployed under.
	Domain string `json:"domain"`
	// Ref is the image reference of the latest deployment requested for the instance.
	Ref          string    `json:"ref"`
	DeploymentID string    `json:"deployment_id"`
	CreatedAt    time.Time `json:"created_at"`
	UpdatedAt    time.Time `json:"updated_at"`
	ExpiresAt    time.Time `json:"expires_at"`
}

const previewColumns = `name, app, pr, domain, ref, deployment_id, created_at, updated_at, expires_at`

func scanPreview(r scanner) (Preview, error) {
	var p Preview
	var created, updated, expires int64
	if err := r.Scan(&p.Name, &p.App, &p.PR, &p.Domain, &p.Ref, &p.DeploymentID, &created, &updated, &expires); err != nil {
		return Preview{}, err
	}
	p.CreatedAt, p.UpdatedAt, p.ExpiresAt = time.UnixMilli(created).UTC(), time.UnixMilli(updated).UTC(), time.UnixMilli(expires).UTC()
	return p, nil
}

// UpsertPreview records an instance for a new deployment: it creates the row, or updates the domain, ref, deployment
// and expiry of an existing one (its creation time stays). It reports whether the row is new.
func (s *Store) UpsertPreview(ctx context.Context, p Preview, at time.Time) (created bool, err error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return false, err
	}
	defer tx.Rollback()
	var n int
	if err := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM previews WHERE name = ?`, p.Name).Scan(&n); err != nil {
		return false, err
	}
	if n == 0 {
		_, err = tx.ExecContext(ctx, `INSERT INTO previews (`+previewColumns+`) VALUES (?,?,?,?,?,?,?,?,?)`,
			p.Name, p.App, p.PR, p.Domain, p.Ref, p.DeploymentID, ms(at), ms(at), ms(p.ExpiresAt))
	} else {
		_, err = tx.ExecContext(ctx, `UPDATE previews SET domain = ?, ref = ?, deployment_id = ?, updated_at = ?, expires_at = ? WHERE name = ?`,
			p.Domain, p.Ref, p.DeploymentID, ms(at), ms(p.ExpiresAt), p.Name)
	}
	if err != nil {
		return false, err
	}
	return n == 0, tx.Commit()
}

// Preview returns one instance.
func (s *Store) Preview(ctx context.Context, name string) (Preview, error) {
	p, err := scanPreview(s.db.QueryRowContext(ctx, `SELECT `+previewColumns+` FROM previews WHERE name = ?`, name))
	if errors.Is(err, sql.ErrNoRows) {
		return Preview{}, ErrNotFound
	}
	return p, err
}

// Previews returns every instance, the oldest first.
func (s *Store) Previews(ctx context.Context) ([]Preview, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT `+previewColumns+` FROM previews ORDER BY created_at, name`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Preview
	for rows.Next() {
		p, err := scanPreview(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

// DeletePreview forgets an instance. Deleting what is not there is a no-op.
func (s *Store) DeletePreview(ctx context.Context, name string) error {
	_, err := s.db.ExecContext(ctx, `DELETE FROM previews WHERE name = ?`, name)
	return err
}
