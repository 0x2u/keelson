package config

import (
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

func write(t *testing.T, content string) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), "f")
	if err := os.WriteFile(p, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	return p
}

func TestLoadAppliesDefaults(t *testing.T) {
	c, err := Load(write(t, "apps:\n  - name: web\n    image: ghcr.io/o/web\n"))
	if err != nil {
		t.Fatal(err)
	}
	a, ok := c.App("web")
	if !ok || a.Stop() != DefaultStopTimeout || a.HealthWait() != DefaultHealthTimeout || a.StableWait() != DefaultStableAfter {
		t.Errorf("defaults not applied: %+v", a)
	}
	if _, ok := c.App("other"); ok {
		t.Error("unknown app must not be found")
	}
}

func TestLoadParsesDurations(t *testing.T) {
	c, err := Load(write(t, "apps:\n  - name: web\n    image: o/web\n    health_timeout: 2m\n    stable_after: 5s\n"))
	if err != nil {
		t.Fatal(err)
	}
	if a := c.Apps[0]; a.HealthWait() != 2*time.Minute || a.StableWait() != 5*time.Second {
		t.Errorf("got %+v", a)
	}
}

func TestLoadRejectsInvalidConfigs(t *testing.T) {
	cases := map[string]string{
		"unknown key":       "apps:\n  - name: web\n    image: o/web\n    imagee: x\n",
		"bad name":          "apps:\n  - name: Web App\n    image: o/web\n",
		"duplicate":         "apps:\n  - {name: web, image: o/a}\n  - {name: web, image: o/b}\n",
		"image with tag":    "apps:\n  - {name: web, image: 'o/web:latest'}\n",
		"image with sha":    "apps:\n  - {name: web, image: 'o/web@sha256:abc'}\n",
		"no image":          "apps:\n  - {name: web}\n",
		"bad restart":       "apps:\n  - {name: web, image: o/web, restart: sometimes}\n",
		"bad port":          "apps:\n  - {name: web, image: o/web, ports: ['80']}\n",
		"port out of range": "apps:\n  - {name: web, image: o/web, ports: ['0:80']}\n",
		"bad volume":        "apps:\n  - {name: web, image: o/web, volumes: ['/data']}\n",
		"negative timeout":  "apps:\n  - {name: web, image: o/web, stop_timeout: -1}\n",
		"registry partial":  "registries:\n  - {host: ghcr.io}\n",
	}
	for name, content := range cases {
		if _, err := Load(write(t, content)); err == nil {
			t.Errorf("%s: want an error", name)
		}
	}
}

func TestLogRotationAndImageRetentionDefaultsAndLimits(t *testing.T) {
	c, err := Load(write(t, "apps:\n  - {name: web, image: o/web}\n"))
	if err != nil {
		t.Fatal(err)
	}
	if l := c.Apps[0].Log; l == nil || l.Driver != "json-file" || l.MaxSizeOrDefault() != 10<<20 || l.MaxFileOrDefault() != 3 || c.Apps[0].KeepImagesOrDefault() != DefaultKeepImages {
		t.Errorf("logs must rotate and old images go by default: %+v keep=%d", l, c.Apps[0].KeepImages)
	}

	c, err = Load(write(t, "apps:\n  - {name: web, image: o/web, keep_images: 5, log: {driver: local, max_size: 50m}}\n"))
	if err != nil {
		t.Fatal(err)
	}
	if l := c.Apps[0].Log; l.Driver != "local" || l.MaxSizeOrDefault() != 50<<20 || l.MaxFileOrDefault() != 3 || c.Apps[0].KeepImagesOrDefault() != 5 {
		t.Errorf("a partial log block keeps the other defaults: %+v keep=%d", l, c.Apps[0].KeepImages)
	}

	for name, content := range map[string]string{
		"syslog driver":  "apps:\n  - {name: web, image: o/web, log: {driver: syslog}}\n",
		"size no unit":   "apps:\n  - {name: web, image: o/web, log: {max_size: '10'}}\n",
		"size zero":      "apps:\n  - {name: web, image: o/web, log: {max_size: 0m}}\n",
		"too many files": "apps:\n  - {name: web, image: o/web, log: {max_file: 101}}\n",
		"negative keep":  "apps:\n  - {name: web, image: o/web, keep_images: -1}\n",
		"huge keep":      "apps:\n  - {name: web, image: o/web, keep_images: 1000}\n",
	} {
		if _, err := Load(write(t, content)); err == nil {
			t.Errorf("%s: want an error", name)
		}
	}
}

