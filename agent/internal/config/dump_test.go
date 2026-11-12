package config

// The runtime baseline of the schema changes.
//
// testdata/legacy holds a copy of the docs/examples/*.apps.yaml (and a legacy builder) as written before the schema changes, and
// next to each the *.runtime.json that `keelson-agent config dump` (Config.RuntimeJSON) printed for it with the code of
// that time: what the file makes the agent run, as neutral JSON. TestLegacyExamplesRuntimeBaseline dumps every one of
// them again and compares: a change of the loader, of the defaults or of the schema that changes what a legacy file
// runs shows up as a diff of one of these files. The dump does not depend on the spelling of the YAML, so the same
// files must keep producing the same bytes after a rename of keys. The deltas that are intended are listed in
// docs/schema.md; a golden that has to change for one of them is regenerated and reviewed in the same
// commit as the change.
//
// Regenerate the goldens (after checking that the diff is an intended one):
//
//	go test ./internal/config -run TestLegacyExamplesRuntimeBaseline -update
//
// The legacy files themselves are never edited: they are the input of the baseline. The docs/examples copies are
// examples; coverage-*.apps.yaml (with its coverage-*.projects.d) are fixtures that add what no example has (managed
// databases, backup destinations, every kind of job and site, a project file) so that the baseline pins it too.

