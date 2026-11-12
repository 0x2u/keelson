package databases

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"testing"
	"time"

	"filippo.io/age"

	"github.com/0x2u/keelson/agent/internal/store"
)

var scratchPattern = regexp.MustCompile(`^shop_rt_[0-9a-f]{8}$`)

// startTest starts a restore test and waits for it to end.
func (h *harness) startTest(req RestoreTestRequest) (store.RestoreTest, error) {
	h.t.Helper()
	req.Database = "shop"
	started, err := h.svc.StartRestoreTest(h.t.Context(), req)
	if err != nil {
		return started, err
	}
	h.svc.wg.Wait()
	return h.test(started.ID), nil
}

func (h *harness) test(id string) store.RestoreTest {
	h.t.Helper()
	tests, err := h.svc.RestoreTests(h.t.Context(), "shop", 50)
	if err != nil {
		h.t.Fatal(err)
	}
	for _, t := range tests {
		if t.ID == id {
			return t
		}
	}
	h.t.Fatalf("test %s not recorded", id)
	return store.RestoreTest{}
}

func (h *harness) dbsLeft() []string {
	h.eng.mu.Lock()
	defer h.eng.mu.Unlock()
	var out []string
	for name := range h.eng.databases {
		out = append(out, name)
	}
	return out
}

func TestARestoreTestRestoresIntoAScratchDatabaseCountsBothSidesAndDropsIt(t *testing.T) {
	h := newHarness(t, "version: 16", "")
	key := h.seed(testNow.AddDate(0, 0, -1), h.id)
	h.eng.tables["scratch"] = []string{"public.orders|7", "public.users|42", "app.events|0"}
	h.eng.tables["shop"] = []string{"app.events|3", "public.orders|9", "public.users|40"}
	secret := h.id.String()

	got, err := h.startTest(RestoreTestRequest{Identity: secret})
	if err != nil {
		t.Fatal(err)
	}
	if got.Status != store.TestPassed || got.Error != "" || got.Backup != key || !got.BackupTime.Equal(testNow.AddDate(0, 0, -1)) || got.FinishedAt == nil {
		t.Fatalf("%+v", got)
	}
	want := []store.TableCount{
		{Name: "app.events", BackupRows: new(int64(0)), LiveRows: new(int64(3))},
		{Name: "public.orders", BackupRows: new(int64(7)), LiveRows: new(int64(9))},
		{Name: "public.users", BackupRows: new(int64(42)), LiveRows: new(int64(40))},
	}
	if fmt.Sprint(tablesString(got.Tables)) != fmt.Sprint(tablesString(want)) {
		t.Errorf("tables:\n got  %v\n want %v", tablesString(got.Tables), tablesString(want))
	}

	steps := []string{"list", "get " + key, "run pg_restore --list", "run pg_restore read", "run psql create", "run pg_restore", "run psql table counts", "run psql table counts", "run psql drop"}
	if got := h.rec.list(); fmt.Sprint(got) != fmt.Sprint(steps) {
		t.Errorf("order of steps:\n got  %v\n want %v", got, steps)
	}
	create, drop := quoted(h.eng.specsOf("psql create")[0]), quoted(h.eng.specsOf("psql drop")[0])
	if !scratchPattern.MatchString(create) || create != drop {
		t.Errorf("the scratch database is %q and the one dropped %q", create, drop)
	}
	if dbArg(h.eng.specsOf("pg_restore")[0]) != create || strings.Contains(strings.Join(h.eng.specsOf("pg_restore")[0].Cmd, " "), "--clean") {
		t.Errorf("the backup is restored into the scratch database, not over anything: %v", h.eng.specsOf("pg_restore")[0].Cmd)
	}
	counted := h.eng.specsOf("psql table counts")
	if dbArg(counted[0]) != create || dbArg(counted[1]) != "shop" {
		t.Errorf("the scratch database is counted, then the live one: %v / %v", counted[0].Cmd, counted[1].Cmd)
	}
	if left := h.dbsLeft(); len(left) != 0 {
		t.Errorf("databases left on the server: %v", left)
	}
	if left, _ := h.st.Scratches(t.Context()); len(left) != 0 {
		t.Errorf("a dropped scratch database is not kept in the record: %+v", left)
	}
	if proofs := h.proofs(); len(proofs) != 1 || !proofs["restore/shop"].Equal(testNow) {
		t.Errorf("a passed test is a proof: %v", proofs)
	}
	if left := h.stagingLeft(); len(left) != 0 {
		t.Errorf("staging left: %v", left)
	}
	if len(h.eng.removed) != len(h.eng.specs) {
		t.Errorf("%d containers created, %d removed", len(h.eng.specs), len(h.eng.removed))
	}
	if h.svc.Busy("shop") {
		t.Error("the database is free again")
	}

	// The identity lives in memory only.
	everything := h.logs.String() + fmt.Sprintf("%+v %+v", h.eng.specs, got) + strings.Join(h.rec.list(), "\n")
	if strings.Contains(everything, secret) {
		t.Error("the age secret key reached a log, a container spec, a record or a step")
	}
	filepath.Walk(h.dataDir, func(path string, info os.FileInfo, err error) error {
		if err == nil && !info.IsDir() {
			if b, _ := os.ReadFile(path); strings.Contains(string(b), "AGE-SECRET-KEY") {
				t.Errorf("the key was written to %s", path)
			}
		}
		return nil
	})
}

