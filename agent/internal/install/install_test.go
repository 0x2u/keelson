package install

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// fakeSystem records what the installer asks of the machine.
type fakeSystem struct {
	users     []string
	groups    map[string]bool
	owners    map[string]string
	ctl       [][]string
	tools     map[string]string
	ufw       bool
	ufwAllows []string
	ufwDels   []string
	allowErr  error
	sudoersOK error
	removed   []string
	// rules are the allow rules ufw already holds, "from:port"; true when the installer wrote them.
	rules map[string]bool
	// stopErr makes "systemctl disable" fail; stillActive makes the service report as running after it.
	stopErr     error
	stillActive bool
	removeErr   error
	containers  []string
	docker      *DockerProbe
	// onRestart runs at the first "systemctl restart": the new version starting.
	onRestart func()
}

func newFake() *fakeSystem {
	return &fakeSystem{
		groups: map[string]bool{"docker": true},
		owners: map[string]string{},
		tools:  map[string]string{"systemctl": "/usr/bin/systemctl", "docker": "/usr/bin/docker", "nginx": "/usr/sbin/nginx"},
	}
}

func (f *fakeSystem) EnsureUser(name string, groups []string) error {
	f.users = append(f.users, name)
	return nil
}
func (f *fakeSystem) GroupExists(name string) bool { return f.groups[name] }
func (f *fakeSystem) Chown(path, owner, group string) error {
	f.owners[path] = owner + ":" + group
	return nil
}
func (f *fakeSystem) Systemctl(args ...string) error {
	f.ctl = append(f.ctl, args)
	if args[0] == "restart" && f.onRestart != nil {
		run := f.onRestart
		f.onRestart = nil
		run()
	}
	switch args[0] {
	case "disable":
		return f.stopErr
	case "is-active":
		if f.stillActive {
			return nil
		}
		return errors.New("inactive")
	}
	return nil
}
func (f *fakeSystem) LookPath(name string) (string, error) {
	if p, ok := f.tools[name]; ok {
		return p, nil
	}
	return "", errors.New("not found")
}
func (f *fakeSystem) ValidateSudoers(string) error { return f.sudoersOK }
func (f *fakeSystem) UfwActive() bool              { return f.ufw }
func (f *fakeSystem) UfwAllow(from string, port int) error {
	f.ufwAllows = append(f.ufwAllows, from)
	if f.allowErr == nil {
		if f.rules == nil {
			f.rules = map[string]bool{}
		}
		f.rules[fmt.Sprintf("%s:%d", from, port)] = true
	}
	return f.allowErr
}
func (f *fakeSystem) UfwDelete(from string, port int) error {
	f.ufwDels = append(f.ufwDels, from)
	delete(f.rules, fmt.Sprintf("%s:%d", from, port))
	return nil
}
func (f *fakeSystem) UfwRule(from string, port int) (bool, bool) {
	ours, exists := f.rules[fmt.Sprintf("%s:%d", from, port)]
	return exists, ours
}
func (f *fakeSystem) RemoveUser(name string) error {
	if f.removeErr != nil {
		return f.removeErr
	}
	f.removed = append(f.removed, name)
	return nil
}
func (f *fakeSystem) ManagedContainers() ([]string, error) { return f.containers, nil }

// DockerProbe answers like a healthy engine reached through the docker group, unless a test set docker; with no
// docker tool and no probe given it answers like a machine without Docker.
func (f *fakeSystem) DockerProbe(socket string) DockerProbe {
	if f.docker != nil {
		probe := *f.docker
		probe.Socket = socket
		return probe
	}
	if _, ok := f.tools["docker"]; !ok {
		return DockerProbe{Socket: socket, PingErr: errors.New("no such file")}
	}
	return DockerProbe{Socket: socket, Resolved: socket, Group: "docker", Server: "Docker/27.3.1 (linux)"}
}

type rig struct {
	t    *testing.T
	root string
	sys  *fakeSystem
	opts Options
}