import (
	"bytes"
	"encoding/json"
	"flag"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

var update = flag.Bool("update", false, "rewrite the *.runtime.json goldens of testdata/legacy")

const legacyDir = "testdata/legacy"

func legacyExamples(t *testing.T) []string {
	t.Helper()
	files, err := filepath.Glob(filepath.Join(legacyDir, "*.apps.yaml"))
	if err != nil || len(files) == 0 {
		t.Fatalf("no legacy examples in %s: %v", legacyDir, err)
	}
	return files
}

// loadLegacyExample loads an example: the apps file, and the project files of <name>.projects.d next to it when there
// is such a directory (a server may have a projects.d next to its apps file).
func loadLegacyExample(example string) (*Config, error) {
	loc := Location{File: example, ProjectsDir: strings.TrimSuffix(example, ".apps.yaml") + ".projects.d"}
	return LoadFrom(loc)
}

func goldenPath(example string) string {
	return strings.TrimSuffix(example, ".apps.yaml") + ".runtime.json"
}

func TestLegacyExamplesRuntimeBaseline(t *testing.T) {
	for _, example := range legacyExamples(t) {
		t.Run(filepath.Base(example), func(t *testing.T) {
			c, err := loadLegacyExample(example)
			if err != nil {
				t.Fatal(err)
			}
			got, err := c.RuntimeJSON()
			if err != nil {
				t.Fatal(err)
			}
			golden := goldenPath(example)
			if *update {
				if err := os.WriteFile(golden, got, 0o644); err != nil {
					t.Fatal(err)
				}
				return
			}
			want, err := os.ReadFile(golden)
			if err != nil {
				t.Fatalf("%v (generate it with -update)", err)
			}
			if !bytes.Equal(got, want) {
				t.Errorf("%s: the runtime of this legacy example changed; if that is intended, review the diff and regenerate with -update\n%s",
					example, firstDifference(string(want), string(got)))
			}
		})
	}
}

// TestLegacyGoldensHaveAnExample catches a golden left behind when its example is gone.
func TestLegacyGoldensHaveAnExample(t *testing.T) {
	goldens, _ := filepath.Glob(filepath.Join(legacyDir, "*.runtime.json"))
	for _, g := range goldens {
		example := strings.TrimSuffix(g, ".runtime.json") + ".apps.yaml"
		if _, err := os.Stat(example); err != nil {
			t.Errorf("%s has no example %s", g, example)
		}
	}
}

// firstDifference names the first line that differs, with its neighbours, so a failure points at the field.
func firstDifference(want, got string) string {
	w, g := strings.Split(want, "\n"), strings.Split(got, "\n")
	for i := 0; i < len(w) || i < len(g); i++ {
		var wl, gl string
		if i < len(w) {
			wl = w[i]
		}
		if i < len(g) {
			gl = g[i]
		}
		if wl != gl {
			return "line " + itoa(i+1) + ":\n  golden: " + wl + "\n  now:    " + gl
		}
	}
	return "(no line differs)"
}

func itoa(n int) string { return strconv.Itoa(n) }

// secretsSource carries a secret in every place the dump could leak one.
const secretsSource = `
registries:
  - {host: ghcr.io, username: bot, password_file: /etc/keelson/ghcr}
proxy: {}
notifications:
  name: prod
  webhooks:
    - {url: "https://hooks.example.com/SECRETWEBHOOKPATH?key=SECRETWEBHOOKQUERY"}
  heartbeat: {url: "https://hc-ping.com/SECRETHEARTBEATUUID"}
apps:
  - name: web
    image: ghcr.io/acme/web
    domains: [web.example.com]
    port: 3000
    env:
      DATABASE_URL: "postgres://app:SECRETENVPASSWORD@db/app"
      PLAIN: SECRETPLAINVALUE
    command: [serve, "--api-token", SECRETARGVFLAGVALUE, "--secret=SECRETARGVEQUALS", "API_KEY=SECRETARGVKEY", --port, "8080"]
    release:
      steps:
        - {name: migrate, command: [migrate, "DB_PASSWORD=SECRETSTEPPASSWORD"]}
    build:
      args: {NPM_TOKEN: SECRETBUILDARG, NODE_ENV: production}
  - name: api
    image: ghcr.io/acme/api
jobs:
  - name: ping
    schedule: "@hourly"
    http:
      url: "https://web.example.com/cron?token=SECRETJOBURLQUERY"
      headers: {X-Auth: SECRETJOBHEADER}
      body: '{"key":"SECRETJOBBODY"}'
previews:
  - app: web
    domain: "pr-{pr}-web.example.com"
    env: {PREVIEW_KEY: SECRETPREVIEWENV}
`

func TestRuntimeJSONHidesEverySecretAndKeepsTheNames(t *testing.T) {
	c, issues := Parse([]byte(secretsSource))
	if c == nil {
		t.Fatalf("%+v", issues)
	}
	out, err := c.RuntimeJSON()
	if err != nil {
		t.Fatal(err)
	}
	text := string(out)
	if strings.Contains(text, "SECRET") {
		for _, line := range strings.Split(text, "\n") {
			if strings.Contains(line, "SECRET") {
				t.Errorf("a secret leaked: %s", strings.TrimSpace(line))
			}
		}
	}
	for _, kept := range []string{
		`"DATABASE_URL": "<hidden>"`, `"PLAIN": "<hidden>"`, `"PREVIEW_KEY": "<hidden>"`, `"X-Auth": "<hidden>"`,
		`"NPM_TOKEN": "<hidden>"`, `"NODE_ENV": "production"`, `"url": "https://web.example.com/cron?<hidden>"`,
		`"--api-token"`, `"--secret=<hidden>"`, `"API_KEY=<hidden>"`, `"DB_PASSWORD=<hidden>"`, `"--port"`, `"8080"`,
		`"password_file": "/etc/keelson/ghcr"`,
	} {
		if !strings.Contains(text, kept) {
			t.Errorf("%s is missing from the dump", kept)
		}
	}
}

func TestRuntimeJSONIsDeterministicAndIgnoresOrderAndSpelling(t *testing.T) {
	dump := func(src string) string {
		t.Helper()
		c, issues := Parse([]byte(src))
		if c == nil {
			t.Fatalf("%+v", issues)
		}
		out, err := c.RuntimeJSON()
		if err != nil {
			t.Fatal(err)
		}
		return string(out)
	}

	// The same text twice, and the same configuration written in another order and in flow and block style.
	if a, b := dump(secretsSource), dump(secretsSource); a != b {
		t.Fatal("two dumps of one configuration differ")
	}
	const one = `
apps:
  - {name: b, image: ghcr.io/acme/b, env: {Z: "1", A: "2"}}
  - name: a
    image: ghcr.io/acme/a
    restart: unless-stopped
    log: {max_size: 10m, max_file: 3}
jobs:
  - {name: y, schedule: "@daily", run: [/bin/true]}
  - {name: x, schedule: "@daily", run: [/bin/true]}
`
	const other = `
jobs:
  - name: x
    schedule: "@daily"
    run: [/bin/true]
  - name: y
    schedule: "@daily"
    run: [/bin/true]
apps:
  - name: a
    image: ghcr.io/acme/a
  - name: b
    image: ghcr.io/acme/b
    env:
      A: "2"
      Z: "1"
`
	// Settings written out at their default value are the same runtime as settings left out.
	if a, b := dump(one), dump(other); a != b {
		t.Errorf("order and YAML spelling changed the dump:\n%s", firstDifference(a, b))
	}
}

func TestRuntimeJSONShapeIsStable(t *testing.T) {
	c, issues := Parse([]byte("apps: []\n"))
	if c == nil {
		t.Fatalf("%+v", issues)
	}
	out, err := c.RuntimeJSON()
	if err != nil {
		t.Fatal(err)
	}
	var m map[string]any
	if err := json.Unmarshal(out, &m); err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{"dump_format", "apps", "jobs", "databases", "previews", "registries", "proxy", "notifications", "managed_postgres"} {
		if _, ok := m[key]; !ok {
			t.Errorf("%q is missing: an empty configuration still dumps every section", key)
		}
	}
	if !bytes.HasSuffix(out, []byte("}\n")) {
		t.Error("the dump ends with a newline")
	}
	for _, list := range []string{"apps", "jobs", "databases", "previews", "registries"} {
		if _, ok := m[list].([]any); !ok {
			t.Errorf("%s is %T, an empty list is []", list, m[list])
		}
	}
}