func TestDrainDefaultsToFiveSecondsAndCanBeZero(t *testing.T) {
	c, err := Load(write(t, "apps:\n  - {name: web, image: o/web}\n  - {name: now, image: o/now, drain: 0s}\n  - {name: slow, image: o/slow, drain: 30s}\n"))
	if err != nil {
		t.Fatal(err)
	}
	got := []time.Duration{c.Apps[0].DrainFor(), c.Apps[1].DrainFor(), c.Apps[2].DrainFor()}
	if want := []time.Duration{5 * time.Second, 0, 30 * time.Second}; !reflect.DeepEqual(got, want) {
		t.Errorf("drain = %v, want %v", got, want)
	}
	for name, content := range map[string]string{
		"negative": "apps:\n  - {name: web, image: o/web, drain: -1s}\n",
		"too long": "apps:\n  - {name: web, image: o/web, drain: 10m}\n",
	} {
		if _, err := Load(write(t, content)); err == nil {
			t.Errorf("%s: want an error", name)
		}
	}
}

func TestRegistryPortInImageIsNotATag(t *testing.T) {
	if _, err := Load(write(t, "apps:\n  - {name: web, image: 'localhost:5000/web'}\n")); err != nil {
		t.Errorf("a registry port is not a tag: %v", err)
	}
	if got := RegistryHost("localhost:5000/web"); got != "localhost:5000" {
		t.Errorf("got %q", got)
	}
	if got := RegistryHost("ghcr.io/o/web"); got != "ghcr.io" {
		t.Errorf("got %q", got)
	}
	if got := RegistryHost("nginx"); got != "docker.io" {
		t.Errorf("got %q", got)
	}
	if got := RegistryHost("library/nginx"); got != "docker.io" {
		t.Errorf("got %q", got)
	}
}

func TestParsePort(t *testing.T) {
	good := map[string]PortMapping{
		"8080:80":           {HostPort: "8080", ContainerPort: "80", Proto: "tcp"},
		"127.0.0.1:8080:80": {HostIP: "127.0.0.1", HostPort: "8080", ContainerPort: "80", Proto: "tcp"},
		"5353:53/udp":       {HostPort: "5353", ContainerPort: "53", Proto: "udp"},
	}
	for in, want := range good {
		got, err := ParsePort(in)
		if err != nil || got != want {
			t.Errorf("%s: got %+v, %v", in, got, err)
		}
	}
	for _, bad := range []string{"", "80", "a:b", "1:2:3:4", "80:80/sctp", "70000:80", "80:0"} {
		if _, err := ParsePort(bad); err == nil {
			t.Errorf("%q must be rejected", bad)
		}
	}
}

func TestEnvironmentMergesFileThenEnv(t *testing.T) {
	envFile := write(t, "# comment\n\nA=1\nexport B=\"two words\"\nC='3'\nD=a=b\n")
	a := App{EnvFile: envFile, Env: map[string]string{"C": "override", "Z": "z", "E": "e"}}
	got, err := a.Environment()
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"A=1", "B=two words", "C=override", "D=a=b", "E=e", "Z=z"}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("got %v, want %v", got, want)
	}
}

func TestEnvFileErrors(t *testing.T) {
	if _, err := ReadEnvFile(filepath.Join(t.TempDir(), "missing")); err == nil {
		t.Error("a missing env file must fail")
	}
	_, err := ReadEnvFile(write(t, "OK=1\nnot a pair\n"))
	if err == nil || !strings.Contains(err.Error(), ":2:") {
		t.Errorf("want an error naming line 2, got %v", err)
	}
}

func TestDomainsRequireProxyPortAndForbidConflicts(t *testing.T) {
	ok := "proxy: {}\napps:\n  - {name: web, image: o/web, port: 3000, domains: [Example.COM, www.example.com]}\n"
	c, err := Load(write(t, ok))
	if err != nil {
		t.Fatal(err)
	}
	if a := c.Apps[0]; !a.Proxied() || a.Domains[0] != "example.com" {
		t.Errorf("domains must be lowercased: %+v", a.Domains)
	}
	if c.Proxy.Admin != DefaultProxyAdmin {
		t.Errorf("admin default not applied: %q", c.Proxy.Admin)
	}

	bad := map[string]string{
		"no proxy section":     "apps:\n  - {name: web, image: o/web, port: 3000, domains: [a.example.com]}\n",
		"no port":              "proxy: {}\napps:\n  - {name: web, image: o/web, domains: [a.example.com]}\n",
		"port without domains": "apps:\n  - {name: web, image: o/web, port: 3000}\n",
		"published ports":      "proxy: {}\napps:\n  - {name: web, image: o/web, port: 3000, domains: [a.example.com], ports: ['80:80']}\n",
		"host network":         "proxy: {}\napps:\n  - {name: web, image: o/web, port: 3000, domains: [a.example.com], network: host}\n",
		"not a hostname":       "proxy: {}\napps:\n  - {name: web, image: o/web, port: 3000, domains: ['a b.com']}\n",
		"single label":         "proxy: {}\napps:\n  - {name: web, image: o/web, port: 3000, domains: [localhost]}\n",
		"wildcard":             "proxy: {}\napps:\n  - {name: web, image: o/web, port: 3000, domains: ['*.example.com']}\n",
		"domain on two apps":   "proxy: {}\napps:\n  - {name: a, image: o/a, port: 1, domains: [x.example.com]}\n  - {name: b, image: o/b, port: 1, domains: [x.example.com]}\n",
		"bad admin":            "proxy: {admin: 'localhost:2019'}\napps: []\n",
		"bad tls":              "proxy: {tls: staging}\napps: []\n",
	}
	for name, content := range bad {
		if _, err := Load(write(t, content)); err == nil {
			t.Errorf("%s: want an error", name)
		}
	}
}