func newRig(t *testing.T) *rig {
	t.Helper()
	root := t.TempDir()
	bin := filepath.Join(t.TempDir(), "keelson-agent")
	if err := os.WriteFile(bin, []byte("#!/bin/sh\necho agent\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	sys := newFake()
	return &rig{t: t, root: root, sys: sys, opts: Options{
		Root: root, Binary: bin, Hosts: []string{"203.0.113.10"}, Name: "vps-1", Version: "1.2.3", Sys: sys,
		HealthCheck: func(string, []byte, Leaf) error { return nil },
	}}
}

func (r *rig) install() Bundle {
	r.t.Helper()
	b, err := Install(context.Background(), r.opts)
	if err != nil {
		r.t.Fatal(err)
	}
	return b
}

func (r *rig) read(rel string) string {
	b, err := os.ReadFile(filepath.Join(r.root, rel))
	if err != nil {
		r.t.Fatal(err)
	}
	return string(b)
}

func mode(t *testing.T, path string) os.FileMode {
	t.Helper()
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	return info.Mode().Perm()
}

func TestInstallLaysOutFilesWithTheRightModesAndOwners(t *testing.T) {
	r := newRig(t)
	b := r.install()
	p := Paths{r.root}

	if b.URL != "https://203.0.113.10:7443" || b.Name != "vps-1" || b.AgentVersion != "1.2.3" || len(b.Token) != 64 || len(b.DeploySecret) != 64 || b.Token == b.DeploySecret {
		t.Errorf("bundle: %+v", b)
	}
	want := map[string]os.FileMode{
		p.Token(): 0o640, p.DeploySecret(): 0o640, p.CAKey(): 0o600, p.ServerKey(): 0o640,
		p.CACert(): 0o644, p.ServerCert(): 0o644, p.Apps(): 0o640, p.Binary(): 0o755, p.Unit(): 0o644,
		// The agent deletes redeemed codes: it needs write access to the directory, not to the files in it.
		p.EnrollDir(): 0o770,
	}
	for path, m := range want {
		if got := mode(t, path); got != m {
			t.Errorf("%s: mode %o, want %o", path, got, m)
		}
	}
	// The agent's account must not be able to read the CA key; it can read what it serves with.
	for path, owner := range map[string]string{
		p.CAKey(): "root:root", p.Token(): "root:keelson", p.ServerKey(): "root:keelson", p.Apps(): "keelson:keelson",
		p.ConfigDir(): "keelson:keelson", p.DataDir(): "keelson:keelson", p.ConfDir(): "root:keelson", p.EnrollDir(): "root:keelson",
	} {
		if r.sys.owners[path] != owner {
			t.Errorf("%s: owner %q, want %q", path, r.sys.owners[path], owner)
		}
	}
	if len(r.sys.users) != 1 || r.sys.users[0] != "keelson" {
		t.Errorf("users: %v", r.sys.users)
	}
	if got := r.read("etc/keelson/config/apps.yaml"); !strings.Contains(got, "apps: []") {
		t.Errorf("starter apps file: %q", got)
	}
	var cmds []string
	for _, c := range r.sys.ctl {
		cmds = append(cmds, strings.Join(c, " "))
	}
	if strings.Join(cmds, "|") != "daemon-reload|enable keelson-agent.service|restart keelson-agent.service" {
		t.Errorf("systemctl: %v", cmds)
	}
}

func TestIssuedCertificatesWorkForMutualTLS13(t *testing.T) {
	r := newRig(t)
	b := r.install()

	caPool := x509.NewCertPool()
	if !caPool.AppendCertsFromPEM([]byte(b.CACert)) {
		t.Fatal("CA certificate does not parse")
	}
	serverCert, err := tls.LoadX509KeyPair(filepath.Join(r.root, "etc/keelson/tls/server.crt"), filepath.Join(r.root, "etc/keelson/tls/server.key"))
	if err != nil {
		t.Fatal(err)
	}
	// The same TLS settings as the agent: TLS 1.3, a client certificate signed by the CA is required.
	srv := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.Write([]byte("ok")) }))
	srv.TLS = &tls.Config{MinVersion: tls.VersionTLS13, Certificates: []tls.Certificate{serverCert}, ClientCAs: caPool, ClientAuth: tls.RequireAndVerifyClientCert}
	srv.StartTLS()
	defer srv.Close()

	clientCert, err := tls.X509KeyPair([]byte(b.ClientCert), []byte(b.ClientKey))
	if err != nil {
		t.Fatal(err)
	}
	// The address in the certificate is the one the dashboard will use; here the server is on loopback, which every
	// server certificate also covers.
	good := &http.Client{Transport: &http.Transport{TLSClientConfig: &tls.Config{RootCAs: caPool, Certificates: []tls.Certificate{clientCert}, MinVersion: tls.VersionTLS13}}}
	resp, err := good.Get(srv.URL)
	if err != nil {
		t.Fatalf("a client with the issued certificate must be accepted: %v", err)
	}
	resp.Body.Close()

	anon := &http.Client{Transport: &http.Transport{TLSClientConfig: &tls.Config{RootCAs: caPool, MinVersion: tls.VersionTLS13}}}
	if resp, err := anon.Get(srv.URL); err == nil {
		resp.Body.Close()
		t.Error("a client without a certificate must be refused")
	}

	other, _, _ := NewCA("someone else", time.Now())
	foreign, _ := other.IssueClient(time.Now())
	fc, _ := tls.X509KeyPair(foreign.CertPEM, foreign.KeyPEM)
	impostor := &http.Client{Transport: &http.Transport{TLSClientConfig: &tls.Config{RootCAs: caPool, Certificates: []tls.Certificate{fc}, MinVersion: tls.VersionTLS13}}}
	if resp, err := impostor.Get(srv.URL); err == nil {
		resp.Body.Close()
		t.Error("a certificate from another CA must be refused")
	}
}

