package databases

import (
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/0x2u/keelson/agent/internal/config"
	"github.com/0x2u/keelson/agent/internal/store"
)

// A dump cut at 60% still listed its first objects: only reading the data to the end tells.
func TestADumpThatIsCutShortIsNotABackup(t *testing.T) {
	h := newHarness(t, "", "")
	h.eng.readCode = 1
	_, err := h.backup()
	if err == nil || !strings.Contains(err.Error(), "verify the dump") || !strings.Contains(err.Error(), "read to the end") {
		t.Fatalf("a dump that cannot be read to the end must fail the backup: %v", err)
	}
	if h.rec.has("put shop/shop-20261021T030000Z.dump.age") || len(h.stagingLeft()) != 0 {
		t.Errorf("nothing is stored and nothing is left: %v %v", h.rec.list(), h.stagingLeft())
	}
}

func TestABackupThatTheDiskCouldNotHoldIsRefusedBeforeTheDump(t *testing.T) {
	h := newHarness(t, "", "")
	h.seed(h.now.Add(-24*time.Hour), h.id) // the last backup is a few hundred bytes: 2.5 times that is needed
	was := freeSpace
	t.Cleanup(func() { freeSpace = was })
	freeSpace = func(string) (uint64, error) { return 100, nil }

	_, err := h.backup()
	if err == nil || !strings.Contains(err.Error(), "not enough free space") || !strings.Contains(err.Error(), "2.5 times the last one") {
		t.Fatalf("%v", err)
	}
	if h.rec.has("run pg_dump") {
		t.Errorf("the dump must not start: %v", h.rec.list())
	}

	freeSpace = func(string) (uint64, error) { return 1 << 30, nil }
	if _, err := h.backup(); err != nil {
		t.Errorf("with room it runs: %v", err)
	}
}

func TestWithNoBackupToCompareWithTheFirstOneIsNotRefused(t *testing.T) {
	h := newHarness(t, "", "")
	was := freeSpace
	t.Cleanup(func() { freeSpace = was })
	freeSpace = func(string) (uint64, error) { return 0, nil }
	if _, err := h.backup(); err != nil {
		t.Errorf("nothing is known about the size of the first backup, so none is refused: %v", err)
	}
}

// Two dumps of one database at once only slow each other down and take twice the disk: a cron backup and a deployment's
// backup share a lock.
func TestTwoBackupsOfOneDatabaseRunOneAfterTheOther(t *testing.T) {
	h := newHarness(t, "", "")
	h.eng.hold, h.eng.holdKind, h.eng.reached = make(chan struct{}), "pg_dump", make(chan struct{})

	first := make(chan error, 1)
	go func() { _, err := h.backup(); first <- err }()
	<-h.eng.reached // the first dump is running

	var secondOut []string
	second := make(chan error, 1)
	go func() {
		second <- h.svc.BackupBeforeDeploy(t.Context(), "shop", func(l string) { secondOut = append(secondOut, l) })
	}()
	time.Sleep(400 * time.Millisecond)
	if n := strings.Count(strings.Join(h.rec.list(), " "), "run pg_dump"); n != 1 {
		t.Fatalf("the second backup must wait: %d dumps started", n)
	}
	close(h.eng.hold)
	if err := <-first; err != nil {
		t.Fatal(err)
	}
	if err := <-second; err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(strings.Join(secondOut, "\n"), "waiting for it to end") && !strings.Contains(strings.Join(secondOut, "\n"), "reusing") {
		t.Errorf("the wait (or the reuse of what the first took) is said: %v", secondOut)
	}
}

func TestADeploymentReusesABackupTakenAMomentAgoAndDumpsAgainOtherwise(t *testing.T) {
	h := newHarness(t, "", "")
	h.seed(h.now.Add(-30*time.Second), h.id)
	var out []string
	if err := h.svc.BackupBeforeDeploy(t.Context(), "shop", func(l string) { out = append(out, l) }); err != nil {
		t.Fatal(err)
	}
	if h.rec.has("run pg_dump") || !strings.Contains(strings.Join(out, "\n"), "reusing shop/shop-20261021T025930Z.dump.age") {
		t.Errorf("a backup of 30 seconds ago is the backup: %v %v", out, h.rec.list())
	}

	h2 := newHarness(t, "", "")
	h2.seed(h2.now.Add(-time.Hour), h2.id)
	if err := h2.svc.BackupBeforeDeploy(t.Context(), "shop", func(string) {}); err != nil {
		t.Fatal(err)
	}
	if !h2.rec.has("run pg_dump") || !h2.rec.has("put shop/shop-20261021T030000Z-pre-deploy.dump.age") {
		t.Errorf("an hour old is not recent, and the backup is kept as a pre-deploy one: %v", h2.rec.list())
	}
}

