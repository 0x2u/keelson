package databases

import (
	"sort"
	"strings"
	"time"
)

const (
	keyTimeLayout = "20060102T150405Z"
	keySuffix     = ".dump.age"
	grantsSuffix  = ".grants.sql.age"
)

// Why a backup was taken. It is part of the key, so retention counts each kind apart: a deployment's backup must
// not evict nightly ones, and the safety backup before a restore must not be pruned by either.
const (
	KindScheduled  = ""
	KindPreDeploy  = "pre-deploy"
	KindPreRestore = "pre-restore"
)

// Backup is one backup as the destination lists it: the destination is the source of truth for which backups exist.
type Backup struct {
	Key       string    `json:"key"`
	Name      string    `json:"name"`
	SizeBytes int64     `json:"size_bytes"`
	CreatedAt time.Time `json:"created_at"`
	// Kind is "pre-deploy" or "pre-restore"; empty for a scheduled or manual backup.
	Kind string `json:"kind,omitempty"`
}

// BackupKey is where the backup of database taken at t is stored: "<db>/<db>-<YYYYMMDDTHHMMSSZ>.dump.age", in UTC.
func BackupKey(database string, t time.Time) string { return BackupKeyOf(database, KindScheduled, t) }

// BackupKeyOf is BackupKey for a backup of the given kind: "<db>/<db>-<YYYYMMDDTHHMMSSZ>-<kind>.dump.age".
func BackupKeyOf(database, kind string, t time.Time) string {
	stamp := t.UTC().Format(keyTimeLayout)
	if kind != KindScheduled {
		stamp += "-" + kind
	}
	return database + "/" + database + "-" + stamp + keySuffix
}

// grantsKey is the object that holds the grants and ownership of the backup stored under dumpKey.
func grantsKey(dumpKey string) string {
	return strings.TrimSuffix(dumpKey, keySuffix) + grantsSuffix
}

// ParseKey returns the time a backup of database was taken, read from its key. It is false for any other key, so a
// stray file in the destination is never listed, restored or deleted.
func ParseKey(database, key string) (time.Time, bool) {
	t, _, ok := parseKey(database, key)
	return t, ok
}

// parseKey also returns the kind of the backup.
func parseKey(database, key string) (time.Time, string, bool) {
	rest, ok := strings.CutPrefix(key, database+"/"+database+"-")
	if !ok {
		return time.Time{}, "", false
	}
	stamp, ok := strings.CutSuffix(rest, keySuffix)
	if !ok {
		return time.Time{}, "", false
	}
	stamp, kind, _ := strings.Cut(stamp, "-")
	if kind != KindScheduled && kind != KindPreDeploy && kind != KindPreRestore {
		return time.Time{}, "", false
	}
	t, err := time.ParseInLocation(keyTimeLayout, stamp, time.UTC)
	if err != nil {
		return time.Time{}, "", false
	}
	return t, kind, true
}

// backupsOf keeps the objects that are backups of database, newest first.
func backupsOf(database string, objects []Object) []Backup {
	var out []Backup
	for _, o := range objects {
		if t, kind, ok := parseKey(database, o.Key); ok {
			out = append(out, Backup{Key: o.Key, Name: o.Key[strings.LastIndex(o.Key, "/")+1:], SizeBytes: o.Size, CreatedAt: t, Kind: kind})
		}
	}
	sort.Slice(out, func(i, j int) bool {
		if !out[i].CreatedAt.Equal(out[j].CreatedAt) {
			return out[i].CreatedAt.After(out[j].CreatedAt)
		}
		return out[i].Key > out[j].Key
	})
	return out
}

// ofKind returns the backups of one kind, keeping their order.
func ofKind(backups []Backup, kind string) []Backup {
	var out []Backup
	for _, b := range backups {
		if b.Kind == kind {
			out = append(out, b)
		}
	}
	return out
}

// expired returns the backups retention deletes. backups is newest first. A backup goes when it is not among the
// newest keep, or when it is older than keepDays days (0 = no age limit). The newest backup always stays: a
// retention rule can never leave a database with nothing to restore.
func expired(backups []Backup, keep, keepDays int, now time.Time) []Backup {
	var out []Backup
	cutoff := now.AddDate(0, 0, -keepDays)
	for i, b := range backups {
		if i == 0 {
			continue
		}
		if i >= keep || (keepDays > 0 && b.CreatedAt.Before(cutoff)) {
			out = append(out, b)
		}
	}
	return out
}
