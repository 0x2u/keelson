package build

import (
	"bytes"
	"encoding/json"
	"fmt"
	"slices"
	"strings"

	"github.com/0x2u/keelson/agent/internal/config"
)

// contextFile is a file the agent adds to the build context.
type contextFile struct {
	Name string
	Data []byte
}

// presetInput is everything a preset's Dockerfile depends on.
type presetInput struct {
	// Build is the app's build block (defaults applied, so its preset options are valid).
	Build *config.Build
	// Port is the app's port; HealthPath its health_path, which the image's HEALTHCHECK follows.
	Port       int
	HealthPath string
	// Args are the names of the build arguments: the generated Dockerfile declares them for the build stage.
	Args []string
	// Root holds the names at the top of the build context, files and directories alike.
	Root map[string]bool
}

// ignoreFile is the .dockerignore the agent adds when the repository has none.
const (
	ignoreName = ".dockerignore"
	ignoreBody = ".git\n.next\nnode_modules\n**/node_modules\n"
)

// packageManager is the Node.js package manager of a project, told by its lockfile.
type packageManager struct {
	name string
	// lockfile is the file that tells it ("" for none).
	lockfile string
	// install is the default install command.
	install string
	// run runs a package.json script; exec runs a binary of node_modules.
	run, exec string
}

var (
	pnpm = packageManager{"pnpm", "pnpm-lock.yaml", "pnpm install --frozen-lockfile", "pnpm run ", "pnpm exec "}
	yarn = packageManager{"yarn", "yarn.lock", "yarn install --frozen-lockfile", "yarn run ", "yarn "}
	npm  = packageManager{"npm", "package-lock.json", "npm ci", "npm run ", "npm exec -- "}
	// npmNoLock is npm for a project without a lockfile.
	npmNoLock = packageManager{"npm", "", "npm install", "npm run ", "npm exec -- "}
)

func detectPackageManager(root map[string]bool) packageManager {
	for _, pm := range []packageManager{pnpm, yarn, npm} {
		if root[pm.lockfile] {
			return pm
		}
	}
	return npmNoLock
}

// corepack is the packages managers pnpm and yarn come through: Node.js images ship it (not the newest ones, hence the
// fallback), and it picks the version package.json's packageManager field names.
const corepackSetup = "command -v corepack >/dev/null 2>&1 || npm install -g corepack; corepack enable"

// presetFiles returns the files to add to the build context for the app's preset: the Dockerfile, and a .dockerignore
// unless the repository has one.
func presetFiles(in presetInput) ([]contextFile, error) {
	dockerfile, err := in.dockerfile()
	if err != nil {
		return nil, err
	}
	files := []contextFile{{Name: config.PresetDockerfile, Data: []byte(dockerfile)}}
	if !in.Root[ignoreName] {
		files = append(files, contextFile{Name: ignoreName, Data: []byte(ignoreBody)})
	}
	return files, nil
}

func (in presetInput) port() int { return config.PresetPort(in.Build.Preset, in.Port) }

func (in presetInput) dockerfile() (string, error) {
	b := in.Build
	pm := detectPackageManager(in.Root)
	if b.Preset != config.PresetStatic && !in.Root["package.json"] {
		return "", archiveErr("the %s preset needs a package.json at the root of the build context (context: %q)", b.Preset, b.Context)
	}
	var d dockerfileWriter
	if b.HasBuildStage() {
		in.buildStage(&d, pm)
	}
	switch b.Preset {
	case config.PresetNextJS:
		in.nextRunner(&d, pm)
	case config.PresetNode:
		in.nodeRunner(&d, pm)
	default:
		in.nginxRunner(&d)
	}
	return d.String(), nil
}