func TestServerCertificateCoversTheHostsTheDashboardUses(t *testing.T) {
	r := newRig(t)
	r.opts.Hosts = []string{"203.0.113.10", "agent.example.com"}
	b := r.install()
	cert, err := parseCert([]byte(b.CACert))
	if err != nil || !cert.IsCA {
		t.Fatalf("CA: %v", err)
	}
	server, _ := parseCert([]byte(r.read("etc/keelson/tls/server.crt")))
	for _, h := range []string{"203.0.113.10", "agent.example.com", "127.0.0.1", "localhost"} {
		if err := server.VerifyHostname(h); err != nil {
			t.Errorf("%s: %v", h, err)
		}
	}
	if server.VerifyHostname("evil.example.com") == nil {
		t.Error("the certificate must not cover other names")
	}
}

func TestReinstallKeepsSecretsAndCAButIssuesAFreshClientCertificate(t *testing.T) {
	r := newRig(t)
	first := r.install()
	// A new host name is added: the server certificate is reissued, the identity of the server is not.
	r.opts.Hosts = []string{"203.0.113.10", "new.example.com"}
	second := r.install()

	if first.Token != second.Token || first.DeploySecret != second.DeploySecret || first.CACert != second.CACert {
		t.Error("secrets and the CA must survive a reinstall")
	}
	if first.ClientCert == second.ClientCert || first.ClientKey == second.ClientKey {
		t.Error("each bundle carries its own client certificate")
	}
	server, _ := parseCert([]byte(r.read("etc/keelson/tls/server.crt")))
	if server.VerifyHostname("new.example.com") != nil {
		t.Error("the server certificate must be reissued to cover the new host")
	}
	// An edited apps file is the operator's: it is never overwritten.
	os.WriteFile(filepath.Join(r.root, "etc/keelson/config/apps.yaml"), []byte("apps: [] # mine\n"), 0o640)
	r.install()
	if !strings.Contains(r.read("etc/keelson/config/apps.yaml"), "# mine") {
		t.Error("the apps file must be kept")
	}
}

