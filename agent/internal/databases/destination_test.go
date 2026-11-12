package databases

import (
	"bytes"
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"filippo.io/age"
)

func identity(t *testing.T) *age.X25519Identity {
	t.Helper()
	id, err := age.GenerateX25519Identity()
	if err != nil {
		t.Fatal(err)
	}
	return id
}

func TestEncryptThenDecryptRoundTripsForAnyRecipient(t *testing.T) {
	a, b := identity(t), identity(t)
	dir := t.TempDir()
	plain := bytes.Repeat([]byte("PGDMP row of data\n"), 20000)
	src := filepath.Join(dir, "dump")
	os.WriteFile(src, plain, 0o600)

	size, err := encryptFile(src, filepath.Join(dir, "dump.age"), []string{a.Recipient().String(), b.Recipient().String()})
	if err != nil {
		t.Fatal(err)
	}
	enc, _ := os.ReadFile(filepath.Join(dir, "dump.age"))
	if int64(len(enc)) != size || bytes.Contains(enc, []byte("PGDMP")) {
		t.Fatalf("size %d vs %d, or plaintext visible", size, len(enc))
	}
	for i, id := range []age.Identity{a, b} {
		out := filepath.Join(dir, "out"+string(rune('0'+i)))
		if err := decryptFile(filepath.Join(dir, "dump.age"), out, id); err != nil {
			t.Fatalf("recipient %d: %v", i, err)
		}
		if got, _ := os.ReadFile(out); !bytes.Equal(got, plain) {
			t.Errorf("recipient %d: the plaintext differs", i)
		}
	}
}

func TestDecryptWithAnotherKeyOrOnATruncatedFileFails(t *testing.T) {
	dir := t.TempDir()
	src := filepath.Join(dir, "dump")
	os.WriteFile(src, bytes.Repeat([]byte("x"), 200000), 0o600)
	owner := identity(t)
	encryptFile(src, filepath.Join(dir, "dump.age"), []string{owner.Recipient().String()})

	err := decryptFile(filepath.Join(dir, "dump.age"), filepath.Join(dir, "out"), identity(t))
	if !errors.Is(err, ErrWrongKey) || err.Error() != "this key cannot decrypt the backup" {
		t.Errorf("a wrong key must say so: %v", err)
	}

	enc, _ := os.ReadFile(filepath.Join(dir, "dump.age"))
	os.WriteFile(filepath.Join(dir, "cut.age"), enc[:len(enc)-100], 0o600)
	if err := decryptFile(filepath.Join(dir, "cut.age"), filepath.Join(dir, "out"), owner); err == nil || errors.Is(err, ErrWrongKey) {
		t.Errorf("a truncated backup must fail on its own, not as a wrong key: %v", err)
	}
	os.WriteFile(filepath.Join(dir, "junk.age"), []byte("not age at all"), 0o600)
	if err := decryptFile(filepath.Join(dir, "junk.age"), filepath.Join(dir, "out"), owner); err == nil {
		t.Error("a file that is not age must fail")
	}
}

