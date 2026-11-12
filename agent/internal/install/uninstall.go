package install

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

// UninstallOptions say how far an uninstall goes.
type UninstallOptions struct {
	// Purge also deletes the apps file, secrets, certificates and history, the firewall rule the install added and the
	// account. Without it everything that describes what the agent ran stays, and a later install picks it up.
	Purge bool
	// PurgeOperatorFiles, with Purge, also deletes the files under /etc/keelson the installer did not write (database
	// password files, a Telegram token): without it they are left and listed.
	PurgeOperatorFiles bool
	// DryRun changes nothing: the report says what would be done.
	DryRun bool
}

// UninstallReport says what an uninstall did, or with DryRun what it would do. Each line is for a person to read.
type UninstallReport struct {
	// Installed is false when there was nothing of the agent on this server.
	Installed bool `json:"installed"`
	// Service is true when the agent's service is installed: stopping it is part of the uninstall.
	Service bool     `json:"service"`
	DryRun  bool     `json:"dry_run"`
	Purge   bool     `json:"purge"`
	Removed []string `json:"removed"`
	// Kept is what was deliberately left, with the reason.
	Kept []string `json:"kept"`
	// Containers are the apps' containers, which an uninstall never stops or removes: they keep running, unmanaged.
	Containers []string `json:"containers"`
	// Problems are steps that failed after the agent had stopped; the others still ran.
	Problems []string `json:"problems"`
}

// Uninstall removes the agent from the server without touching what it ran:
//
//   - The apps' containers are never stopped or removed. They keep serving, with their restart policy, and only stop
//     being managed. The report lists them.
//   - The agent is stopped first, and if it cannot be stopped nothing is removed: a half-removed unit that restarts on
//     its own and crashes is worse than the agent.
//   - The nginx upstream file is deleted only when no nginx configuration refers to its upstreams: removing it
//     otherwise would make the next reload (a certificate renewal, any change) fail with the site down. When it stays,
//     it is handed to root, as the account that wrote it is going away.
//   - A firewall rule is removed only if it carries the comment the installer gives its own rules.
//   - Once the agent has stopped, a failing step does not prevent the others: every problem is reported together.
//
// Without Purge the apps file, secrets, certificates, history and account stay, so removing the agent never deletes
// the description of what it ran. Running it again, or on a server without the agent, is harmless.
func Uninstall(o Options, uo UninstallOptions) (UninstallReport, error) {
	if uo.PurgeOperatorFiles && !uo.Purge {
		return UninstallReport{}, errors.New("--purge-operator-files only means something with --purge")
	}
	if err := o.defaultsForUninstall(); err != nil {
		return UninstallReport{}, err
	}
	p := Paths{o.Root}
	sys := o.Sys
	if o.Log == nil {
		o.Log = func(string, ...any) {}
	}
	rep := UninstallReport{DryRun: uo.DryRun, Purge: uo.Purge, Removed: []string{}, Kept: []string{}, Containers: []string{}, Problems: []string{}}
	m := readMeta(p)

	if list, err := sys.ManagedContainers(); err == nil {
		rep.Containers = append(rep.Containers, list...)
	}

	hasUnit, hasBinary := fileExists(p.Unit()), fileExists(p.Binary())
	hasConf, hasData := fileExists(p.ConfDir()), fileExists(p.DataDir())
	rep.Installed = hasUnit || hasBinary || hasConf || hasData
	rep.Service = hasUnit
	if !rep.Installed {
		return rep, nil
	}
	did := func(what string) { rep.Removed = append(rep.Removed, what) }
	kept := func(what string) { rep.Kept = append(rep.Kept, what) }
	problem := func(what string, err error) { rep.Problems = append(rep.Problems, fmt.Sprintf("%s: %v", what, err)) }

	// 1. Stop the agent. Nothing else is touched until it is stopped.
	if hasUnit {
		if !uo.DryRun {
			o.Log("stopping the agent")
			if err := sys.Systemctl("disable", "--now", unitName); err != nil {
				return rep, fmt.Errorf("could not stop the agent, so nothing was removed: %w", err)
			}
			if sys.Systemctl("is-active", "--quiet", unitName) == nil {
				return rep, errors.New("the agent is still running after being stopped, so nothing was removed")
			}
		}
		did("the keelson-agent service (stopped and disabled)")
	}

	// 2. Its program and unit, and the credential a connected server holds: a dashboard that has been told to forget this
	// server refuses it, and keeping the file would stop it from being connected again.
	for _, f := range []string{p.Unit(), p.Binary(), p.Binary() + ".prev", p.Relay()} {
		if !fileExists(f) {
			continue
		}
		if err := removeFile(uo.DryRun, f); err != nil {
			problem("remove "+displayPath(o.Root, f), err)
			continue
		}
		did(displayPath(o.Root, f))
	}
	if hasUnit && !uo.DryRun {
		_ = sys.Systemctl("daemon-reload")
		_ = sys.Systemctl("reset-failed", unitName)
	}

	if !uo.Purge {
		if hasConf {
			kept(displayPath(o.Root, p.ConfDir()) + ": the apps file, secrets and certificates (a later install reuses them)")
		}
		if hasData {
			kept(displayPath(o.Root, p.DataDir()) + ": deployment records, job runs and stats history")
		}
		if len(m.AllowFrom) > 0 {
			kept(fmt.Sprintf("the ufw rule for %s to port %d", strings.Join(m.AllowFrom, ", "), listenPort(m.Listen)))
		}
		kept("the " + ServiceUser + " account")
		return rep, finish(rep)
	}

	// 3. Purge: what the install added to the rest of the system, then its own files, then the account.
	port := listenPort(m.Listen)
	for _, from := range m.AllowFrom {
		what := fmt.Sprintf("the ufw rule for %s to port %d", from, port)
		if !sys.UfwActive() {
			kept(what + ": ufw is not active, so it was not touched")
			continue
		}
		exists, ours := sys.UfwRule(from, port)
		switch {
		case !exists:
			continue // already gone
		case !ours:
			kept(what + ": it was not written by Keelson")
			continue
		}
		if !uo.DryRun {
			if err := sys.UfwDelete(from, port); err != nil {
				problem("remove "+what, err)
				continue
			}
		}
		did(what)
	}

	if fileExists(p.Sudoers()) {
		if err := removeFile(uo.DryRun, p.Sudoers()); err != nil {
			problem("remove the sudoers rule", err)
		} else {
			did(displayPath(o.Root, p.Sudoers()))
		}
	}

	if fileExists(p.NginxDir()) {
		if refs := nginxReferences(p); len(refs) > 0 {
			kept(fmt.Sprintf("%s: nginx still uses its upstreams (%s). Deleting it would make the next nginx reload fail. The apps keep running behind it; edit or remove it when you retire them", displayPath(o.Root, p.NginxDir()), strings.Join(refs, ", ")))
			if !uo.DryRun {
				if err := handToRoot(sys, p.NginxDir()); err != nil {
					problem("hand "+displayPath(o.Root, p.NginxDir())+" to root", err)
				}
			}
		} else if err := removeAll(uo.DryRun, p.NginxDir()); err != nil {
			problem("remove "+displayPath(o.Root, p.NginxDir()), err)
		} else {
			did(displayPath(o.Root, p.NginxDir()) + " (no nginx configuration uses it)")
		}
	}

	if fileExists(p.DataDir()) {
		for _, line := range postgresState(o.Root, p) {
			did(line)
		}
	}
	var operator []string
	if !uo.PurgeOperatorFiles {
		operator = operatorFiles(p)
	}
	for _, f := range operator {
		kept(displayPath(o.Root, f) + ": operator-added file, kept: pass --purge-operator-files to delete")
	}
	for _, dir := range []string{p.ConfDir(), p.DataDir()} {
		if !fileExists(dir) {
			continue
		}
		if dir == p.ConfDir() && len(operator) > 0 {
			if err := removeInstallerConfig(uo.DryRun, p); err != nil {
				problem("remove the installer's files in "+displayPath(o.Root, dir), err)
				continue
			}
			// The account that owned the directory is going away; a number left behind could be handed to another.
			if !uo.DryRun {
				if err := handToRoot(sys, dir); err != nil {
					problem("hand "+displayPath(o.Root, dir)+" to root", err)
				}
			}
			did(displayPath(o.Root, dir) + ": the installer's own files (the operator's files stay)")
			continue
		}
		if dir == p.ConfDir() {
			for _, f := range operatorFiles(p) {
				did(displayPath(o.Root, f) + ": operator-added file (--purge-operator-files)")
			}
		}
		if err := removeAll(uo.DryRun, dir); err != nil {
			problem("remove "+displayPath(o.Root, dir), err)
			continue
		}
		did(displayPath(o.Root, dir))
	}

	if !uo.DryRun {
		if err := sys.RemoveUser(ServiceUser); err != nil {
			problem("remove the "+ServiceUser+" account", err)
		} else {
			did("the " + ServiceUser + " account")
		}
	} else {
		did("the " + ServiceUser + " account")
	}
	return rep, finish(rep)
}