// A deployment's backup must never push a nightly one out of keep: each kind has its own count.
func TestPreDeployBackupsAreKeptApartFromTheScheduledOnes(t *testing.T) {
	h := newHarness(t, "", "keep_pre_deploy: 2")
	nightly := []string{}
	for i := 1; i <= 3; i++ {
		nightly = append(nightly, h.seed(h.now.Add(-time.Duration(i)*24*time.Hour), h.id))
	}
	var pre []string
	for i := 1; i <= 3; i++ {
		at := h.now.Add(-time.Duration(i) * time.Hour * 30)
		key := BackupKeyOf("shop", KindPreDeploy, at)
		h.dest.objects[key] = []byte("x")
		pre = append(pre, key)
	}
	if err := h.svc.BackupBeforeDeploy(t.Context(), "shop", func(string) {}); err != nil {
		t.Fatal(err)
	}
	for _, k := range nightly {
		if _, ok := h.dest.objects[k]; !ok {
			t.Errorf("a scheduled backup was pushed out by a deployment's: %s", k)
		}
	}
	left := 0
	for _, k := range pre {
		if _, ok := h.dest.objects[k]; ok {
			left++
		}
	}
	if _, ok := h.dest.objects["shop/shop-20261021T030000Z-pre-deploy.dump.age"]; !ok || left != 1 {
		t.Errorf("keep_pre_deploy 2: the new one and the newest older one stay (older ones left: %d)", left)
	}
}

func TestEveryDestinationHoldsTheBackupOrTheBackupFailsAndLeavesNoCopy(t *testing.T) {
	h := newHarness(t, "", "")
	second := &fakeDest{rec: h.rec, objects: map[string][]byte{}}
	cfg := h.svc.config()
	cfg.Databases[0].Backups.Destinations = []config.BackupDestination{{Local: &config.LocalDestination{Dir: "/a"}}, {Local: &config.LocalDestination{Dir: "/b"}}}
	h.svc.newDest = func(d config.BackupDestination) (Destination, error) {
		if d.Local.Dir == "/b" {
			return second, nil
		}
		return h.dest, nil
	}

	if _, err := h.backup(); err != nil {
		t.Fatal(err)
	}
	key := "shop/shop-20261021T030000Z.dump.age"
	if len(h.dest.objects[key]) == 0 || string(h.dest.objects[key]) != string(second.objects[key]) {
		t.Fatalf("both destinations hold the same backup: %d and %d bytes", len(h.dest.objects[key]), len(second.objects[key]))
	}

	// The second destination refuses the next one: the copy that reached the first is taken back.
	h.now = h.now.Add(24 * time.Hour)
	second.putErr = errors.New("s3 PUT: 403 Forbidden AccessDenied")
	_, err := h.backup()
	if err == nil || !strings.Contains(err.Error(), "local:/b") || !strings.Contains(err.Error(), "AccessDenied") {
		t.Fatalf("the failure names the destination that refused: %v", err)
	}
	if _, left := h.dest.objects["shop/shop-20261022T030000Z.dump.age"]; left {
		t.Error("a backup that is not everywhere it was promised is not a backup of record: the first copy must go")
	}
	if _, kept := h.dest.objects[key]; !kept {
		t.Error("the earlier backup stays")
	}
}

// A restore over the live database cannot be undone by itself: a backup of what is there comes first, and without it
// nothing is overwritten.
func TestARestoreOverTheLiveDatabaseTakesASafetyBackupFirstAndStopsIfItFails(t *testing.T) {
	h := newHarness(t, "", "")
	h.seed(h.now.Add(-24*time.Hour), h.id)
	run := h.restoreLive(t)
	if run.Status != store.JobSucceeded {
		t.Fatalf("%s: %s\n%s", run.Status, run.Detail, run.Output)
	}
	ops := h.rec.list()
	dumpAt, restoreAt := indexOf(ops, "run pg_dump"), lastIndexOf(ops, "run pg_restore")
	if dumpAt < 0 || restoreAt < dumpAt {
		t.Errorf("the safety backup comes before the overwrite: %v", ops)
	}
	if !h.rec.has("put shop/shop-20261021T030000Z-pre-restore.dump.age") {
		t.Errorf("and it is kept as a pre-restore backup: %v", ops)
	}

	h2 := newHarness(t, "", "")
	h2.seed(h2.now.Add(-24*time.Hour), h2.id)
	h2.eng.dumpCode = 1
	run = h2.restoreLive(t)
	if run.Status != store.JobFailed || !strings.Contains(run.Detail, "nothing was overwritten") {
		t.Fatalf("%s: %s", run.Status, run.Detail)
	}
	if specs := h2.eng.specsOf("pg_restore"); len(specs) != 0 {
		t.Errorf("no restore may run when the safety backup failed: %d", len(specs))
	}
}

// restoreLive restores the newest seeded backup over the live database and returns the run.
func (h *harness) restoreLive(t *testing.T) store.JobRun {
	t.Helper()
	keys := h.dest.keys()
	_, run, err := h.restore(RestoreRequest{Backup: keys[len(keys)-1], Identity: h.id.String(), Target: "shop", Overwrite: true, Confirm: "shop"})
	if err != nil {
		t.Fatal(err)
	}
	return run
}

func indexOf(list []string, want string) int {
	for i, s := range list {
		if s == want {
			return i
		}
	}
	return -1
}

func lastIndexOf(list []string, want string) int {
	for i := len(list) - 1; i >= 0; i-- {
		if list[i] == want {
			return i
		}
	}
	return -1
}
