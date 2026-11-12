package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func validateDir(t *testing.T, apps string, projects map[string]string) string {
	t.Helper()
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "apps.yaml"), []byte(apps), 0o640); err != nil {
		t.Fatal(err)
	}
	for name, content := range projects {
		if err := os.MkdirAll(filepath.Join(dir, "projects.d"), 0o750); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dir, "projects.d", name+".yaml"), []byte(content), 0o640); err != nil {
			t.Fatal(err)
		}
	}
	return dir
}

func exitCode(err error) int {
	var e *exitError
	if errors.As(err, &e) {
		return e.code
	}
	if err != nil {
		return -1
	}
	return 0
}

func TestConfigValidateAcceptsAValidConfigurationAndCountsWhatItRuns(t *testing.T) {
	dir := validateDir(t, "apps:\n  - {name: web, image: ghcr.io/acme/web}\n", map[string]string{
		"shop": "apps:\n  - {name: shop, image: ghcr.io/acme/shop}\n",
	})
	var out bytes.Buffer
	if err := configValidate([]string{"--apps", filepath.Join(dir, "apps.yaml")}, &out); err != nil {
		t.Fatalf("%v\n%s", err, out.String())
	}
	if got := strings.TrimSpace(out.String()); got != "valid: 2 apps, 0 jobs, 0 databases" {
		t.Errorf("summary: %q", got)
	}
}

func TestConfigValidateNamesTheFileAndLineOfEachErrorAndExitsOne(t *testing.T) {
	dir := validateDir(t, "apps:\n  - {name: web, image: ghcr.io/acme/web}\n  - {name: web, image: ghcr.io/acme/other}\n", map[string]string{
		"shop": "apps:\n  - name: shop\n    image: ghcr.io/acme/shop\n    helth_path: /x\n",
	})
	apps := filepath.Join(dir, "apps.yaml")
	var out bytes.Buffer
	err := configValidate([]string{"--apps", apps}, &out)
	if exitCode(err) != 1 {
		t.Fatalf("an invalid configuration exits 1, got %v", err)
	}
	for _, want := range []string{
		apps + ":3: error: app \"web\": duplicate name",
		filepath.Join(dir, "projects.d", "shop.yaml") + ":4: error: unknown key \"helth_path\"",
		"invalid: 2 errors, 0 warnings",
	} {
		if !strings.Contains(out.String(), want) {
			t.Errorf("%q missing:\n%s", want, out.String())
		}
	}
	if strings.Contains(out.String(), "(apps[web])") {
		t.Errorf("a message that names the app does not repeat it:\n%s", out.String())
	}
}

func TestConfigValidateWarningsFailOnlyWithStrict(t *testing.T) {
	dir := validateDir(t, "apps:\n  - {name: web, image: ghcr.io/acme/web, keep_images: 0}\n", nil)
	apps := filepath.Join(dir, "apps.yaml")

	var out bytes.Buffer
	if err := configValidate([]string{"--apps", apps}, &out); err != nil {
		t.Fatalf("a deprecated key is a warning, not a failure: %v\n%s", err, out.String())
	}
	if !strings.Contains(out.String(), apps+":2: warning: keep_images") || !strings.Contains(out.String(), "valid: 1 app, 0 jobs, 0 databases, 1 warning") {
		t.Errorf("the warning must be reported with its line:\n%s", out.String())
	}

	out.Reset()
	if err := configValidate([]string{"--apps", apps, "--strict"}, &out); exitCode(err) != 1 {
		t.Fatalf("--strict must refuse a warning, got %v\n%s", err, out.String())
	}
}

func TestConfigValidateJSONAndGitHubFormats(t *testing.T) {
	dir := validateDir(t, "apps:\n  - {name: web, image: ghcr.io/acme/web, helth_path: /x}\n", nil)
	apps := filepath.Join(dir, "apps.yaml")

	var out bytes.Buffer
	if err := configValidate([]string{"--apps", apps, "--format", "json"}, &out); exitCode(err) != 1 {
		t.Fatalf("json output keeps the exit code: %v", err)
	}
	var got struct {
		Valid  bool `json:"valid"`
		Issues []struct {
			Severity, File string
			Line           int
		}
	}
	if err := json.Unmarshal(out.Bytes(), &got); err != nil {
		t.Fatalf("%v\n%s", err, out.String())
	}
	if got.Valid || len(got.Issues) != 1 || got.Issues[0].Line != 2 || got.Issues[0].Severity != "error" {
		t.Errorf("json: %+v", got)
	}

	out.Reset()
	configValidate([]string{"--apps", apps, "--format", "github"}, &out)
	if want := "::error file=" + apps + ",line=2::unknown key"; !strings.HasPrefix(out.String(), want) {
		t.Errorf("github annotation: %q, want it to start with %q", out.String(), want)
	}

	out.Reset()
	ok := validateDir(t, "apps:\n  - {name: web, image: ghcr.io/acme/web}\n", nil)
	if err := configValidate([]string{"--apps", filepath.Join(ok, "apps.yaml"), "--format", "json"}, &out); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out.String(), `"valid": true`) || !strings.Contains(out.String(), `"issues": []`) {
		t.Errorf("a valid configuration has an empty list of issues, not null:\n%s", out.String())
	}
}

func TestConfigValidateExitsTwoForUsageAndUnreadableFiles(t *testing.T) {
	for name, args := range map[string][]string{
		"no file":        {},
		"unknown format": {"--apps", "x.yaml", "--format", "xml"},
		"unknown flag":   {"--apps", "x.yaml", "--nope"},
		"missing file":   {"--apps", filepath.Join(t.TempDir(), "absent.yaml")},
	} {
		var out bytes.Buffer
		if c := exitCode(configValidate(args, &out)); c != 2 {
			t.Errorf("%s: exit %d, want 2", name, c)
		}
	}
}
