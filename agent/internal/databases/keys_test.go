package databases

import (
	"fmt"
	"testing"
	"time"
)

func TestBackupKeyRoundTripsAndIsInUTC(t *testing.T) {
	paris := time.FixedZone("CEST", 2*3600)
	at := time.Date(2026, 3, 9, 5, 7, 11, 0, paris) // 03:07:11 UTC
	key := BackupKey("shop", at)
	if key != "shop/shop-20260309T030711Z.dump.age" {
		t.Fatalf("key %q", key)
	}
	got, ok := ParseKey("shop", key)
	if !ok || !got.Equal(at) || got.Location() != time.UTC {
		t.Errorf("ParseKey(%q) = %v, %v", key, got, ok)
	}
}

func TestParseKeyOnlyAcceptsABackupOfThatDatabase(t *testing.T) {
	for _, key := range []string{
		"",
		"shop/shop-20260309T030711Z.dump", // not encrypted
		"shop/shop-20260309T030711Z.dump.age.tmp",
		"shop/shop-20260309T030711.dump.age",     // no Z
		"shop/shop-20261309T030711Z.dump.age",    // month 13
		"shop/shop-eu-20260309T030711Z.dump.age", // another database's file name
		"shop-eu/shop-eu-20260309T030711Z.dump.age",
		"other/shop-20260309T030711Z.dump.age",
		"shop/sub/shop-20260309T030711Z.dump.age",
		"shop/../shop/shop-20260309T030711Z.dump.age",
		"/shop/shop-20260309T030711Z.dump.age",
		"shop/.upload-123",
	} {
		if _, ok := ParseKey("shop", key); ok {
			t.Errorf("ParseKey(shop, %q) must be refused", key)
		}
	}
}

func TestBackupsOfIgnoresStrayFilesAndSortsNewestFirst(t *testing.T) {
	got := backupsOf("shop", []Object{
		{Key: "shop/shop-20260101T030000Z.dump.age", Size: 10},
		{Key: "shop/notes.txt", Size: 1},
		{Key: "shop/shop-20260103T030000Z.dump.age", Size: 30},
		{Key: "shop/.upload-9", Size: 5},
		{Key: "shop/shop-20260102T030000Z.dump.age", Size: 20},
	})
	if len(got) != 3 || got[0].SizeBytes != 30 || got[1].SizeBytes != 20 || got[2].SizeBytes != 10 {
		t.Fatalf("%+v", got)
	}
	if got[0].Name != "shop-20260103T030000Z.dump.age" || got[0].CreatedAt != time.Date(2026, 1, 3, 3, 0, 0, 0, time.UTC) {
		t.Errorf("name and date come from the key: %+v", got[0])
	}
}

// days builds n backups, one a day, the newest first, the newest being `age` days old at now.
func days(now time.Time, age, n int) []Backup {
	var out []Backup
	for i := range n {
		at := now.AddDate(0, 0, -(age + i))
		out = append(out, Backup{Key: BackupKey("shop", at), CreatedAt: at})
	}
	return out
}

func keys(bs []Backup) []string {
	var out []string
	for _, b := range bs {
		out = append(out, b.Key)
	}
	return out
}

func TestRetention(t *testing.T) {
	now := time.Date(2026, 6, 15, 12, 0, 0, 0, time.UTC)
	cases := []struct {
		name           string
		backups        []Backup
		keep, keepDays int
		wantDeleted    []int // indexes into backups
	}{
		{"fewer than keep", days(now, 0, 3), 14, 0, nil},
		{"exactly keep", days(now, 0, 14), 14, 0, nil},
		{"keep N drops the oldest", days(now, 0, 16), 14, 0, []int{14, 15}},
		{"keep 1", days(now, 0, 3), 1, 0, []int{1, 2}},
		{"keep_days drops the old ones", days(now, 0, 10), 14, 7, []int{8, 9}},
		{"a backup exactly keep_days old stays", days(now, 0, 8), 14, 7, nil},
		{"both rules apply: the stricter wins", days(now, 0, 10), 5, 8, []int{5, 6, 7, 8, 9}},
		{"keep_days alone cannot empty the destination", days(now, 30, 3), 14, 7, []int{1, 2}},
		{"the only backup is never deleted", days(now, 400, 1), 1, 1, nil},
		{"nothing to do", nil, 14, 7, nil},
	}
	for _, c := range cases {
		var want []string
		for _, i := range c.wantDeleted {
			want = append(want, c.backups[i].Key)
		}
		got := keys(expired(c.backups, c.keep, c.keepDays, now))
		if fmt.Sprint(got) != fmt.Sprint(want) {
			t.Errorf("%s: deleted %v, want %v", c.name, got, want)
		}
		if len(c.backups) > 0 {
			for _, k := range got {
				if k == c.backups[0].Key {
					t.Errorf("%s: the newest backup must never be deleted", c.name)
				}
			}
		}
	}
}
