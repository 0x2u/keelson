package databases

import (
	"bytes"
	"cmp"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"filippo.io/age"

	"github.com/0x2u/keelson/agent/internal/config"
	"github.com/0x2u/keelson/agent/internal/docker"
	"github.com/0x2u/keelson/agent/internal/store"
)

const plainDump = "PGDMP plaintext of the database"

// recorder keeps the order in which the fakes were called.
type recorder struct {
	mu     sync.Mutex
	events []string
}

func (r *recorder) add(format string, args ...any) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.events = append(r.events, fmt.Sprintf(format, args...))
}

func (r *recorder) list() []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]string(nil), r.events...)
}

func (r *recorder) has(prefix string) bool {
	for _, e := range r.list() {
		if strings.HasPrefix(e, prefix) {
			return true
		}
	}
	return false
}

// fakeEngine plays the Docker engine: a throwaway container "runs" when it is started, and the commands of the
// PostgreSQL client are scripted by the fields below.
type fakeEngine struct {
	rec *recorder

	mu      sync.Mutex
	present map[string]bool
	pulled  []string
	specs   []docker.ContainerSpec
	removed []string
	running map[string]result
	// readCode is the exit code of the pass that reads the whole dump (pg_restore -f /dev/null).
	readCode int
	// restored is what pg_restore found in /in/dump.
	restored []byte

	dumpCode  int
	dumpEmpty bool
	toc       []string
	tocCode   int
	probe     []string
	probeCode int
	createOut []string // when set, creating the database fails with it
	restoreOK bool
	counts    []string
	// databases are the databases created and not dropped; tables are what psql prints for the row counts of a database,
	// by the name of the database; dropCode and tableCode are the exit codes of dropping a database and counting rows.
	databases map[string]bool
	tables    map[string][]string
	dropCode  int
	tableCode int

	// hold blocks pg_restore until it is closed; reached is closed when it is waiting.
	hold     chan struct{}
	holdKind string // the kind of container hold applies to; pg_restore when empty
	reached  chan struct{}
	once     sync.Once
	// probeHold blocks every version probe until it is closed.
	probeHold chan struct{}
}

type result struct {
	code  int
	lines []string
}

func newFakeEngine(rec *recorder) *fakeEngine {
	return &fakeEngine{
		rec: rec, present: map[string]bool{}, running: map[string]result{}, restoreOK: true, databases: map[string]bool{}, tables: map[string][]string{},
		toc:    []string{"; Archive created at 2026-10-21", ";     dbname: shop", "1259; 16385 TABLE public users shop", "1259; 16390 TABLE public orders shop"},
		probe:  []string{"160004|16.4 (Debian 16.4-1.pgdg120+1)|8421376"},
		counts: []string{"orders|7|2", "users|42|2"},
	}
}

func (f *fakeEngine) ListImages(_ context.Context, repo string) ([]docker.Image, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []docker.Image
	for ref := range f.present {
		if strings.HasPrefix(ref, repo+":") {
			out = append(out, docker.Image{RepoTags: []string{ref}})
		}
	}
	return out, nil
}

func (f *fakeEngine) Pull(_ context.Context, repo, ref, _ string, _ func(string)) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.pulled = append(f.pulled, repo+":"+ref)
	f.present[repo+":"+ref] = true
	return nil
}

func (f *fakeEngine) Create(_ context.Context, spec docker.ContainerSpec) (string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.specs = append(f.specs, spec)
	return spec.Name, nil
}

// kind names what a container runs.
func kind(spec docker.ContainerSpec) string {
	joined := strings.Join(spec.Cmd, " ")
	switch {
	case spec.Cmd[0] == "pg_dump":
		return "pg_dump"
	case spec.Cmd[0] == "pg_restore" && strings.Contains(joined, "--list"):
		return "pg_restore --list"
	case spec.Cmd[0] == "pg_restore" && strings.Contains(joined, "-f /dev/null"):
		return "pg_restore read"
	case spec.Cmd[0] == "pg_restore":
		return "pg_restore"
	case strings.Contains(joined, "server_version_num"):
		return "psql version"
	case strings.Contains(joined, "CREATE DATABASE"):
		return "psql create"
	case strings.Contains(joined, "DROP DATABASE"):
		return "psql drop"
	case strings.Contains(joined, `collate "C"`):
		return "psql table counts"
	case strings.Contains(joined, "query_to_xml"):
		return "psql counts"
	}
	return "unknown " + joined
}

// quoted is the name between double quotes in the command of a CREATE or DROP DATABASE.
func quoted(spec docker.ContainerSpec) string {
	joined := strings.Join(spec.Cmd, " ")
	_, rest, _ := strings.Cut(joined, `"`)
	name, _, _ := strings.Cut(rest, `"`)
	return name
}

// dbArg is the database a psql command connects to (-d).
func dbArg(spec docker.ContainerSpec) string {
	i := slices.Index(spec.Cmd, "-d")
	if i < 0 {
		return ""
	}
	return spec.Cmd[i+1]
}

// bindDir returns the host directory mounted by the container.
func bindDir(spec docker.ContainerSpec) string {
	if len(spec.Binds) == 0 {
		return ""
	}
	return strings.SplitN(spec.Binds[0], ":", 2)[0]
}

func (f *fakeEngine) Start(_ context.Context, id string) error {
	f.mu.Lock()
	var spec docker.ContainerSpec
	for _, s := range f.specs {
		if s.Name == id {
			spec = s
		}
	}
	f.mu.Unlock()

	k := kind(spec)
	f.rec.add("run %s", k)
	res := result{}
	switch k {
	case "pg_dump":
		if f.dumpCode != 0 {
			res = result{f.dumpCode, []string{"pg_dump: error: connection to server failed: FATAL:  password authentication failed"}}
			break
		}
		content := plainDump
		if f.dumpEmpty {
			content = ""
		}
		if err := os.WriteFile(filepath.Join(bindDir(spec), "dump"), []byte(content), 0o600); err != nil {
			return err
		}
	case "pg_restore read":
		if _, err := os.Stat(filepath.Join(bindDir(spec), "dump")); err != nil {
			res = result{1, []string{"pg_restore: error: could not open input file"}}
			break
		}
		if f.readCode != 0 {
			res = result{f.readCode, []string{"pg_restore: error: unexpected end of file"}}
		}
	case "pg_restore --list":
		if _, err := os.Stat(filepath.Join(bindDir(spec), "dump")); err != nil {
			res = result{1, []string{"pg_restore: error: could not open input file"}}
			break
		}
		res = result{f.tocCode, f.toc}
	case "pg_restore":
		data, err := os.ReadFile(filepath.Join(bindDir(spec), "dump"))
		if err != nil {
			return err
		}
		f.mu.Lock()
		f.restored = data
		f.mu.Unlock()
		if !f.restoreOK {
			res = result{1, []string{"pg_restore: error: could not execute query: ERROR:  relation \"users\" already exists"}}
		}
	case "psql version":
		res = result{f.probeCode, f.probe}
	case "psql create":
		if f.createOut != nil {
			res = result{1, f.createOut}
			break
		}
		f.mu.Lock()
		f.databases[quoted(spec)] = true
		f.mu.Unlock()
	case "psql drop":
		if f.dropCode != 0 {
			res = result{f.dropCode, []string{"ERROR:  database is being accessed by other users"}}
			break
		}
		f.mu.Lock()
		delete(f.databases, quoted(spec))
		f.mu.Unlock()
	case "psql counts":
		res = result{0, f.counts}
	case "psql table counts":
		f.mu.Lock()
		db := dbArg(spec)
		if strings.Contains(db, "_rt_") {
			db = "scratch" // the name of a scratch database is random
		}
		res = result{f.tableCode, f.tables[db]}
		f.mu.Unlock()
	default:
		return errors.New(k)
	}
	f.mu.Lock()
	f.running[id] = res
	f.mu.Unlock()
	return nil
}