func removeFile(dryRun bool, path string) error {
	if dryRun {
		return nil
	}
	return os.Remove(path)
}

func removeAll(dryRun bool, path string) error {
	if dryRun {
		return nil
	}
	return os.RemoveAll(path)
}

func finish(rep UninstallReport) error {
	if len(rep.Problems) == 0 {
		return nil
	}
	return fmt.Errorf("the agent was removed, but %d step(s) failed: %s", len(rep.Problems), strings.Join(rep.Problems, "; "))
}

// displayPath shows a path as the server sees it, without the test root.
func displayPath(root, path string) string {
	if root == "" || root == "/" {
		return path
	}
	if rel, err := filepath.Rel(root, path); err == nil {
		return "/" + filepath.ToSlash(rel)
	}
	return path
}

func (o *Options) defaultsForUninstall() error {
	if o.Root == "" {
		o.Root = "/"
	}
	if o.Sys == nil {
		o.Sys = HostSystem()
	}
	return nil
}

// upstreamName matches the upstream blocks the nginx driver writes (keelson_<app>).
var upstreamName = regexp.MustCompile(`\bkeelson_[A-Za-z0-9_.-]+`)

const maxNginxFile = 1 << 20

// nginxReferences lists the nginx configuration files outside the agent's own directory that use one of its upstreams
// (a proxy_pass to keelson_<app>). A symlink such as sites-enabled/shop is followed, and reported by its own name.
func nginxReferences(p Paths) []string {
	var found []string
	own := p.NginxDir()
	_ = filepath.WalkDir(p.at("etc/nginx"), func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if d.IsDir() {
			if path == own {
				return filepath.SkipDir
			}
			return nil
		}
		info, err := os.Stat(path) // follows a symlink to its target
		if err != nil || !info.Mode().IsRegular() || info.Size() > maxNginxFile {
			return nil
		}
		data, err := os.ReadFile(path)
		if err == nil && upstreamName.Match(data) {
			found = append(found, displayPath(p.Root, path))
		}
		return nil
	})
	return found
}

// handToRoot gives a directory and its files to root: the account that owned them is being removed, and a number left
// behind could be handed to a different account later.
func handToRoot(sys System, dir string) error {
	var first error
	_ = filepath.WalkDir(dir, func(path string, _ fs.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if err := sys.Chown(path, "root", "root"); err != nil && first == nil {
			first = err
		}
		return nil
	})
	return first
}