func TestNginxOptionCreatesTheDirectoryAndAScopedSudoersRule(t *testing.T) {
	r := newRig(t)
	r.opts.WithNginx = true
	b := r.install()
	p := Paths{r.root}
	if r.sys.owners[p.NginxDir()] != "keelson:keelson" {
		t.Errorf("nginx dir owner: %q", r.sys.owners[p.NginxDir()])
	}
	rule := r.read("etc/sudoers.d/keelson")
	if !strings.Contains(rule, "keelson ALL=(root) NOPASSWD: /usr/bin/systemctl reload nginx, /usr/sbin/nginx -t") || strings.Count(rule, "NOPASSWD") != 1 {
		t.Errorf("sudoers: %q", rule)
	}
	if mode(t, p.Sudoers()) != 0o440 {
		t.Errorf("sudoers mode: %o", mode(t, p.Sudoers()))
	}
	unit := r.read("etc/systemd/system/keelson-agent.service")
	if strings.Contains(unit, "\nNoNewPrivileges=yes") || !strings.Contains(unit, "-/etc/nginx/keelson") {
		t.Errorf("the unit must allow sudo and the nginx dir:\n%s", unit)
	}
	if len(b.Notes) != 1 || !strings.Contains(b.Notes[0], "include /etc/nginx/keelson/*.conf") {
		t.Errorf("notes: %v", b.Notes)
	}
}

func TestUpgradeReplacesTheBinaryAndKeepsHowTheAgentWasInstalled(t *testing.T) {
	r := newRig(t)
	r.opts.WithNginx = true
	r.opts.Listen = "0.0.0.0:7555"
	r.opts.Hosts = []string{"203.0.113.10", "vps.example.com"}
	first := r.install()
	unitBefore := r.read("etc/systemd/system/keelson-agent.service")

	// An upgrade is given the new binary and nothing else: no host, no listen address, no --nginx.
	os.WriteFile(r.opts.Binary, []byte("#!/bin/sh\necho newer\n"), 0o755)
	r.opts = Options{Root: r.root, Binary: r.opts.Binary, Version: "1.3.0", Sys: r.sys, Upgrade: true, HealthCheck: r.opts.HealthCheck}
	second := r.install()

	if !strings.Contains(r.read("usr/local/bin/keelson-agent"), "newer") {
		t.Error("the binary must be replaced")
	}
	if r.read("etc/systemd/system/keelson-agent.service") != unitBefore {
		t.Error("the unit must be what the installation had: listen address and the nginx privileges included")
	}
	if _, err := os.Stat(filepath.Join(r.root, "etc/sudoers.d/keelson")); err != nil {
		t.Error("the nginx rule must still be there")
	}
	if second.URL != first.URL || second.AgentVersion != "1.3.0" || second.Token != first.Token || second.CACert != first.CACert {
		t.Errorf("same address, same secrets, new version: %+v", second)
	}
	if !strings.Contains(r.read("etc/keelson/install.json"), "vps.example.com") {
		t.Error("the remembered host names must survive")
	}
}

// The agent drains for up to ~150 s when it is stopped: an installation made before the unit said so must get the
// longer stop timeout from an upgrade.
func TestUpgradeRewritesAnOldUnitWithTheStopTimeout(t *testing.T) {
	r := newRig(t)
	r.install()
	unitPath := filepath.Join(r.root, "etc/systemd/system/keelson-agent.service")
	old := strings.Replace(r.read("etc/systemd/system/keelson-agent.service"), "TimeoutStopSec=180\n", "", 1)
	if strings.Contains(old, "TimeoutStopSec") {
		t.Fatal("the fixture must be a unit without it")
	}
	if err := os.WriteFile(unitPath, []byte(old), 0o644); err != nil {
		t.Fatal(err)
	}
	r.opts = Options{Root: r.root, Binary: r.opts.Binary, Version: "1.3.0", Sys: r.sys, Upgrade: true, HealthCheck: r.opts.HealthCheck}
	r.install()
	if !strings.Contains(r.read("etc/systemd/system/keelson-agent.service"), "\nTimeoutStopSec=180\n") {
		t.Error("the upgrade must rewrite the unit with TimeoutStopSec=180")
	}
}