func tablesString(ts []store.TableCount) []string {
	out := make([]string, len(ts))
	for i, t := range ts {
		b, l := "null", "null"
		if t.BackupRows != nil {
			b = fmt.Sprint(*t.BackupRows)
		}
		if t.LiveRows != nil {
			l = fmt.Sprint(*t.LiveRows)
		}
		out[i] = t.Name + ":" + b + "/" + l
	}
	return out
}

func TestATableOnlyOneSideHasIsReportedWithNullOnTheOther(t *testing.T) {
	h := newHarness(t, "version: 16", "")
	h.seed(testNow.AddDate(0, 0, -1), h.id)
	h.eng.tables["scratch"] = []string{"public.created_later|0", "public.users|42", "public.only_in_backup|5"}
	h.eng.tables["shop"] = []string{"public.users|40", "public.only_in_live|11"}

	got, err := h.startTest(RestoreTestRequest{Identity: h.id.String()})
	if err != nil {
		t.Fatal(err)
	}
	if got.Status != store.TestPassed {
		t.Fatalf("%+v", got)
	}
	want := []string{"public.created_later:0/null", "public.only_in_backup:5/null", "public.only_in_live:null/11", "public.users:42/40"}
	if fmt.Sprint(tablesString(got.Tables)) != fmt.Sprint(want) {
		t.Errorf("\n got  %v\n want %v", tablesString(got.Tables), want)
	}
}

func TestTheVerdictOfARestoreTest(t *testing.T) {
	for name, tc := range map[string]struct {
		tables []store.TableCount
		failed string // part of the error; empty means passed
	}{
		"rows on both sides, counts differ": {
			tables: []store.TableCount{{Name: "public.a", BackupRows: new(int64(3)), LiveRows: new(int64(50))}}},
		"live has no rows at all, backup has none either": {
			tables: []store.TableCount{{Name: "public.a", BackupRows: new(int64(0)), LiveRows: new(int64(0))}}},
		"live database is empty of tables": {
			tables: []store.TableCount{{Name: "public.a", BackupRows: new(int64(0))}}},
		"live has rows, backup holds one": {
			tables: []store.TableCount{{Name: "public.a", BackupRows: new(int64(1)), LiveRows: new(int64(900))}}},
		"rows only in a table the live one lacks": {
			tables: []store.TableCount{{Name: "public.a", BackupRows: new(int64(4))}, {Name: "public.b", LiveRows: new(int64(10))}}},
		"live has rows, restore holds none": {
			tables: []store.TableCount{{Name: "public.a", BackupRows: new(int64(0)), LiveRows: new(int64(7))}}, failed: "holds no row, and the live database holds 7"},
		"restored database has no table": {
			tables: []store.TableCount{{Name: "public.a", LiveRows: new(int64(7))}}, failed: "no table"},
		"nothing anywhere": {
			tables: nil, failed: "no table"},
	} {
		t.Run(name, func(t *testing.T) {
			err := verdict(tc.tables)
			switch {
			case tc.failed == "" && err != nil:
				t.Errorf("should pass: %v", err)
			case tc.failed != "" && (err == nil || !strings.Contains(err.Error(), tc.failed)):
				t.Errorf("should fail with %q: %v", tc.failed, err)
			}
		})
	}
}

