package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func layout(t *testing.T, main string, projects map[string]string) Location {
	t.Helper()
	dir := t.TempDir()
	loc := DefaultLocation(filepath.Join(dir, "apps.yaml"))
	if err := os.WriteFile(loc.File, []byte(main), 0o640); err != nil {
		t.Fatal(err)
	}
	for n, c := range projects {
		if err := os.MkdirAll(loc.ProjectsDir, 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(loc.ProjectPath(n), []byte(c), 0o640); err != nil {
			t.Fatal(err)
		}
	}
	return loc
}

func TestDefaultLocationIsProjectsDNextToTheAppsFile(t *testing.T) {
	loc := DefaultLocation("/etc/keelson/config/apps.yaml")
	if loc.ProjectsDir != "/etc/keelson/config/projects.d" || loc.ProjectPath("shop") != "/etc/keelson/config/projects.d/shop.yaml" {
		t.Errorf("%+v", loc)
	}
}

func TestReadWithoutAProjectsDirectoryIsTheAppsFileAlone(t *testing.T) {
	loc := layout(t, mainDoc, nil)
	b, err := loc.Read()
	if err != nil || string(b.Main) != mainDoc || len(b.Projects) != 0 || b.Hash() != Hash([]byte(mainDoc)) {
		t.Errorf("%+v %v", b, err)
	}
	// An empty directory is the same.
	if err := os.MkdirAll(loc.ProjectsDir, 0o700); err != nil {
		t.Fatal(err)
	}
	if b, err = loc.Read(); err != nil || len(b.Projects) != 0 || b.Hash() != Hash([]byte(mainDoc)) {
		t.Errorf("%+v %v", b, err)
	}
	// A configuration that names no directory reads none.
	b, err = Location{File: loc.File}.Read()
	if err != nil || len(b.Projects) != 0 {
		t.Errorf("%+v %v", b, err)
	}
	if _, err := (Location{File: filepath.Join(t.TempDir(), "missing.yaml")}).Read(); !os.IsNotExist(err) {
		t.Errorf("a missing apps file is an error: %v", err)
	}
}

func TestReadTakesProjectFilesAndIgnoresWhatIsNotOne(t *testing.T) {
	loc := layout(t, mainDoc, map[string]string{"shop": shopDoc, "blog": "apps: []\n"})
	for name, content := range map[string]string{
		".shop.yaml-123": "half a write",
		"README.md":      "notes",
		"shop.yaml.bak":  "backup",
	} {
		os.WriteFile(filepath.Join(loc.ProjectsDir, name), []byte(content), 0o640)
	}
	os.Mkdir(filepath.Join(loc.ProjectsDir, "nested.yaml"), 0o700)
	os.WriteFile(filepath.Join(loc.ProjectsDir, "old.yml"), []byte("apps: []\n"), 0o640)

	b, err := loc.Read()
	if err != nil {
		t.Fatal(err)
	}
	if got := b.ProjectNames(); len(got) != 2 || got[0] != "blog" || got[1] != "shop" {
		t.Errorf("%v", got)
	}
	if string(b.Projects["shop"]) != shopDoc || b.MainName != "apps.yaml" {
		t.Errorf("%+v", b)
	}
	if len(b.Strays) != 1 || b.Strays[0] != "old.yml" {
		t.Errorf("a .yml file is reported, not read: %v", b.Strays)
	}
	if c, issues := ParseBundle(b); c != nil || len(errorsOnly(issues)) != 1 || errorsOnly(issues)[0].File != "projects.d/old.yml" {
		t.Errorf("%+v", issues)
	}
}

func TestLoadFromReadsAndValidatesTheWholeConfiguration(t *testing.T) {
	loc := layout(t, mainDoc, map[string]string{"shop": shopDoc})
	c, err := LoadFrom(loc)
	if err != nil || len(c.Apps) != 2 {
		t.Fatalf("%+v %v", c, err)
	}
	os.WriteFile(loc.ProjectPath("shop"), []byte("apps:\n  - {name: web, image: o/x}\n"), 0o640)
	if _, err := LoadFrom(loc); err == nil || !strings.Contains(err.Error(), loc.File) || !strings.Contains(err.Error(), "duplicate name") {
		t.Errorf("%v", err)
	}
	// Load, the one-file form, is as it was: it never reads a directory.
	if c, err := Load(loc.File); err != nil || len(c.Apps) != 1 {
		t.Errorf("%v", err)
	}
}

func TestWriteReplacesOnlyWhatChangedAndCreatesTheDirectory(t *testing.T) {
	loc := layout(t, mainDoc, nil)
	old, _ := loc.Read()
	next := old.Clone()
	next.SetContent("shop", []byte(shopDoc))
	if err := loc.Write(old, next); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(loc.ProjectsDir)
	if err != nil || info.Mode().Perm() != 0o700 {
		t.Errorf("the directory is private: %v %v", info, err)
	}
	fi, err := os.Stat(loc.ProjectPath("shop"))
	if err != nil || fi.Mode().Perm() != 0o640 {
		t.Errorf("a new project file takes the permissions of the apps file: %v %v", fi, err)
	}
	got, _ := loc.Read()
	if !got.Equal(next) {
		t.Error("written as given")
	}
	mainInfo, _ := os.Stat(loc.File)

	// Change one project file and remove another; the apps file is not rewritten.
	again := got.Clone()
	again.SetContent("shop", []byte(shopDoc+"# more\n"))
	again.SetContent("blog", []byte("apps: []\n"))
	if err := loc.Write(got, again); err != nil {
		t.Fatal(err)
	}
	if st, _ := os.Stat(loc.File); !st.ModTime().Equal(mainInfo.ModTime()) {
		t.Error("an unchanged apps file is not written")
	}
	gone := again.Clone()
	delete(gone.Projects, "blog")
	if err := loc.Write(again, gone); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(loc.ProjectPath("blog")); !os.IsNotExist(err) {
		t.Errorf("the file of a removed project goes: %v", err)
	}
	if entries, _ := os.ReadDir(loc.ProjectsDir); len(entries) != 1 {
		t.Errorf("no temporary file is left behind: %v", entries)
	}
}

func TestWriteFailurePutsEveryFileBack(t *testing.T) {
	loc := layout(t, mainDoc, map[string]string{"alpha": "apps: []\n"})
	old, _ := loc.Read()
	// The path of "zeta" is a directory, so replacing it fails after "alpha" and the apps file were written.
	if err := os.Mkdir(loc.ProjectPath("zeta"), 0o700); err != nil {
		t.Fatal(err)
	}
	next := old.Clone()
	next.Main = []byte(mainDoc + "# changed\n")
	next.SetContent("alpha", []byte("apps: []\n# changed\n"))
	next.SetContent("zeta", []byte("apps: []\n"))
	if err := loc.Write(old, next); err == nil {
		t.Fatal("the write must fail")
	}
	if b, _ := os.ReadFile(loc.File); string(b) != mainDoc {
		t.Errorf("the apps file is back:\n%s", b)
	}
	if b, _ := os.ReadFile(loc.ProjectPath("alpha")); string(b) != "apps: []\n" {
		t.Errorf("alpha is back:\n%s", b)
	}
}

func TestWriteOrderLeavesDuplicatesNotLossesIfItStopsHalfway(t *testing.T) {
	// A split writes the new project file first: with only that on disk the entity is defined twice, which no
	// configuration accepts, rather than gone, which would be taken for a deliberate removal.
	b := mk(monolith, nil)
	next, _, err := b.SplitProject("shop")
	if err != nil {
		t.Fatal(err)
	}
	halfway := b.Clone()
	halfway.SetContent("shop", next.Projects["shop"])
	c, issues := ParseBundle(halfway)
	if c != nil || len(errorsOf(issues)) == 0 {
		t.Fatal("the first step of a split is refused as a whole")
	}
	dup := false
	for _, is := range issues {
		dup = dup || strings.Contains(is.Message, "duplicate name")
	}
	if !dup {
		t.Errorf("the entries defined twice are named: %+v", issues)
	}
}