const nginxProxy = "proxy: {type: nginx, upstreams_file: /etc/nginx/keelson/upstreams.conf, test: [nginx, -t], reload: [systemctl, reload, nginx]}\n"

func TestNginxHostPortsConfig(t *testing.T) {
	ok := nginxProxy + "apps:\n  - {name: shop, image: o/shop, network: host, host_ports: [3000, 3001], health_path: /api/health}\n"
	c, err := Load(write(t, ok))
	if err != nil {
		t.Fatal(err)
	}
	a := c.Apps[0]
	if !a.Proxied() || a.PortEnv != "PORT" || c.Proxy.Type != ProxyNginx || len(c.Proxy.Reload) != 3 {
		t.Errorf("unexpected parse: %+v %+v", a, c.Proxy)
	}

	// A container with its own network can also sit behind nginx, without domains.
	if _, err := Load(write(t, nginxProxy+"apps:\n  - {name: web, image: o/web, port: 3000}\n")); err != nil {
		t.Errorf("port without domains is valid with nginx: %v", err)
	}

	bad := map[string]string{
		"host_ports without host network":  nginxProxy + "apps:\n  - {name: a, image: o/a, host_ports: [3000, 3001]}\n",
		"host network with port":           nginxProxy + "apps:\n  - {name: a, image: o/a, network: host, port: 3000}\n",
		"one host port":                    nginxProxy + "apps:\n  - {name: a, image: o/a, network: host, host_ports: [3000]}\n",
		"three host ports":                 nginxProxy + "apps:\n  - {name: a, image: o/a, network: host, host_ports: [1, 2, 3]}\n",
		"identical host ports":             nginxProxy + "apps:\n  - {name: a, image: o/a, network: host, host_ports: [3000, 3000]}\n",
		"host port out of range":           nginxProxy + "apps:\n  - {name: a, image: o/a, network: host, host_ports: [3000, 70000]}\n",
		"port and host_ports":              nginxProxy + "apps:\n  - {name: a, image: o/a, network: host, port: 1, host_ports: [3000, 3001]}\n",
		"published ports":                  nginxProxy + "apps:\n  - {name: a, image: o/a, network: host, host_ports: [3000, 3001], ports: ['80:80']}\n",
		"bad port_env":                     nginxProxy + "apps:\n  - {name: a, image: o/a, network: host, host_ports: [3000, 3001], port_env: 'my port'}\n",
		"port_env without host_ports":      nginxProxy + "apps:\n  - {name: a, image: o/a, port: 3000, port_env: PORT}\n",
		"health_path without blue/green":   nginxProxy + "apps:\n  - {name: a, image: o/a, health_path: /up}\n",
		"health_path not absolute":         nginxProxy + "apps:\n  - {name: a, image: o/a, port: 3000, health_path: up}\n",
		"health_path with space":           nginxProxy + "apps:\n  - {name: a, image: o/a, port: 3000, health_path: '/a b'}\n",
		"domains with nginx":               nginxProxy + "apps:\n  - {name: a, image: o/a, port: 3000, domains: [a.example.com]}\n",
		"relative upstreams file":          "proxy: {type: nginx, upstreams_file: upstreams.conf, reload: [nginx, -s, reload]}\napps: []\n",
		"missing reload":                   "proxy: {type: nginx, upstreams_file: /etc/nginx/u.conf}\napps: []\n",
		"caddy options with nginx":         "proxy: {type: nginx, upstreams_file: /etc/nginx/u.conf, reload: [x], tls: internal}\napps: []\n",
		"nginx options with caddy":         "proxy: {reload: [nginx, -s, reload]}\napps: []\n",
		"caddy blue/green without domains": "proxy: {}\napps:\n  - {name: a, image: o/a, port: 3000}\n",
		"unknown proxy type":               "proxy: {type: haproxy}\napps: []\n",
		"blue/green without proxy section": "apps:\n  - {name: a, image: o/a, network: host, host_ports: [3000, 3001]}\n",
	}
	for name, content := range bad {
		if _, err := Load(write(t, content)); err == nil {
			t.Errorf("%s: want an error", name)
		}
	}
}

