package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/user"
	"path/filepath"
	"strings"
	"time"

	"github.com/0x2u/keelson/agent/internal/config"
	"github.com/0x2u/keelson/agent/internal/docker"
	"github.com/0x2u/keelson/agent/internal/store"
	"github.com/0x2u/keelson/agent/internal/sysinfo"
)

// Where an installed agent keeps what doctor looks at when no flag says otherwise.
const (
	installedApps  = "/etc/keelson/config/apps.yaml"
	installedRelay = "/etc/keelson/relay.json"
)

type level int

const (
	levelOK level = iota
	levelWarn
	levelFail
)

// check is one line of the report: what was looked at, what was found and, when it is not fine, what to do.
type check struct {
	level  level
	name   string
	detail string
	fix    string
}

// doctorCmd looks at this machine the way the agent will find it and says what would stop it or hurt it: the engine,
// the configuration, the files it names, the data directory and the disks, Caddy, and the way to the dashboard. It needs
// no running agent and changes nothing: it only reads, asks the engine and Caddy for information, and creates and removes
// one empty file in the data directory to prove it is writable. Exit status: 0 when nothing failed (warnings do not
// change it), 1 when something failed, 2 for a usage error.
func doctorCmd(ctx context.Context, args []string) error {
	fs, socket := newFlags("doctor")
	appsFile := fs.String("apps", env("KEELSON_APPS", ""), "apps file (default: /etc/keelson/config/apps.yaml when it exists)")
	projectsDir := fs.String("projects-dir", env("KEELSON_PROJECTS_DIR", ""), "directory of the per-project files (default: projects.d next to the apps file)")
	dataDir := fs.String("data-dir", env("KEELSON_DATA_DIR", "/var/lib/keelson"), "directory of the agent's database")
	relayFile := fs.String("relay-file", env("KEELSON_RELAY_FILE", ""), "relay.json of a server that connects out (default: /etc/keelson/relay.json when it exists)")
	if err := fs.Parse(args); err != nil {
		return &exitError{exitUsage, err}
	}
	if fs.NArg() != 0 {
		return &exitError{exitUsage, errors.New("usage: keelson-agent doctor [--apps FILE] [--projects-dir DIR] [--data-dir DIR] [--relay-file FILE] [--docker-socket PATH]")}
	}
	if *appsFile == "" {
		if _, err := os.Stat(installedApps); err == nil {
			*appsFile = installedApps
		}
	}
	if *relayFile == "" {
		if _, err := os.Stat(installedRelay); err == nil {
			*relayFile = installedRelay
		}
	}
	return runDoctor(ctx, os.Stdout, doctorOptions{socket: *socket, appsFile: *appsFile, projectsDir: *projectsDir, dataDir: *dataDir, relayFile: *relayFile})
}

type doctorOptions struct {
	socket, appsFile, projectsDir, dataDir, relayFile string
}

func runDoctor(ctx context.Context, out io.Writer, o doctorOptions) error {
	var checks []check

	engine, info := checkDocker(ctx, o.socket)
	checks = append(checks, engine)

	var cfg *config.Config
	if o.appsFile == "" {
		checks = append(checks, check{levelWarn, "Configuration", "no apps file given and none at " + installedApps, "pass --apps FILE (or set KEELSON_APPS) to check the configuration and the files it names"})
	} else {
		var c check
		c, cfg = checkConfig(o.appsFile, o.projectsDir)
		checks = append(checks, c)
	}
	if cfg != nil {
		checks = append(checks, checkFiles(cfg)...)
		checks = append(checks, checkNotifications(cfg))
	}

	data, dataDisk := checkData(o.dataDir)
	checks = append(checks, data...)
	if dataDisk != nil {
		checks = append(checks, diskCheck("Disk of "+o.dataDir, dataDisk))
	}
	if info != nil && info.RootDir != "" {
		if d := sysinfo.Read("/proc", info.RootDir, "/").Disk; d != nil && (dataDisk == nil || d.Dev != dataDisk.Dev) {
			checks = append(checks, diskCheck("Disk of Docker ("+d.Path+")", d))
		}
	}
	if cfg != nil {
		if c, ok := checkCaddy(ctx, cfg); ok {
			checks = append(checks, c)
		}
	}
	if o.relayFile != "" {
		checks = append(checks, checkDashboard(ctx, o.relayFile))
	}

	var counts [3]int
	for _, c := range checks {
		counts[c.level]++
		tag := map[level]string{levelOK: "ok  ", levelWarn: "WARN", levelFail: "FAIL"}[c.level]
		fmt.Fprintf(out, "%s  %-28s %s\n", tag, c.name, c.detail)
		if c.fix != "" {
			fmt.Fprintf(out, "      %-28s -> %s\n", "", c.fix)
		}
	}
	fmt.Fprintf(out, "\n%d ok, %d warnings, %d failures\n", counts[levelOK], counts[levelWarn], counts[levelFail])
	if counts[levelFail] > 0 {
		return &exitError{code: exitRefused}
	}
	return nil
}