func TestAFailedVerdictIsAFailedTestWithItsTablesAndNoProof(t *testing.T) {
	h := newHarness(t, "version: 16", "")
	h.seed(testNow.AddDate(0, 0, -1), h.id)
	h.eng.tables["scratch"] = []string{"public.users|0"}
	h.eng.tables["shop"] = []string{"public.users|12"}
	got, err := h.startTest(RestoreTestRequest{Identity: h.id.String()})
	if err != nil {
		t.Fatal(err)
	}
	if got.Status != store.TestFailed || !strings.Contains(got.Error, "holds no row") || len(got.Tables) != 1 {
		t.Fatalf("%+v", got)
	}
	if len(h.proofs()) != 0 {
		t.Error("a failed test proves nothing")
	}
	if left := h.dbsLeft(); len(left) != 0 {
		t.Errorf("the scratch database goes whatever the verdict: %v", left)
	}
}

func TestAnEmptyLiveDatabaseDoesNotFailARestoreOfAnEmptyBackup(t *testing.T) {
	h := newHarness(t, "version: 16", "")
	h.seed(testNow.AddDate(0, 0, -1), h.id)
	h.eng.tables["scratch"] = []string{"public.users|0"}
	h.eng.tables["shop"] = []string{"public.users|0"}
	got, err := h.startTest(RestoreTestRequest{Identity: h.id.String()})
	if err != nil || got.Status != store.TestPassed {
		t.Fatalf("%+v %v", got, err)
	}
}

func TestAFailingRestoreDropsTheScratchDatabaseAndProvesNothing(t *testing.T) {
	h := newHarness(t, "version: 16", "")
	h.seed(testNow.AddDate(0, 0, -1), h.id)
	h.eng.restoreOK = false

	got, err := h.startTest(RestoreTestRequest{Identity: h.id.String()})
	if err != nil {
		t.Fatal(err)
	}
	if got.Status != store.TestFailed || !strings.Contains(got.Error, "pg_restore") || got.FinishedAt == nil || len(got.Tables) != 0 {
		t.Fatalf("%+v", got)
	}
	if h.rec.has("run psql table counts") {
		t.Error("nothing is counted after a failed restore")
	}
	if !h.rec.has("run psql drop") || len(h.dbsLeft()) != 0 {
		t.Errorf("the scratch database is dropped: %v left, steps %v", h.dbsLeft(), h.rec.list())
	}
	if len(h.proofs()) != 0 {
		t.Error("a failed test proves nothing")
	}
	if left, _ := h.st.Scratches(t.Context()); len(left) != 0 {
		t.Errorf("%+v", left)
	}
}

func TestARestoreThatFailsBeforeAnythingIsCreatedHasNothingToDrop(t *testing.T) {
	t.Run("wrong key", func(t *testing.T) {
		h := newHarness(t, "version: 16", "")
		h.seed(testNow.AddDate(0, 0, -1), h.id)
		other, _ := age.GenerateX25519Identity()
		got, err := h.startTest(RestoreTestRequest{Identity: other.String()})
		if err != nil || got.Status != store.TestFailed || !strings.Contains(got.Error, "cannot decrypt") {
			t.Fatalf("%+v %v", got, err)
		}
		if h.rec.has("run psql create") || h.rec.has("run psql drop") {
			t.Errorf("no database was created: %v", h.rec.list())
		}
		if left, _ := h.st.Scratches(t.Context()); len(left) != 0 {
			t.Errorf("nothing to drop later either: %+v", left)
		}
	})
	t.Run("corrupt dump", func(t *testing.T) {
		h := newHarness(t, "version: 16", "")
		h.seed(testNow.AddDate(0, 0, -1), h.id)
		h.eng.readCode = 1
		got, err := h.startTest(RestoreTestRequest{Identity: h.id.String()})
		if err != nil || got.Status != store.TestFailed || h.rec.has("run psql create") {
			t.Fatalf("%+v %v %v", got, err, h.rec.list())
		}
	})
}