func TestNotificationsConfig(t *testing.T) {
	ok := `notifications:
  name: vps-1
  events: [deployment.failed, app.down]
  webhooks:
    - {url: https://hooks.example.com/x, secret_file: /etc/keelson/hook}
  telegram: {bot_token_file: /etc/keelson/tg, chat_id: "-1001"}
  heartbeat: {url: https://hc-ping.com/abc}
apps: []
`
	c, err := Load(write(t, ok))
	if err != nil {
		t.Fatal(err)
	}
	n := c.Notifications
	if n.Telegram.APIURL != DefaultTelegramAPI || n.Heartbeat.Interval() != DefaultHeartbeatEvery {
		t.Errorf("defaults not applied: %+v %+v", n.Telegram, n.Heartbeat)
	}
	if !n.EventEnabled(EventAppDown) || n.EventEnabled(EventAppRecovered) {
		t.Error("an explicit list is exactly what is sent")
	}

	// Without a list: everything that needs attention, but not routine successes.
	c, _ = Load(write(t, "notifications: {webhooks: [{url: 'https://x.example.com'}]}\napps: []\n"))
	for _, e := range DefaultEvents {
		if !c.Notifications.EventEnabled(e) {
			t.Errorf("%s must be on by default", e)
		}
	}
	if c.Notifications.EventEnabled(EventDeploymentSucceeded) {
		t.Error("successful deployments are opt-in")
	}

	bad := map[string]string{
		"unknown event":      "notifications: {events: [deployment.exploded]}\napps: []\n",
		"webhook not http":   "notifications: {webhooks: [{url: 'ftp://x.example.com'}]}\napps: []\n",
		"webhook no url":     "notifications: {webhooks: [{}]}\napps: []\n",
		"telegram no chat":   "notifications: {telegram: {bot_token_file: /x}}\napps: []\n",
		"telegram no token":  "notifications: {telegram: {chat_id: '1'}}\napps: []\n",
		"telegram bad api":   "notifications: {telegram: {bot_token_file: /x, chat_id: '1', api_url: 'bot'}}\napps: []\n",
		"heartbeat not http": "notifications: {heartbeat: {url: 'hc-ping.com/x'}}\napps: []\n",
		"heartbeat too fast": "notifications: {heartbeat: {url: 'https://hc.example.com/x', every: 5s}}\napps: []\n",
		"unknown key":        "notifications: {slack: {}}\napps: []\n",
	}
	for name, content := range bad {
		if _, err := Load(write(t, content)); err == nil {
			t.Errorf("%s: want an error", name)
		}
	}
}

func TestReleaseConfig(t *testing.T) {
	ok := `apps:
  - name: web
    image: ghcr.io/o/web
    release:
      on_rollback: true
      steps:
        - {name: backup, run: [/srv/web/backup.sh], dir: /srv/web, continue_on_failure: true, timeout: 5m}
        - {name: migrate, command: [pnpm, exec, prisma, migrate, deploy], image: ghcr.io/o/web-migrate}
`
	c, err := Load(write(t, ok))
	if err != nil {
		t.Fatal(err)
	}
	r := c.Apps[0].Release
	if !r.OnRollback || len(r.Steps) != 2 || r.Steps[0].RunTimeout() != 5*time.Minute || r.Steps[1].RunTimeout() != DefaultReleaseTimeout {
		t.Errorf("unexpected release: %+v", r)
	}

	app := func(steps string) string {
		return "apps:\n  - name: web\n    image: o/web\n    release:\n      steps:\n" + steps
	}
	bad := map[string]string{
		"no steps":                "apps:\n  - name: web\n    image: o/web\n    release: {steps: []}\n",
		"bad name":                app("        - {name: Migrate!, command: [x]}\n"),
		"duplicate name":          app("        - {name: a, command: [x]}\n        - {name: a, command: [y]}\n"),
		"neither run nor command": app("        - {name: a}\n"),
		"both run and command":    app("        - {name: a, run: [x], command: [y]}\n"),
		"image on a host step":    app("        - {name: a, run: [x], image: o/m}\n"),
		"dir on a container step": app("        - {name: a, command: [x], dir: /srv}\n"),
		"relative dir":            app("        - {name: a, run: [x], dir: srv}\n"),
		"image with a tag":        app("        - {name: a, command: [x], image: 'o/m:latest'}\n"),
		"negative timeout":        app("        - {name: a, command: [x], timeout: -1s}\n"),
		"timeout too long":        app("        - {name: a, command: [x], timeout: 2h}\n"),
		"empty program":           app("        - {name: a, run: ['']}\n"),
		"unknown key":             app("        - {name: a, command: [x], retries: 3}\n"),
	}
	for name, content := range bad {
		if _, err := Load(write(t, content)); err == nil {
			t.Errorf("%s: want an error", name)
		}
	}
}

