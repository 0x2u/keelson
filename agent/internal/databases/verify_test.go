package databases

import (
	"bytes"
	"context"
	"crypto/rand"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"filippo.io/age"

	"github.com/0x2u/keelson/agent/internal/config"
)

func (h *harness) proofs() map[string]time.Time {
	h.t.Helper()
	list, err := h.st.Proofs(h.t.Context())
	if err != nil {
		h.t.Fatal(err)
	}
	out := map[string]time.Time{}
	for _, p := range list {
		out[p.Kind+"/"+p.Subject] = p.At
	}
	return out
}

func TestAKeyThatOpensTheNewestScheduledBackupIsProvedAndRecorded(t *testing.T) {
	h := newHarness(t, "version: 16", "")
	old := h.seed(testNow.AddDate(0, 0, -3), h.id)
	newest := h.seed(testNow.AddDate(0, 0, -1), h.id)
	// A backup taken before a deployment is newer, and still not what the schedule produced.
	h.dest.objects[BackupKeyOf("shop", KindPreDeploy, testNow.Add(-time.Hour))] = []byte("not even age")
	secret := h.id.String()

	res, err := h.svc.VerifyKey(t.Context(), "shop", secret, "")
	if err != nil {
		t.Fatal(err)
	}
	if !res.OK || res.Reason != "" || res.Backup != newest || !res.BackupTime.Equal(testNow.AddDate(0, 0, -1)) {
		t.Fatalf("%+v (the old one is %s)", res, old)
	}
	if got := h.proofs(); len(got) != 1 || !got["key/shop"].Equal(testNow) {
		t.Errorf("a proof is recorded for the database: %v", got)
	}
	if !h.rec.has("open "+newest) || h.rec.has("get ") {
		t.Errorf("the object is streamed, not downloaded: %v", h.rec.list())
	}
	if len(h.eng.specs) != 0 {
		t.Error("no container is needed to prove a key")
	}
	if left := h.stagingLeft(); len(left) != 0 {
		t.Errorf("nothing is staged: %v", left)
	}

	// A named backup, even one of another kind, is the one tried.
	if res, err := h.svc.VerifyKey(t.Context(), "shop", secret, old); err != nil || !res.OK || res.Backup != old {
		t.Errorf("a named backup: %+v %v", res, err)
	}
	filepath.Walk(h.dataDir, func(path string, info os.FileInfo, err error) error {
		if err == nil && !info.IsDir() {
			if b, _ := os.ReadFile(path); bytes.Contains(b, []byte("AGE-SECRET-KEY")) {
				t.Errorf("the key was written to %s", path)
			}
		}
		return nil
	})
	if strings.Contains(h.logs.String(), secret) {
		t.Error("the key reached the log")
	}
}

func TestAKeyThatDoesNotOpenTheBackupIsNotProved(t *testing.T) {
	h := newHarness(t, "version: 16", "")
	h.seed(testNow.AddDate(0, 0, -1), h.id)
	other, _ := age.GenerateX25519Identity()

	res, err := h.svc.VerifyKey(t.Context(), "shop", other.String(), "")
	if err != nil || res.OK || res.Reason != ReasonWrongKey {
		t.Fatalf("%+v %v", res, err)
	}
	if got := h.proofs(); len(got) != 0 {
		t.Errorf("a wrong key proves nothing: %v", got)
	}
	if strings.Contains(h.logs.String(), other.String()) {
		t.Error("the key reached the log")
	}
}

func TestAnObjectThatIsNotAnAgeFileIsToldApart(t *testing.T) {
	for name, content := range map[string][]byte{
		"plain text":        []byte("hello, I am not encrypted"),
		"empty":             nil,
		"cut in its header": []byte("age-encryption.org/v1\n-> X25519 "),
	} {
		t.Run(name, func(t *testing.T) {
			h := newHarness(t, "version: 16", "")
			key := BackupKey("shop", testNow.AddDate(0, 0, -1))
			h.dest.objects[key] = content
			res, err := h.svc.VerifyKey(t.Context(), "shop", h.id.String(), "")
			if err != nil || res.OK || res.Reason != ReasonNotAge {
				t.Fatalf("%+v %v", res, err)
			}
			if len(h.proofs()) != 0 {
				t.Error("no proof")
			}
		})
	}
}

func TestAKeyIsNotTriedWhenThereIsNoBackupToTryItOn(t *testing.T) {
	h := newHarness(t, "version: 16", "")
	secret := h.id.String()
	res, err := h.svc.VerifyKey(t.Context(), "shop", secret, "")
	if err != nil || res.OK || res.Reason != ReasonNoBackup {
		t.Fatalf("an empty destination: %+v %v", res, err)
	}
	h.dest.objects[BackupKeyOf("shop", KindPreDeploy, testNow)] = []byte("x")
	if res, err = h.svc.VerifyKey(t.Context(), "shop", secret, ""); err != nil || res.Reason != ReasonNoBackup {
		t.Fatalf("only a backup taken before a deployment: %+v %v", res, err)
	}
	h.svc.config().Databases[0].Backups = nil
	if res, err = h.svc.VerifyKey(t.Context(), "shop", secret, ""); err != nil || res.Reason != ReasonNoBackup {
		t.Fatalf("no backup section: %+v %v", res, err)
	}
	if len(h.proofs()) != 0 {
		t.Error("no proof")
	}
}