func TestAScratchDatabaseThatCannotBeDroppedFailsTheTestAndIsDroppedAtTheNextStart(t *testing.T) {
	h := newHarness(t, "version: 16", "")
	h.seed(testNow.AddDate(0, 0, -1), h.id)
	h.eng.tables["scratch"] = []string{"public.users|3"}
	h.eng.tables["shop"] = []string{"public.users|3"}
	h.eng.dropCode = 1

	got, err := h.startTest(RestoreTestRequest{Identity: h.id.String()})
	if err != nil {
		t.Fatal(err)
	}
	if got.Status != store.TestFailed || !strings.Contains(got.Error, "could not be dropped") || len(got.Tables) != 1 {
		t.Fatalf("a stray database is a failure, said loudly: %+v", got)
	}
	left := h.dbsLeft()
	if len(left) != 1 || !strings.Contains(got.Error, left[0]) {
		t.Fatalf("the error names the stray database %v: %q", left, got.Error)
	}
	if len(h.proofs()) != 0 {
		t.Error("no proof")
	}
	if kept, _ := h.st.Scratches(t.Context()); len(kept) != 1 || kept[0].Scratch != left[0] {
		t.Fatalf("its name stays recorded: %+v", kept)
	}

	// The next start drops it.
	h.eng.dropCode = 0
	next := New(Options{Config: h.svc.config(), Store: h.st, Engine: h.eng, DataDir: h.dataDir, Log: h.svc.log})
	if err := next.RecoverRestoreTests(t.Context()); err != nil {
		t.Fatal(err)
	}
	next.wg.Wait()
	if len(h.dbsLeft()) != 0 {
		t.Errorf("still there: %v", h.dbsLeft())
	}
	if kept, _ := h.st.Scratches(t.Context()); len(kept) != 0 {
		t.Errorf("%+v", kept)
	}
}

// The agent was killed while a test ran: its row says running, and the scratch database is on the server.
func TestAScratchDatabaseLeftByACrashedRunIsDroppedAtTheNextStart(t *testing.T) {
	h := newHarness(t, "version: 16", "")
	scratch := "shop_rt_0badc0de"
	h.eng.databases[scratch] = true
	key := BackupKey("shop", testNow.AddDate(0, 0, -1))
	if err := h.st.CreateRestoreTest(t.Context(), store.RestoreTest{ID: "crashed", Database: "shop", Backup: key, BackupTime: testNow.AddDate(0, 0, -1), Scratch: scratch, StartedAt: testNow.Add(-time.Hour)}); err != nil {
		t.Fatal(err)
	}
	// A second one belongs to a database that is not in the file any more: there is nowhere to drop it.
	if err := h.st.CreateRestoreTest(t.Context(), store.RestoreTest{ID: "orphan", Database: "gone", Backup: "gone/x", BackupTime: testNow, Scratch: "gone_rt_00000000", StartedAt: testNow}); err != nil {
		t.Fatal(err)
	}

	restarted := New(Options{Config: h.svc.config(), Store: h.st, Engine: h.eng, DataDir: h.dataDir, Log: h.svc.log})
	if err := restarted.RecoverRestoreTests(t.Context()); err != nil {
		t.Fatal(err)
	}
	restarted.wg.Wait()

	if left := h.dbsLeft(); len(left) != 0 {
		t.Errorf("the stale scratch database must be dropped: %v", left)
	}
	if drops := h.eng.specsOf("psql drop"); len(drops) != 1 || quoted(drops[0]) != scratch || !strings.Contains(strings.Join(drops[0].Cmd, " "), `DROP DATABASE IF EXISTS "shop_rt_0badc0de"`) {
		t.Errorf("exactly the recorded scratch database is dropped: %v", drops)
	}
	got := h.test("crashed")
	if got.Status != store.TestFailed || !strings.Contains(got.Error, "interrupted") || got.FinishedAt == nil {
		t.Errorf("a test cut short is failed: %+v", got)
	}
	if left, _ := h.st.Scratches(t.Context()); len(left) != 0 {
		t.Errorf("both rows are settled: %+v", left)
	}
	if len(h.proofs()) != 0 {
		t.Error("no proof")
	}
}