func TestJobsConfig(t *testing.T) {
	ok := `apps:
  - {name: shop, image: ghcr.io/o/shop}
jobs:
  - name: monitoring
    schedule: "*/5 * * * *"
    http:
      url: http://127.0.0.1:3000/api/cron/monitoring
      bearer: {app: shop, env: CRON_SECRET}
  - name: daily-report
    schedule: "0 7 * * *"
    timezone: Europe/Paris
    http: {url: https://example.com/report, method: post, bearer: {file: /etc/keelson/cron}, expect_status: [200, 202]}
    alert_after: 2
  - name: backup
    schedule: "@daily"
    run: [/srv/shop/backup.sh]
    dir: /srv/shop
    timeout: 20m
  - name: reindex
    schedule: "@every 15m"
    container: {app: shop, command: [node, reindex.js]}
    paused: true
`
	c, err := Load(write(t, ok))
	if err != nil {
		t.Fatal(err)
	}
	if len(c.Jobs) != 4 {
		t.Fatalf("got %d jobs", len(c.Jobs))
	}
	m, r, b, x := c.Jobs[0], c.Jobs[1], c.Jobs[2], c.Jobs[3]
	if m.RunTimeout() != DefaultJobTimeout || m.AlertThreshold() != 1 || m.HTTP.Method != "GET" || m.Kind() != "http" || m.Location().String() != "UTC" {
		t.Errorf("defaults not applied: %+v", m)
	}
	if r.HTTP.Method != "POST" || r.AlertThreshold() != 2 || r.Location().String() != "Europe/Paris" {
		t.Errorf("unexpected job: %+v", r)
	}
	if b.Kind() != "host" || b.RunTimeout() != 20*time.Minute || x.Kind() != "container" || !x.Paused {
		t.Errorf("unexpected jobs: %+v %+v", b, x)
	}
	if next := m.ParsedSchedule().Next(time.Date(2026, 1, 1, 12, 3, 0, 0, time.UTC)); next.Minute() != 5 {
		t.Errorf("ParsedSchedule must give a working schedule, next %s", next)
	}
	if _, ok := c.Job("backup"); !ok {
		t.Error("Job must find a job by name")
	}

	shop := "apps:\n  - {name: shop, image: o/shop}\n"
	bad := map[string]string{
		"bad name":           shop + "jobs:\n  - {name: 'My Job', schedule: '@daily', run: [x]}\n",
		"duplicate":          shop + "jobs:\n  - {name: a, schedule: '@daily', run: [x]}\n  - {name: a, schedule: '@daily', run: [y]}\n",
		"bad schedule":       shop + "jobs:\n  - {name: a, schedule: '61 * * * *', run: [x]}\n",
		"no schedule":        shop + "jobs:\n  - {name: a, run: [x]}\n",
		"every too short":    shop + "jobs:\n  - {name: a, schedule: '@every 5s', run: [x]}\n",
		"bad timezone":       shop + "jobs:\n  - {name: a, schedule: '@daily', timezone: Mars/Base, run: [x]}\n",
		"no action":          shop + "jobs:\n  - {name: a, schedule: '@daily'}\n",
		"two actions":        shop + "jobs:\n  - {name: a, schedule: '@daily', run: [x], http: {url: 'http://x.com'}}\n",
		"http not http":      shop + "jobs:\n  - {name: a, schedule: '@daily', http: {url: 'ftp://x.com'}}\n",
		"http bad method":    shop + "jobs:\n  - {name: a, schedule: '@daily', http: {url: 'http://x.com', method: TRACE}}\n",
		"http bad header":    shop + "jobs:\n  - {name: a, schedule: '@daily', http: {url: 'http://x.com', headers: {'Bad Header': v}}}\n",
		"header injection":   shop + "jobs:\n  - {name: a, schedule: '@daily', http: {url: 'http://x.com', headers: {X: \"a\\r\\nEvil: 1\"}}}\n",
		"auth twice":         shop + "jobs:\n  - {name: a, schedule: '@daily', http: {url: 'http://x.com', headers: {authorization: x}, bearer: {file: /s}}}\n",
		"bad expect status":  shop + "jobs:\n  - {name: a, schedule: '@daily', http: {url: 'http://x.com', expect_status: [99]}}\n",
		"bearer both":        shop + "jobs:\n  - {name: a, schedule: '@daily', http: {url: 'http://x.com', bearer: {file: /s, app: shop, env: X}}}\n",
		"bearer neither":     shop + "jobs:\n  - {name: a, schedule: '@daily', http: {url: 'http://x.com', bearer: {}}}\n",
		"bearer relative":    shop + "jobs:\n  - {name: a, schedule: '@daily', http: {url: 'http://x.com', bearer: {file: secret}}}\n",
		"bearer unknown app": shop + "jobs:\n  - {name: a, schedule: '@daily', http: {url: 'http://x.com', bearer: {app: ghost, env: X}}}\n",
		"bearer bad env":     shop + "jobs:\n  - {name: a, schedule: '@daily', http: {url: 'http://x.com', bearer: {app: shop, env: 'a b'}}}\n",
		"empty program":      shop + "jobs:\n  - {name: a, schedule: '@daily', run: ['']}\n",
		"relative dir":       shop + "jobs:\n  - {name: a, schedule: '@daily', run: [x], dir: srv}\n",
		"dir on http":        shop + "jobs:\n  - {name: a, schedule: '@daily', http: {url: 'http://x.com'}, dir: /srv}\n",
		"container no app":   shop + "jobs:\n  - {name: a, schedule: '@daily', container: {app: ghost, command: [x]}}\n",
		"container no cmd":   shop + "jobs:\n  - {name: a, schedule: '@daily', container: {app: shop}}\n",
		"timeout too long":   shop + "jobs:\n  - {name: a, schedule: '@daily', run: [x], timeout: 2h}\n",
		"negative alert":     shop + "jobs:\n  - {name: a, schedule: '@daily', run: [x], alert_after: -1}\n",
		"unknown key":        shop + "jobs:\n  - {name: a, schedule: '@daily', run: [x], retries: 3}\n",
	}
	for name, content := range bad {
		if _, err := Load(write(t, content)); err == nil {
			t.Errorf("%s: want an error", name)
		}
	}
}