func (f *fakeEngine) Logs(_ context.Context, id string, _ docker.LogOptions, fn func(docker.LogLine) error) error {
	f.mu.Lock()
	res := f.running[id]
	f.mu.Unlock()
	for _, l := range res.lines {
		if err := fn(docker.LogLine{Line: l}); err != nil {
			return err
		}
	}
	return nil
}

func (f *fakeEngine) Wait(ctx context.Context, id string) (int, error) {
	f.mu.Lock()
	res := f.running[id]
	var spec docker.ContainerSpec
	for _, s := range f.specs {
		if s.Name == id {
			spec = s
		}
	}
	f.mu.Unlock()
	if f.probeHold != nil && kind(spec) == "psql version" {
		select {
		case <-f.probeHold:
		case <-ctx.Done():
			return 0, ctx.Err()
		}
	}
	if f.hold != nil && kind(spec) == cmp.Or(f.holdKind, "pg_restore") {
		f.once.Do(func() { close(f.reached) })
		select {
		case <-f.hold:
		case <-ctx.Done():
			return 0, ctx.Err()
		}
	}
	return res.code, nil
}

func (f *fakeEngine) RemoveThrowaway(_ context.Context, id string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.removed = append(f.removed, id)
	return nil
}

func (f *fakeEngine) specsOf(k string) []docker.ContainerSpec {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []docker.ContainerSpec
	for _, s := range f.specs {
		if kind(s) == k {
			out = append(out, s)
		}
	}
	return out
}

// fakeDest is a destination in memory.
type fakeDest struct {
	rec     *recorder
	mu      sync.Mutex
	objects map[string][]byte
	putErr  error
	delErr  error
	listErr error
}

func (d *fakeDest) Put(_ context.Context, key, src string) error {
	d.rec.add("put %s", key)
	if d.putErr != nil {
		return d.putErr
	}
	b, err := os.ReadFile(src)
	if err != nil {
		return err
	}
	d.mu.Lock()
	defer d.mu.Unlock()
	if _, taken := d.objects[key]; taken {
		return fmt.Errorf("%s: %w", key, ErrExists)
	}
	d.objects[key] = b
	return nil
}

func (d *fakeDest) Get(_ context.Context, key, dst string) error {
	d.rec.add("get %s", key)
	d.mu.Lock()
	b, ok := d.objects[key]
	d.mu.Unlock()
	if !ok {
		return errors.New("no such object")
	}
	return os.WriteFile(dst, b, 0o600)
}

func (d *fakeDest) Open(_ context.Context, key string) (io.ReadCloser, error) {
	d.rec.add("open %s", key)
	d.mu.Lock()
	b, ok := d.objects[key]
	d.mu.Unlock()
	if !ok {
		return nil, errors.New("no such object")
	}
	return io.NopCloser(bytes.NewReader(b)), nil
}

func (d *fakeDest) List(_ context.Context, prefix string) ([]Object, error) {
	d.rec.add("list")
	if d.listErr != nil {
		return nil, d.listErr
	}
	d.mu.Lock()
	defer d.mu.Unlock()
	var out []Object
	for k, v := range d.objects {
		if strings.HasPrefix(k, prefix) {
			out = append(out, Object{Key: k, Size: int64(len(v))})
		}
	}
	return out, nil
}

func (d *fakeDest) Delete(_ context.Context, key string) error {
	d.rec.add("delete %s", key)
	if d.delErr != nil {
		return d.delErr
	}
	d.mu.Lock()
	delete(d.objects, key)
	d.mu.Unlock()
	return nil
}

func (d *fakeDest) keys() []string {
	d.mu.Lock()
	defer d.mu.Unlock()
	var out []string
	for k := range d.objects {
		out = append(out, k)
	}
	return out
}

type harness struct {
	t        *testing.T
	svc      *Service
	eng      *fakeEngine
	dest     *fakeDest
	rec      *recorder
	st       *store.Store
	id       *age.X25519Identity
	dataDir  string
	passFile string
	logs     *bytes.Buffer
	now      time.Time
}

var testNow = time.Date(2026, 10, 21, 3, 0, 0, 0, time.UTC)