func TestAnUnreachableDestinationIsFetchFailedAndTheLogKeepsTheCause(t *testing.T) {
	h := newHarness(t, "version: 16", "")
	secret := h.id.String()
	h.dest.listErr = errors.New("dial tcp 10.0.0.5:9000: connection refused")
	res, err := h.svc.VerifyKey(t.Context(), "shop", secret, "")
	if err != nil || res.OK || res.Reason != ReasonFetchFailed {
		t.Fatalf("listing fails: %+v %v", res, err)
	}
	if !strings.Contains(h.logs.String(), "10.0.0.5:9000") {
		t.Errorf("the operator reads the cause in the log: %s", h.logs)
	}
	h.dest.listErr = nil
	missing := BackupKey("shop", testNow.AddDate(0, 0, -5))
	if res, err = h.svc.VerifyKey(t.Context(), "shop", secret, missing); err != nil || res.Reason != ReasonFetchFailed {
		t.Fatalf("the named object is not there: %+v %v", res, err)
	}
	if strings.Contains(h.logs.String(), secret) {
		t.Error("the key reached the log")
	}
}

// A connection that breaks while the start of the object is read is a failed fetch, not a file that is not age.
func TestAConnectionThatBreaksIsNotTakenForAFileThatIsNotAge(t *testing.T) {
	h := newHarness(t, "version: 16", "")
	key := h.seed(testNow.AddDate(0, 0, -1), h.id)
	h.svc.newDest = func(config.BackupDestination) (Destination, error) {
		return &brokenDest{h.dest}, nil
	}
	res, err := h.svc.VerifyKey(t.Context(), "shop", h.id.String(), key)
	if err != nil || res.Reason != ReasonFetchFailed {
		t.Fatalf("%+v %v", res, err)
	}
}

type brokenDest struct{ *fakeDest }

func (b *brokenDest) Open(ctx context.Context, key string) (io.ReadCloser, error) {
	r, err := b.fakeDest.Open(ctx, key)
	if err != nil {
		return nil, err
	}
	return io.NopCloser(io.MultiReader(io.LimitReader(r, 10), errReader{errors.New("connection reset by peer")})), nil
}

type errReader struct{ err error }

func (e errReader) Read([]byte) (int, error) { return 0, e.err }

// Only the start of the object is read: for a backup of many gigabytes the check costs one block.
func TestOnlyTheStartOfALargeBackupIsRead(t *testing.T) {
	h := newHarness(t, "version: 16", "")
	dir := t.TempDir()
	big := make([]byte, 4<<20)
	rand.Read(big)
	os.WriteFile(filepath.Join(dir, "dump"), big, 0o600)
	if _, err := encryptFile(filepath.Join(dir, "dump"), filepath.Join(dir, "dump.age"), []string{h.id.Recipient().String()}); err != nil {
		t.Fatal(err)
	}
	enc, _ := os.ReadFile(filepath.Join(dir, "dump.age"))
	key := BackupKey("shop", testNow.AddDate(0, 0, -1))
	h.dest.objects[key] = enc

	var read atomic.Int64
	h.svc.newDest = func(config.BackupDestination) (Destination, error) { return &countingDest{h.dest, &read}, nil }
	res, err := h.svc.VerifyKey(t.Context(), "shop", h.id.String(), "")
	if err != nil || !res.OK {
		t.Fatalf("%+v %v", res, err)
	}
	if n := read.Load(); n > 256<<10 || n < 1 {
		t.Errorf("read %d of %d bytes: the first block is enough", n, len(enc))
	}
}

type countingDest struct {
	*fakeDest
	read *atomic.Int64
}

func (c *countingDest) Open(ctx context.Context, key string) (io.ReadCloser, error) {
	r, err := c.fakeDest.Open(ctx, key)
	if err != nil {
		return nil, err
	}
	return struct {
		io.Reader
		io.Closer
	}{readFunc(func(p []byte) (int, error) { n, err := r.Read(p); c.read.Add(int64(n)); return n, err }), r}, nil
}

type readFunc func([]byte) (int, error)

func (f readFunc) Read(p []byte) (int, error) { return f(p) }

func TestAKeyCheckRefusesWhatCannotBeAnswered(t *testing.T) {
	h := newHarness(t, "version: 16", "")
	h.seed(testNow.AddDate(0, 0, -1), h.id)
	var bad *RequestError
	if _, err := h.svc.VerifyKey(t.Context(), "shop", "not a key", ""); !errors.As(err, &bad) {
		t.Errorf("an identity that is not an age key: %v", err)
	}
	if _, err := h.svc.VerifyKey(t.Context(), "shop", h.id.String(), "shop/another.dump.age"); !errors.As(err, &bad) {
		t.Errorf("a key that is not a backup of this database: %v", err)
	}
	if _, err := h.svc.VerifyKey(t.Context(), "ghost", h.id.String(), ""); !errors.Is(err, ErrUnknownDatabase) {
		t.Errorf("an unknown database: %v", err)
	}
	if len(h.proofs()) != 0 || h.rec.has("open") {
		t.Errorf("nothing was tried: %v %v", h.proofs(), h.rec.list())
	}
}