func TestProjectAndEnvironmentAreLabelsWithTheNameRules(t *testing.T) {
	ok := "apps:\n  - name: web\n    image: o/web\n    project: shop\n    environment: staging\n"
	c, issues := Parse([]byte(ok))
	if c == nil || len(issues) != 0 || c.Apps[0].Project != "shop" || c.Apps[0].Stage != "staging" {
		t.Fatalf("%+v %v", c, issues)
	}
	// Both are optional.
	if c, issues := Parse([]byte("apps:\n  - name: web\n    image: o/web\n")); c == nil || len(issues) != 0 {
		t.Errorf("no labels: %v", issues)
	}
	for _, bad := range []string{"project: Shop Co", "environment: Staging!", "project: -x"} {
		_, issues := Parse([]byte("apps:\n  - name: web\n    image: o/web\n    " + bad + "\n"))
		if len(issues) == 0 || !strings.Contains(issues[0].Message, "must match") {
			t.Errorf("%q must be refused, got %v", bad, issues)
		}
	}
}

func TestManagedEnvFilesAreStrictJSONAndOrdinaryOnesAreUnchanged(t *testing.T) {
	values := []string{"plain", "", "two\nlines\n", `quote " and \ backslash`, "  spaced  ", "a=b", "<&>", "héllo"}
	var b strings.Builder
	b.WriteString(ManagedEnvHeader + "\n#@ var K0 2026-10-23T10:00:00Z build\n")
	for i, v := range values {
		fmt.Fprintf(&b, "K%d=%s\n", i, QuoteEnvValue(v))
	}
	pairs, err := ReadEnvFile(write(t, b.String()))
	if err != nil || len(pairs) != len(values) {
		t.Fatalf("%v %v", pairs, err)
	}
	for i, v := range values {
		if pairs[i][1] != v {
			t.Errorf("K%d: got %q, want %q", i, pairs[i][1], v)
		}
	}
	if q := QuoteEnvValue("<&>"); q != `"<&>"` {
		t.Errorf("HTML characters are not escaped: %s", q)
	}

	// An unquoted value is an error in a managed file, and the error never holds the value.
	_, err = ReadEnvFile(write(t, ManagedEnvHeader+"\nA=hunter2hunter2\n"))
	if err == nil || !strings.Contains(err.Error(), ":2:") || strings.Contains(err.Error(), "hunter2") {
		t.Errorf("%v", err)
	}

	// The same lines without the header keep their historical meaning: quotes stripped, no escapes.
	pairs, err = ReadEnvFile(write(t, "A=\"x\\ny\"\nB='1'\n"))
	if err != nil || pairs[0][1] != `x\ny` || pairs[1][1] != "1" {
		t.Errorf("%v %v", pairs, err)
	}
	// The header only counts on the first line.
	pairs, err = ReadEnvFile(write(t, "A=1\n"+ManagedEnvHeader+"\nB=2\n"))
	if err != nil || len(pairs) != 2 || pairs[1][1] != "2" {
		t.Errorf("%v %v", pairs, err)
	}
}