func TestLocalDestination(t *testing.T) {
	root := t.TempDir()
	d := &localDestination{dir: filepath.Join(root, "backups")}
	ctx := t.Context()
	key := "shop/shop-20260101T030000Z.dump.age"

	src := filepath.Join(root, "src")
	os.WriteFile(src, []byte("ciphertext"), 0o600)
	if err := d.Put(ctx, key, src); err != nil {
		t.Fatal(err)
	}
	stored, _ := os.ReadFile(filepath.Join(root, "backups", "shop", "shop-20260101T030000Z.dump.age"))
	if string(stored) != "ciphertext" {
		t.Fatalf("stored %q", stored)
	}
	if entries, _ := os.ReadDir(filepath.Join(root, "backups", "shop")); len(entries) != 1 {
		t.Errorf("no temporary file may stay beside the backup: %v", entries)
	}
	if info, _ := os.Stat(filepath.Join(root, "backups", "shop", "shop-20260101T030000Z.dump.age")); info.Mode().Perm() != 0o600 {
		t.Errorf("backups are private to the agent's user, mode %v", info.Mode().Perm())
	}

	objs, err := d.List(ctx, "shop/")
	if err != nil || len(objs) != 1 || objs[0] != (Object{Key: key, Size: 10}) {
		t.Errorf("%+v %v", objs, err)
	}
	if objs, err := d.List(ctx, "other/"); err != nil || len(objs) != 0 {
		t.Errorf("an unknown database has no backups: %+v %v", objs, err)
	}

	got := filepath.Join(root, "got")
	if err := d.Get(ctx, key, got); err != nil {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(got); string(b) != "ciphertext" {
		t.Errorf("got %q", b)
	}
	if err := d.Delete(ctx, key); err != nil {
		t.Fatal(err)
	}
	if objs, _ := d.List(ctx, "shop/"); len(objs) != 0 {
		t.Errorf("deleted: %+v", objs)
	}
}

func TestLocalDestinationRefusesKeysOutsideItsDirectory(t *testing.T) {
	root := t.TempDir()
	secret := filepath.Join(root, "secret")
	os.WriteFile(secret, []byte("do not read"), 0o600)
	d := &localDestination{dir: filepath.Join(root, "backups")}
	for _, key := range []string{"../secret", "shop/../../secret", "/etc/passwd", ""} {
		if err := d.Get(t.Context(), key, filepath.Join(root, "out")); err == nil || !strings.Contains(err.Error(), "invalid key") {
			t.Errorf("Get(%q): %v", key, err)
		}
		if err := d.Delete(t.Context(), key); err == nil {
			t.Errorf("Delete(%q) must be refused", key)
		}
	}
	if _, err := os.Stat(secret); err != nil {
		t.Error("the file outside the directory must be untouched")
	}
}

func TestLocalDestinationNeverReplacesABackup(t *testing.T) {
	root := t.TempDir()
	d := &localDestination{dir: filepath.Join(root, "backups")}
	key := "shop/shop-20260101T030000Z.dump.age"
	first, second := filepath.Join(root, "first"), filepath.Join(root, "second")
	os.WriteFile(first, []byte("first"), 0o600)
	os.WriteFile(second, []byte("second"), 0o600)
	if err := d.Put(t.Context(), key, first); err != nil {
		t.Fatal(err)
	}
	err := d.Put(t.Context(), key, second)
	if !errors.Is(err, ErrExists) {
		t.Fatalf("a taken key is ErrExists, got %v", err)
	}
	if got, _ := os.ReadFile(filepath.Join(root, "backups", key)); string(got) != "first" {
		t.Errorf("the backup was replaced: %q", got)
	}
	if entries, _ := os.ReadDir(filepath.Join(root, "backups", "shop")); len(entries) != 1 {
		t.Errorf("a refused upload must leave no temporary file: %v", entries)
	}
}

func TestLocalDestinationLeavesNoTemporaryFileOnAFailedUpload(t *testing.T) {
	root := t.TempDir()
	d := &localDestination{dir: filepath.Join(root, "backups")}
	src := filepath.Join(root, "src")
	os.WriteFile(src, bytes.Repeat([]byte("x"), 1<<20), 0o600)
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	if err := d.Put(ctx, "shop/shop-20260101T030000Z.dump.age", src); err == nil {
		t.Fatal("a canceled upload must fail")
	}
	if entries, _ := os.ReadDir(filepath.Join(root, "backups", "shop")); len(entries) != 0 {
		t.Errorf("temporary files left behind: %v", entries)
	}
}

func TestLocalDestinationSweepsStaleUploadsButNotRecentOnes(t *testing.T) {
	root := t.TempDir()
	dir := filepath.Join(root, "backups", "shop")
	os.MkdirAll(dir, 0o700)
	stale, recent, backup := filepath.Join(dir, ".upload-111"), filepath.Join(dir, ".upload-222"), filepath.Join(dir, "shop-20260101T030000Z.dump.age")
	for _, p := range []string{stale, recent, backup} {
		os.WriteFile(p, []byte("x"), 0o600)
	}
	old := time.Now().Add(-2 * staleUpload)
	os.Chtimes(stale, old, old)
	os.Chtimes(backup, old, old) // an old backup is not a temporary file

	d := &localDestination{dir: filepath.Join(root, "backups")}
	objs, err := d.List(t.Context(), "shop/")
	if err != nil || len(objs) != 1 || objs[0].Key != "shop/shop-20260101T030000Z.dump.age" {
		t.Fatalf("a temporary file is never listed: %+v %v", objs, err)
	}
	if _, err := os.Stat(stale); !os.IsNotExist(err) {
		t.Error("the stale temporary file must be removed by a listing")
	}
	if _, err := os.Stat(recent); err != nil {
		t.Error("a recent temporary file may belong to an upload in progress")
	}
	if _, err := os.Stat(backup); err != nil {
		t.Error("a backup must never be swept")
	}

	// An upload sweeps its own directory too.
	os.WriteFile(stale, []byte("x"), 0o600)
	os.Chtimes(stale, old, old)
	src := filepath.Join(root, "src")
	os.WriteFile(src, []byte("data"), 0o600)
	if err := d.Put(t.Context(), "shop/shop-20260102T030000Z.dump.age", src); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(stale); !os.IsNotExist(err) {
		t.Error("the stale temporary file must be removed by an upload")
	}
}