func checkDocker(ctx context.Context, socket string) (check, *docker.EngineInfo) {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	c := docker.New(socket)
	if err := c.Ping(ctx); err != nil {
		return check{levelFail, "Docker engine", fmt.Sprintf("does not answer on %s: %v", socket, err),
			"start Docker, and run this as root or as an account in the docker group; --docker-socket names another socket"}, nil
	}
	info, err := c.Info(ctx)
	if err != nil {
		return check{levelFail, "Docker engine", fmt.Sprintf("answers on %s but its info cannot be read: %v", socket, err), ""}, nil
	}
	detail := fmt.Sprintf("%s on %s/%s, %d running of %d containers", info.Version, info.OSType, info.Arch, info.Running, info.Containers)
	if info.OSType != "" && info.OSType != "linux" {
		return check{levelWarn, "Docker engine", detail, "Keelson servers are Linux hosts: this engine runs " + info.OSType + " containers"}, info
	}
	return check{levelOK, "Docker engine", detail, ""}, info
}

func checkConfig(appsFile, projectsDir string) (check, *config.Config) {
	loc := location(appsFile, projectsDir)
	bundle, err := loc.Read()
	if err != nil {
		return check{levelFail, "Configuration", err.Error(), "check the path of --apps, and that this account can read it"}, nil
	}
	cfg, issues := config.ParseBundle(bundle)
	if cfg == nil {
		var lines []string
		for _, is := range issues {
			if is.Severity != config.SeverityError {
				continue
			}
			if len(lines) == 3 {
				lines = append(lines, "...")
				break
			}
			where := issueFile(loc, is)
			if is.Line > 0 {
				where += fmt.Sprintf(":%d", is.Line)
			}
			lines = append(lines, where+": "+is.Message)
		}
		return check{levelFail, "Configuration", strings.Join(lines, "; "), "`keelson-agent config validate --apps " + appsFile + "` lists every problem; a running agent keeps the last good version"}, nil
	}
	detail := fmt.Sprintf("%s: %s, %s, %s", appsFile, plural(len(cfg.Apps), "app"), plural(len(cfg.Jobs), "job"), plural(len(cfg.Databases), "database"))
	for _, is := range issues {
		if is.Severity != config.SeverityError {
			return check{levelWarn, "Configuration", detail + ", with deprecated keys", "`keelson-agent config migrate --apps " + appsFile + " --dry-run`"}, cfg
		}
	}
	return check{levelOK, "Configuration", detail, ""}, cfg
}

// checkFiles looks at every file the configuration names: it has to exist and this account has to be able to read it. The
// agent reads some of them at every use (a registry password, a bearer), so a missing one is a failure at the worst moment.
func checkFiles(cfg *config.Config) []check {
	refs := cfg.FileRefs()
	who := "this account"
	if u, err := user.Current(); err == nil {
		who = u.Username
	}
	var out []check
	for _, r := range refs {
		fi, err := os.Stat(r.Path)
		switch {
		case err != nil:
			out = append(out, check{levelFail, "File " + r.Where, r.Path + ": " + unwrapPathError(err), "create it, or fix the path in the configuration"})
			continue
		case fi.IsDir():
			out = append(out, check{levelFail, "File " + r.Where, r.Path + " is a directory", "name a file"})
			continue
		}
		f, err := os.Open(r.Path)
		if err != nil {
			out = append(out, check{levelFail, "File " + r.Where, fmt.Sprintf("%s cannot be read by %s: %s", r.Path, who, unwrapPathError(err)), "the agent runs as root by default; if it runs as another account, that one must be able to read it"})
			continue
		}
		f.Close()
		if r.Secret() && fi.Mode().Perm()&0o007 != 0 {
			out = append(out, check{levelWarn, "File " + r.Where, fmt.Sprintf("%s is readable by every account (mode %04o)", r.Path, fi.Mode().Perm()), "chmod 600 " + r.Path + " (or 640 with the agent's group)"})
		}
	}
	if len(out) == 0 {
		return []check{{levelOK, "Files named", fmt.Sprintf("%d, all readable", len(refs)), ""}}
	}
	return out
}

func unwrapPathError(err error) string {
	var pe *os.PathError
	if errors.As(err, &pe) {
		return pe.Err.Error()
	}
	return err.Error()
}

func checkNotifications(cfg *config.Config) check {
	if cfg.Notifications == nil {
		return check{levelWarn, "Notifications", "none configured: a failed deployment, a dead app or a full disk is only logged", "add a notifications section (Telegram, webhook or heartbeat), then `keelson-agent notify-test`"}
	}
	return check{levelOK, "Notifications", "a notifications section is configured (`keelson-agent notify-test` sends a real message)", ""}
}