func TestBackupReleaseStep(t *testing.T) {
	const databases = `databases:
  - name: shop
    host: 127.0.0.1
    database: shop
    user: shop
    backup:
      schedule: "0 3 * * *"
      recipients: ["age1ql3z7hjy54pw3hyww5ayyfg7zqgvc7w3j2elw8zmrj2kg5sfn9aqmcac8p"]
      destination: {local: {dir: /var/backups/keelson}}
  - name: plain
    host: 127.0.0.1
    database: plain
    user: plain
`
	app := func(steps string) string {
		return "apps:\n  - name: web\n    image: o/web\n    release:\n      steps:\n" + steps + databases
	}
	c, err := Load(write(t, app("        - {name: backup, backup: shop, timeout: 20m}\n        - {name: migrate, command: [x]}\n")))
	if err != nil {
		t.Fatal(err)
	}
	if s := c.Apps[0].Release.Steps[0]; s.Backup != "shop" || s.RunTimeout() != 20*time.Minute {
		t.Errorf("unexpected step: %+v", s)
	}

	bad := map[string]string{
		"a database that is not declared":    app("        - {name: backup, backup: orders}\n"),
		"a database without a backup":        app("        - {name: backup, backup: plain}\n"),
		"backup and run":                     app("        - {name: backup, backup: shop, run: [x]}\n"),
		"backup and command":                 app("        - {name: backup, backup: shop, command: [x]}\n"),
		"backup with a dir":                  app("        - {name: backup, backup: shop, dir: /srv}\n"),
		"backup with an image":               app("        - {name: backup, backup: shop, image: o/m}\n"),
		"backup that is not a database name": app("        - {name: backup, backup: 'Shop!'}\n"),
	}
	for name, content := range bad {
		if _, err := Load(write(t, content)); err == nil {
			t.Errorf("%s: want an error", name)
		}
	}
	if _, err := Load(write(t, app("        - {name: backup, backup: orders}\n"))); err == nil || !strings.Contains(err.Error(), `backs up database "orders", which is not declared`) {
		t.Errorf("the issue must name the database and say why: %v", err)
	}
}

// The production example must load, and the parts a deployment depends on must be what its comments say.
func TestProductionExample(t *testing.T) {
	c, err := Load("../../../docs/examples/shop-production.apps.yaml")
	if err != nil {
		t.Fatal(err)
	}
	a, ok := c.App("shop")
	if !ok || a.Network != "host" || len(a.HostPorts) != 2 || a.HostPorts[0] != 3000 || a.HealthPath != "/api/health" || a.Build == nil || a.Build.Dockerfile != "Dockerfile.keelson" {
		t.Fatalf("unexpected app: %+v", a)
	}
	var steps []string
	for _, s := range a.Release.Steps {
		steps = append(steps, s.Name)
	}
	if !reflect.DeepEqual(steps, []string{"check-env", "backup", "migrate"}) {
		t.Errorf("the backup must come after the env gate and before the migration: %v", steps)
	}
	if a.Build.MemoryBytes() < 3<<30 {
		t.Errorf("a next build was measured at 2.67 GiB: the cap must not be lower than 3g")
	}
	if len(c.Jobs) < 3 || len(c.Databases) != 1 || c.Databases[0].Backups == nil {
		t.Errorf("jobs and the database's backup are part of the switch: %d jobs, %+v", len(c.Jobs), c.Databases)
	}
}

// The Caddy variant of the production file: the app is routed by domain, www is the one host with an app, the apex redirects,
// and the Cloudflare origin certificate is loaded rather than asked for.
func TestProductionCaddyExample(t *testing.T) {
	c, err := Load("../../../docs/examples/shop-production-caddy.apps.yaml")
	if err != nil {
		t.Fatal(err)
	}
	a, ok := c.App("shop")
	if !ok || !reflect.DeepEqual(a.Domains, []string{"www.example.com"}) || !reflect.DeepEqual(a.HostPorts, []int{3000, 3001}) {
		t.Fatalf("unexpected app: %+v", a)
	}
	p := c.Proxy
	if p.AccessLog != "/data/access.log" || p.Type != ProxyCaddy || len(p.Certificates) != 1 || p.ClientIPHeader != "CF-Connecting-IP" || len(p.TrustedProxies) != 22 {
		t.Errorf("unexpected proxy: %+v", p)
	}
	if len(p.Sites) != 1 || p.Sites[0].Redirect == nil || p.Sites[0].Redirect.To != "https://www.example.com{uri}" {
		t.Errorf("the apex must redirect to www: %+v", p.Sites)
	}
	nginx, err := Load("../../../docs/examples/shop-production.apps.yaml")
	if err != nil {
		t.Fatal(err)
	}
	b, _ := nginx.App("shop")
	a.Domains, b.Domains = nil, nil
	if !reflect.DeepEqual(a, b) || !reflect.DeepEqual(c.Jobs, nginx.Jobs) || !reflect.DeepEqual(c.Databases, nginx.Databases) {
		t.Error("the Caddy variant must differ from the nginx one only in the proxy and the domains")
	}
}