func TestADropThatKeepsFailingIsTriedAgainAtTheNextStartNotForever(t *testing.T) {
	h := newHarness(t, "version: 16", "")
	h.eng.databases["shop_rt_0badc0de"] = true
	h.st.CreateRestoreTest(t.Context(), store.RestoreTest{ID: "crashed", Database: "shop", Backup: BackupKey("shop", testNow), BackupTime: testNow, Scratch: "shop_rt_0badc0de", StartedAt: testNow})
	h.eng.dropCode = 1
	restarted := New(Options{Config: h.svc.config(), Store: h.st, Engine: h.eng, DataDir: h.dataDir, Log: h.svc.log})
	restarted.sweepWait = time.Millisecond
	if err := restarted.RecoverRestoreTests(t.Context()); err != nil {
		t.Fatal(err)
	}
	restarted.wg.Wait()
	if n := len(h.eng.specsOf("psql drop")); n != sweepAttempts {
		t.Errorf("%d attempts, want %d", n, sweepAttempts)
	}
	if kept, _ := h.st.Scratches(t.Context()); len(kept) != 1 {
		t.Errorf("the name stays recorded for the next start: %+v", kept)
	}
}

func TestARestoreTestCannotStartWhileAnotherRestoreTestRestoreOrBackupRuns(t *testing.T) {
	h := newHarness(t, "version: 16", "")
	key := h.seed(testNow.AddDate(0, 0, -1), h.id)
	h.eng.hold, h.eng.reached = make(chan struct{}), make(chan struct{})
	req := RestoreTestRequest{Database: "shop", Identity: h.id.String()}

	started, err := h.svc.StartRestoreTest(t.Context(), req)
	if err != nil {
		t.Fatal(err)
	}
	<-h.eng.reached
	if running := h.test(started.ID); running.Status != store.TestRunning || running.FinishedAt != nil || len(running.Tables) != 0 {
		t.Errorf("a running test is listed as running: %+v", running)
	}
	if !h.svc.Busy("shop") {
		t.Error("a database under test is busy: the managed PostgreSQL must not drop it")
	}
	if _, err := h.svc.StartRestoreTest(t.Context(), req); !errors.Is(err, ErrTestBusy) {
		t.Errorf("a second test: %v", err)
	}
	if _, err := h.svc.Restore(t.Context(), RestoreRequest{Database: "shop", Backup: key, Identity: h.id.String()}); !errors.Is(err, ErrTestBusy) {
		t.Errorf("a restore, which would change what the test counts: %v", err)
	}
	// A backup only reads the database: the nightly one is not failed by a test.
	if err := h.svc.beginBackup("shop"); err != nil {
		t.Errorf("a backup may run beside a test: %v", err)
	} else {
		h.svc.endBackup("shop")
	}
	close(h.eng.hold)
	h.svc.wg.Wait()
	if got := h.test(started.ID); got.Status == store.TestRunning {
		t.Errorf("%+v", got)
	}
	if h.svc.Busy("shop") {
		t.Error("free again")
	}

	// And the other way round.
	h.eng.hold, h.eng.reached, h.eng.once = make(chan struct{}), make(chan struct{}), sync.Once{}
	if _, err := h.svc.Restore(t.Context(), RestoreRequest{Database: "shop", Backup: key, Identity: h.id.String()}); err != nil {
		t.Fatal(err)
	}
	<-h.eng.reached
	if _, err := h.svc.StartRestoreTest(t.Context(), req); !errors.Is(err, ErrRestoreBusy) {
		t.Errorf("a test during a restore: %v", err)
	}
	close(h.eng.hold)
	h.svc.wg.Wait()

	if err := h.svc.beginBackup("shop"); err != nil {
		t.Fatal(err)
	}
	if _, err := h.svc.StartRestoreTest(t.Context(), req); !errors.Is(err, ErrBackupBusy) {
		t.Errorf("a test during a backup: %v", err)
	}
	h.svc.endBackup("shop")
	if _, err := h.svc.StartRestoreTest(t.Context(), req); err != nil {
		t.Errorf("free again: %v", err)
	}
	h.svc.wg.Wait()
}