func TestUpgradeRefusesAnAgentThatIsNotInstalled(t *testing.T) {
	r := newRig(t)
	r.opts = Options{Root: r.root, Binary: r.opts.Binary, Sys: r.sys, Upgrade: true, HealthCheck: r.opts.HealthCheck}
	_, err := Install(context.Background(), r.opts)
	if err == nil || !strings.Contains(err.Error(), "not installed") {
		t.Fatalf("want a refusal, got %v", err)
	}
	if _, statErr := os.Stat(filepath.Join(r.root, "usr/local/bin/keelson-agent")); statErr == nil {
		t.Error("nothing must be installed by a refused upgrade")
	}
}

func TestWithoutNginxTheUnitForbidsGainingPrivileges(t *testing.T) {
	r := newRig(t)
	r.install()
	unit := r.read("etc/systemd/system/keelson-agent.service")
	for _, want := range []string{"NoNewPrivileges=yes", "ProtectSystem=full", "User=keelson", "--tls-client-ca /etc/keelson/tls/ca.crt", "ReadWritePaths=/etc/keelson/config -/etc/keelson/enroll /var/lib/keelson", "--enroll-dir /etc/keelson/enroll", "\nTimeoutStopSec=180\n"} {
		if !strings.Contains(unit, want) {
			t.Errorf("unit lacks %q:\n%s", want, unit)
		}
	}
	if _, err := os.Stat(filepath.Join(r.root, "etc/sudoers.d/keelson")); err == nil {
		t.Error("no sudoers rule without the nginx option")
	}
}

func TestNginxOptionFailsCleanlyWhenNginxOrTheSudoersRuleIsBad(t *testing.T) {
	r := newRig(t)
	r.opts.WithNginx = true
	delete(r.sys.tools, "nginx")
	if _, err := Install(context.Background(), r.opts); err == nil || !strings.Contains(err.Error(), "nginx") {
		t.Errorf("missing nginx: %v", err)
	}
	r = newRig(t)
	r.opts.WithNginx = true
	r.sys.sudoersOK = errors.New("syntax error")
	if _, err := Install(context.Background(), r.opts); err == nil {
		t.Error("a rejected sudoers rule must fail the install")
	}
	if _, err := os.Stat(filepath.Join(r.root, "etc/sudoers.d/keelson")); err == nil {
		t.Error("a rejected sudoers rule must not be left behind")
	}
}

func TestFirewallIsOpenedOnlyForTheGivenAddressAndOnlyWhenUfwIsActive(t *testing.T) {
	r := newRig(t)
	r.opts.AllowFrom = "198.51.100.7"
	r.sys.ufw = true
	r.install()
	if len(r.sys.ufwAllows) != 1 || r.sys.ufwAllows[0] != "198.51.100.7" {
		t.Errorf("ufw: %v", r.sys.ufwAllows)
	}

	r = newRig(t)
	r.opts.AllowFrom = "198.51.100.7"
	b := r.install()
	if len(r.sys.ufwAllows) != 0 || len(b.Notes) != 1 || !strings.Contains(b.Notes[0], "ufw is not active") {
		t.Errorf("inactive ufw: %v %v", r.sys.ufwAllows, b.Notes)
	}

	r = newRig(t)
	r.sys.ufw = true
	r.install()
	if len(r.sys.ufwAllows) != 0 {
		t.Error("without an address nothing is opened")
	}

	r = newRig(t)
	r.opts.AllowFrom = "198.51.100.7"
	r.sys.ufw, r.sys.allowErr = true, errors.New("boom")
	if b := r.install(); len(b.Notes) != 1 || !strings.Contains(b.Notes[0], "open it yourself") {
		t.Errorf("a failed rule is reported, not fatal: %v", b.Notes)
	}
}