func TestBuildOnlyApp(t *testing.T) {
	c, err := Load(write(t, "apps:\n  - name: shop-build\n    image: keelson-local/shop\n    build: {only: true, dockerfile: Dockerfile.keelson, network: host, memory: 3g, cpus: 2}\n    keep_images: 3\n"))
	if err != nil {
		t.Fatal(err)
	}
	a, _ := c.App("shop-build")
	if !a.BuildOnly() || a.Build.MemoryBytes() != 3<<30 || a.Build.Network != "host" {
		t.Errorf("unexpected builder: %+v", a)
	}
	if (App{}).BuildOnly() || (App{Build: &Build{}}).BuildOnly() {
		t.Error("only an app whose build says only is a builder")
	}
	// a framework preset writes port and health_path into the image it builds: a builder keeps them
	if _, err := Load(write(t, "apps:\n  - name: site-build\n    image: keelson-local/site\n    port: 3000\n    health_path: /\n    build: {only: true, preset: nextjs}\n")); err != nil {
		t.Errorf("a preset builder keeps port and health_path: %v", err)
	}

	app := func(extra string) string {
		return "apps:\n  - name: shop-build\n    image: keelson-local/shop\n    build: {only: true}\n" + extra
	}
	for name, extra := range map[string]string{
		"domains":    "    domains: [shop.example.com]\n",
		"ports":      "    ports: ['127.0.0.1:8080:80']\n",
		"host_ports": "    network: host\n    host_ports: [3000, 3001]\n",
		"volumes":    "    volumes: ['/srv/x:/x']\n",
		"release":    "    release: {steps: [{name: m, command: [x]}]}\n",
		"env_file":   "    env_file: /srv/.env\n",
		"env":        "    env: {A: b}\n",
		"network":    "    network: host\n",
		"command":    "    command: [node, x.js]\n",
	} {
		if _, err := Load(write(t, app(extra))); err == nil || !strings.Contains(err.Error(), "build.only") {
			t.Errorf("%s on a builder must be refused with the reason: %v", name, err)
		}
	}
}

func TestLegacyBuilderExample(t *testing.T) {
	c, err := Load("testdata/legacy/legacy-builder.apps.yaml")
	if err != nil {
		t.Fatal(err)
	}
	a, ok := c.App("shop-build")
	if !ok || !a.BuildOnly() || a.Image != "keelson-local/shop" || a.Build.Network != "host" || a.Build.Dockerfile != "Dockerfile.keelson" {
		t.Fatalf("unexpected builder: %+v", a)
	}
	if a.Build.MemoryBytes() < 3<<30 {
		t.Errorf("a next build was measured at 2.67 GiB: the cap must not be lower than 3g")
	}
	run, err := Load("../../../docs/examples/shop-production.apps.yaml")
	if err != nil {
		t.Fatal(err)
	}
	if r, _ := run.App("shop"); r.Image != a.Image {
		t.Errorf("the builder and the app that runs the image must share a repository: %q and %q", a.Image, r.Image)
	}
}

// The Next.js + PostgreSQL example must load, and the parts its deployments rely on must be what its comments say.
func TestWebPostgresExample(t *testing.T) {
	c, err := Load("../../../docs/examples/web-postgres.apps.yaml")
	if err != nil {
		t.Fatal(err)
	}
	a, ok := c.App("web-demo")
	if !ok || a.ContainerPort != 3000 || !reflect.DeepEqual(a.Domains, []string{"staging.example.com"}) || a.HealthPath != "/api/health" || a.Build == nil || a.Build.Dockerfile != "Dockerfile.keelson" || !a.Build.Database {
		t.Fatalf("unexpected app: %+v", a)
	}
	var steps []string
	for _, s := range a.Release.Steps {
		steps = append(steps, s.Name)
	}
	if !reflect.DeepEqual(steps, []string{"check-env", "migrate"}) {
		t.Errorf("the environment gate must come before the migration: %v", steps)
	}
	if len(c.Jobs) != 1 || c.Jobs[0].Name != "prune-guestbook" {
		t.Errorf("the example's cron job is part of the file: %+v", c.Jobs)
	}
}
