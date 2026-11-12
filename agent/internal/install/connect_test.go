package install

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

const (
	testToken  = "t0ken-t0ken-t0ken-t0ken-t0ken-t0ken-aaaa"
	testSecret = "s3cret-s3cret-s3cret-s3cret-s3cret-bbbb"
	testRelay  = "{\n  \"dashboard\": \"https://keelson.example.com\",\n  \"credential\": \"cred-do-not-print\",\n  \"server_id\": \"srv-1\",\n  \"name\": \"vps-1\"\n}\n"
)

// registered counts the calls to the dashboard and answers like one that accepted the code.
type registered struct {
	calls int
	err   error
}

func (g *registered) register(context.Context) (Registration, error) {
	g.calls++
	if g.err != nil {
		return Registration{}, g.err
	}
	return Registration{Token: testToken, DeploySecret: testSecret, RelayJSON: []byte(testRelay), Name: "vps-1", ServerID: "srv-1", Dashboard: "https://keelson.example.com"}, nil
}

// connectRig is a rig whose service stays up once started, and that does not wait for it.
func connectRig(t *testing.T) (*rig, *registered) {
	r := newRig(t)
	r.sys.stillActive = true
	r.opts.settle = time.Nanosecond
	r.opts.Hosts = nil // a connected server is reached by no address
	return r, &registered{}
}

func (r *rig) connect(g *registered) (Connected, error) {
	r.t.Helper()
	return InstallConnected(context.Background(), r.opts, g.register)
}

func TestConnectedInstallWritesOnlyWhatAnOutboundServerNeeds(t *testing.T) {
	r, g := connectRig(t)
	var log []string
	r.opts.Log = func(f string, a ...any) { log = append(log, f) }
	c, err := r.connect(g)
	if err != nil {
		t.Fatal(err)
	}
	p := Paths{r.root}

	if c.Name != "vps-1" || c.ServerID != "srv-1" || c.Dashboard != "https://keelson.example.com" || c.AgentVersion != "1.2.3" {
		t.Errorf("connected: %+v", c)
	}
	for path, want := range map[string]os.FileMode{
		p.Token(): 0o640, p.DeploySecret(): 0o640, p.Relay(): 0o640, p.Apps(): 0o640, p.Binary(): 0o755, p.Unit(): 0o644,
		p.ConfDir(): 0o750, p.ConfigDir(): 0o750, p.DataDir(): 0o700,
	} {
		if got := mode(t, path); got != want {
			t.Errorf("%s: mode %o, want %o", path, got, want)
		}
	}
	for path, owner := range map[string]string{
		p.Token(): "root:keelson", p.DeploySecret(): "root:keelson", p.Relay(): "root:keelson", p.Apps(): "keelson:keelson",
		p.ConfDir(): "root:keelson", p.ConfigDir(): "keelson:keelson", p.DataDir(): "keelson:keelson",
	} {
		if r.sys.owners[path] != owner {
			t.Errorf("%s: owner %q, want %q", path, r.sys.owners[path], owner)
		}
	}
	if r.read("etc/keelson/token") != testToken+"\n" || r.read("etc/keelson/deploy-secret") != testSecret+"\n" || r.read("etc/keelson/relay.json") != testRelay {
		t.Error("the files hold what the registration gave")
	}
	if r.read("etc/keelson/config/apps.yaml") != starterApps {
		t.Errorf("apps file: %q", r.read("etc/keelson/config/apps.yaml"))
	}
	// Nothing for a listener: no certificates, no enrolment directory, no install record, no firewall.
	for _, absent := range []string{p.TLSDir(), p.EnrollDir(), p.Meta(), p.Sudoers()} {
		if exists(absent) {
			t.Errorf("%s must not exist on a connected server", absent)
		}
	}
	if len(r.sys.ufwAllows) != 0 {
		t.Error("a connected server opens no port")
	}

	unit := r.read("etc/systemd/system/keelson-agent.service")
	for _, want := range []string{
		"ExecStart=/usr/local/bin/keelson-agent serve --relay-file /etc/keelson/relay.json --listen= --token-file /etc/keelson/token --deploy-secret-file /etc/keelson/deploy-secret --apps /etc/keelson/config/apps.yaml --data-dir /var/lib/keelson\n",
		"User=keelson", "NoNewPrivileges=yes", "ProtectSystem=full", "ReadWritePaths=/etc/keelson/config -/etc/keelson/enroll /var/lib/keelson",
		"\nRestart=always\nRestartPreventExitStatus=78\n", "\nTimeoutStopSec=180\n",
	} {
		if !strings.Contains(unit, want) {
			t.Errorf("unit lacks %q:\n%s", want, unit)
		}
	}
	for _, not := range []string{"--tls-", "--enroll-dir", "--allow-insecure"} {
		if strings.Contains(unit, not) {
			t.Errorf("unit has %q:\n%s", not, unit)
		}
	}
	var cmds []string
	for _, c := range r.sys.ctl {
		cmds = append(cmds, strings.Join(c, " "))
	}
	if got := strings.Join(cmds, "|"); got != "daemon-reload|enable keelson-agent.service|restart keelson-agent.service|is-active --quiet keelson-agent.service" {
		t.Errorf("systemctl: %v", cmds)
	}
	if strings.Contains(strings.Join(log, "\n"), testToken) || strings.Contains(strings.Join(log, "\n"), "cred-do-not-print") {
		t.Error("the progress log must not carry a secret")
	}
}

