package install

import (
	"fmt"
	"os"
	"os/exec"
	"os/user"
	"strconv"
	"strings"
)

// System is everything the installer does to the machine besides writing files. A fake stands in for it in tests.
type System interface {
	// EnsureUser creates the system account (no login, no home worth keeping) and adds it to the groups that exist.
	EnsureUser(name string, groups []string) error
	GroupExists(name string) bool
	// Chown sets the owner and group of a path, by name.
	Chown(path, owner, group string) error
	Systemctl(args ...string) error
	LookPath(name string) (string, error)
	// ValidateSudoers checks a sudoers drop-in with visudo.
	ValidateSudoers(path string) error
	UfwActive() bool
	UfwAllow(from string, port int) error
	UfwDelete(from string, port int) error
	// UfwRule looks for an allow rule for the port from that address: whether it exists, and whether it carries the
	// comment this installer gives its own, which is how a rule it added is told from one the operator wrote.
	UfwRule(from string, port int) (exists, ours bool)
	RemoveUser(name string) error
	// ManagedContainers lists the containers the agent started (labelled keelson.app) with their state, "name: status".
	// It reads the engine and changes nothing; an engine that cannot be reached gives an error.
	ManagedContainers() ([]string, error)
	// DockerProbe asks the engine at the socket whether it answers and who may use the socket. It changes nothing.
	DockerProbe(socket string) DockerProbe
}

// hostSystem acts on the real machine.
type hostSystem struct{}

// HostSystem returns the System that changes the machine it runs on. It needs root.
func HostSystem() System { return hostSystem{} }

func run(name string, args ...string) error {
	out, err := exec.Command(name, args...).CombinedOutput()
	if err != nil {
		return fmt.Errorf("%s %s: %w: %s", name, strings.Join(args, " "), err, strings.TrimSpace(string(out)))
	}
	return nil
}

func (hostSystem) GroupExists(name string) bool {
	_, err := user.LookupGroup(name)
	return err == nil
}

func (s hostSystem) EnsureUser(name string, groups []string) error {
	if _, err := user.Lookup(name); err != nil {
		if err := run("useradd", "--system", "--user-group", "--no-create-home", "--home-dir", "/var/lib/"+name, "--shell", "/usr/sbin/nologin", name); err != nil {
			return err
		}
	}
	for _, g := range groups {
		if s.GroupExists(g) {
			if err := run("usermod", "-aG", g, name); err != nil {
				return err
			}
		}
	}
	return nil
}

func (hostSystem) Chown(path, owner, group string) error {
	u, err := user.Lookup(owner)
	if err != nil {
		return err
	}
	g, err := user.LookupGroup(group)
	if err != nil {
		return err
	}
	uid, _ := strconv.Atoi(u.Uid)
	gid, _ := strconv.Atoi(g.Gid)
	return os.Chown(path, uid, gid)
}

func (hostSystem) Systemctl(args ...string) error { return run("systemctl", args...) }

func (hostSystem) LookPath(name string) (string, error) {
	if p, err := exec.LookPath(name); err == nil {
		return p, nil
	}
	// Administrative tools live in sbin, which an unprivileged PATH may omit.
	for _, dir := range []string{"/usr/sbin", "/sbin", "/usr/local/sbin"} {
		if p := dir + "/" + name; fileExists(p) {
			return p, nil
		}
	}
	return "", fmt.Errorf("%s not found", name)
}

func (hostSystem) ValidateSudoers(path string) error {
	if _, err := exec.LookPath("visudo"); err != nil {
		return nil // nothing to check with; the file is a single plain rule
	}
	return run("visudo", "-cf", path)
}

func (hostSystem) UfwActive() bool {
	out, err := exec.Command("ufw", "status").CombinedOutput()
	return err == nil && strings.Contains(string(out), "Status: active")
}

func (hostSystem) UfwAllow(from string, port int) error {
	return run("ufw", "allow", "from", from, "to", "any", "port", strconv.Itoa(port), "proto", "tcp", "comment", ufwComment)
}

func (hostSystem) UfwDelete(from string, port int) error {
	return run("ufw", "--force", "delete", "allow", "from", from, "to", "any", "port", strconv.Itoa(port), "proto", "tcp")
}

// ufwComment is what UfwAllow writes next to the rules it adds.
const ufwComment = "keelson-agent"

func (hostSystem) UfwRule(from string, port int) (exists, ours bool) {
	out, err := exec.Command("ufw", "status").CombinedOutput()
	if err != nil {
		return false, false
	}
	return parseUfwRule(string(out), from, port)
}

// parseUfwRule reads `ufw status`: a line such as "7443/tcp   ALLOW   198.51.100.7   # keelson-agent".
func parseUfwRule(status, from string, port int) (exists, ours bool) {
	want := strconv.Itoa(port)
	for _, line := range strings.Split(status, "\n") {
		line, comment, _ := strings.Cut(line, "#")
		f := strings.Fields(line)
		if len(f) >= 3 && f[1] == "ALLOW" && f[2] == "IN" { // newer ufw writes "ALLOW IN"
			f = append(f[:2], f[3:]...)
		}
		if len(f) < 3 || f[1] != "ALLOW" || f[2] != from {
			continue
		}
		if f[0] != want && f[0] != want+"/tcp" {
			continue
		}
		exists = true
		if strings.TrimSpace(comment) == ufwComment {
			ours = true
		}
	}
	return exists, ours
}

func (s hostSystem) ManagedContainers() ([]string, error) {
	docker, err := s.LookPath("docker")
	if err != nil {
		return nil, err
	}
	out, err := exec.Command(docker, "ps", "-a", "--filter", "label=keelson.app", "--format", "{{.Names}}: {{.Status}}").Output()
	if err != nil {
		return nil, err
	}
	var list []string
	for _, l := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		if l != "" {
			list = append(list, l)
		}
	}
	return list, nil
}

func (hostSystem) RemoveUser(name string) error {
	if _, err := user.Lookup(name); err != nil {
		return nil
	}
	return run("userdel", name)
}

func fileExists(p string) bool {
	_, err := os.Stat(p)
	return err == nil
}