// buildStage installs the dependencies and builds the project. The manifests are copied first, so the install layer is
// reused while they do not change.
func (in presetInput) buildStage(d *dockerfileWriter, pm packageManager) {
	b := in.Build
	d.line("FROM node:%s-alpine AS build", b.Node)
	if b.Preset == config.PresetNextJS {
		d.line("ENV NEXT_TELEMETRY_DISABLED=1")
	}
	usesCorepack := pm.name != "npm"
	if usesCorepack {
		d.line("ENV COREPACK_HOME=%s COREPACK_ENABLE_DOWNLOAD_PROMPT=0", corepackHome)
		d.run(corepackSetup)
	}
	d.line("WORKDIR /app")
	if in.Root["package.json"] {
		manifests := []string{"package.json"}
		if pm.lockfile != "" {
			manifests = append(manifests, pm.lockfile)
		}
		for _, name := range []string{".npmrc", ".yarnrc", ".yarnrc.yml", "pnpm-workspace.yaml"} {
			if in.Root[name] {
				manifests = append(manifests, name)
			}
		}
		d.exec("COPY", append(manifests, "./")...)
		install := b.Install
		if install == "" {
			install = pm.install
		}
		d.run(install)
	} else if b.Install != "" {
		d.run(b.Install)
	}
	d.line("COPY . .")
	for _, name := range in.Args {
		d.line("ARG %s", name)
	}
	switch {
	case b.BuildCommand != "":
		d.run(b.BuildCommand)
	case b.Preset == config.PresetNode:
		// A plain Node.js app often has nothing to build.
		d.run("if node -e 'const s=require(\"./package.json\").scripts||{};process.exit(s.build?0:1)'; then " + pm.run + "build; fi")
	default:
		d.run(pm.run + "build")
	}
	if b.Preset == config.PresetNextJS && b.Standalone {
		d.run("mkdir -p public && test -f .next/standalone/server.js || { echo 'keelson: standalone is on, but the build wrote no .next/standalone/server.js: set output: \"standalone\" in next.config' >&2; exit 1; }")
	}
}

// corepackHome is where the package manager corepack fetched stays, so the runtime stage can use it offline.
const corepackHome = "/opt/corepack"

// nodeRuntime starts a runtime stage of a Node.js app: tini as init (a Node.js process alone as PID 1 ignores
// SIGTERM), the port and health path, and the files of the build owned by the non-root user.
func (in presetInput) nodeRuntime(d *dockerfileWriter, pm packageManager, withPM bool) {
	b := in.Build
	d.line("FROM node:%s-alpine", b.Node)
	d.run("apk add --no-cache tini")
	if withPM && pm.name != "npm" {
		d.line("ENV COREPACK_HOME=%s COREPACK_ENABLE_DOWNLOAD_PROMPT=0", corepackHome)
		d.run(corepackSetup)
		d.line("COPY --from=build %s %s", corepackHome, corepackHome)
	}
	d.line("ENV NODE_ENV=production PORT=%d HOSTNAME=0.0.0.0", in.port())
	in.healthEnv(d)
	d.line("WORKDIR /app")
	d.run("chown node:node /app")
}

func (in presetInput) nodeTail(d *dockerfileWriter, start string) {
	d.line("USER node")
	d.line("EXPOSE %d", in.port())
	d.line("HEALTHCHECK --interval=5s --timeout=3s --start-period=10s --retries=3 CMD wget -qO- http://127.0.0.1:$PORT${HEALTH_PATH:-/} >/dev/null || exit 1")
	d.line("STOPSIGNAL SIGTERM")
	d.line(`ENTRYPOINT ["/sbin/tini", "-g", "--"]`)
	d.exec("CMD", "sh", "-c", start)
}

func (in presetInput) healthEnv(d *dockerfileWriter) {
	if in.HealthPath != "" {
		d.line("ENV HEALTH_PATH=%q", in.HealthPath)
	}
}

func (in presetInput) nodeRunner(d *dockerfileWriter, pm packageManager) {
	in.nodeRuntime(d, pm, true)
	d.line("COPY --from=build --chown=node:node /app /app")
	start := in.Build.Start
	if start == "" {
		start = pm.name + " start"
	}
	in.nodeTail(d, start)
}

func (in presetInput) nextRunner(d *dockerfileWriter, pm packageManager) {
	b := in.Build
	in.nodeRuntime(d, pm, !b.Standalone)
	start := b.Start
	if b.Standalone {
		d.line("COPY --from=build --chown=node:node /app/.next/standalone /app")
		d.line("COPY --from=build --chown=node:node /app/.next/static /app/.next/static")
		d.line("COPY --from=build --chown=node:node /app/public /app/public")
		if start == "" {
			start = "node server.js"
		}
	} else {
		d.line("COPY --from=build --chown=node:node /app /app")
		if start == "" {
			start = pm.exec + `next start -p "$PORT"`
		}
	}
	in.nodeTail(d, start)
}