// newHarness builds a service for one database, "shop", with a backup section. extra is added to the database
// definition (a version, say) and backup to the backup section.
func newHarness(t *testing.T, extra, backup string) *harness {
	t.Helper()
	id, err := age.GenerateX25519Identity()
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	pass := filepath.Join(dir, "pw")
	if err := os.WriteFile(pass, []byte("pa55word\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	doc := fmt.Sprintf(`
databases:
  - name: shop
    host: 127.0.0.1
    database: shop
    user: shop
    password_file: %s
    %s
    backup:
      schedule: "0 3 * * *"
      recipients: ["%s"]
      keep: 3
      destination: {local: {dir: /var/backups/keelson}}
      %s
`, pass, extra, id.Recipient(), backup)
	cfg, issues := config.Parse([]byte(doc))
	if cfg == nil {
		t.Fatalf("config: %+v", issues)
	}
	st, err := store.Open(filepath.Join(dir, "a.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })

	rec := &recorder{}
	h := &harness{t: t, eng: newFakeEngine(rec), dest: &fakeDest{rec: rec, objects: map[string][]byte{}}, rec: rec, st: st, id: id, dataDir: filepath.Join(dir, "data"), passFile: pass, logs: &bytes.Buffer{}, now: testNow}
	h.svc = New(Options{Config: cfg, Store: st, Engine: h.eng, DataDir: h.dataDir, Log: slog.New(slog.NewTextHandler(h.logs, nil))})
	h.svc.now = func() time.Time { return h.now }
	h.svc.newDest = func(config.BackupDestination) (Destination, error) { return h.dest, nil }
	return h
}

func (h *harness) backup() (string, error) {
	h.t.Helper()
	var lines []string
	err := h.svc.Backup(h.t.Context(), "shop", func(l string) { lines = append(lines, l) })
	return strings.Join(lines, "\n"), err
}

// seed stores an encrypted backup taken at "at" in the destination.
func (h *harness) seed(at time.Time, identity *age.X25519Identity) string {
	h.t.Helper()
	dir := h.t.TempDir()
	os.WriteFile(filepath.Join(dir, "dump"), []byte(plainDump), 0o600)
	if _, err := encryptFile(filepath.Join(dir, "dump"), filepath.Join(dir, "dump.age"), []string{identity.Recipient().String()}); err != nil {
		h.t.Fatal(err)
	}
	b, _ := os.ReadFile(filepath.Join(dir, "dump.age"))
	key := BackupKey("shop", at)
	h.dest.objects[key] = b
	return key
}

func (h *harness) stagingLeft() []string {
	entries, _ := os.ReadDir(filepath.Join(h.dataDir, stagingDir))
	var out []string
	for _, e := range entries {
		out = append(out, e.Name())
	}
	return out
}

// --- backup ------------------------------------------------------------------------------------------------

func TestBackupRunsInOrderAndStoresOnlyTheEncryptedDump(t *testing.T) {
	h := newHarness(t, "", "")
	output, err := h.backup()
	if err != nil {
		t.Fatalf("%v\n%s", err, output)
	}

	want := []string{"list", "run psql version", "run pg_dump", "run pg_restore --list", "run pg_restore read", "put shop/shop-20261021T030000Z.dump.age", "list"}
	if got := h.rec.list(); fmt.Sprint(got) != fmt.Sprint(want) {
		t.Errorf("order of steps:\n got  %v\n want %v", got, want)
	}
	if fmt.Sprint(h.eng.pulled) != "[postgres:17-alpine postgres:16-alpine]" {
		t.Errorf("the probe image, then the server's major version, are pulled: %v", h.eng.pulled)
	}

	dump := h.eng.specsOf("pg_dump")[0]
	cmd := strings.Join(dump.Cmd, " ")
	for _, want := range []string{"-h 127.0.0.1", "-p 5432", "-U shop", "-d shop", "--format=custom", "--compress=6", "--no-owner", "--no-privileges", "--file /out/dump"} {
		if !strings.Contains(cmd, want) {
			t.Errorf("pg_dump command lacks %q: %s", want, cmd)
		}
	}
	if dump.Image != "postgres:16-alpine" || dump.NetworkMode != "host" || dump.Labels["keelson.job"] != "true" || dump.User == "" || dump.RestartPolicy != "no" {
		t.Errorf("spec: %+v", dump)
	}
	if !strings.Contains(strings.Join(dump.Env, " "), "PGPASSWORD=pa55word") {
		t.Errorf("the password travels in the container's environment: %v", dump.Env)
	}
	staging := filepath.Join(h.dataDir, stagingDir)
	if len(dump.Binds) != 1 || !strings.HasPrefix(dump.Binds[0], staging+string(filepath.Separator)) || !strings.HasSuffix(dump.Binds[0], ":/out") {
		t.Errorf("the dump goes to a private staging directory: %v", dump.Binds)
	}
	if verify := h.eng.specsOf("pg_restore --list")[0]; !strings.HasSuffix(verify.Binds[0], ":/out:ro") {
		t.Errorf("verification reads the dump read-only: %v", verify.Binds)
	}
	for _, spec := range h.eng.specs {
		if strings.Contains(strings.Join(spec.Cmd, " "), "pa55word") {
			t.Errorf("the password must not be in a command line: %v", spec.Cmd)
		}
	}

	stored := h.dest.objects["shop/shop-20261021T030000Z.dump.age"]
	if len(stored) == 0 || bytes.Contains(stored, []byte("PGDMP")) {
		t.Fatalf("what is uploaded must be encrypted: %q", stored)
	}
	r, err := age.Decrypt(bytes.NewReader(stored), h.id)
	if err != nil {
		t.Fatal(err)
	}
	if plain, _ := io.ReadAll(r); string(plain) != plainDump {
		t.Errorf("decrypted %q", plain)
	}

	lines := strings.Split(output, "\n")
	if last := lines[len(lines)-1]; !strings.HasPrefix(last, "backup shop/shop-20261021T030000Z.dump.age: 2 objects in the dump") || !strings.Contains(last, "upload verified") {
		t.Errorf("the summary is the last line: %q", last)
	}
	if strings.Contains(output, "pa55word") {
		t.Error("the password must not be in the output")
	}
	if left := h.stagingLeft(); len(left) != 0 {
		t.Errorf("staging must be removed: %v", left)
	}
	if len(h.eng.removed) != len(h.eng.specs) || len(h.eng.specs) != 4 {
		t.Errorf("every throwaway container is removed: %d created, %d removed", len(h.eng.specs), len(h.eng.removed))
	}
}

func TestBackupThatCannotBeVerifiedUploadsNothingAndLeavesNoStaging(t *testing.T) {
	cases := []struct {
		name   string
		setup  func(h *harness)
		want   string
		ranDmp bool
	}{
		{"dump fails", func(h *harness) { h.eng.dumpCode = 1 }, "authentication failed", true},
		{"dump is empty", func(h *harness) { h.eng.dumpEmpty = true }, "empty file", true},
		{"pg_restore cannot read it", func(h *harness) { h.eng.tocCode = 1 }, "verify the dump", true},
		{"nothing in it", func(h *harness) { h.eng.toc = []string{"; Archive created at", ";     dbname: shop"} }, "lists no object", true},
		{"password file is gone", func(h *harness) { os.Remove(h.passFile) }, "read the password", false},
		{"server version cannot be found", func(h *harness) {
			h.eng.probeCode = 2
			h.eng.probe = []string{`psql: error: connection to server at "127.0.0.1", port 5432 failed: Connection refused`}
		}, "Connection refused", false},
	}
	for _, c := range cases {
		h := newHarness(t, "", "")
		c.setup(h)
		_, err := h.backup()
		if err == nil || !strings.Contains(err.Error(), c.want) {
			t.Errorf("%s: want an error with %q, got %v", c.name, c.want, err)
		}
		if h.rec.has("put") || len(h.dest.objects) != 0 {
			t.Errorf("%s: nothing may be uploaded: %v", c.name, h.rec.list())
		}
		if c.ranDmp != h.rec.has("run pg_dump") {
			t.Errorf("%s: pg_dump ran = %v: %v", c.name, h.rec.has("run pg_dump"), h.rec.list())
		}
		if left := h.stagingLeft(); len(left) != 0 {
			t.Errorf("%s: staging left: %v", c.name, left)
		}
		if len(h.eng.removed) != len(h.eng.specs) {
			t.Errorf("%s: %d containers created, %d removed", c.name, len(h.eng.specs), len(h.eng.removed))
		}
	}
}

func TestBackupWhoseUploadFailsRemovesItsStaging(t *testing.T) {
	h := newHarness(t, "", "")
	h.dest.putErr = errors.New("s3 PUT: 403 Forbidden AccessDenied: Access Denied")
	_, err := h.backup()
	if err == nil || !strings.Contains(err.Error(), "upload shop/shop-20261021T030000Z.dump.age") || !strings.Contains(err.Error(), "AccessDenied") {
		t.Errorf("%v", err)
	}
	// The only listing is the one before the dump (the last backup's size, for the free-space check): none after the failure.
	if got := h.rec.list(); h.rec.has("delete") || got[len(got)-1] != "put shop/shop-20261021T030000Z.dump.age" {
		t.Errorf("retention must not run after a failed upload: %v", got)
	}
	if left := h.stagingLeft(); len(left) != 0 {
		t.Errorf("staging left: %v", left)
	}
}

func TestBackupAppliesRetentionAndItsFailureDoesNotFailTheBackup(t *testing.T) {
	h := newHarness(t, "", "")
	for i := 1; i <= 5; i++ {
		h.seed(testNow.AddDate(0, 0, -i), h.id)
	}
	output, err := h.backup()
	if err != nil {
		t.Fatal(err)
	}
	keys := h.dest.keys()
	if len(keys) != 3 || h.dest.objects["shop/shop-20261021T030000Z.dump.age"] == nil || h.dest.objects[BackupKey("shop", testNow.AddDate(0, 0, -1))] == nil || h.dest.objects[BackupKey("shop", testNow.AddDate(0, 0, -2))] == nil {
		t.Errorf("keep: 3 leaves the new backup and the two before it: %v", keys)
	}
	if !strings.HasSuffix(output, "retention kept 3, deleted 3") {
		t.Errorf("the summary reports retention: %q", output)
	}

	h = newHarness(t, "", "")
	for i := 1; i <= 5; i++ {
		h.seed(testNow.AddDate(0, 0, -i), h.id)
	}
	h.dest.delErr = errors.New("s3 DELETE: 500 InternalError")
	output, err = h.backup()
	if err != nil {
		t.Fatalf("a retention failure must not fail the backup: %v", err)
	}
	if !strings.Contains(output, "retention: could not delete") || !strings.Contains(output, "3 could not be deleted") || len(h.dest.keys()) != 6 {
		t.Errorf("the failure is reported in the output: %q", output)
	}
}

func TestRetentionNeverDeletesTheBackupJustStoredEvenWhenTheClockWentBack(t *testing.T) {
	h := newHarness(t, "", "")
	// keep: 3, and three backups dated after the clock now says: by date the new one is the oldest of four.
	var older []string
	for i := 1; i <= 3; i++ {
		older = append(older, h.seed(testNow.AddDate(0, 0, i), h.id))
	}
	output, err := h.backup()
	if err != nil {
		t.Fatal(err)
	}
	fresh := BackupKey("shop", testNow)
	if _, ok := h.dest.objects[fresh]; !ok {
		t.Fatalf("the backup just stored was deleted by retention: %v\n%s", h.dest.keys(), output)
	}
	for _, k := range older {
		if _, ok := h.dest.objects[k]; !ok {
			t.Errorf("%s was deleted: only the fresh backup was over the limit, and it is protected", k)
		}
	}
}

func TestBackupNeverReplacesAnObjectAndTakesTheNextFreeKey(t *testing.T) {
	h := newHarness(t, "", "")
	taken := BackupKey("shop", testNow)
	h.dest.objects[taken] = []byte("an earlier backup")

	output, err := h.backup()
	if err != nil {
		t.Fatal(err)
	}
	if string(h.dest.objects[taken]) != "an earlier backup" {
		t.Error("the existing backup was replaced")
	}
	next := BackupKey("shop", testNow.Add(time.Second))
	if _, ok := h.dest.objects[next]; !ok {
		t.Fatalf("the new backup must take the next free key %s: %v", next, h.dest.keys())
	}
	if !strings.Contains(output, "already exists") || !strings.Contains(output, "backup "+next) {
		t.Errorf("the output says which key was taken and which was used: %q", output)
	}
	if _, ok := ParseKey("shop", next); !ok {
		t.Error("the new key must stay in the naming scheme")
	}
}

func TestBackupFailsWhenEveryKeyItTriesIsTaken(t *testing.T) {
	h := newHarness(t, "", "")
	for i := range maxKeyAttempts {
		h.dest.objects[BackupKey("shop", testNow.Add(time.Duration(i)*time.Second))] = []byte("old")
	}
	_, err := h.backup()
	if !errors.Is(err, ErrExists) {
		t.Fatalf("want ErrExists, got %v", err)
	}
	for k, v := range h.dest.objects {
		if string(v) != "old" {
			t.Errorf("%s was replaced", k)
		}
	}
	if len(h.stagingLeft()) != 0 {
		t.Errorf("staging left: %v", h.stagingLeft())
	}
}

func TestBackupUsesTheConfiguredVersionWithoutProbing(t *testing.T) {
	h := newHarness(t, "version: 14", "")
	if _, err := h.backup(); err != nil {
		t.Fatal(err)
	}
	if h.rec.has("run psql version") || fmt.Sprint(h.eng.pulled) != "[postgres:14-alpine]" {
		t.Errorf("events %v, pulled %v", h.rec.list(), h.eng.pulled)
	}
	h.eng.present["postgres:14-alpine"] = true
	h.eng.pulled = nil
	if _, err := h.backup(); err != nil || len(h.eng.pulled) != 0 {
		t.Errorf("an image the engine has is not pulled again: %v %v", err, h.eng.pulled)
	}
}

func TestStartingTheServiceClearsStagingLeftByACrash(t *testing.T) {
	h := newHarness(t, "", "")
	left := filepath.Join(h.dataDir, stagingDir, "deadbeef")
	os.MkdirAll(left, 0o700)
	os.WriteFile(filepath.Join(left, "dump"), []byte(plainDump), 0o600)
	cfg := h.svc.config()
	New(Options{Config: cfg, Store: h.st, Engine: h.eng, DataDir: h.dataDir})
	if _, err := os.Stat(left); !os.IsNotExist(err) {
		t.Errorf("a dump left by a crashed agent must be removed at the next start: %v", err)
	}
}

// Docker reads a relative bind source as a volume name and refuses it: a relative --data-dir must still give
// an absolute staging mount.
func TestStagingMountIsAbsoluteWhateverTheDataDir(t *testing.T) {
	h := newHarness(t, "", "")
	t.Chdir(filepath.Dir(h.dataDir))
	h.svc = New(Options{Config: h.svc.config(), Store: h.st, Engine: h.eng, DataDir: "data"})
	h.svc.now = func() time.Time { return h.now }
	h.svc.newDest = func(config.BackupDestination) (Destination, error) { return h.dest, nil }
	if _, err := h.backup(); err != nil {
		t.Fatal(err)
	}
	if dir := bindDir(h.eng.specsOf("pg_dump")[0]); !filepath.IsAbs(dir) {
		t.Errorf("the staging mount must be absolute, got %q", dir)
	}
}

// --- restore -----------------------------------------------------------------------------------------------

func (h *harness) restoreRuns() []store.JobRun {
	runs, err := h.svc.Restores(h.t.Context(), "shop", 10)
	if err != nil {
		h.t.Fatal(err)
	}
	return runs
}

// restore starts a restore and waits for it to end.
func (h *harness) restore(req RestoreRequest) (RestoreStarted, store.JobRun, error) {
	h.t.Helper()
	req.Database = "shop"
	started, err := h.svc.Restore(h.t.Context(), req)
	if err != nil {
		return started, store.JobRun{}, err
	}
	h.svc.wg.Wait()
	run, err := h.st.JobRun(h.t.Context(), started.RunID)
	if err != nil {
		h.t.Fatal(err)
	}
	return started, run, nil
}

func TestRestoreRulesAreCheckedBeforeAnyRunExists(t *testing.T) {
	h := newHarness(t, "version: 16", "")
	key := h.seed(testNow.AddDate(0, 0, -1), h.id)
	secret := h.id.String()
	other := BackupKey("other", testNow)

	cases := []struct {
		name string
		req  RestoreRequest
		want string
	}{
		{"live without overwrite", RestoreRequest{Backup: key, Identity: secret, Target: "shop"}, "needs overwrite: true and confirm"},
		{"live without confirmation", RestoreRequest{Backup: key, Identity: secret, Target: "shop", Overwrite: true}, "needs overwrite: true and confirm"},
		{"live with the wrong confirmation", RestoreRequest{Backup: key, Identity: secret, Target: "shop", Overwrite: true, Confirm: "Shop"}, "needs overwrite: true and confirm"},
		{"confirmation without overwrite", RestoreRequest{Backup: key, Identity: secret, Target: "shop", Confirm: "shop"}, "needs overwrite: true and confirm"},
		{"target with a quote", RestoreRequest{Backup: key, Identity: secret, Target: `x"; drop database shop; --`}, "target must match"},
		{"target with a dash", RestoreRequest{Backup: key, Identity: secret, Target: "my-copy"}, "target must match"},
		{"target starting with a digit", RestoreRequest{Backup: key, Identity: secret, Target: "1copy"}, "target must match"},
		{"target too long", RestoreRequest{Backup: key, Identity: secret, Target: strings.Repeat("a", 64)}, "target must match"},
		{"another database's backup", RestoreRequest{Backup: other, Identity: secret}, "not the key of a backup of this database"},
		{"a path", RestoreRequest{Backup: "shop/../../etc/passwd", Identity: secret}, "not the key of a backup of this database"},
		{"no backup", RestoreRequest{Identity: secret}, "not the key of a backup of this database"},
		{"not a key", RestoreRequest{Backup: key, Identity: "hunter2"}, "identity must be an age secret key"},
		{"a public key", RestoreRequest{Backup: key, Identity: h.id.Recipient().String()}, "identity must be an age secret key"},
		{"no key", RestoreRequest{Backup: key}, "identity must be an age secret key"},
	}
	for _, c := range cases {
		c.req.Database = "shop"
		_, err := h.svc.Restore(t.Context(), c.req)
		var bad *RequestError
		if !errors.As(err, &bad) || !strings.Contains(err.Error(), c.want) {
			t.Errorf("%s: want a request error with %q, got %v", c.name, c.want, err)
			continue
		}
		if c.req.Identity != "" && strings.Contains(err.Error(), c.req.Identity) {
			t.Errorf("%s: the error echoes the key: %v", c.name, err)
		}
	}
	if runs := h.restoreRuns(); len(runs) != 0 || len(h.eng.specs) != 0 || len(h.rec.list()) != 0 {
		t.Errorf("a refused request starts nothing: %+v %v", runs, h.rec.list())
	}

	if _, err := h.svc.Restore(t.Context(), RestoreRequest{Database: "ghost", Backup: key, Identity: secret}); !errors.Is(err, ErrUnknownDatabase) {
		t.Errorf("unknown database: %v", err)
	}
}

func TestRestoreIntoANewDatabaseCreatesItRestoresAndCountsRows(t *testing.T) {
	h := newHarness(t, "version: 16", "")
	key := h.seed(testNow.AddDate(0, 0, -1), h.id)
	secret := h.id.String()

	started, run, err := h.restore(RestoreRequest{Backup: key, Identity: secret})
	if err != nil {
		t.Fatal(err)
	}
	if started.Target != "shop_restore_20261021" || started.RunID == "" {
		t.Errorf("default target: %+v", started)
	}
	if run.Job != "restore-shop" || run.Status != store.JobSucceeded || run.Trigger != "manual" || run.FinishedAt == nil {
		t.Fatalf("run: %+v", run)
	}
	want := []string{"get " + key, "run pg_restore --list", "run pg_restore read", "run psql create", "run pg_restore", "run psql counts"}
	if got := h.rec.list(); fmt.Sprint(got) != fmt.Sprint(want) {
		t.Errorf("order of steps:\n got  %v\n want %v", got, want)
	}

	create := h.eng.specsOf("psql create")[0]
	if !strings.Contains(strings.Join(create.Cmd, " "), `-d postgres`) || !strings.Contains(strings.Join(create.Cmd, " "), `CREATE DATABASE "shop_restore_20261021"`) {
		t.Errorf("the target is created from the maintenance database: %v", create.Cmd)
	}
	restore := h.eng.specsOf("pg_restore")[0]
	cmd := strings.Join(restore.Cmd, " ")
	if !strings.Contains(cmd, "-d shop_restore_20261021") || !strings.Contains(cmd, "--exit-on-error") || !strings.Contains(cmd, "--no-owner") || !strings.Contains(cmd, "--no-privileges") || strings.Contains(cmd, "--clean") || !strings.HasSuffix(cmd, "/in/dump") {
		t.Errorf("pg_restore command: %s", cmd)
	}
	if len(restore.Binds) != 1 || !strings.HasSuffix(restore.Binds[0], ":/in:ro") {
		t.Errorf("the dump is mounted read-only: %v", restore.Binds)
	}
	if string(h.eng.restored) != plainDump {
		t.Errorf("pg_restore must see the decrypted dump, saw %q", h.eng.restored)
	}
	lines := strings.Split(run.Output, "\n")
	if last := lines[len(lines)-1]; last != "row counts (2 tables, public ones by name, the others as schema.table): orders=7, users=42" {
		t.Errorf("the row counts are the final line: %q", last)
	}
	if !strings.Contains(run.Output, "created database shop_restore_20261021") {
		t.Errorf("output: %q", run.Output)
	}

	// The key lives in memory only.
	everything := run.Output + run.Detail + h.logs.String() + fmt.Sprintf("%+v", h.eng.specs) + strings.Join(h.rec.list(), "\n")
	if strings.Contains(everything, secret) || strings.Contains(everything, "AGE-SECRET-KEY") {
		t.Error("the age secret key reached the output, the logs, a container spec or a recorded step")
	}
	filepath.Walk(h.dataDir, func(path string, info os.FileInfo, err error) error {
		if err == nil && !info.IsDir() {
			if b, _ := os.ReadFile(path); bytes.Contains(b, []byte("AGE-SECRET-KEY")) {
				t.Errorf("the key was written to %s", path)
			}
		}
		return nil
	})
	if left := h.stagingLeft(); len(left) != 0 {
		t.Errorf("staging left: %v", left)
	}
	if len(h.eng.removed) != len(h.eng.specs) {
		t.Errorf("%d containers created, %d removed", len(h.eng.specs), len(h.eng.removed))
	}
}

func TestRestoreOverTheLiveDatabaseNeedsNoNewDatabaseAndCleansFirst(t *testing.T) {
	h := newHarness(t, "version: 16", "")
	key := h.seed(testNow.AddDate(0, 0, -1), h.id)

	_, run, err := h.restore(RestoreRequest{Backup: key, Identity: h.id.String(), Target: "shop", Overwrite: true, Confirm: "shop"})
	if err != nil || run.Status != store.JobSucceeded {
		t.Fatalf("%v %+v", err, run)
	}
	if h.rec.has("run psql create") {
		t.Errorf("the live database exists already: %v", h.rec.list())
	}
	cmd := strings.Join(h.eng.specsOf("pg_restore")[0].Cmd, " ")
	if !strings.Contains(cmd, "-d shop ") || !strings.Contains(cmd, "--clean --if-exists --single-transaction") || !strings.Contains(cmd, "--exit-on-error") {
		t.Errorf("pg_restore command: %s", cmd)
	}
}

func TestRestoreFailuresAreExplainedAndTouchNothingBeforeTheyHappen(t *testing.T) {
	t.Run("wrong key", func(t *testing.T) {
		h := newHarness(t, "version: 16", "")
		key := h.seed(testNow.AddDate(0, 0, -1), h.id)
		stranger := identity(t)
		_, run, err := h.restore(RestoreRequest{Backup: key, Identity: stranger.String()})
		if err != nil || run.Status != store.JobFailed || run.Detail != "this key cannot decrypt the backup" {
			t.Fatalf("%v %+v", err, run)
		}
		if h.rec.has("run") {
			t.Errorf("a key that cannot read the backup must stop everything before a container runs: %v", h.rec.list())
		}
		if left := h.stagingLeft(); len(left) != 0 {
			t.Errorf("staging left: %v", left)
		}
	})
	t.Run("target exists", func(t *testing.T) {
		h := newHarness(t, "version: 16", "")
		key := h.seed(testNow.AddDate(0, 0, -1), h.id)
		h.eng.createOut = []string{`ERROR:  database "shop_old" already exists`}
		_, run, _ := h.restore(RestoreRequest{Backup: key, Identity: h.id.String(), Target: "shop_old"})
		if run.Status != store.JobFailed || !strings.Contains(run.Detail, "database shop_old already exists: nothing was changed") {
			t.Errorf("%+v", run)
		}
		if len(h.eng.specsOf("pg_restore")) != 0 {
			t.Errorf("an existing target must be left alone: %v", h.rec.list())
		}
	})
	t.Run("pg_restore fails", func(t *testing.T) {
		h := newHarness(t, "version: 16", "")
		key := h.seed(testNow.AddDate(0, 0, -1), h.id)
		h.eng.restoreOK = false
		_, run, _ := h.restore(RestoreRequest{Backup: key, Identity: h.id.String()})
		if run.Status != store.JobFailed || !strings.Contains(run.Detail, "already exists") || !strings.Contains(run.Detail, "shop_restore_20261021 was created and is left as it is") {
			t.Errorf("%+v", run)
		}
		if h.rec.has("run psql counts") {
			t.Error("no row counts after a failed restore")
		}
	})
	t.Run("backup is gone", func(t *testing.T) {
		h := newHarness(t, "version: 16", "")
		_, run, _ := h.restore(RestoreRequest{Backup: BackupKey("shop", testNow), Identity: h.id.String()})
		if run.Status != store.JobFailed || !strings.Contains(run.Detail, "fetch") {
			t.Errorf("%+v", run)
		}
	})
}

func TestRestoreRefusesACorruptDumpBeforeAnythingIsCreatedOrDropped(t *testing.T) {
	for _, target := range []string{"", "shop"} {
		h := newHarness(t, "version: 16", "")
		key := h.seed(testNow.AddDate(0, 0, -1), h.id)
		h.eng.tocCode = 1
		req := RestoreRequest{Backup: key, Identity: h.id.String(), Target: target}
		if target == "shop" {
			req.Overwrite, req.Confirm = true, "shop"
		}
		_, run, err := h.restore(req)
		if err != nil || run.Status != store.JobFailed || !strings.Contains(run.Detail, "verify the dump") {
			t.Fatalf("target %q: %v %+v", target, err, run)
		}
		if h.rec.has("run psql create") || len(h.eng.specsOf("pg_restore")) != 0 || len(h.eng.specsOf("psql create")) != 0 {
			t.Errorf("target %q: a corrupt dump must stop everything before a mutating container: %v", target, h.rec.list())
		}
		if left := h.stagingLeft(); len(left) != 0 {
			t.Errorf("staging left: %v", left)
		}
	}
}

func TestShuttingDownCancelsARunningRestoreAndRemovesItsContainer(t *testing.T) {
	h := newHarness(t, "version: 16", "")
	key := h.seed(testNow.AddDate(0, 0, -1), h.id)
	h.eng.hold, h.eng.reached = make(chan struct{}), make(chan struct{})
	started, err := h.svc.Restore(t.Context(), RestoreRequest{Database: "shop", Backup: key, Identity: h.id.String()})
	if err != nil {
		t.Fatal(err)
	}
	<-h.eng.reached
	if !h.svc.Shutdown(5 * time.Second) {
		t.Fatal("Shutdown must return once the restore is cancelled")
	}
	run, err := h.st.JobRun(t.Context(), started.RunID)
	if err != nil || run.Status != store.JobFailed || !strings.Contains(run.Detail, "cancelled") || run.FinishedAt == nil {
		t.Fatalf("a cancelled restore is recorded as failed: %v %+v", err, run)
	}
	h.eng.mu.Lock()
	created, removed := len(h.eng.specs), len(h.eng.removed)
	h.eng.mu.Unlock()
	if created != removed {
		t.Errorf("%d containers created, %d removed", created, removed)
	}
	if _, err := h.svc.Restore(t.Context(), RestoreRequest{Database: "shop", Backup: key, Identity: h.id.String()}); !errors.Is(err, ErrShuttingDown) {
		t.Errorf("a stopped service accepts no restore: %v", err)
	}
}

func TestShuttingDownCancelsARunningBackup(t *testing.T) {
	h := newHarness(t, "version: 16", "")
	h.eng.hold, h.eng.reached, h.eng.holdKind = make(chan struct{}), make(chan struct{}), "pg_dump"
	errc := make(chan error, 1)
	go func() { _, err := h.backup(); errc <- err }()
	<-h.eng.reached
	if !h.svc.Shutdown(5 * time.Second) {
		t.Fatal("Shutdown must return once the backup is cancelled")
	}
	if err := <-errc; !errors.Is(err, context.Canceled) {
		t.Errorf("want a cancelled backup, got %v", err)
	}
	if len(h.eng.removed) != len(h.eng.specs) {
		t.Errorf("%d containers created, %d removed", len(h.eng.specs), len(h.eng.removed))
	}
}

func TestABackupAndARestoreOfTheSameDatabaseExcludeEachOther(t *testing.T) {
	t.Run("backup during restore", func(t *testing.T) {
		h := newHarness(t, "version: 16", "")
		key := h.seed(testNow.AddDate(0, 0, -1), h.id)
		h.eng.hold, h.eng.reached = make(chan struct{}), make(chan struct{})
		if _, err := h.svc.Restore(t.Context(), RestoreRequest{Database: "shop", Backup: key, Identity: h.id.String()}); err != nil {
			t.Fatal(err)
		}
		<-h.eng.reached
		if _, err := h.backup(); !errors.Is(err, ErrRestoreBusy) {
			t.Errorf("want ErrRestoreBusy, got %v", err)
		}
		close(h.eng.hold)
		h.svc.wg.Wait()
		h.eng.hold, h.eng.reached = nil, nil
		if _, err := h.backup(); err != nil {
			t.Errorf("once the restore has ended a backup can run: %v", err)
		}
	})
	t.Run("restore during backup", func(t *testing.T) {
		h := newHarness(t, "version: 16", "")
		key := h.seed(testNow.AddDate(0, 0, -1), h.id)
		h.eng.hold, h.eng.reached, h.eng.holdKind = make(chan struct{}), make(chan struct{}), "pg_dump"
		errc := make(chan error, 1)
		go func() { _, err := h.backup(); errc <- err }()
		<-h.eng.reached
		if _, err := h.svc.Restore(t.Context(), RestoreRequest{Database: "shop", Backup: key, Identity: h.id.String()}); !errors.Is(err, ErrBackupBusy) {
			t.Errorf("want ErrBackupBusy, got %v", err)
		}
		if len(h.restoreRuns()) != 0 {
			t.Error("a refused restore creates no run")
		}
		close(h.eng.hold)
		if err := <-errc; err != nil {
			t.Fatal(err)
		}
		h.eng.hold, h.eng.reached = nil, nil
		if _, run, err := h.restore(RestoreRequest{Backup: key, Identity: h.id.String()}); err != nil || run.Status != store.JobSucceeded {
			t.Errorf("once the backup has ended a restore can run: %v %+v", err, run)
		}
	})
}

func TestOnlyOneRestorePerDatabaseAtATime(t *testing.T) {
	h := newHarness(t, "version: 16", "")
	key := h.seed(testNow.AddDate(0, 0, -1), h.id)
	h.eng.hold, h.eng.reached = make(chan struct{}), make(chan struct{})

	first, err := h.svc.Restore(t.Context(), RestoreRequest{Database: "shop", Backup: key, Identity: h.id.String()})
	if err != nil {
		t.Fatal(err)
	}
	<-h.eng.reached
	if _, err := h.svc.Restore(t.Context(), RestoreRequest{Database: "shop", Backup: key, Identity: h.id.String(), Target: "shop_other"}); !errors.Is(err, ErrRestoreBusy) {
		t.Errorf("want ErrRestoreBusy, got %v", err)
	}
	if run, _ := h.st.JobRun(t.Context(), first.RunID); run.Status != store.JobRunning {
		t.Errorf("the first restore is still running: %+v", run)
	}
	if len(h.restoreRuns()) != 1 {
		t.Error("a refused restore creates no run")
	}

	close(h.eng.hold)
	h.svc.wg.Wait()
	h.eng.hold, h.eng.reached = nil, nil
	if _, err := h.svc.Restore(t.Context(), RestoreRequest{Database: "shop", Backup: key, Identity: h.id.String(), Target: "shop_other"}); err != nil {
		t.Errorf("once the first has ended another can start: %v", err)
	}
	h.svc.wg.Wait()
}

func TestAnInterruptedRestoreIsAJobRunSoRecoverFailsIt(t *testing.T) {
	h := newHarness(t, "version: 16", "")
	key := h.seed(testNow.AddDate(0, 0, -1), h.id)
	h.eng.hold, h.eng.reached = make(chan struct{}), make(chan struct{})
	if _, err := h.svc.Restore(t.Context(), RestoreRequest{Database: "shop", Backup: key, Identity: h.id.String()}); err != nil {
		t.Fatal(err)
	}
	<-h.eng.reached
	running, err := h.st.RunningJobRuns(t.Context())
	if err != nil || len(running) != 1 || running[0].Job != "restore-shop" {
		t.Errorf("Scheduler.Recover finds interrupted restores through RunningJobRuns: %+v %v", running, err)
	}
	close(h.eng.hold)
	h.svc.wg.Wait()
}

func TestDefaultTargetIsAPlainIdentifierOfAtMost63Characters(t *testing.T) {
	cases := map[string]string{
		"shop":    "shop_restore_20261021",
		"my-shop": "my_shop_restore_20261021",
		"v1.db":   "v1_db_restore_20261021",
		"2fast":   "db_2fast_restore_20261021",
	}
	for in, want := range cases {
		if got := defaultTarget(in, testNow); got != want || !targetPattern.MatchString(got) {
			t.Errorf("defaultTarget(%q) = %q, want %q", in, got, want)
		}
	}
	long := defaultTarget(strings.Repeat("a", 63), testNow)
	if len(long) != 63 || !strings.HasSuffix(long, "_restore_20261021") || !targetPattern.MatchString(long) {
		t.Errorf("%q (%d)", long, len(long))
	}
}

// --- what the API shows ------------------------------------------------------------------------------------

func TestLiveProbesTheServerAndRemembersTheAnswerForAMinute(t *testing.T) {
	h := newHarness(t, "", "")
	live, err := h.svc.Live(t.Context(), "shop")
	if err != nil || live != (Live{ServerVersion: "16.4", SizeBytes: 8421376, ClientImage: "postgres:16-alpine"}) {
		t.Fatalf("%+v %v", live, err)
	}
	if n := len(h.eng.specsOf("psql version")); n != 1 {
		t.Fatalf("%d probes", n)
	}
	if _, err := h.svc.Live(t.Context(), "shop"); err != nil || len(h.eng.specsOf("psql version")) != 1 {
		t.Error("a second call within the minute must not run a container")
	}
	// The probe also taught the backup which client to use.
	if _, err := h.backup(); err != nil || len(h.eng.specsOf("psql version")) != 1 {
		t.Errorf("a backup right after a probe must reuse its result: %v", err)
	}
	h.now = h.now.Add(61 * time.Second)
	if _, err := h.svc.Live(t.Context(), "shop"); err != nil || len(h.eng.specsOf("psql version")) != 2 {
		t.Error("after a minute the server is asked again")
	}
	h.now = h.now.Add(11 * time.Minute)
	if _, err := h.backup(); err != nil || len(h.eng.specsOf("psql version")) != 3 {
		t.Errorf("the detected version is forgotten after ten minutes: %v", err)
	}
}

func TestConcurrentLiveCallsShareOneProbe(t *testing.T) {
	h := newHarness(t, "", "")
	h.eng.probeHold = make(chan struct{})
	const callers = 8
	var wg sync.WaitGroup
	errs := make([]error, callers)
	lives := make([]Live, callers)
	for i := range callers {
		wg.Add(1)
		go func() {
			defer wg.Done()
			lives[i], errs[i] = h.svc.Live(t.Context(), "shop")
		}()
	}
	// A caller that gives up leaves at once and does not fail the probe the others wait for.
	gone, cancel := context.WithCancel(t.Context())
	cancel()
	if _, err := h.svc.Live(gone, "shop"); !errors.Is(err, context.Canceled) {
		t.Errorf("a canceled caller must stop waiting: %v", err)
	}
	time.Sleep(200 * time.Millisecond) // every caller is waiting for the one probe
	close(h.eng.probeHold)
	wg.Wait()

	if n := len(h.eng.specsOf("psql version")); n != 1 {
		t.Errorf("%d probe containers for %d concurrent callers, want 1", n, callers)
	}
	for i := range callers {
		if errs[i] != nil || lives[i].ServerVersion != "16.4" {
			t.Errorf("caller %d: %+v %v", i, lives[i], errs[i])
		}
	}
	if _, err := h.svc.Live(t.Context(), "shop"); err != nil || len(h.eng.specsOf("psql version")) != 1 {
		t.Errorf("the answer is cached once the probe ends: %v", err)
	}
}

func TestLiveFailureIsSharedAndNotCached(t *testing.T) {
	h := newHarness(t, "", "")
	h.eng.probeCode = 2
	h.eng.probe = []string{"psql: error: connection refused"}
	if _, err := h.svc.Live(t.Context(), "shop"); !errors.Is(err, ErrServer) {
		t.Fatalf("a failed probe is an ErrServer: %v", err)
	}
	h.eng.probeCode = 0
	h.eng.probe = []string{"160004|16.4|1"}
	if _, err := h.svc.Live(t.Context(), "shop"); err != nil {
		t.Errorf("a failure must not be remembered or stay in flight: %v", err)
	}
}

func TestRemoteFailuresAreClassifiedAndKeepTheirText(t *testing.T) {
	h := newHarness(t, "", "")
	os.Remove(h.passFile)
	_, err := h.svc.Live(t.Context(), "shop")
	if !errors.Is(err, ErrSecret) || !strings.Contains(err.Error(), h.passFile) {
		t.Errorf("an unreadable password file is an ErrSecret with its detail kept for the log: %v", err)
	}
	h.dest.listErr = errors.New("s3 GET: 403 AccessDenied")
	if _, err := h.svc.Backups(t.Context(), "shop"); !errors.Is(err, ErrDestination) || !strings.Contains(err.Error(), "AccessDenied") {
		t.Errorf("an unreadable destination is an ErrDestination: %v", err)
	}
}

func TestLiveFailureSaysWhatPostgresSaid(t *testing.T) {
	h := newHarness(t, "", "")
	h.eng.probeCode = 2
	h.eng.probe = []string{"psql: error: connection to server at \"127.0.0.1\", port 5432 failed: FATAL:  password authentication failed for user \"shop\""}
	_, err := h.svc.Live(t.Context(), "shop")
	if err == nil || !strings.Contains(err.Error(), `port 5432 failed: FATAL:  password authentication failed for user "shop"`) {
		t.Errorf("%v", err)
	}
	if strings.Contains(err.Error(), "pa55word") {
		t.Error("the password must not be in the error")
	}
	if _, err := h.svc.Live(t.Context(), "ghost"); !errors.Is(err, ErrUnknownDatabase) {
		t.Errorf("%v", err)
	}
}

func TestBackupsListsTheDestinationNewestFirstAndIgnoresStrayFiles(t *testing.T) {
	h := newHarness(t, "", "")
	h.seed(testNow.AddDate(0, 0, -3), h.id)
	h.seed(testNow.AddDate(0, 0, -1), h.id)
	h.dest.objects["shop/README"] = []byte("x")

	got, err := h.svc.Backups(t.Context(), "shop")
	if err != nil || len(got) != 2 || got[0].CreatedAt != testNow.AddDate(0, 0, -1) || got[1].CreatedAt != testNow.AddDate(0, 0, -3) || got[0].SizeBytes == 0 {
		t.Fatalf("%+v %v", got, err)
	}
	h.dest.listErr = errors.New("s3 list: 403 AccessDenied")
	if _, err := h.svc.Backups(t.Context(), "shop"); err == nil || !strings.Contains(err.Error(), "AccessDenied") {
		t.Errorf("an unreachable destination is an error: %v", err)
	}
	if _, err := h.svc.Backups(t.Context(), "ghost"); !errors.Is(err, ErrUnknownDatabase) {
		t.Errorf("%v", err)
	}

	plain, issues := config.Parse([]byte("databases:\n  - {name: scratch, host: h, database: d, user: u}\n"))
	if plain == nil {
		t.Fatal(issues)
	}
	none := New(Options{Config: plain, Store: h.st, Engine: h.eng, DataDir: t.TempDir()})
	list, err := none.Backups(t.Context(), "scratch")
	if err != nil || list == nil || len(list) != 0 {
		t.Errorf("a database without backup has none, as [] and not null: %v %v", list, err)
	}
}

func TestDatabasesViewHasNoSecretAndReportsTheBackupJob(t *testing.T) {
	h := newHarness(t, "", "timezone: Europe/Paris\n      keep_days: 30")
	views, err := h.svc.Databases(t.Context())
	if err != nil || len(views) != 1 {
		t.Fatalf("%+v %v", views, err)
	}
	v := views[0]
	if v.Name != "shop" || v.Engine != "postgres" || v.Port != 5432 || !v.HasPassword || v.Network != "host" || v.Version != 0 {
		t.Errorf("%+v", v)
	}
	b := v.Backup
	if b == nil || b.Job != "backup-shop" || b.Destination != "local:/var/backups/keelson" || b.Recipients != 1 || b.Keep != 3 || b.KeepDays != 30 || b.Timezone != "Europe/Paris" || b.LastRun != nil {
		t.Fatalf("%+v", b)
	}
	// 03:00 Paris is 01:00 or 02:00 UTC: the next one after 03:00 UTC on 21 October is the next morning.
	if b.NextRun == nil || !b.NextRun.Equal(time.Date(2026, 10, 22, 1, 0, 0, 0, time.UTC)) {
		t.Errorf("next run %v", b.NextRun)
	}

	ctx := t.Context()
	h.st.CreateJobRun(ctx, store.JobRun{ID: "r1", Job: "backup-shop", Trigger: "schedule", Status: store.JobRunning, StartedAt: testNow})
	h.st.FinishJobRun(ctx, "r1", store.JobFailed, "dump: boom", "out", testNow.Add(time.Minute))
	views, _ = h.svc.Databases(ctx)
	if lr := views[0].Backup.LastRun; lr == nil || lr.ID != "r1" || lr.Status != store.JobFailed || lr.Detail != "dump: boom" || lr.FinishedAt == nil {
		t.Errorf("last run %+v", lr)
	}

	paused := newHarness(t, "", "paused: true")
	views, _ = paused.svc.Databases(ctx)
	if views[0].Backup.NextRun != nil || !views[0].Backup.Paused {
		t.Errorf("a paused backup has no next run: %+v", views[0].Backup)
	}
}

func TestAReloadSwapsTheDatabases(t *testing.T) {
	h := newHarness(t, "", "")
	next, issues := config.Parse([]byte("databases:\n  - {name: other, host: h, database: d, user: u}\n"))
	if next == nil {
		t.Fatal(issues)
	}
	apply, err := h.svc.Prepare(h.svc.config(), next)
	if err != nil {
		t.Fatal(err)
	}
	apply()
	views, _ := h.svc.Databases(t.Context())
	if len(views) != 1 || views[0].Name != "other" {
		t.Errorf("%+v", views)
	}
	if _, err := h.svc.Live(t.Context(), "shop"); !errors.Is(err, ErrUnknownDatabase) {
		t.Errorf("a removed database is unknown: %v", err)
	}
}

func TestDatabasesViewCarriesTheProjectLabel(t *testing.T) {
	cfg, issues := config.Parse([]byte("databases:\n  - {name: labelled, project: shop, host: h, database: d, user: u}\n  - {name: plain, host: h, database: d2, user: u}\n"))
	if cfg == nil {
		t.Fatal(issues)
	}
	h := newHarness(t, "", "")
	svc := New(Options{Config: cfg, Store: h.st, Engine: h.eng, DataDir: t.TempDir()})
	views, err := svc.Databases(t.Context())
	if err != nil || len(views) != 2 || views[0].Project != "shop" || views[1].Project != "" {
		t.Fatalf("%+v %v", views, err)
	}
	raw, _ := json.Marshal(views)
	if strings.Count(string(raw), `"project"`) != 1 {
		t.Errorf("an unlabelled database has no project key: %s", raw)
	}
}