func TestARefusedEnrolmentLeavesTheServerAsItWas(t *testing.T) {
	r, g := connectRig(t)
	g.err = errors.New("the code was refused")
	if _, err := r.connect(g); err == nil || !strings.Contains(err.Error(), "refused") {
		t.Fatalf("got %v", err)
	}
	if entries, _ := os.ReadDir(r.root); len(entries) != 0 {
		t.Errorf("a refused code must leave no file or directory, found %d entries", len(entries))
	}
	if len(r.sys.users) != 0 || len(r.sys.ctl) != 0 {
		t.Errorf("no account, no service: users %v, systemctl %v", r.sys.users, r.sys.ctl)
	}
}

func TestAConnectedServerIsNeverConnectedTwiceNorOverADirectOne(t *testing.T) {
	r, g := connectRig(t)
	if _, err := r.connect(g); err != nil {
		t.Fatal(err)
	}
	relayBefore := r.read("etc/keelson/relay.json")
	_, err := r.connect(g)
	if err == nil || !strings.Contains(err.Error(), "already connected") || !strings.Contains(err.Error(), "uninstall") {
		t.Fatalf("must refuse and say how to connect it again: %v", err)
	}
	if g.calls != 1 {
		t.Errorf("the dashboard was asked %d times: a refused second install must not spend a code", g.calls)
	}
	if r.read("etc/keelson/relay.json") != relayBefore {
		t.Error("relay.json must be untouched")
	}

	// A direct installation is not turned into a connected one by accident.
	d := newRig(t)
	d.install()
	g2 := &registered{}
	d.opts.Hosts = nil
	if _, err := InstallConnected(context.Background(), d.opts, g2.register); err == nil || !strings.Contains(err.Error(), "directly") || g2.calls != 0 {
		t.Errorf("a direct agent: %v (asked %d times)", err, g2.calls)
	}
	// And the other way round: a direct install on a connected server is refused, with the way to upgrade it.
	if _, err := Install(context.Background(), Options{Root: r.root, Binary: r.opts.Binary, Hosts: []string{"203.0.113.10"}, Sys: r.sys, HealthCheck: r.opts.HealthCheck}); err == nil || !strings.Contains(err.Error(), "install --upgrade") {
		t.Errorf("direct over connected: %v", err)
	}
}

func TestConnectedInstallWithoutDockerIsRefusedBeforeTheCodeIsSpent(t *testing.T) {
	r, g := connectRig(t)
	delete(r.sys.tools, "docker")
	if _, err := r.connect(g); err == nil || !strings.Contains(err.Error(), "Docker is not installed") || g.calls != 0 {
		t.Errorf("got %v after %d calls to the dashboard", err, g.calls)
	}
}

func TestConnectedInstallRefusesWithoutSystemd(t *testing.T) {
	r, g := connectRig(t)
	delete(r.sys.tools, "systemctl")
	if _, err := r.connect(g); err == nil || !strings.Contains(err.Error(), "systemd") || g.calls != 0 {
		t.Errorf("got %v after %d calls to the dashboard", err, g.calls)
	}
}

func TestAConnectedAgentThatDoesNotStayUpIsReportedAndKept(t *testing.T) {
	r, g := connectRig(t)
	r.sys.stillActive = false
	_, err := r.connect(g)
	if err == nil || !strings.Contains(err.Error(), "did not stay up") || !strings.Contains(err.Error(), "journalctl") {
		t.Fatalf("got %v", err)
	}
	// The dashboard has the server now: its files stay, so that fixing the cause and restarting connects it.
	if !exists(Paths{r.root}.Relay()) {
		t.Error("relay.json must stay: the server is registered")
	}
}

func TestUpgradeKeepsTheConnectedServerAndItsSecrets(t *testing.T) {
	r, g := connectRig(t)
	if _, err := r.connect(g); err != nil {
		t.Fatal(err)
	}
	files := map[string]string{}
	for _, f := range []string{"etc/keelson/token", "etc/keelson/deploy-secret", "etc/keelson/relay.json", "etc/keelson/config/apps.yaml"} {
		files[f] = r.read(f)
	}
	unitBefore := r.read("etc/systemd/system/keelson-agent.service")
	os.WriteFile(r.opts.Binary, []byte("#!/bin/sh\necho newer\n"), 0o755)

	if !IsConnected(r.root) {
		t.Fatal("a directory with relay.json is a connected server")
	}
	r.opts = Options{Root: r.root, Binary: r.opts.Binary, Version: "1.3.0", Sys: r.sys, Upgrade: true, settle: time.Nanosecond}
	c, err := InstallConnected(context.Background(), r.opts, nil)
	if err != nil {
		t.Fatal(err)
	}
	if c.Name != "vps-1" || c.ServerID != "srv-1" || c.AgentVersion != "1.3.0" {
		t.Errorf("upgraded: %+v", c)
	}
	if !strings.Contains(r.read("usr/local/bin/keelson-agent"), "newer") {
		t.Error("the binary must be replaced")
	}
	for f, before := range files {
		if r.read(f) != before {
			t.Errorf("%s must be kept as it was", f)
		}
	}
	if r.read("etc/systemd/system/keelson-agent.service") != unitBefore {
		t.Error("the unit must stay the connected one")
	}
}