func TestARestoreTestRefusesWhatCannotBeStarted(t *testing.T) {
	h := newHarness(t, "version: 16", "")
	var bad *RequestError
	start := func(req RestoreTestRequest) error {
		req.Database = cmpOr(req.Database, "shop")
		_, err := h.svc.StartRestoreTest(t.Context(), req)
		return err
	}
	if err := start(RestoreTestRequest{Identity: h.id.String()}); !errors.As(err, &bad) || !strings.Contains(err.Error(), "no scheduled backup") {
		t.Errorf("nothing to test: %v", err)
	}
	h.seed(testNow.AddDate(0, 0, -1), h.id)
	if err := start(RestoreTestRequest{Identity: "nope"}); !errors.As(err, &bad) {
		t.Errorf("not an age key: %v", err)
	}
	if err := start(RestoreTestRequest{Identity: h.id.String(), Backup: "shop/other.dump.age"}); !errors.As(err, &bad) {
		t.Errorf("not a backup of this database: %v", err)
	}
	if err := start(RestoreTestRequest{Database: "ghost", Identity: h.id.String()}); !errors.Is(err, ErrUnknownDatabase) {
		t.Errorf("unknown: %v", err)
	}
	h.dest.listErr = errors.New("connection refused")
	if err := start(RestoreTestRequest{Identity: h.id.String()}); err == nil || errors.As(err, &bad) {
		t.Errorf("an unreachable destination is not the caller's mistake: %v", err)
	}
	if tests, _ := h.svc.RestoreTests(t.Context(), "shop", 10); len(tests) != 0 || len(h.eng.specs) != 0 || h.svc.Busy("shop") {
		t.Errorf("nothing was started: %+v %d containers busy=%v", tests, len(h.eng.specs), h.svc.Busy("shop"))
	}
}

func cmpOr(a, b string) string {
	if a != "" {
		return a
	}
	return b
}

func TestShuttingDownDuringARestoreTestStillDropsTheScratchDatabase(t *testing.T) {
	h := newHarness(t, "version: 16", "")
	h.seed(testNow.AddDate(0, 0, -1), h.id)
	h.eng.hold, h.eng.reached = make(chan struct{}), make(chan struct{})
	started, err := h.svc.StartRestoreTest(t.Context(), RestoreTestRequest{Database: "shop", Identity: h.id.String()})
	if err != nil {
		t.Fatal(err)
	}
	<-h.eng.reached
	if len(h.dbsLeft()) != 1 {
		t.Fatalf("the scratch database exists while pg_restore runs: %v", h.dbsLeft())
	}
	if !h.svc.Shutdown(10 * time.Second) {
		t.Fatal("shutdown did not finish")
	}
	if left := h.dbsLeft(); len(left) != 0 {
		t.Errorf("the scratch database must be dropped even when the agent is stopping: %v", left)
	}
	got := h.test(started.ID)
	if got.Status != store.TestFailed || !strings.Contains(got.Error, "shutting down") {
		t.Errorf("%+v", got)
	}
}

