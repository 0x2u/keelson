package store

import (
	"context"
	"database/sql"
	"errors"
	"time"
)

// ClaimEnrolment records that the code with this hash was redeemed at now, and reports whether this call is the one
// that did: the primary key makes it atomic, so of any number of concurrent redemptions exactly one gets true. expires
// is kept only so the row can be pruned once the code could not be redeemed anyway.
func (s *Store) ClaimEnrolment(ctx context.Context, hash string, expires, now time.Time) (fresh bool, err error) {
	res, err := s.db.ExecContext(ctx,
		`INSERT OR IGNORE INTO enrolments (hash, expires_at, used_at) VALUES (?, ?, ?)`, hash, ms(expires), ms(now))
	if err != nil {
		return false, err
	}
	n, err := res.RowsAffected()
	return n == 1, err
}

// PruneEnrolments forgets the redeemed codes whose expiry has passed.
func (s *Store) PruneEnrolments(ctx context.Context, now time.Time) error {
	_, err := s.db.ExecContext(ctx, `DELETE FROM enrolments WHERE expires_at <= ?`, ms(now))
	return err
}

// EnrolmentUsed returns when the code with this hash was redeemed; ok is false when it was not (or was pruned).
func (s *Store) EnrolmentUsed(ctx context.Context, hash string) (at time.Time, ok bool, err error) {
	var used int64
	err = s.db.QueryRowContext(ctx, `SELECT used_at FROM enrolments WHERE hash = ?`, hash).Scan(&used)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return time.Time{}, false, nil
		}
		return time.Time{}, false, err
	}
	return time.UnixMilli(used).UTC(), true, nil
}