// nginxRunner serves the site with nginx, as the nginx user: its configuration is ours, with temporary files under
// /tmp and the port filled in when the container starts (PORT, as for the Node.js images).
func (in presetInput) nginxRunner(d *dockerfileWriter) {
	b := in.Build
	d.line("FROM nginx:alpine")
	d.writeFile(nginxConf(b.Preset == config.PresetVite, b.SPAEnabled()), "/etc/nginx/keelson.conf.tpl", "rm -rf /usr/share/nginx/html/*")
	d.line("ENV PORT=%d", in.port())
	in.healthEnv(d)
	if b.HasBuildStage() {
		d.exec("COPY --from=build --chown=nginx:nginx", "/app/"+b.OutputDir, "/usr/share/nginx/html")
	} else {
		d.exec("COPY --chown=nginx:nginx", b.OutputDir, "/usr/share/nginx/html")
	}
	d.line("USER nginx")
	d.line("EXPOSE %d", in.port())
	d.line("HEALTHCHECK --interval=5s --timeout=3s --start-period=5s --retries=3 CMD wget -qO- http://127.0.0.1:$PORT${HEALTH_PATH:-/} >/dev/null || exit 1")
	d.line("STOPSIGNAL SIGQUIT")
	d.exec("CMD", "sh", "-c", `case "$PORT" in ''|*[!0-9]*) echo "keelson: PORT must be a number" >&2; exit 1;; esac; `+
		`sed "s/__PORT__/$PORT/" /etc/nginx/keelson.conf.tpl > /tmp/nginx.conf && exec nginx -c /tmp/nginx.conf -g 'daemon off;'`)
}

// nginxConf is the whole nginx configuration of the static presets, one line per element. Dotfiles are never served
// (a static site rooted at the repository would otherwise offer .env and .git). With spa, an unknown path answers with
// /index.html so the client-side router can take over.
func nginxConf(vite, spa bool) []string {
	fallback := "try_files $uri $uri/ =404;"
	if spa {
		fallback = "try_files $uri $uri/index.html /index.html;"
	}
	conf := []string{
		"worker_processes auto;",
		"pid /tmp/nginx.pid;",
		"error_log /dev/stderr warn;",
		"events { worker_connections 1024; }",
		"http {",
		"  include /etc/nginx/mime.types;",
		"  default_type application/octet-stream;",
		"  access_log /dev/stdout;",
		"  client_body_temp_path /tmp/client_temp;",
		"  proxy_temp_path /tmp/proxy_temp;",
		"  fastcgi_temp_path /tmp/fastcgi_temp;",
		"  uwsgi_temp_path /tmp/uwsgi_temp;",
		"  scgi_temp_path /tmp/scgi_temp;",
		"  server_tokens off;",
		"  sendfile on;",
		"  gzip on;",
		"  gzip_vary on;",
		"  gzip_types text/plain text/css text/javascript application/javascript application/json image/svg+xml;",
		"  server {",
		"    listen __PORT__ default_server;",
		"    server_name _;",
		"    root /usr/share/nginx/html;",
		"    index index.html;",
		`    location ~ /\. { return 404; }`,
	}
	if vite {
		// Vite names its built assets after their content: they never change.
		conf = append(conf, `    location /assets/ { add_header Cache-Control "public, max-age=31536000, immutable"; try_files $uri =404; }`)
	}
	return append(conf, "    location / { "+fallback+" }", "  }", "}")
}

// ArgNames returns the names of the build arguments, sorted.
func argNames(args map[string]string) []string {
	names := make([]string, 0, len(args))
	for k := range args {
		names = append(names, k)
	}
	slices.Sort(names)
	return names
}

// dockerfileWriter writes Dockerfile text. Commands are never put in the text as they are: they go through JSON
// (exec form), so no character of an option can end an instruction or start another.
type dockerfileWriter struct{ bytes.Buffer }

func (d *dockerfileWriter) line(format string, args ...any) {
	fmt.Fprintf(d, format+"\n", args...)
}

// exec writes an instruction in exec form: INSTR ["a", "b"].
func (d *dockerfileWriter) exec(instr string, args ...string) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	_ = enc.Encode(args) // a slice of strings always encodes
	d.line("%s %s", instr, strings.TrimSuffix(buf.String(), "\n"))
}

// run writes RUN with a shell command, in exec form.
func (d *dockerfileWriter) run(cmd string) { d.exec("RUN", "sh", "-c", cmd) }

// writeFile writes RUN printf of lines into path (shell form, continued over lines, one quoted line each) and then runs
// after. The lines are ours, never an option's: they are quoted for sh all the same.
func (d *dockerfileWriter) writeFile(lines []string, path, after string) {
	d.line("RUN printf '%%s\\n' \\")
	for _, l := range lines {
		d.line("  '%s' \\", strings.ReplaceAll(l, "'", `'\''`))
	}
	d.line("  > %s && %s", path, after)
}