func TestTheRowsOfAHundredTablesAreCountedAndMoreAreCapped(t *testing.T) {
	h := newHarness(t, "version: 16", "")
	h.seed(testNow.AddDate(0, 0, -1), h.id)
	var backup, live []string
	for i := range maxTestTables + 1 { // one more than the cap: the query asks for it to know there are more
		backup = append(backup, fmt.Sprintf("public.t%03d|1", i))
	}
	for i := range 150 {
		live = append(live, fmt.Sprintf("public.t%03d|2", i))
	}
	live = append(live, "public.t250|9") // beyond where the restored side was cut: unknown there, so left out
	h.eng.tables["scratch"], h.eng.tables["shop"] = backup, live

	got, err := h.startTest(RestoreTestRequest{Identity: h.id.String()})
	if err != nil || got.Status != store.TestPassed {
		t.Fatalf("%+v %v", got, err)
	}
	if len(got.Tables) != maxTestTables {
		t.Fatalf("%d tables, want the cap of %d", len(got.Tables), maxTestTables)
	}
	for _, tc := range got.Tables {
		if tc.Name == "public.t250" || tc.Name == fmt.Sprintf("public.t%03d", maxTestTables) {
			t.Errorf("%s is past the cap", tc.Name)
		}
		if tc.Name == "public.t199" && (tc.LiveRows != nil || tc.BackupRows == nil) {
			t.Errorf("a table the live side has no row for says null there: %+v", tc)
		}
	}
	if q := strings.Join(h.eng.specsOf("psql table counts")[0].Cmd, " "); !strings.Contains(q, "limit 201") {
		t.Errorf("the query asks for one table more than the cap: %s", q)
	}
}

func TestMergingCountsNeverReportsATableMissingBecauseOfWhereACapFell(t *testing.T) {
	names := func(from, to int) []tableCount {
		var out []tableCount
		for i := from; i < to; i++ {
			out = append(out, tableCount{fmt.Sprintf("public.t%03d", i), int64(i)})
		}
		return out
	}
	got := mergeCounts(names(0, 200), names(0, 150), true, false)
	if len(got) != 200 || got[199].Name != "public.t199" || got[199].LiveRows != nil {
		t.Errorf("a side that is cut still reports what it has: %d tables, last %+v", len(got), got[len(got)-1])
	}
	got = mergeCounts(names(0, 200), append(names(0, 50), tableCount{"public.t300", 1}), true, false)
	for _, tc := range got {
		if tc.Name == "public.t300" {
			t.Error("a table past the cut of the other side is unknown there and left out")
		}
	}
	both := mergeCounts(names(0, 200), names(100, 300)[:200], true, true)
	if last := both[len(both)-1].Name; last != "public.t199" {
		t.Errorf("the smaller cut wins: %s", last)
	}
	if got := mergeCounts(nil, nil, false, false); len(got) != 0 {
		t.Errorf("%v", got)
	}
}

func TestTheScratchNameFitsAPostgreSQLIdentifier(t *testing.T) {
	re := regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]{0,62}$`)
	for _, db := range []string{"shop", "1shop", "my-shop.v2", strings.Repeat("x", 63)} {
		n := scratchName(db)
		if !re.MatchString(n) || !strings.Contains(n, "_rt_") || len(n) > 63 {
			t.Errorf("%q -> %q", db, n)
		}
	}
	if a, b := scratchName("shop"), scratchName("shop"); a == b {
		t.Error("two tests of a database must not share a scratch database")
	}
}

func TestOldestRestoreTestsArePrunedButNeverOneWithAScratchToDrop(t *testing.T) {
	h := newHarness(t, "version: 16", "")
	ctx := t.Context()
	for i := range keepRestoreTests + 3 {
		scratch := ""
		if i == 0 {
			scratch = "shop_rt_00000000"
		}
		h.st.CreateRestoreTest(ctx, store.RestoreTest{ID: fmt.Sprint("t", i), Database: "shop", Backup: "k", BackupTime: testNow, Scratch: scratch, StartedAt: testNow.Add(time.Duration(i) * time.Minute)})
	}
	if err := h.st.PruneRestoreTests(ctx, "shop", keepRestoreTests); err != nil {
		t.Fatal(err)
	}
	tests, _ := h.st.RestoreTests(ctx, "shop", 100)
	ids := map[string]bool{}
	for _, x := range tests {
		ids[x.ID] = true
	}
	if len(tests) != keepRestoreTests+1 || !ids["t0"] || ids["t1"] || !ids["t22"] {
		t.Errorf("%d kept: the newest %d and the one whose scratch is not dropped", len(tests), keepRestoreTests)
	}
}