func TestUpgradeOfAServerThatIsNotConnectedIsRefused(t *testing.T) {
	r, _ := connectRig(t)
	r.opts.Upgrade = true
	if _, err := InstallConnected(context.Background(), r.opts, nil); err == nil || !strings.Contains(err.Error(), "not connected") {
		t.Errorf("got %v", err)
	}
	if exists(filepath.Join(r.root, "usr/local/bin/keelson-agent")) {
		t.Error("a refused upgrade installs nothing")
	}
}

func TestAConnectedUpgradeThatDoesNotStartPutsThePreviousVersionBack(t *testing.T) {
	r, g := connectRig(t)
	if _, err := r.connect(g); err != nil {
		t.Fatal(err)
	}
	binBefore := r.read("usr/local/bin/keelson-agent")
	// What is on disk when the upgrade starts is what must come back, whoever wrote it.
	unitBefore := r.read("etc/systemd/system/keelson-agent.service") + "# local\n"
	os.WriteFile(filepath.Join(r.root, "etc/systemd/system/keelson-agent.service"), []byte(unitBefore), 0o644)
	os.WriteFile(r.opts.Binary, []byte("#!/bin/sh\necho broken\n"), 0o755)

	r.sys.stillActive = false
	r.opts = Options{Root: r.root, Binary: r.opts.Binary, Version: "1.3.0", Sys: r.sys, Upgrade: true, settle: time.Nanosecond}
	_, err := InstallConnected(context.Background(), r.opts, nil)
	if err == nil || !strings.Contains(err.Error(), "previous version was restored") {
		t.Fatalf("got %v", err)
	}
	if r.read("etc/systemd/system/keelson-agent.service") != unitBefore || r.read("usr/local/bin/keelson-agent") != binBefore {
		t.Error("the unit and the binary must be back as they were")
	}
	if exists(Paths{r.root}.Binary() + ".prev") {
		t.Error("the backup copy must not be left behind")
	}
}

// The installer's file list must name what a connected install writes as well as what a direct one does.
func TestInstallerFilesCoverTheConnectedInstallToo(t *testing.T) {
	r, g := connectRig(t)
	if _, err := r.connect(g); err != nil {
		t.Fatal(err)
	}
	p := Paths{r.root}
	if got := operatorFiles(p); len(got) != 0 {
		t.Errorf("a connected install has no operator files: %v", got)
	}
}

func TestUninstallOfAConnectedServerRemovesItsCredential(t *testing.T) {
	r, g := connectRig(t)
	if _, err := r.connect(g); err != nil {
		t.Fatal(err)
	}
	p := Paths{r.root}
	r.sys.stillActive = false // the service is stopped once `disable --now` ran

	rep, err := r.uninstall(false, true)
	if err != nil || !strings.Contains(joined(rep.Removed), "/etc/keelson/relay.json") || !exists(p.Relay()) {
		t.Fatalf("a dry run says it and changes nothing: %v %v", err, rep.Removed)
	}
	rep, err = r.uninstall(false, false)
	if err != nil {
		t.Fatal(err)
	}
	if exists(p.Relay()) || exists(p.Unit()) || exists(p.Binary()) {
		t.Error("the unit, the binary and the credential are removed")
	}
	if !strings.Contains(joined(rep.Removed), "/etc/keelson/relay.json") {
		t.Errorf("relay.json must be in the report: %v", rep.Removed)
	}
	if !exists(p.Token()) || !exists(p.Apps()) || !exists(p.DataDir()) {
		t.Error("without --purge the apps file, secrets and data stay")
	}

	// A server that was uninstalled can be connected again.
	r.sys.stillActive = true
	g2 := &registered{}
	if _, err := r.connect(g2); err != nil || g2.calls != 1 {
		t.Fatalf("connect again: %v", err)
	}
	r.sys.stillActive = false
	if _, err := r.uninstall(true, false); err != nil {
		t.Fatal(err)
	}
	for _, gone := range append(p.installerFiles(), p.DataDir(), p.Unit(), p.Binary()) {
		if exists(gone) {
			t.Errorf("a purge must remove %s", gone)
		}
	}
}

// Nothing is removed from a connected server whose agent cannot be stopped, the credential included.
func TestUninstallThatCannotStopAConnectedAgentRemovesNothing(t *testing.T) {
	r, g := connectRig(t)
	if _, err := r.connect(g); err != nil {
		t.Fatal(err)
	}
	r.sys.stopErr = errors.New("busy")
	if _, err := r.uninstall(false, false); err == nil {
		t.Fatal("must fail")
	}
	if !exists(Paths{r.root}.Relay()) || !exists(Paths{r.root}.Unit()) {
		t.Error("nothing may be removed")
	}
}
