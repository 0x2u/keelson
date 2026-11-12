package confmgr

import (
	"errors"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/0x2u/keelson/agent/internal/config"
	"github.com/0x2u/keelson/agent/internal/store"
)

const base = `apps:
  - name: shop
    image: ghcr.io/me/shop
    env:
      DATABASE_URL: postgres://u:pw@db/shop
  - name: web
    image: ghcr.io/me/web
jobs:
  - name: backup
    schedule: "@daily"
    run: [/bin/true]
`

type fakeApplier struct {
	err      error
	prepared int
	applied  int
	last     *config.Config
}

func (f *fakeApplier) Prepare(_, next *config.Config) (func(), error) {
	f.prepared++
	if f.err != nil {
		return nil, f.err
	}
	return func() { f.applied++; f.last = next }, nil
}

type rig struct {
	t    *testing.T
	path string
	st   *store.Store
	m    *Manager
	a, b *fakeApplier
}

func newRig(t *testing.T, content string) *rig {
	t.Helper()
	dir := t.TempDir()
	path := filepath.Join(dir, "apps.yaml")
	if err := os.WriteFile(path, []byte(content), 0o640); err != nil {
		t.Fatal(err)
	}
	st, err := store.Open(filepath.Join(dir, "agent.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	return build(t, path, st)
}

func build(t *testing.T, path string, st *store.Store) *rig {
	t.Helper()
	cfg, err := config.Load(path)
	if err != nil {
		t.Fatal(err)
	}
	r := &rig{t: t, path: path, st: st, a: &fakeApplier{}, b: &fakeApplier{}}
	r.m, err = New(path, st, cfg, slog.New(slog.NewTextHandler(io.Discard, nil)), r.a, r.b)
	if err != nil {
		t.Fatal(err)
	}
	return r
}

func (r *rig) disk() string {
	b, err := os.ReadFile(r.path)
	if err != nil {
		r.t.Fatal(err)
	}
	return string(b)
}

func (r *rig) document() Document {
	d, err := r.m.Document()
	if err != nil {
		r.t.Fatal(err)
	}
	return d
}

func TestStartRecordsTheFirstVersionAndLaterHandEdits(t *testing.T) {
	r := newRig(t, base)
	versions, _ := r.m.Versions(10)
	if len(versions) != 1 || versions[0].Source != store.SourceStartup {
		t.Fatalf("first version: %+v", versions)
	}
	// Edited while the agent was down: the next start records it as a file edit.
	os.WriteFile(r.path, []byte(base+"# edited\n"), 0o640)
	r2 := build(t, r.path, r.st)
	versions, _ = r2.m.Versions(10)
	if len(versions) != 2 || versions[0].Source != store.SourceFile {
		t.Fatalf("after an offline edit: %+v", versions)
	}
	// An unchanged restart adds nothing.
	r3 := build(t, r.path, r.st)
	if versions, _ = r3.m.Versions(10); len(versions) != 2 {
		t.Errorf("unchanged restart must not add a version: %d", len(versions))
	}
}

func TestDocumentHidesSecretsAndSaysWhatIsRunning(t *testing.T) {
	r := newRig(t, base)
	d := r.document()
	if strings.Contains(d.Content, "pw@db") || !strings.Contains(d.Content, config.Hidden) {
		t.Errorf("secrets must be hidden:\n%s", d.Content)
	}
	if d.Hash != config.Hash([]byte(base)) || d.Hash != d.AppliedHash || d.Error != "" || d.Model == nil {
		t.Errorf("unexpected document: %+v", d)
	}
}

func TestSaveAppliesWritesAndKeepsSecrets(t *testing.T) {
	r := newRig(t, base)
	d := r.document()
	edited := strings.Replace(d.Content, "ghcr.io/me/web", "ghcr.io/me/web2", 1)
	out, err := r.m.Save([]byte(edited), d.Hash, false, Meta{Source: store.SourceAPI, Actor: "dashboard", Comment: "bump"})
	if err != nil {
		t.Fatal(err)
	}
	if r.a.applied != 1 || r.b.applied != 1 || r.a.last.Apps[1].Image != "ghcr.io/me/web2" {
		t.Errorf("every applier must apply the new configuration: %+v %+v", r.a, r.b)
	}
	if got := r.disk(); !strings.Contains(got, "postgres://u:pw@db/shop") || !strings.Contains(got, "web2") || strings.Contains(got, config.Hidden) {
		t.Errorf("the file keeps its secrets and takes the edit:\n%s", got)
	}
	if out.Hash != config.Hash([]byte(r.disk())) || r.m.Config().Apps[1].Image != "ghcr.io/me/web2" {
		t.Errorf("outcome %+v", out)
	}
	versions, _ := r.m.Versions(10)
	if len(versions) != 2 || versions[0].Source != store.SourceAPI || versions[0].Actor != "dashboard" || versions[0].Comment != "bump" {
		t.Errorf("versions: %+v", versions)
	}
	if info, _ := os.Stat(r.path); info.Mode().Perm() != 0o640 {
		t.Errorf("the file keeps its mode, got %v", info.Mode().Perm())
	}
}

func TestSaveRefusesAnInvalidDocumentAndTouchesNothing(t *testing.T) {
	r := newRig(t, base)
	d := r.document()
	bad := strings.Replace(d.Content, "ghcr.io/me/web", "Not A Repo:tag", 1)
	_, err := r.m.Save([]byte(bad), d.Hash, false, Meta{Source: store.SourceAPI})
	var inv *InvalidError
	if !errors.As(err, &inv) || len(inv.Issues) == 0 || inv.Issues[0].Line == 0 {
		t.Fatalf("want InvalidError with a line, got %v %+v", err, inv)
	}
	if r.disk() != base || r.a.applied != 0 {
		t.Error("an invalid document must change nothing")
	}
}

func TestSaveDetectsAConcurrentEdit(t *testing.T) {
	r := newRig(t, base)
	d := r.document()
	os.WriteFile(r.path, []byte(base+"# someone else\n"), 0o640)
	_, err := r.m.Save([]byte(d.Content), d.Hash, false, Meta{Source: store.SourceAPI})
	var c *ConflictError
	if !errors.As(err, &c) || c.Hash != config.Hash([]byte(base+"# someone else\n")) {
		t.Fatalf("want ConflictError with the current hash, got %v", err)
	}
}

func TestRemovingAnAppOrJobOrChangingTheProxyNeedsAcknowledgement(t *testing.T) {
	r := newRig(t, base)
	d := r.document()
	withoutWeb := strings.Replace(d.Content, "  - name: web\n    image: ghcr.io/me/web\n", "", 1)
	_, err := r.m.Save([]byte(withoutWeb), d.Hash, false, Meta{Source: store.SourceAPI})
	var ack *NeedsAckError
	if !errors.As(err, &ack) || len(blockingWarnings(ack.Issues)) == 0 || blockingWarnings(ack.Issues)[0].Code != CodeAppRemoved {
		t.Fatalf("want NeedsAckError app_removed, got %v", err)
	}
	if r.a.applied != 0 || !strings.Contains(r.disk(), "web") {
		t.Error("nothing may be applied before the acknowledgement")
	}
	if _, err := r.m.Save([]byte(withoutWeb), d.Hash, true, Meta{Source: store.SourceAPI}); err != nil {
		t.Fatalf("with force: %v", err)
	}
	if _, ok := r.m.Config().App("web"); ok {
		t.Error("web must be gone")
	}
}

func TestOneRefusingApplierStopsTheWholeChange(t *testing.T) {
	r := newRig(t, base)
	r.b.err = &BusyError{Reason: "a deployment is running"}
	d := r.document()
	edited := strings.Replace(d.Content, "ghcr.io/me/web", "ghcr.io/me/web2", 1)
	_, err := r.m.Save([]byte(edited), d.Hash, false, Meta{Source: store.SourceAPI})
	var busy *BusyError
	if !errors.As(err, &busy) {
		t.Fatalf("want BusyError, got %v", err)
	}
	if r.a.applied != 0 || r.disk() != base {
		t.Errorf("all or nothing: applied=%d, file changed=%v", r.a.applied, r.disk() != base)
	}
}

func TestValidateReportsErrorsAndWarningsWithoutWriting(t *testing.T) {
	r := newRig(t, base)
	d := r.document()
	issues, err := r.m.Validate([]byte(strings.Replace(d.Content, "  - name: web\n    image: ghcr.io/me/web\n", "", 1)))
	if err != nil || len(blockingWarnings(issues)) != 1 || blockingWarnings(issues)[0].Code != CodeAppRemoved || blockingWarnings(issues)[0].Severity != config.SeverityWarning {
		t.Fatalf("%v %+v", err, issues)
	}
	issues, _ = r.m.Validate([]byte("apps:\n  - name: BAD\n    image: x\n"))
	if !hasErrors(issues) {
		t.Errorf("want errors: %+v", issues)
	}
	if r.disk() != base || r.a.prepared != 0 {
		t.Error("validation must not write or prepare anything")
	}
}

func TestEditChangesOneAppAndKeepsTheRest(t *testing.T) {
	r := newRig(t, base)
	d := r.document()
	_, err := r.m.Edit(d.Hash, false, Meta{Source: store.SourceAPI}, func(disk []byte) ([]byte, []config.Issue, error) {
		return config.SetApp(disk, "web", map[string]any{"name": "web", "image": "ghcr.io/me/web", "restart": "always"})
	})
	if err != nil {
		t.Fatal(err)
	}
	cfg := r.m.Config()
	web, _ := cfg.App("web")
	shop, _ := cfg.App("shop")
	if web.Restart != "always" || shop.Env["DATABASE_URL"] != "postgres://u:pw@db/shop" || len(cfg.Jobs) != 1 {
		t.Errorf("web %+v shop %+v", web, shop)
	}
}

func TestRestoreVersionWritesTheOldTextAsANewVersion(t *testing.T) {
	r := newRig(t, base)
	d := r.document()
	edited := strings.Replace(d.Content, "ghcr.io/me/web", "ghcr.io/me/web2", 1)
	out, err := r.m.Save([]byte(edited), d.Hash, false, Meta{Source: store.SourceAPI})
	if err != nil {
		t.Fatal(err)
	}
	versions, _ := r.m.Versions(10)
	first := versions[len(versions)-1]
	if _, err := r.m.RestoreVersion(first.ID, out.Hash, false, "dashboard"); err != nil {
		t.Fatal(err)
	}
	if r.disk() != base {
		t.Errorf("the original text is back:\n%s", r.disk())
	}
	versions, _ = r.m.Versions(10)
	if len(versions) != 3 || versions[0].Source != store.SourceRestore {
		t.Errorf("restore adds a version: %+v", versions)
	}
	if _, red, err := r.m.Version(first.ID); err != nil || strings.Contains(red, "pw@db") {
		t.Errorf("version text must be redacted: %v\n%s", err, red)
	}
	if _, _, err := r.m.Version(9999); !errors.Is(err, store.ErrNotFound) {
		t.Errorf("want ErrNotFound, got %v", err)
	}
}

func TestWatchAppliesHandEditsAndIgnoresBrokenOnes(t *testing.T) {
	r := newRig(t, base)

	os.WriteFile(r.path, []byte(strings.Replace(base, "ghcr.io/me/web", "ghcr.io/me/web3", 1)), 0o640)
	r.m.checkFile()
	if r.m.Config().Apps[1].Image != "ghcr.io/me/web3" || r.a.applied != 1 {
		t.Fatal("a valid hand edit must be applied")
	}
	if v, _ := r.m.Versions(10); v[0].Source != store.SourceFile {
		t.Errorf("recorded as a file edit: %+v", v[0])
	}

	good := r.disk()
	os.WriteFile(r.path, []byte("apps:\n  - name: BAD\n"), 0o640)
	r.m.checkFile()
	r.m.checkFile() // the same broken file is not re-reported
	if r.m.Config().Apps[1].Image != "ghcr.io/me/web3" || r.a.applied != 1 {
		t.Error("a broken edit must leave the running configuration alone")
	}
	d := r.document()
	if d.Error == "" || !strings.Contains(d.Content, "ghcr.io/me/web3") || d.Hash == d.AppliedHash {
		t.Errorf("the document shows the last good text and the problem: %+v", d)
	}

	os.WriteFile(r.path, []byte(good), 0o640)
	r.m.checkFile()
	if d := r.document(); d.Error != "" || d.Hash != d.AppliedHash {
		t.Errorf("the problem clears once the file is valid again: %+v", d)
	}
}

func TestWatchRetriesWhenBusy(t *testing.T) {
	r := newRig(t, base)
	r.a.err = &BusyError{Reason: "a deployment is running"}
	os.WriteFile(r.path, []byte(strings.Replace(base, "ghcr.io/me/web", "ghcr.io/me/web3", 1)), 0o640)
	r.m.checkFile()
	if r.a.applied != 0 {
		t.Fatal("busy: not applied yet")
	}
	r.a.err = nil
	r.m.checkFile()
	if r.a.applied != 1 {
		t.Error("it is applied once the agent is free")
	}
}

func TestWarningsNameWhatChanges(t *testing.T) {
	old, _ := config.Parse([]byte(base))
	next, _ := config.Parse([]byte("apps:\n  - name: shop\n    image: ghcr.io/me/shop\n"))
	codes := map[string]bool{}
	for _, w := range Warnings(old, next) {
		codes[w.Code] = true
	}
	if !codes[CodeAppRemoved] || !codes[CodeJobRemoved] || codes[CodeProxyChanged] {
		t.Errorf("codes: %v", codes)
	}
}

func TestRemovingAPreviewsTemplateNeedsAcknowledgement(t *testing.T) {
	const with = "proxy: {}\napps:\n  - {name: shop, image: ghcr.io/me/shop, port: 3000, domains: [shop.example.com]}\npreviews:\n  - {app: shop, domain: 'pr-{pr}-shop.example.com'}\n"
	const without = "proxy: {}\napps:\n  - {name: shop, image: ghcr.io/me/shop, port: 3000, domains: [shop.example.com]}\n"
	old, iss := config.Parse([]byte(with))
	next, iss2 := config.Parse([]byte(without))
	if old == nil || next == nil {
		t.Fatalf("%+v %+v", iss, iss2)
	}
	var got []config.Issue
	for _, w := range Warnings(old, next) {
		if w.Code == CodePreviewsRemoved {
			got = append(got, w)
		}
	}
	if len(got) != 1 || got[0].Path != "apps[shop].previews" || !blocking[CodePreviewsRemoved] {
		t.Fatalf("%+v", got)
	}
	if len(Warnings(old, old)) != 0 {
		t.Error("an unchanged template warns about nothing")
	}
}

func TestARestrictedManagerRefusesWhatTheRestrictionForbidsThroughTheAPIOnly(t *testing.T) {
	machine := "apps: []\nbuild_limits: {memory: 4g}\n"
	r := newRig(t, machine)
	r.m.Restrict(config.BuildMachineIssues)
	d := r.document()

	withJob := d.Content + "jobs:\n  - name: pwn\n    schedule: \"* * * * *\"\n    host: [sh, -c, id]\n"
	if issues, err := r.m.Validate([]byte(withJob)); err != nil || !hasErrors(issues) {
		t.Errorf("validating must report the restriction: %v %+v", err, issues)
	}
	_, err := r.m.Save([]byte(withJob), d.Hash, false, Meta{Source: store.SourceAPI})
	var inv *InvalidError
	if !errors.As(err, &inv) || !strings.Contains(inv.Issues[len(inv.Issues)-1].Message, "runs no jobs") {
		t.Fatalf("a job written through the API must be refused with the reason: %v %+v", err, inv)
	}
	if r.disk() != machine || r.a.applied != 0 {
		t.Error("a refused document must change nothing")
	}

	limits := strings.Replace(d.Content, "memory: 4g", "memory: 6g", 1)
	if _, err := r.m.Save([]byte(limits), d.Hash, false, Meta{Source: store.SourceAPI}); err != nil {
		t.Errorf("the limits are what the machine is for: %v", err)
	}
}