// checkData looks at the data directory and the database in it without changing the database. It returns the disk it is on.
func checkData(dir string) ([]check, *sysinfo.Disk) {
	fi, err := os.Stat(dir)
	if err != nil {
		if os.IsNotExist(err) {
			return []check{{levelWarn, "Data directory", dir + " does not exist yet", "the agent creates it at its first start; --data-dir names another"}}, nil
		}
		return []check{{levelFail, "Data directory", err.Error(), ""}}, nil
	}
	if !fi.IsDir() {
		return []check{{levelFail, "Data directory", dir + " is not a directory", ""}}, nil
	}
	var out []check
	probe := filepath.Join(dir, fmt.Sprintf(".doctor-%d", os.Getpid()))
	if err := os.WriteFile(probe, nil, 0o600); err != nil {
		out = append(out, check{levelFail, "Data directory", dir + " is not writable: " + unwrapPathError(err), "the agent keeps its database, its history and its backups of the apps file there"})
	} else {
		os.Remove(probe)
		out = append(out, check{levelOK, "Data directory", dir + " is writable", ""})
	}
	db := filepath.Join(dir, "agent.db")
	if _, err := os.Stat(db); err == nil {
		v, err := store.ReadSchemaVersion(db)
		switch {
		case err != nil:
			out = append(out, check{levelFail, "Database", db + " cannot be read: " + err.Error(), "restore agent.db from its daily copy in the data directory"})
		case v > store.SchemaVersion():
			out = append(out, check{levelFail, "Database", fmt.Sprintf("%s has schema %d, written by a newer agent than this one (which has %d)", db, v, store.SchemaVersion()),
				"install the newer agent again, or put back the copy an upgrade made: agent.db.before-upgrade-from-v<N>"})
		case v < store.SchemaVersion():
			out = append(out, check{levelOK, "Database", fmt.Sprintf("schema %d, this agent migrates it to %d at its next start (after copying it)", v, store.SchemaVersion()), ""})
		default:
			out = append(out, check{levelOK, "Database", fmt.Sprintf("schema %d, current", v), ""})
		}
	}
	return out, sysinfo.Read("/proc", dir).Disk
}

// diskCheck: the agent fails signed requests with a full disk (507), and Docker stops pulling.
func diskCheck(name string, d *sysinfo.Disk) check {
	if d.Total == 0 {
		return check{levelOK, name, "size unknown", ""}
	}
	usedPct := 100 - float64(d.Free)*100/float64(d.Total)
	detail := fmt.Sprintf("%.0f%% used, %s free of %s", usedPct, human(d.Free), human(d.Total))
	switch {
	case d.Free < 200<<20 || usedPct >= 99:
		return check{levelFail, name, detail, "free space now: a full disk stops deployments and the agent's own requests"}
	case d.Free < 2<<30 || usedPct >= 90:
		return check{levelWarn, name, detail, "`docker system df` shows what Docker holds; old images are pruned after keep_images deployments"}
	}
	return check{levelOK, name, detail, ""}
}

// checkCaddy asks the admin API of the Caddy the agent drives. Without apps behind it a missing Caddy is only a warning.
func checkCaddy(ctx context.Context, cfg *config.Config) (check, bool) {
	px := cfg.Proxy
	if px == nil || (px.Type != "" && px.Type != config.ProxyCaddy) {
		return check{}, false
	}
	admin := px.Admin
	if admin == "" {
		admin = config.DefaultProxyAdmin
	}
	ctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, strings.TrimRight(admin, "/")+"/config/", nil)
	resp, err := http.DefaultClient.Do(req)
	if err == nil {
		resp.Body.Close()
		if resp.StatusCode < 300 {
			return check{levelOK, "Caddy", "its admin API answers at " + admin, ""}, true
		}
		err = fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	level := levelWarn
	for _, a := range cfg.Apps {
		if a.Proxied() {
			level = levelFail // an app is deployed through it
			break
		}
	}
	return check{level, "Caddy", fmt.Sprintf("its admin API does not answer at %s: %v", admin, err), "start the Caddy dedicated to Keelson (docs/reference/proxy.md); apps with domains are not served without it"}, true
}

// checkDashboard reaches the dashboard a server that connects out is bound to, the one thing such a server cannot do without.
func checkDashboard(ctx context.Context, relayFile string) check {
	m, err := readMachine(relayFile)
	if err != nil {
		return check{levelFail, "Dashboard", err.Error(), ""}
	}
	base := strings.TrimRight(m.Dashboard, "/")
	if !strings.Contains(base, "://") {
		base = "https://" + base
	}
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, base+"/api/health", nil)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return check{levelFail, "Dashboard", fmt.Sprintf("%s cannot be reached: %v", base, err),
			"this server needs outbound HTTPS to it: check DNS, the firewall, and the clock (a wrong date fails TLS)"}
	}
	resp.Body.Close()
	if resp.StatusCode >= 500 {
		return check{levelWarn, "Dashboard", fmt.Sprintf("%s answers HTTP %d", base, resp.StatusCode), "the dashboard itself is failing: see its logs"}
	}
	return check{levelOK, "Dashboard", fmt.Sprintf("%s is reachable (HTTP %d)", base, resp.StatusCode), ""}
}