func TestInstallRefusesBadInputAndMissingPrerequisites(t *testing.T) {
	r := newRig(t)
	r.opts.Hosts = nil
	if _, err := Install(context.Background(), r.opts); err == nil || !strings.Contains(err.Error(), "--host") {
		t.Errorf("no host: %v", err)
	}
	r = newRig(t)
	r.opts.Listen = "nonsense"
	if _, err := Install(context.Background(), r.opts); err == nil {
		t.Error("bad listen address")
	}
	r = newRig(t)
	r.opts.Listen = "0.0.0.0:99999"
	if _, err := Install(context.Background(), r.opts); err == nil {
		t.Error("bad port")
	}
	r = newRig(t)
	delete(r.sys.tools, "docker")
	if _, err := Install(context.Background(), r.opts); err == nil || !strings.Contains(err.Error(), "Docker") {
		t.Errorf("no docker: %v", err)
	}
	r = newRig(t)
	delete(r.sys.tools, "systemctl")
	if _, err := Install(context.Background(), r.opts); err == nil || !strings.Contains(err.Error(), "systemd") {
		t.Errorf("no systemd: %v", err)
	}
}

func TestInstallFailsWhenTheAgentDoesNotAnswer(t *testing.T) {
	r := newRig(t)
	r.opts.HealthCheck = func(string, []byte, Leaf) error { return errors.New("connection refused") }
	ctx, cancel := context.WithTimeout(context.Background(), 600*time.Millisecond)
	defer cancel()
	_, err := Install(ctx, r.opts)
	if err == nil || !strings.Contains(err.Error(), "did not come up") {
		t.Errorf("want a clear failure, got %v", err)
	}
}

func TestAFailedUpgradeRestoresThePreviousUnitBinaryAndSettings(t *testing.T) {
	r := newRig(t)
	r.install()
	p := Paths{r.root}
	unitBefore := r.read("etc/systemd/system/keelson-agent.service")
	binBefore := r.read("usr/local/bin/keelson-agent")
	metaBefore := r.read("etc/keelson/install.json")

	// The new version listens somewhere that does not work, and ships a different binary.
	os.WriteFile(r.opts.Binary, []byte("#!/bin/sh\necho broken\n"), 0o755)
	r.opts.Listen = "0.0.0.0:80"
	r.opts.HealthCheck = func(string, []byte, Leaf) error { return errors.New("connection refused") }
	ctx, cancel := context.WithTimeout(context.Background(), 600*time.Millisecond)
	defer cancel()
	_, err := Install(ctx, r.opts)
	if err == nil || !strings.Contains(err.Error(), "previous version was restored") {
		t.Fatalf("want a restore message, got %v", err)
	}
	if r.read("etc/systemd/system/keelson-agent.service") != unitBefore || r.read("usr/local/bin/keelson-agent") != binBefore || r.read("etc/keelson/install.json") != metaBefore {
		t.Error("the unit, the binary and the settings must be back as they were")
	}
	if _, err := os.Stat(p.Binary() + ".prev"); err == nil {
		t.Error("the backup copy must not be left behind after a restore")
	}
	last := r.sys.ctl[len(r.sys.ctl)-1]
	if strings.Join(last, " ") != "restart keelson-agent.service" {
		t.Errorf("the restored agent must be restarted, last call: %v", last)
	}

	// A successful upgrade removes the backup.
	r.opts.HealthCheck = func(string, []byte, Leaf) error { return nil }
	r.opts.Listen = DefaultListen
	r.install()
	if _, err := os.Stat(p.Binary() + ".prev"); err == nil {
		t.Error("the backup copy is removed once the upgrade works")
	}
}
