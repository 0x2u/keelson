package databases

import (
	"context"
	"errors"
	"fmt"
	"io"
	"strings"
	"time"

	"filippo.io/age"

	"github.com/0x2u/keelson/agent/internal/config"
	"github.com/0x2u/keelson/agent/internal/store"
)

// Why a key could not be proved on a backup.
const (
	// ReasonWrongKey: the backup is an age file and this key is not one of its recipients.
	ReasonWrongKey = "wrong_key"
	// ReasonNotAge: the object is not an age file (or its first block does not authenticate).
	ReasonNotAge = "not_age"
	// ReasonNoBackup: the database has no scheduled backup to try the key on.
	ReasonNoBackup = "no_backup"
	// ReasonFetchFailed: the destination could not be read.
	ReasonFetchFailed = "fetch_failed"
)

// errNoBackup is pickBackup finding nothing to pick.
var errNoBackup = errors.New("there is no scheduled backup of this database")

// KeyCheck is the answer of VerifyKey. When OK is false only Reason is meant for the caller; Backup is what was tried.
type KeyCheck struct {
	OK         bool
	Reason     string
	Backup     string
	BackupTime time.Time
}

// pickBackup returns the backup to work on: the one named, which must be the key of a backup of the database, or else the
// newest scheduled one (a backup taken before a deployment or a restore is not what the schedule produced). errNoBackup
// says there is none.
func (s *Service) pickBackup(ctx context.Context, db config.Database, key string) (string, time.Time, error) {
	if key != "" {
		t, ok := ParseKey(db.Name, key)
		if !ok {
			return "", time.Time{}, &RequestError{"backup is not the key of a backup of this database"}
		}
		return key, t, nil
	}
	dests, err := s.newDests(db.Backups)
	if err != nil {
		return "", time.Time{}, err
	}
	objects, err := dests[0].dest.List(ctx, db.Name+"/")
	if err != nil {
		return "", time.Time{}, classify(ErrDestination, err)
	}
	scheduled := ofKind(backupsOf(db.Name, objects), KindScheduled)
	if len(scheduled) == 0 {
		return "", time.Time{}, errNoBackup
	}
	return scheduled[0].Key, scheduled[0].CreatedAt, nil
}

// VerifyKey proves that an age identity opens a backup of the database: it reads the start of the object, which is all that
// age needs to say whether the key is a recipient and whether the first block authenticates, and stops there; nothing is
// written to disk and the rest of the object is never read. The identity lives in this call: it is neither logged nor stored.
// A key that works is recorded as a proof for the database. Which key was tried and what became of it is the answer; a
// request that cannot be answered at all (an unknown database, an identity that is not an age key, a backup that is not one
// of this database's) is an error.
func (s *Service) VerifyKey(ctx context.Context, name, identity, backup string) (KeyCheck, error) {
	db, err := s.database(name)
	if err != nil {
		return KeyCheck{}, err
	}
	id, err := age.ParseX25519Identity(strings.TrimSpace(identity))
	if err != nil {
		return KeyCheck{}, &RequestError{"identity must be an age secret key (AGE-SECRET-KEY-1...)"}
	}
	if db.Backups == nil {
		return KeyCheck{Reason: ReasonNoBackup}, nil
	}
	key, at, err := s.pickBackup(ctx, db, backup)
	var bad *RequestError
	switch {
	case errors.As(err, &bad):
		return KeyCheck{}, err
	case errors.Is(err, errNoBackup):
		return KeyCheck{Reason: ReasonNoBackup}, nil
	case err != nil:
		s.log.Warn("verify key: could not list the backups", "database", db.Name, "err", err)
		return KeyCheck{Reason: ReasonFetchFailed}, nil
	}
	res := KeyCheck{Backup: key, BackupTime: at}
	if res.Reason = s.openBackup(ctx, db, key, id); res.Reason != "" {
		return res, nil
	}
	if err := s.store.RecordProof(ctx, store.ProofKey, db.Name, s.now()); err != nil {
		return KeyCheck{}, fmt.Errorf("record the proof: %w", err)
	}
	res.OK = true
	return res, nil
}

// openBackup streams the start of the object through age and says why it did not work, or "" when it did.
func (s *Service) openBackup(ctx context.Context, db config.Database, key string, id age.Identity) string {
	dests, err := s.newDests(db.Backups)
	if err != nil {
		s.log.Warn("verify key: could not reach the destination", "database", db.Name, "err", err)
		return ReasonFetchFailed
	}
	var body io.ReadCloser
	for _, d := range dests { // every destination holds every backup: the first that answers will do
		if body, err = d.dest.Open(ctx, key); err == nil {
			break
		}
	}
	if err != nil {
		s.log.Warn("verify key: could not open the backup", "database", db.Name, "backup", key, "err", err)
		return ReasonFetchFailed
	}
	defer body.Close()

	// What the object's own reads failed with tells a damaged connection from an object that is not an age file: age reports
	// both as a failed read.
	src := &failureReader{r: body}
	r, err := age.Decrypt(src, id)
	if err == nil {
		_, err = r.Read(make([]byte, 1)) // the first block: age authenticates it before it gives a byte
		if errors.Is(err, io.EOF) {
			err = nil
		}
	}
	switch {
	case err == nil:
		return ""
	case src.err != nil:
		s.log.Warn("verify key: reading the backup failed", "database", db.Name, "backup", key, "err", src.err)
		return ReasonFetchFailed
	}
	var noMatch *age.NoIdentityMatchError
	if errors.As(err, &noMatch) {
		return ReasonWrongKey
	}
	return ReasonNotAge
}

// failureReader remembers the first error of its source that is not the end of it.
type failureReader struct {
	r   io.Reader
	err error
}

func (f *failureReader) Read(p []byte) (int, error) {
	n, err := f.r.Read(p)
	if err != nil && err != io.EOF && f.err == nil {
		f.err = err
	}
	return n, err
}
