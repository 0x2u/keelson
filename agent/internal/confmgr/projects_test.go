package confmgr

import (
	"context"
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

const mainApps = `apps:
  - name: web
    image: ghcr.io/me/web
jobs:
  - name: backup
    schedule: "@daily"
    run: [/bin/true]
`

const shopFile = `# The shop.
apps:
  - name: shop
    image: ghcr.io/me/shop
    env:
      DATABASE_URL: postgres://u:pw@db/shop
jobs:
  - name: shop-job
    schedule: "@daily"
    container: {app: shop, command: [x]}
`

const blogFile = "apps:\n  - {name: blog, image: ghcr.io/me/blog}\n"

// projectRig is a rig whose apps file has project files next to it.
func projectRig(t *testing.T, main string, projects map[string]string) *rig {
	t.Helper()
	dir := t.TempDir()
	path := filepath.Join(dir, "apps.yaml")
	if err := os.WriteFile(path, []byte(main), 0o640); err != nil {
		t.Fatal(err)
	}
	loc := config.DefaultLocation(path)
	for n, c := range projects {
		if err := os.MkdirAll(loc.ProjectsDir, 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(loc.ProjectPath(n), []byte(c), 0o640); err != nil {
			t.Fatal(err)
		}
	}
	st, err := store.Open(filepath.Join(dir, "agent.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	cfg, err := config.LoadFrom(loc)
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

func (r *rig) projectPath(name string) string {
	return config.DefaultLocation(r.path).ProjectPath(name)
}

func (r *rig) projectDisk(name string) string {
	b, err := os.ReadFile(r.projectPath(name))
	if err != nil {
		r.t.Fatal(err)
	}
	return string(b)
}

func (r *rig) bundle() config.Bundle {
	b, err := config.DefaultLocation(r.path).Read()
	if err != nil {
		r.t.Fatal(err)
	}
	return b
}

// recorded is the content a version holds.
func (r *rig) recorded(id int64) string {
	v, err := r.st.ConfigVersion(context.Background(), id)
	if err != nil {
		r.t.Fatal(err)
	}
	return v.Content
}

func TestStartRecordsTheBundleAsTheFirstVersion(t *testing.T) {
	r := projectRig(t, mainApps, map[string]string{"shop": shopFile})
	b := r.bundle()
	versions, _ := r.m.Versions(10)
	if len(versions) != 1 || versions[0].Source != store.SourceStartup || versions[0].Hash != b.Hash() || versions[0].Hash == config.Hash([]byte(mainApps)) {
		t.Fatalf("%+v", versions)
	}
	got, err := config.DecodeBundle(r.recorded(versions[0].ID))
	if err != nil || !got.Equal(b) {
		t.Errorf("the version holds every file: %+v %v", got, err)
	}
	// An unchanged restart adds nothing; an edit of a project file while the agent was down is a file version.
	cfg, _ := config.LoadFrom(config.DefaultLocation(r.path))
	if _, err := New(r.path, r.st, cfg, nil); err != nil {
		t.Fatal(err)
	}
	if versions, _ = r.m.Versions(10); len(versions) != 1 {
		t.Errorf("%+v", versions)
	}
	os.WriteFile(r.projectPath("shop"), []byte(shopFile+"# edited\n"), 0o640)
	cfg, _ = config.LoadFrom(config.DefaultLocation(r.path))
	if _, err := New(r.path, r.st, cfg, nil); err != nil {
		t.Fatal(err)
	}
	if versions, _ = r.m.Versions(10); len(versions) != 2 || versions[0].Source != store.SourceFile {
		t.Errorf("%+v", versions)
	}
}

func TestWithoutProjectFilesNothingChanges(t *testing.T) {
	r := newRig(t, base)
	d := r.document()
	if d.Hash != config.Hash([]byte(base)) || len(d.Files) != 1 || d.Files[0].Project != "" || d.Files[0].Path != "apps.yaml" || d.Files[0].Hash != d.Hash {
		t.Errorf("%+v", d)
	}
	versions, _ := r.m.Versions(10)
	if r.recorded(versions[0].ID) != base {
		t.Error("a configuration without project files is recorded as the apps file itself")
	}
	if list, err := r.m.Projects(); err != nil || len(list) != 0 {
		t.Errorf("%v %v", list, err)
	}
	if _, err := r.m.ProjectDocument("shop"); !errors.Is(err, store.ErrNotFound) {
		t.Errorf("%v", err)
	}
	if _, err := os.Stat(filepath.Join(filepath.Dir(r.path), config.ProjectsDirName)); !os.IsNotExist(err) {
		t.Error("no directory is created until a project file is")
	}
}

func TestDocumentOfABundleHidesSecretsInEveryFile(t *testing.T) {
	r := projectRig(t, mainApps, map[string]string{"shop": shopFile, "blog": blogFile})
	d := r.document()
	b := r.bundle()
	if d.Hash != b.Hash() || d.Hash != d.AppliedHash || d.Error != "" || len(d.Files) != 3 {
		t.Fatalf("%+v", d)
	}
	if d.Content != mainApps {
		t.Errorf("the content is the apps file's:\n%s", d.Content)
	}
	if d.Files[0].Project != "" || d.Files[1].Project != "blog" || d.Files[2].Project != "shop" || d.Files[2].Path != "projects.d/shop.yaml" || d.Files[2].Hash != config.Hash([]byte(shopFile)) {
		t.Errorf("%+v", d.Files)
	}
	apps, _ := d.Model["apps"].([]any)
	if len(apps) != 3 {
		t.Fatalf("the model lists the apps of every file: %v", d.Model["apps"])
	}
	for _, a := range apps {
		e := a.(map[string]any)
		if e["name"] == "shop" {
			if e["project"] != "shop" || e["env"].(map[string]any)["DATABASE_URL"] != config.Hidden {
				t.Errorf("project filled in, secret hidden: %+v", e)
			}
		}
	}
	jobs, _ := d.Model["jobs"].([]any)
	if len(jobs) != 2 || jobs[1].(map[string]any)["project"] != "shop" {
		t.Errorf("%v", jobs)
	}
}

func TestProjectsAndProjectDocumentHideSecretsAndSayWhatIsInForce(t *testing.T) {
	r := projectRig(t, mainApps, map[string]string{"shop": shopFile, "blog": ""})
	list, err := r.m.Projects()
	if err != nil || len(list) != 2 {
		t.Fatalf("%+v %v", list, err)
	}
	blog, shop := list[0], list[1]
	if blog.Name != "blog" || blog.Path != "projects.d/blog.yaml" || blog.Apps+blog.Jobs != 0 ||
		shop.Name != "shop" || shop.Apps != 1 || shop.Jobs != 1 || shop.Databases != 0 || shop.Previews != 0 ||
		shop.Hash != config.Hash([]byte(shopFile)) || shop.AppliedHash != shop.Hash || shop.ModifiedAt.IsZero() {
		t.Errorf("%+v", list)
	}
	doc, err := r.m.ProjectDocument("shop")
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(doc.Content, "pw@db") || !strings.Contains(doc.Content, config.Hidden) || !strings.Contains(doc.Content, "# The shop.") ||
		doc.Hash != config.Hash([]byte(shopFile)) || doc.AppliedHash != doc.Hash || doc.ConfigHash != r.bundle().Hash() || doc.Error != "" || doc.Path != "projects.d/shop.yaml" {
		t.Errorf("%+v", doc)
	}
	if apps := doc.Model["apps"].([]any); len(apps) != 1 || apps[0].(map[string]any)["project"] != "shop" {
		t.Errorf("%+v", doc.Model)
	}
	if _, err := r.m.ProjectDocument("missing"); !errors.Is(err, store.ErrNotFound) {
		t.Errorf("%v", err)
	}
	if _, err := r.m.ProjectDocument("../apps"); !errors.Is(err, store.ErrNotFound) {
		t.Errorf("a name that is not a project name finds nothing: %v", err)
	}
}

func TestSaveProjectCreatesTheFileAppliesAndRecordsAVersion(t *testing.T) {
	r := projectRig(t, mainApps, nil)
	out, err := r.m.SaveProject("shop", []byte(shopFile), "", false, Meta{Source: store.SourceAPI, Actor: "dashboard", Comment: "new project"})
	if err != nil {
		t.Fatal(err)
	}
	if r.projectDisk("shop") != shopFile {
		t.Errorf("%s", r.projectDisk("shop"))
	}
	if out.FileHash != config.Hash([]byte(shopFile)) || out.Hash != r.bundle().Hash() || out.Version == 0 {
		t.Errorf("%+v", out)
	}
	if _, ok := r.m.Config().App("shop"); !ok || r.a.applied != 1 || r.b.applied != 1 {
		t.Error("applied to every applier")
	}
	if got, _ := r.m.Config().Job("shop-job"); got.Project != "shop" {
		t.Errorf("%+v", got)
	}
	v := r.recorded(out.Version)
	if b, err := config.DecodeBundle(v); err != nil || !b.Equal(r.bundle()) {
		t.Errorf("the version is the bundle: %v", err)
	}
	if fi, _ := os.Stat(r.projectPath("shop")); fi.Mode().Perm() != 0o640 {
		t.Errorf("the new file takes the permissions of the apps file: %v", fi.Mode())
	}

	// A second save is based on the file's hash.
	edited := strings.Replace(shopFile, "ghcr.io/me/shop", "ghcr.io/me/shop2", 1)
	if _, err := r.m.SaveProject("shop", []byte(edited), "stale", false, Meta{}); err == nil {
		t.Fatal("a stale hash is refused")
	} else {
		var c *ConflictError
		if !errors.As(err, &c) || c.Hash != config.Hash([]byte(shopFile)) {
			t.Errorf("the conflict says the file's hash: %v", err)
		}
	}
	if _, err := r.m.SaveProject("shop", []byte(edited), out.FileHash, false, Meta{Source: store.SourceAPI}); err != nil {
		t.Fatal(err)
	}
	if got, _ := r.m.Config().App("shop"); got.Image != "ghcr.io/me/shop2" || r.a.applied != 2 {
		t.Errorf("%+v", got)
	}
	// Another file changing does not conflict a save based on this file's hash.
	r2 := projectRig(t, mainApps, map[string]string{"shop": shopFile, "blog": blogFile})
	h := config.Hash([]byte(shopFile))
	if _, err := r2.m.SaveProject("blog", []byte(blogFile+"# x\n"), config.Hash([]byte(blogFile)), false, Meta{}); err != nil {
		t.Fatal(err)
	}
	if _, err := r2.m.SaveProject("shop", []byte(edited), h, false, Meta{}); err != nil {
		t.Errorf("each file has its own hash: %v", err)
	}
	// An empty file is a project with nothing in it yet.
	if _, err := r2.m.SaveProject("empty", nil, "", false, Meta{}); err != nil {
		t.Errorf("%v", err)
	}
	if _, err := os.Stat(r2.projectPath("empty")); err != nil {
		t.Error(err)
	}
	// Not a name.
	var invalid *InvalidError
	if _, err := r2.m.SaveProject("../evil", []byte(blogFile), "", false, Meta{}); !errors.As(err, &invalid) {
		t.Errorf("%v", err)
	}
}

func TestSaveProjectIsValidatedInTheContextOfTheOtherFiles(t *testing.T) {
	r := projectRig(t, mainApps, map[string]string{"shop": shopFile})
	before := r.bundle()
	for name, tc := range map[string]struct {
		project, content, path, message string
		line                            int
	}{
		"duplicate across files": {"blog", "apps:\n  - {name: web, image: o/dup}\n", "apps[web]", "duplicate name", 2},
		"unknown app":            {"shop", strings.Replace(shopFile, "container: {app: shop", "container: {app: ghost", 1), "jobs[shop-job]", `unknown app "ghost"`, 8},
		"server-wide section":    {"shop", shopFile + "proxy: {}\n", "proxy", "server-wide", 11},
		"other project":          {"shop", strings.Replace(shopFile, "    image: ghcr.io/me/shop\n", "    image: ghcr.io/me/shop\n    project: other\n", 1), "apps[shop]", "project is \"other\"", 3},
	} {
		_, err := r.m.SaveProject(tc.project, []byte(tc.content), "", false, Meta{})
		var invalid *InvalidError
		if !errors.As(err, &invalid) {
			t.Fatalf("%s: %v", name, err)
		}
		found := false
		for _, is := range invalid.Issues {
			if is.Path == tc.path && strings.Contains(is.Message, tc.message) && strings.HasPrefix(is.File, "projects.d/") && is.Line == tc.line {
				found = true
			}
		}
		if !found {
			t.Errorf("%s: %+v", name, invalid.Issues)
		}
		if !r.bundle().Equal(before) || r.a.applied != 0 {
			t.Fatalf("%s: a refused change writes and applies nothing", name)
		}
	}
}

func TestSaveProjectKeepsSecretsThatTheDocumentShowsHidden(t *testing.T) {
	r := projectRig(t, mainApps, map[string]string{"shop": shopFile})
	doc, _ := r.m.ProjectDocument("shop")
	edited := strings.Replace(doc.Content, "ghcr.io/me/shop", "ghcr.io/me/shop3", 1)
	issues, err := r.m.ValidateProject("shop", []byte(edited))
	if err != nil || hasErrors(issues) {
		t.Fatalf("%v %+v", err, issues)
	}
	if _, err := r.m.SaveProject("shop", []byte(edited), doc.Hash, false, Meta{Source: store.SourceAPI}); err != nil {
		t.Fatal(err)
	}
	got := r.projectDisk("shop")
	if !strings.Contains(got, "postgres://u:pw@db/shop") || strings.Contains(got, config.Hidden) || !strings.Contains(got, "shop3") {
		t.Errorf("%s", got)
	}
	// A hidden value with nothing stored is an error, not a literal "<hidden>".
	issues, _ = r.m.ValidateProject("blog", []byte("apps:\n  - {name: blog, image: o/blog, env: {TOKEN: '"+config.Hidden+"'}}\n"))
	if !hasErrors(issues) {
		t.Errorf("%+v", issues)
	}
	// Validation says what it would remove, and writes nothing.
	before := r.bundle()
	issues, err = r.m.ValidateProject("shop", []byte("apps: []\n"))
	if err != nil || hasErrors(issues) || len(blockingWarnings(issues)) == 0 || !r.bundle().Equal(before) {
		t.Errorf("%v %+v", err, issues)
	}
}

func TestMainDocumentSaveSeesTheProjectFiles(t *testing.T) {
	r := projectRig(t, mainApps, map[string]string{"shop": shopFile})
	d := r.document()
	// The apps file may call what a project file defines.
	edited := d.Content + "  - name: calls-shop\n    schedule: '@daily'\n    container: {app: shop, command: [y]}\n"
	if issues, err := r.m.Validate([]byte(edited)); err != nil || hasErrors(issues) {
		t.Fatalf("%v %+v", err, issues)
	}
	// Taking the same name as a project file's app is refused, at the apps file.
	dup := strings.Replace(d.Content, "apps:\n", "apps:\n  - {name: shop, image: o/x}\n", 1)
	issues, _ := r.m.Validate([]byte(dup))
	found := false
	for _, is := range issues {
		found = found || (is.Path == "apps[shop]" && is.File == "projects.d/shop.yaml" && is.Line == 3 && strings.Contains(is.Message, "first defined in apps.yaml, line 2"))
	}
	if !found {
		t.Errorf("%+v", issues)
	}
	out, err := r.m.Save([]byte(edited), d.Hash, false, Meta{Source: store.SourceAPI})
	if err != nil {
		t.Fatal(err)
	}
	if r.projectDisk("shop") != shopFile || out.Hash != r.bundle().Hash() {
		t.Error("the project files stay as they are")
	}
	// The base hash is the bundle's: a change to a project file since the read is a conflict.
	if _, err := r.m.SaveProject("shop", []byte(shopFile+"# x\n"), "", false, Meta{}); err != nil {
		t.Fatal(err)
	}
	if _, err := r.m.Save([]byte(edited+"# y\n"), out.Hash, false, Meta{}); err == nil {
		t.Error("the bundle hash covers the project files")
	}
}

func TestEntityEditsAreRoutedToTheFileThatHoldsThem(t *testing.T) {
	r := projectRig(t, mainApps, map[string]string{"shop": shopFile})
	d := r.document()
	out, err := r.m.EditBundle(d.Hash, false, Meta{Source: store.SourceAPI, Actor: "dashboard"}, func(b *config.Bundle) ([]config.Issue, error) {
		return b.SetJob("shop-job", map[string]any{"name": "shop-job", "schedule": "@hourly", "container": map[string]any{"app": "shop", "command": []any{"x"}}})
	})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(r.projectDisk("shop"), "@hourly") {
		t.Errorf("%s", r.projectDisk("shop"))
	}
	if disk, _ := os.ReadFile(r.path); string(disk) != mainApps {
		t.Errorf("the apps file is untouched:\n%s", disk)
	}
	if j, _ := r.m.Config().Job("shop-job"); j.Cron != "@hourly" || j.Project != "shop" {
		t.Errorf("%+v", j)
	}
	if out.Hash != r.bundle().Hash() || out.FileHash != "" {
		t.Errorf("%+v", out)
	}
	// New entity of a project that has a file: into it; without one: the apps file with the label.
	if _, err := r.m.EditBundle("", false, Meta{Source: store.SourceAPI}, func(b *config.Bundle) ([]config.Issue, error) {
		if _, err := b.SetJob("new-shop-job", map[string]any{"name": "new-shop-job", "project": "shop", "schedule": "@daily", "run": []any{"/bin/true"}}); err != nil {
			return nil, err
		}
		return b.SetJob("new-blog-job", map[string]any{"name": "new-blog-job", "project": "blog", "schedule": "@daily", "run": []any{"/bin/true"}})
	}); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(r.projectDisk("shop"), "new-shop-job") {
		t.Errorf("%s", r.projectDisk("shop"))
	}
	if disk, _ := os.ReadFile(r.path); !strings.Contains(string(disk), "new-blog-job") || !strings.Contains(string(disk), "project: blog") {
		t.Errorf("%s", disk)
	}
	// The single-document Edit still edits the apps file only (notifications).
	if _, err := r.m.Edit("", false, Meta{Source: store.SourceAPI}, func(disk []byte) ([]byte, []config.Issue, error) {
		return append(disk, []byte("# edited by hand\n")...), nil, nil
	}); err != nil {
		t.Fatal(err)
	}
	// The package-level EditBundle uses the manager's bundle edit, and the apps file alone for a service without it.
	if _, err := EditBundle(r.m, "", true, Meta{Source: store.SourceAPI}, func(b *config.Bundle) ([]config.Issue, error) { return nil, b.DeleteJob("new-shop-job") }); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(r.projectDisk("shop"), "new-shop-job") {
		t.Error("deleted from the project file")
	}
	var only singleOnly
	if _, err := EditBundle(&only, "", false, Meta{}, func(b *config.Bundle) ([]config.Issue, error) {
		if len(b.Projects) != 0 {
			t.Error("a service that cannot edit project files hands over the apps file alone")
		}
		return b.SetApp("x", map[string]any{"name": "x", "image": "o/x"})
	}); err != nil || !strings.Contains(string(only.disk), "name: x") {
		t.Errorf("%v %s", err, only.disk)
	}
}

type singleOnly struct{ disk []byte }

func (s *singleOnly) Edit(_ string, _ bool, _ Meta, edit func([]byte) ([]byte, []config.Issue, error)) (Outcome, error) {
	out, _, err := edit([]byte("apps: []\n"))
	s.disk = out
	return Outcome{}, err
}

func TestDeleteProjectAsksForAcknowledgementBeforeDroppingItsApps(t *testing.T) {
	r := projectRig(t, mainApps, map[string]string{"shop": shopFile, "blog": ""})
	_, err := r.m.DeleteProject("shop", "", false, Meta{Source: store.SourceAPI})
	var ack *NeedsAckError
	if !errors.As(err, &ack) {
		t.Fatalf("%v", err)
	}
	codes := map[string]bool{}
	for _, is := range ack.Issues {
		codes[is.Code] = true
	}
	if !codes[CodeAppRemoved] || !codes[CodeJobRemoved] {
		t.Errorf("%+v", ack.Issues)
	}
	if _, statErr := os.Stat(r.projectPath("shop")); statErr != nil || r.a.applied != 0 {
		t.Fatal("nothing is deleted without the acknowledgement")
	}
	if _, err := r.m.DeleteProject("shop", "stale", true, Meta{}); err == nil {
		t.Error("a stale file hash is a conflict, force or not")
	}
	out, err := r.m.DeleteProject("shop", config.Hash([]byte(shopFile)), true, Meta{Source: store.SourceAPI, Actor: "dashboard"})
	if err != nil {
		t.Fatal(err)
	}
	if _, statErr := os.Stat(r.projectPath("shop")); !os.IsNotExist(statErr) {
		t.Error("the file is removed")
	}
	if _, ok := r.m.Config().App("shop"); ok || out.FileHash != "" || out.Version == 0 {
		t.Errorf("%+v", out)
	}
	// A project with nothing in it goes without asking.
	if _, err := r.m.DeleteProject("blog", "", false, Meta{}); err != nil {
		t.Errorf("%v", err)
	}
	if _, err := r.m.DeleteProject("blog", "", false, Meta{}); !errors.Is(err, store.ErrNotFound) {
		t.Errorf("deleting what is not there: %v", err)
	}
	if _, err := r.m.DeleteProject("..", "", true, Meta{}); !errors.Is(err, store.ErrNotFound) {
		t.Errorf("%v", err)
	}
}

func TestVersionsAndRestoreCoverTheBundle(t *testing.T) {
	r := projectRig(t, mainApps, map[string]string{"shop": shopFile})
	first, _ := r.m.Versions(10)
	// Change a project file and the apps file, then add a project.
	if _, err := r.m.SaveProject("shop", []byte(strings.Replace(shopFile, "ghcr.io/me/shop", "ghcr.io/me/shop9", 1)), "", false, Meta{Source: store.SourceAPI}); err != nil {
		t.Fatal(err)
	}
	d := r.document()
	if _, err := r.m.Save([]byte(d.Content+"# main edit\n"), d.Hash, false, Meta{Source: store.SourceAPI}); err != nil {
		t.Fatal(err)
	}
	if _, err := r.m.SaveProject("empty", nil, "", false, Meta{Source: store.SourceAPI}); err != nil {
		t.Fatal(err)
	}
	versions, _ := r.m.Versions(10)
	if len(versions) != 4 {
		t.Fatalf("%+v", versions)
	}

	// The version shows the apps file's text, and the project files, with secrets hidden.
	_, content, err := r.m.Version(first[0].ID)
	if err != nil || content != mainApps {
		t.Errorf("%v\n%s", err, content)
	}
	files, err := r.m.VersionFiles(first[0].ID)
	if err != nil || len(files) != 1 || files[0].Project != "shop" || files[0].Path != "projects.d/shop.yaml" ||
		strings.Contains(files[0].Content, "pw@db") || !strings.Contains(files[0].Content, config.Hidden) || files[0].Hash != config.Hash([]byte(shopFile)) {
		t.Errorf("%+v %v", files, err)
	}
	if files, _ := r.m.VersionFiles(versions[0].ID); len(files) != 2 {
		t.Errorf("%+v", files)
	}
	if _, err := r.m.VersionFiles(9999); !errors.Is(err, store.ErrNotFound) {
		t.Errorf("%v", err)
	}

	// Restoring the first puts back every file, and removes the project that did not exist then.
	cur := r.bundle()
	out, err := r.m.RestoreVersion(first[0].ID, cur.Hash(), false, "operator")
	if err != nil {
		t.Fatal(err)
	}
	if r.projectDisk("shop") != shopFile {
		t.Errorf("the project file is back:\n%s", r.projectDisk("shop"))
	}
	if disk, _ := os.ReadFile(r.path); string(disk) != mainApps {
		t.Errorf("the apps file is back:\n%s", disk)
	}
	if _, err := os.Stat(r.projectPath("empty")); !os.IsNotExist(err) {
		t.Error("a project file the version did not have is removed")
	}
	if out.Hash != first[0].Hash || r.m.document().AppliedHash != first[0].Hash {
		t.Errorf("the hash of the restored version: %+v", out)
	}
	if v, _ := r.m.Versions(10); len(v) != 5 || v[0].Source != store.SourceRestore || !strings.Contains(v[0].Comment, "restored version") {
		t.Errorf("%+v", v)
	}
	if got, _ := r.m.Config().App("shop"); got.Image != "ghcr.io/me/shop" {
		t.Errorf("%+v", got)
	}
}

func (m *Manager) document() Document {
	d, err := m.Document()
	if err != nil {
		panic(err)
	}
	return d
}

func TestRestoringAVersionFromBeforeProjectFilesNeedsTheAcknowledgement(t *testing.T) {
	r := newRig(t, mainApps)
	v, _ := r.m.Versions(10)
	plain := v[0]
	// The project file is created by hand, picked up, and the old version is restored over it.
	os.MkdirAll(filepath.Dir(r.projectPath("shop")), 0o700)
	os.WriteFile(r.projectPath("shop"), []byte(shopFile), 0o640)
	r.m.checkFile()
	if _, ok := r.m.Config().App("shop"); !ok {
		t.Fatal("a project file made by hand is picked up")
	}
	_, err := r.m.RestoreVersion(plain.ID, "", false, "operator")
	var ack *NeedsAckError
	if !errors.As(err, &ack) {
		t.Fatalf("restoring removes the project's apps: %v", err)
	}
	if _, err := r.m.RestoreVersion(plain.ID, "", true, "operator"); err != nil {
		t.Fatal(err)
	}
	if _, statErr := os.Stat(r.projectPath("shop")); !os.IsNotExist(statErr) {
		t.Error("the project file is removed")
	}
	if disk, _ := os.ReadFile(r.path); string(disk) != mainApps {
		t.Errorf("%s", disk)
	}
	if v, _ := r.m.Versions(10); r.recorded(v[0].ID) != mainApps {
		t.Error("a configuration without project files is recorded as the apps file again")
	}
}

func TestHandEditOfAProjectFileIsPickedUp(t *testing.T) {
	r := projectRig(t, mainApps, map[string]string{"shop": shopFile})
	edited := strings.Replace(shopFile, "ghcr.io/me/shop", "ghcr.io/me/shop-hand", 1)
	os.WriteFile(r.projectPath("shop"), []byte(edited), 0o640)
	r.m.checkFile()
	if got, _ := r.m.Config().App("shop"); got.Image != "ghcr.io/me/shop-hand" || r.a.applied != 1 {
		t.Fatalf("%+v", got)
	}
	d := r.document()
	if d.Error != "" || d.Hash != d.AppliedHash || d.Hash != r.bundle().Hash() {
		t.Errorf("%+v", d)
	}
	v, _ := r.m.Versions(10)
	if v[0].Source != store.SourceFile || v[0].Hash != d.Hash {
		t.Errorf("%+v", v[0])
	}
	if b, err := config.DecodeBundle(r.recorded(v[0].ID)); err != nil || string(b.Projects["shop"]) != edited {
		t.Errorf("recorded with every file: %v", err)
	}
	r.m.checkFile()
	if r.a.applied != 1 {
		t.Error("an applied edit is not applied twice")
	}

	// A new project file made by hand, and a project file removed by hand (nothing in it).
	os.WriteFile(r.projectPath("empty"), nil, 0o640)
	r.m.checkFile()
	if r.a.applied != 2 {
		t.Error("a new empty project file is a change")
	}
	os.Remove(r.projectPath("empty"))
	r.m.checkFile()
	if r.a.applied != 3 {
		t.Error("removing it is a change")
	}
}

func TestInvalidProjectFileIsRefusedAsAWholeAndTheLastGoodStateKeepsRunning(t *testing.T) {
	r := projectRig(t, mainApps, map[string]string{"shop": shopFile})
	buf := logged(r)
	// The project file is broken and a change to the apps file is valid on its own: neither is applied.
	os.WriteFile(r.projectPath("shop"), []byte("apps:\n  - name: shop\n    image: ghcr.io/me/shop\n    bogus: 1\n"), 0o640)
	os.WriteFile(r.path, []byte(mainApps+"# valid change\n"), 0o640)
	r.m.checkFile()
	r.m.checkFile()
	if r.a.applied != 0 {
		t.Fatal("one invalid file refuses the whole state")
	}
	d := r.document()
	if !strings.Contains(d.Error, "projects.d/shop.yaml line 4") || !strings.Contains(d.Error, "bogus") {
		t.Errorf("the status names the file and line: %q", d.Error)
	}
	if d.Content != mainApps || d.AppliedHash == d.Hash {
		t.Errorf("the document shows what runs: %+v", d)
	}
	if n := strings.Count(buf.String(), "is invalid"); n != 1 {
		t.Errorf("reported once, got %d", n)
	}
	doc, err := r.m.ProjectDocument("shop")
	if err != nil || strings.Contains(doc.Content, "bogus") || !strings.Contains(doc.Error, "projects.d/shop.yaml line 4") || doc.Hash == doc.AppliedHash {
		t.Errorf("%+v %v", doc, err)
	}
	// Fixing the file applies the state, including the other file's valid change.
	os.WriteFile(r.projectPath("shop"), []byte(shopFile), 0o640)
	r.m.checkFile()
	if r.a.applied != 1 || r.document().Error != "" {
		t.Errorf("%+v", r.document())
	}
}

func TestAcknowledgementCoversTheBundle(t *testing.T) {
	r := projectRig(t, mainApps, map[string]string{"shop": shopFile, "blog": blogFile})
	os.Remove(r.projectPath("shop"))
	r.m.checkFile()
	if _, ok := r.m.Config().App("shop"); !ok || r.a.applied != 0 {
		t.Fatal("removing a project file with apps in it waits for an acknowledgement")
	}
	b := r.bundle()
	d := r.document()
	if !strings.Contains(d.Error, "app shop is removed") || !strings.Contains(d.Error, b.Hash()) || !strings.Contains(d.Error, "whole configuration") || !strings.Contains(d.Error, ".force") {
		t.Errorf("the status says how to acknowledge: %q", d.Error)
	}
	marker := r.path + ForceSuffix
	// The hash of the apps file alone is not the configuration's.
	os.WriteFile(marker, []byte(config.Hash([]byte(mainApps))), 0o600)
	r.m.checkFile()
	if r.a.applied != 0 {
		t.Fatal("the marker must hold the hash of the whole configuration")
	}
	os.WriteFile(marker, []byte(b.Hash()+"\n"), 0o600)
	r.m.checkFile()
	if _, ok := r.m.Config().App("shop"); ok || r.a.applied != 1 {
		t.Fatal("acknowledged")
	}
	if _, err := os.Stat(marker); !os.IsNotExist(err) {
		t.Error("consumed")
	}

	// A marker for one version does not cover a later edit of any file.
	r2 := projectRig(t, mainApps, map[string]string{"shop": shopFile, "blog": blogFile})
	os.Remove(r2.projectPath("shop"))
	r2.m.checkFile()
	os.WriteFile(r2.path+ForceSuffix, []byte(r2.bundle().Hash()), 0o600)
	os.WriteFile(r2.projectPath("blog"), []byte(blogFile+"# one more edit\n"), 0o640)
	r2.m.checkFile()
	if r2.a.applied != 0 {
		t.Error("an acknowledgement covers one version of the configuration")
	}
}

func TestSplitThroughTheManagerIsOneVersionAndTheConfigurationStaysTheSame(t *testing.T) {
	monolith := `apps:
  # The shop.
  - {name: shop, project: shop, image: ghcr.io/me/shop, env: {DATABASE_URL: "postgres://u:pw@db/shop"}}
  - {name: web, image: ghcr.io/me/web}
jobs:
  - {name: shop-job, schedule: "@daily", container: {app: shop, command: [x]}}
  - {name: backup, schedule: "@daily", run: [/bin/true]}
`
	r := newRig(t, monolith)
	before := r.m.Config()
	d := r.document()

	out, plan, err := r.m.SplitProject("shop", d.Hash, false, true, Meta{Source: store.SourceAPI})
	if err != nil || out.Hash != d.Hash || len(plan.Apps) != 1 || len(plan.Jobs) != 1 {
		t.Fatalf("dry run: %+v %+v %v", out, plan, err)
	}
	if r.disk() != monolith || r.a.prepared != 0 {
		t.Fatal("a dry run writes and applies nothing")
	}
	if _, _, err := r.m.SplitProject("shop", "stale", false, true, Meta{}); err == nil {
		t.Error("a dry run checks the base hash too")
	}

	versions, _ := r.m.Versions(10)
	out, plan, err = r.m.SplitProject("shop", d.Hash, false, false, Meta{Source: store.SourceAPI, Actor: "dashboard", Comment: "split shop"})
	if err != nil {
		t.Fatal(err)
	}
	if plan.File != "projects.d/shop.yaml" || out.FileHash != config.Hash([]byte(r.projectDisk("shop"))) {
		t.Errorf("%+v %+v", out, plan)
	}
	after, _ := r.m.Versions(10)
	if len(after) != len(versions)+1 || after[0].Source != store.SourceAPI || after[0].Comment != "split shop" || after[0].Hash != out.Hash {
		t.Errorf("one new version: %+v", after)
	}
	if r.a.applied != 1 || r.b.applied != 1 {
		t.Errorf("applied once: %d %d", r.a.applied, r.b.applied)
	}
	if strings.Contains(r.disk(), "shop") || !strings.Contains(r.projectDisk("shop"), "shop-job") || !strings.Contains(r.projectDisk("shop"), "# The shop.") {
		t.Errorf("main:\n%s\nproject:\n%s", r.disk(), r.projectDisk("shop"))
	}
	if !strings.Contains(r.projectDisk("shop"), "postgres://u:pw@db/shop") {
		t.Error("the secret moves as written")
	}
	now := r.m.Config()
	if len(now.Apps) != len(before.Apps) || len(now.Jobs) != len(before.Jobs) {
		t.Fatalf("what runs is the same: %d/%d apps, %d/%d jobs", len(now.Apps), len(before.Apps), len(now.Jobs), len(before.Jobs))
	}
	if a, _ := now.App("shop"); a.Image != "ghcr.io/me/shop" || a.Project != "shop" {
		t.Errorf("%+v", a)
	}
	if d := r.document(); d.Error != "" || d.Hash != d.AppliedHash || len(d.Files) != 2 {
		t.Errorf("%+v", d)
	}
	// Splitting again is refused: the project has its file.
	if _, _, err := r.m.SplitProject("shop", "", false, false, Meta{}); err == nil {
		t.Error("the project already has its file")
	}
	// The version holds the bundle, and restoring the one before the split restores the single file.
	if _, err := r.m.RestoreVersion(versions[0].ID, "", false, "operator"); err != nil {
		t.Fatal(err)
	}
	if r.disk() != monolith {
		t.Errorf("%s", r.disk())
	}
	if _, err := os.Stat(r.projectPath("shop")); !os.IsNotExist(err) {
		t.Error("the project file is removed again")
	}
}

func TestSplitRefusalsAreInvalidErrors(t *testing.T) {
	r := newRig(t, base)
	var invalid *InvalidError
	if _, _, err := r.m.SplitProject("ghost", "", false, false, Meta{}); !errors.As(err, &invalid) || !strings.Contains(invalid.Issues[0].Message, "nothing belongs") {
		t.Errorf("%v", err)
	}
	if _, _, err := r.m.SplitProject("ghost", "", false, true, Meta{}); !errors.As(err, &invalid) {
		t.Errorf("%v", err)
	}
	if r.disk() != base {
		t.Error("nothing is written")
	}
}

func TestStartupFallsBackAsAWholeWhenAProjectFileIsInvalid(t *testing.T) {
	r := projectRig(t, mainApps, map[string]string{"shop": shopFile})
	loc := config.DefaultLocation(r.path)
	os.WriteFile(loc.ProjectPath("shop"), []byte("apps: [\n"), 0o640)

	cfg, fb, err := ChooseAt(loc, r.st, nil)
	if err != nil || fb == nil || !strings.Contains(fb.Reason, "projects.d/shop.yaml") {
		t.Fatalf("%+v %v", fb, err)
	}
	if _, ok := cfg.App("shop"); !ok {
		t.Fatal("the last good configuration, with the project's apps")
	}
	m, err := NewFallbackAt(loc, r.st, fb, cfg, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err != nil {
		t.Fatal(err)
	}
	d, _ := m.Document()
	if !strings.HasPrefix(d.Error, "using version ") {
		t.Errorf("%+v", d)
	}
	if d.Content != mainApps || d.AppliedHash != fb.Version.Hash {
		t.Errorf("the document is of what runs: %+v", d)
	}
	if v, _ := m.Versions(10); len(v) != 1 {
		t.Error("no version is recorded for the file that was refused")
	}
	// A usable apps file with project files is chosen as it is.
	os.WriteFile(loc.ProjectPath("shop"), []byte(shopFile), 0o640)
	if _, fb, err := ChooseAt(loc, r.st, nil); err != nil || fb != nil {
		t.Errorf("%+v %v", fb, err)
	}
	// And Choose, the one-file form, reads the directory next to the file.
	if _, fb, err := Choose(r.path, r.st, nil); err != nil || fb != nil {
		t.Errorf("%+v %v", fb, err)
	}
}

func TestRestrictAppliesToProjectFiles(t *testing.T) {
	r := projectRig(t, mainApps, nil)
	r.m.Restrict(func(c *config.Config) []config.Issue {
		var out []config.Issue
		for _, a := range c.Apps {
			if a.Name == "forbidden" {
				out = append(out, config.Issue{Severity: config.SeverityError, Path: "apps[forbidden]", Message: "not on this machine"})
			}
		}
		return out
	})
	_, err := r.m.SaveProject("shop", []byte("apps:\n  - {name: forbidden, image: o/x}\n"), "", false, Meta{})
	var invalid *InvalidError
	if !errors.As(err, &invalid) || len(errorIssues(invalid.Issues)) == 0 || errorIssues(invalid.Issues)[0].Message != "not on this machine" {
		t.Errorf("%v", err)
	}
	if _, statErr := os.Stat(r.projectPath("shop")); !os.IsNotExist(statErr) {
		t.Error("nothing is written")
	}
	if issues, _ := r.m.ValidateProject("shop", []byte("apps:\n  - {name: forbidden, image: o/x}\n")); !hasErrors(issues) {
		t.Error("validation applies the same limits")
	}
}

func TestAnApplierThatRefusesStopsAProjectChangeBeforeAnythingIsWritten(t *testing.T) {
	r := projectRig(t, mainApps, nil)
	r.b.err = &BusyError{Reason: "a deployment is running"}
	_, err := r.m.SaveProject("shop", []byte(shopFile), "", false, Meta{})
	var busy *BusyError
	if !errors.As(err, &busy) {
		t.Fatalf("%v", err)
	}
	if _, statErr := os.Stat(r.projectPath("shop")); !os.IsNotExist(statErr) {
		t.Error("nothing is written when an applier refuses")
	}
}

func TestErrorTextNamesTheFileOnlyWhenThereIsOne(t *testing.T) {
	plain := errorText([]config.Issue{{Severity: config.SeverityError, Line: 3, Message: "bad"}, {Severity: config.SeverityWarning, Message: "ignored"}, {Severity: config.SeverityError, Message: "worse"}})
	if plain != "line 3: bad; worse" {
		t.Errorf("%q", plain)
	}
	multi := errorText([]config.Issue{{Severity: config.SeverityError, File: "projects.d/a.yaml", Line: 3, Message: "bad"}, {Severity: config.SeverityError, File: "apps.yaml", Message: "worse"}})
	if multi != "projects.d/a.yaml line 3: bad; apps.yaml: worse" {
		t.Errorf("%q", multi)
	}
}

// errorIssues are the errors among the issues (a legacy spelling in a fixture adds deprecation warnings).
func errorIssues(issues []config.Issue) []config.Issue {
	var out []config.Issue
	for _, is := range issues {
		if is.Severity == config.SeverityError {
			out = append(out, is)
		}
	}
	return out
}
