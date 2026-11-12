package main

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/0x2u/keelson/agent/internal/config"
)

const splitSource = `# Server.
apps:
  # The shop.
  - {name: shop, project: shop, image: ghcr.io/me/shop}
  - {name: web, image: ghcr.io/me/web}
jobs:
  - {name: shop-job, schedule: "@daily", container: {app: shop, command: [x]}}
  - {name: report, schedule: "@daily", run: [/bin/true]}
`

func splitDir(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "apps.yaml"), []byte(splitSource), 0o640); err != nil {
		t.Fatal(err)
	}
	return dir
}

func TestConfigSplitDryRunSaysWhatMovesAndWritesNothing(t *testing.T) {
	dir := splitDir(t)
	var out bytes.Buffer
	if err := configSplit([]string{"--apps", filepath.Join(dir, "apps.yaml"), "--project", "shop", "--dry-run"}, &out); err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"would move into projects.d/shop.yaml", "app shop", "job shop-job", "nothing was changed"} {
		if !strings.Contains(out.String(), want) {
			t.Errorf("%q missing:\n%s", want, out.String())
		}
	}
	if strings.Contains(out.String(), "web") || strings.Contains(out.String(), "report") {
		t.Errorf("only the project's entries are listed:\n%s", out.String())
	}
	if b, _ := os.ReadFile(filepath.Join(dir, "apps.yaml")); string(b) != splitSource {
		t.Error("a dry run changes nothing")
	}
	if _, err := os.Stat(filepath.Join(dir, "projects.d")); !os.IsNotExist(err) {
		t.Error("a dry run creates nothing")
	}
}

func TestConfigSplitWritesTheProjectFileAndTheConfigurationRunsTheSame(t *testing.T) {
	dir := splitDir(t)
	apps := filepath.Join(dir, "apps.yaml")
	before, err := config.Load(apps)
	if err != nil {
		t.Fatal(err)
	}
	var out bytes.Buffer
	if err := configSplit([]string{"--apps", apps, "--project", "shop"}, &out); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out.String(), "moved into projects.d/shop.yaml") || !strings.Contains(out.String(), "written") {
		t.Errorf("%s", out.String())
	}
	project, err := os.ReadFile(filepath.Join(dir, "projects.d", "shop.yaml"))
	if err != nil || !strings.Contains(string(project), "# The shop.") || !strings.Contains(string(project), "shop-job") {
		t.Errorf("%v\n%s", err, project)
	}
	if main, _ := os.ReadFile(apps); strings.Contains(string(main), "shop") || !strings.Contains(string(main), "# Server.") {
		t.Errorf("%s", main)
	}
	after, err := config.LoadFrom(config.DefaultLocation(apps))
	if err != nil || config.Equivalent(before, after, "shop") != nil || len(after.Apps) != len(before.Apps) {
		t.Errorf("%v", err)
	}

	// Again: the project has its file.
	if err := configSplit([]string{"--apps", apps, "--project", "shop"}, &out); err == nil || !strings.Contains(err.Error(), "already exists") {
		t.Errorf("%v", err)
	}
}

func TestConfigSplitHonoursTheProjectsDirectoryFlagAndRefusesNonsense(t *testing.T) {
	dir := splitDir(t)
	apps := filepath.Join(dir, "apps.yaml")
	elsewhere := filepath.Join(t.TempDir(), "per-project")
	if err := configSplit([]string{"--apps", apps, "--projects-dir", elsewhere, "--project", "shop"}, &bytes.Buffer{}); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(elsewhere, "shop.yaml")); err != nil {
		t.Error(err)
	}
	if _, err := os.Stat(filepath.Join(dir, "projects.d")); !os.IsNotExist(err) {
		t.Error("the default directory is not used")
	}
	for _, args := range [][]string{
		{"--apps", apps},
		{"--project", "shop"},
		{"--apps", apps, "--project", "ghost"},
		{"--apps", apps, "--project", "Not A Name"},
		{"--apps", apps, "--project", "shop", "extra"},
	} {
		if err := configSplit(args, &bytes.Buffer{}); err == nil {
			t.Errorf("%v must be refused", args)
		}
	}
	if err := configCmd(t.Context(), nil); err == nil || !strings.Contains(err.Error(), "usage") {
		t.Errorf("%v", err)
	}
	if err := configCmd(t.Context(), []string{"merge"}); err == nil {
		t.Error("unknown subcommand")
	}
}

func TestLocationDefaultsToProjectsDNextToTheAppsFile(t *testing.T) {
	if loc := location("/etc/keelson/config/apps.yaml", ""); loc.File != "/etc/keelson/config/apps.yaml" || loc.ProjectsDir != "/etc/keelson/config/projects.d" {
		t.Errorf("%+v", loc)
	}
	if loc := location("/etc/keelson/config/apps.yaml", "/srv/projects"); loc.ProjectsDir != "/srv/projects" {
		t.Errorf("%+v", loc)
	}
}

func TestConfigDumpPrintsTheRuntimeOfTheAppsFileAndItsProjectFiles(t *testing.T) {
	dir := splitDir(t)
	apps := filepath.Join(dir, "apps.yaml")
	var plain bytes.Buffer
	if err := configDump([]string{"--apps", apps}, &plain); err != nil {
		t.Fatal(err)
	}
	cfg, err := config.Load(apps)
	if err != nil {
		t.Fatal(err)
	}
	want, err := cfg.RuntimeJSON()
	if err != nil {
		t.Fatal(err)
	}
	if plain.String() != string(want) {
		t.Errorf("config dump prints RuntimeJSON:\n%s", plain.String())
	}

	// A project file's entries are part of the dump, wherever the directory is.
	projects := filepath.Join(dir, "projects.d")
	if err := os.MkdirAll(projects, 0o750); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(projects, "blog.yaml"), []byte("apps:\n  - {name: blog, image: ghcr.io/me/blog}\n"), 0o640); err != nil {
		t.Fatal(err)
	}
	var withProject, viaDir bytes.Buffer
	if err := configDump([]string{"--apps", apps}, &withProject); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(withProject.String(), `"name": "blog"`) || withProject.String() == plain.String() {
		t.Errorf("the project file's app is in the dump:\n%s", withProject.String())
	}
	if err := configDump([]string{"--apps", apps, "--projects-dir", projects}, &viaDir); err != nil || viaDir.String() != withProject.String() {
		t.Errorf("--projects-dir names the same directory: %v", err)
	}
}

func TestConfigDumpNeedsTheAppsFileAndRefusesAnInvalidOne(t *testing.T) {
	var out bytes.Buffer
	if err := configDump(nil, &out); err == nil || !strings.Contains(err.Error(), "usage") {
		t.Errorf("no --apps is a usage error: %v", err)
	}
	bad := filepath.Join(t.TempDir(), "apps.yaml")
	if err := os.WriteFile(bad, []byte("apps:\n  - {name: Web}\n"), 0o640); err != nil {
		t.Fatal(err)
	}
	if err := configDump([]string{"--apps", bad}, &out); err == nil || out.Len() != 0 {
		t.Errorf("an invalid file prints nothing and fails: %v %q", err, out.String())
	}
}
