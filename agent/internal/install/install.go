// Package install puts the agent on a server: an unprivileged account, its files, certificates for mutual TLS, a
// systemd unit and, when asked, the few privileges nginx needs. It is the one thing the dashboard asks a server to
// do over SSH, once; after that the agent runs on its own.
package install

import (
	"context"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// Names and defaults.
const (
	ServiceUser   = "keelson"
	DefaultListen = "0.0.0.0:7443"
	unitName      = "keelson-agent.service"
)

// Paths locates every file the installer manages under a root directory ("/" on a real server).
type Paths struct{ Root string }

func (p Paths) at(rel string) string { return filepath.Join(p.Root, rel) }

func (p Paths) Binary() string       { return p.at("usr/local/bin/keelson-agent") }
func (p Paths) ConfDir() string      { return p.at("etc/keelson") }
func (p Paths) ConfigDir() string    { return p.at("etc/keelson/config") }
func (p Paths) Apps() string         { return p.at("etc/keelson/config/apps.yaml") }
func (p Paths) TLSDir() string       { return p.at("etc/keelson/tls") }
func (p Paths) Token() string        { return p.at("etc/keelson/token") }
func (p Paths) DeploySecret() string { return p.at("etc/keelson/deploy-secret") }
func (p Paths) Relay() string        { return p.at("etc/keelson/relay.json") }
func (p Paths) CACert() string       { return p.at("etc/keelson/tls/ca.crt") }
func (p Paths) CAKey() string        { return p.at("etc/keelson/tls/ca.key") }
func (p Paths) ServerCert() string   { return p.at("etc/keelson/tls/server.crt") }
func (p Paths) ServerKey() string    { return p.at("etc/keelson/tls/server.key") }
func (p Paths) Meta() string         { return p.at("etc/keelson/install.json") }
func (p Paths) DataDir() string      { return p.at("var/lib/keelson") }
func (p Paths) Unit() string         { return p.at("etc/systemd/system/" + unitName) }
func (p Paths) Sudoers() string      { return p.at("etc/sudoers.d/keelson") }
func (p Paths) NginxDir() string     { return p.at("etc/nginx/keelson") }

// Options configure an installation.
type Options struct {
	// Root is the filesystem root; empty means "/". Tests install into a temporary directory.
	Root string
	// Binary is the executable to install: normally the running one.
	Binary string
	// Listen is where the agent listens, "host:port".
	Listen string
	// Hosts are the names and addresses the dashboard reaches the server by: certificate subject names. The first one
	// is the host of the URL in the bundle.
	Hosts []string
	// Name labels the server in the dashboard.
	Name    string
	Version string
	// WithNginx gives the agent what it needs to switch traffic through nginx: a directory it can write the upstream
	// file to, and permission to test and reload nginx, nothing else.
	WithNginx bool
	// AllowFrom, when set, is opened in ufw (if it is active) for the agent's port: the dashboard's address.
	AllowFrom string

	Sys System
	Log func(format string, args ...any)
	// Now is replaceable in tests.
	Now func() time.Time
	// HealthCheck proves the agent answers over mutual TLS. Replaceable in tests.
	HealthCheck func(listen string, caPEM []byte, client Leaf) error
	// SkipDockerCheck lets tests install on a machine without Docker.
	SkipDockerCheck bool
	// Upgrade installs this binary over the one already installed, with the settings the installation remembers
	// (listen address, host names, name, nginx): nothing else has to be given, and an agent that is not installed
	// is refused. The apps file, secrets and certificate authority are kept as for any re-install.
	Upgrade bool
	// NoEnrolmentCode skips the enrolment code a fresh install ends with (an upgrade never makes one).
	NoEnrolmentCode bool
	// settle is how long a connected agent must stay up after starting (tests shorten it).
	settle time.Duration
}

// Bundle is what the dashboard needs to talk to the agent. The client key is in it: it is shown once, here.
type Bundle struct {
	Version      int    `json:"version"`
	Name         string `json:"name"`
	URL          string `json:"url"`
	Token        string `json:"token"`
	DeploySecret string `json:"deploy_secret"`
	CACert       string `json:"ca_cert"`
	ClientCert   string `json:"client_cert"`
	ClientKey    string `json:"client_key"`
	AgentVersion string `json:"agent_version"`
	// Notes are things the person installing should know (a closed firewall, nginx steps).
	Notes []string `json:"notes,omitempty"`
	// Enrolment is an enrolment string for pasting into the dashboard instead of the five values above, valid until
	// EnrolmentExpires (RFC 3339). It is absent for an upgrade and when the install was asked not to make one.
	Enrolment        string `json:"enrolment,omitempty"`
	EnrolmentExpires string `json:"enrolment_expires,omitempty"`
}

// meta remembers how the agent was installed, for upgrades and uninstalling.
type meta struct {
	Listen    string   `json:"listen"`
	Hosts     []string `json:"hosts"`
	Name      string   `json:"name"`
	Nginx     bool     `json:"nginx"`
	AllowFrom []string `json:"allow_from,omitempty"`
}

// commonDefaults completes what every kind of install needs.
func (o *Options) commonDefaults() error {
	if o.Root == "" {
		o.Root = "/"
	}
	if o.Listen == "" {
		o.Listen = DefaultListen
	}
	if o.Log == nil {
		o.Log = func(string, ...any) {}
	}
	if o.Now == nil {
		o.Now = time.Now
	}
	if o.Sys == nil {
		o.Sys = HostSystem()
	}
	if o.HealthCheck == nil {
		o.HealthCheck = checkHealth
	}
	if o.Name == "" {
		o.Name, _ = os.Hostname()
	}
	if o.Binary == "" {
		exe, err := os.Executable()
		if err != nil {
			return err
		}
		o.Binary = exe
	}
	return nil
}

// defaults completes the options of a direct install, which listens and so needs an address and the names it is reached by.
func (o *Options) defaults() error {
	if err := o.commonDefaults(); err != nil {
		return err
	}
	if _, port, err := net.SplitHostPort(o.Listen); err != nil {
		return fmt.Errorf("listen address %q: %w", o.Listen, err)
	} else if n, err := strconv.Atoi(port); err != nil || n < 1 || n > 65535 {
		return fmt.Errorf("listen address %q: invalid port", o.Listen)
	}
	hosts := o.Hosts[:0:0]
	for _, h := range o.Hosts {
		if h = strings.TrimSpace(h); h != "" {
			hosts = append(hosts, h)
		}
	}
	if len(hosts) == 0 {
		return errors.New("give at least one host name or address the dashboard will use (--host)")
	}
	o.Hosts = hosts
	return nil
}

func listenPort(listen string) int {
	_, p, _ := net.SplitHostPort(listen)
	n, _ := strconv.Atoi(p)
	return n
}

// Install installs or upgrades the agent and returns the bundle for the dashboard. It is safe to run again: secrets,
// certificate authority and data are kept, a new client certificate is issued, the binary and unit are refreshed.
func Install(ctx context.Context, o Options) (Bundle, error) {
	if relay := (Paths{rootOrSlash(o.Root)}).Relay(); fileExists(relay) {
		return Bundle{}, fmt.Errorf("this server is connected to a dashboard (%s exists): upgrade it with `keelson-agent install --upgrade`, or uninstall it before setting it up for a direct connection", relay)
	}
	if o.Upgrade {
		if err := o.reuseInstalledSettings(); err != nil {
			return Bundle{}, err
		}
	}
	if err := o.defaults(); err != nil {
		return Bundle{}, err
	}
	p := Paths{o.Root}
	sys := o.Sys
	now := o.Now()

	if _, err := sys.LookPath("systemctl"); err != nil {
		return Bundle{}, errors.New("systemd is required: this server does not run it")
	}
	if !o.SkipDockerCheck {
		if err := checkDocker(sys, p); err != nil {
			return Bundle{}, err
		}
	}

	o.Log("creating the %s account and its directories", ServiceUser)
	if err := sys.EnsureUser(ServiceUser, []string{"docker"}); err != nil {
		return Bundle{}, fmt.Errorf("create the %s account: %w", ServiceUser, err)
	}
	if err := mkdir(sys, p.ConfDir(), 0o750, "root", ServiceUser); err != nil {
		return Bundle{}, err
	}
	// The agent rewrites its apps file by renaming a new one over it, so it needs write access to the directory.
	if err := mkdir(sys, p.ConfigDir(), 0o750, ServiceUser, ServiceUser); err != nil {
		return Bundle{}, err
	}
	if err := mkdir(sys, p.TLSDir(), 0o750, "root", ServiceUser); err != nil {
		return Bundle{}, err
	}
	// Where the agent finds the pending enrolment codes root leaves for it, and deletes them once redeemed.
	if err := mkdir(sys, p.EnrollDir(), 0o770, "root", ServiceUser); err != nil {
		return Bundle{}, err
	}
	if err := mkdir(sys, p.DataDir(), 0o700, ServiceUser, ServiceUser); err != nil {
		return Bundle{}, err
	}

	o.Log("generating secrets")
	token, err := keepOrCreateSecret(sys, p.Token())
	if err != nil {
		return Bundle{}, err
	}
	deploy, err := keepOrCreateSecret(sys, p.DeploySecret())
	if err != nil {
		return Bundle{}, err
	}
	if !fileExists(p.Apps()) {
		if err := put(sys, p.Apps(), []byte(starterApps), 0o640, ServiceUser, ServiceUser); err != nil {
			return Bundle{}, err
		}
	}

	o.Log("preparing certificates for mutual TLS")
	ca, err := loadOrCreateCA(sys, p, o.Name, now)
	if err != nil {
		return Bundle{}, err
	}
	if err := ensureServerCert(sys, p, ca, o.Hosts, now); err != nil {
		return Bundle{}, err
	}
	client, err := ca.IssueClient(now)
	if err != nil {
		return Bundle{}, err
	}

	var notes []string
	if o.WithNginx {
		n, err := setUpNginx(sys, p)
		if err != nil {
			return Bundle{}, err
		}
		notes = append(notes, n...)
	}

	o.Log("installing the agent")
	previous := readMeta(p)
	prevUnit, unitErr := os.ReadFile(p.Unit())
	hadUnit := unitErr == nil
	prevBinary := p.Binary() + ".prev"
	hadBinary := fileExists(p.Binary()) && copyBinary(p.Binary(), prevBinary) == nil
	dbBefore := snapshotsOf(p)
	if err := copyBinary(o.Binary, p.Binary()); err != nil {
		return Bundle{}, fmt.Errorf("install the binary: %w", err)
	}
	unit := renderUnit(unitSpec{Listen: o.Listen, Nginx: o.WithNginx})
	if err := put(sys, p.Unit(), []byte(unit), 0o644, "", ""); err != nil {
		return Bundle{}, err
	}

	m := meta{Listen: o.Listen, Hosts: o.Hosts, Name: o.Name, Nginx: o.WithNginx, AllowFrom: previous.AllowFrom}
	port := listenPort(o.Listen)
	if o.AllowFrom != "" {
		switch {
		case !sys.UfwActive():
			notes = append(notes, fmt.Sprintf("ufw is not active: make sure port %d is reachable from the dashboard", port))
		case ufwRuleExists(sys, o.AllowFrom, port):
			// Not ours to remove later: leave it out of the install's record.
			notes = append(notes, fmt.Sprintf("ufw already allows %s to port %d: that rule was left as it is", o.AllowFrom, port))
		case sys.UfwAllow(o.AllowFrom, port) != nil:
			notes = append(notes, fmt.Sprintf("could not open port %d for %s in ufw: open it yourself", port, o.AllowFrom))
		default:
			o.Log("opened port %d for %s in ufw", port, o.AllowFrom)
			if !contains(m.AllowFrom, o.AllowFrom) {
				m.AllowFrom = append(m.AllowFrom, o.AllowFrom)
			}
		}
	}
	if err := writeMeta(sys, p, m); err != nil {
		return Bundle{}, err
	}

	o.Log("starting the service")
	if err := sys.Systemctl("daemon-reload"); err != nil {
		return Bundle{}, err
	}
	if err := sys.Systemctl("enable", unitName); err != nil {
		return Bundle{}, err
	}
	if err := sys.Systemctl("restart", unitName); err != nil {
		return Bundle{}, fmt.Errorf("start the agent: %w", err)
	}
	if err := waitHealthy(ctx, o, ca.PEM, client); err != nil {
		if hadUnit {
			// An upgrade that does not start must not take a working agent down: put the previous one back.
			o.Log("the new version did not start: restoring the previous one")
			_ = put(sys, p.Unit(), prevUnit, 0o644, "", "")
			if hadBinary {
				_ = os.Rename(prevBinary, p.Binary())
			}
			if previous.Listen != "" {
				_ = writeMeta(sys, p, previous)
			}
			restoreDatabase(sys, p, dbBefore, o.Log)
			_ = sys.Systemctl("daemon-reload")
			_ = sys.Systemctl("restart", unitName)
			return Bundle{}, fmt.Errorf("the agent did not come up: %w (the previous version was restored; see: journalctl -u keelson-agent)", err)
		}
		return Bundle{}, fmt.Errorf("the agent did not come up: %w (see: journalctl -u keelson-agent)", err)
	}
	_ = os.Remove(prevBinary)

	b := Bundle{
		Version: 1, Name: o.Name,
		URL:   "https://" + net.JoinHostPort(o.Hosts[0], strconv.Itoa(port)),
		Token: token, DeploySecret: deploy,
		CACert: string(ca.PEM), ClientCert: string(client.CertPEM), ClientKey: string(client.KeyPEM),
		AgentVersion: o.Version, Notes: notes,
	}
	if !o.Upgrade && !o.NoEnrolmentCode {
		// The install succeeded: a code that cannot be made is a note, not a failure.
		e, err := CreateEnrolment(EnrolOptions{Root: o.Root, Sys: sys, Now: o.Now})
		if err != nil {
			b.Notes = append(b.Notes, "could not create an enrolment code: "+err.Error())
		} else {
			b.Enrolment, b.EnrolmentExpires = e.String, e.Expires.UTC().Format(time.RFC3339)
		}
	}
	return b, nil
}

// starterApps is the apps file a new agent starts with: nothing to manage yet. It is edited from the dashboard.
const starterApps = "# Keelson apps file. Edit it here or from the dashboard: changes apply without a restart.\napps: []\n"

func mkdir(sys System, path string, mode os.FileMode, owner, group string) error {
	if err := os.MkdirAll(path, mode); err != nil {
		return err
	}
	if err := os.Chmod(path, mode); err != nil {
		return err
	}
	return sys.Chown(path, owner, group)
}

// put writes a file with the given mode and owner (left alone when owner is empty).
func put(sys System, path string, data []byte, mode os.FileMode, owner, group string) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(path), ".keelson-*")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Chmod(mode); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := os.Rename(tmp.Name(), path); err != nil {
		return err
	}
	if owner != "" {
		return sys.Chown(path, owner, group)
	}
	return nil
}

func keepOrCreateSecret(sys System, path string) (string, error) {
	if b, err := os.ReadFile(path); err == nil && len(strings.TrimSpace(string(b))) >= 32 {
		return strings.TrimSpace(string(b)), nil
	}
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		return "", err
	}
	secret := hex.EncodeToString(raw)
	// Readable by the agent's group only.
	return secret, put(sys, path, []byte(secret+"\n"), 0o640, "root", ServiceUser)
}

func loadOrCreateCA(sys System, p Paths, name string, now time.Time) (*CA, error) {
	certPEM, err1 := os.ReadFile(p.CACert())
	keyPEM, err2 := os.ReadFile(p.CAKey())
	if err1 == nil && err2 == nil {
		if ca, err := LoadCA(certPEM, keyPEM); err == nil && now.Before(ca.Cert.NotAfter) {
			return ca, nil
		}
	}
	ca, keyPEM, err := NewCA(name, now)
	if err != nil {
		return nil, err
	}
	// The CA key is root's alone: the agent, which is reachable from the network, never holds it.
	if err := put(sys, p.CAKey(), keyPEM, 0o600, "root", "root"); err != nil {
		return nil, err
	}
	if err := put(sys, p.CACert(), ca.PEM, 0o644, "root", ServiceUser); err != nil {
		return nil, err
	}
	return ca, nil
}

func ensureServerCert(sys System, p Paths, ca *CA, hosts []string, now time.Time) error {
	if b, err := os.ReadFile(p.ServerCert()); err == nil && ServerCertCovers(b, append([]string{"127.0.0.1"}, hosts...), now) {
		if _, err := os.Stat(p.ServerKey()); err == nil {
			return nil
		}
	}
	leaf, err := ca.IssueServer(append([]string{"127.0.0.1", "localhost"}, hosts...), now)
	if err != nil {
		return err
	}
	if err := put(sys, p.ServerKey(), leaf.KeyPEM, 0o640, "root", ServiceUser); err != nil {
		return err
	}
	return put(sys, p.ServerCert(), leaf.CertPEM, 0o644, "root", ServiceUser)
}

// setUpNginx gives the agent exactly what the nginx driver needs: a directory for the upstream file, and the right
// to test and reload nginx. It returns the instructions the person still has to follow in nginx itself.
func setUpNginx(sys System, p Paths) ([]string, error) {
	if err := mkdir(sys, p.NginxDir(), 0o755, ServiceUser, ServiceUser); err != nil {
		return nil, err
	}
	nginxBin, err := sys.LookPath("nginx")
	if err != nil {
		return nil, errors.New("nginx was asked for but is not installed on this server")
	}
	systemctl, err := sys.LookPath("systemctl")
	if err != nil {
		return nil, err
	}
	rule := fmt.Sprintf("# Written by keelson-agent install: the agent may test and reload nginx, nothing else.\n%s ALL=(root) NOPASSWD: %s reload nginx, %s -t\n", ServiceUser, systemctl, nginxBin)
	if err := put(sys, p.Sudoers(), []byte(rule), 0o440, "root", "root"); err != nil {
		return nil, err
	}
	if err := sys.ValidateSudoers(p.Sudoers()); err != nil {
		_ = os.Remove(p.Sudoers())
		return nil, fmt.Errorf("the sudoers rule for nginx was rejected: %w", err)
	}
	return []string{
		"nginx: add `include /etc/nginx/keelson/*.conf;` to the http block, then use these in the apps file: " +
			fmt.Sprintf("proxy: {type: nginx, upstreams_file: /etc/nginx/keelson/upstreams.conf, test: [sudo, %s, -t], reload: [sudo, %s, reload, nginx]}", nginxBin, systemctl),
	}, nil
}

func copyBinary(from, to string) error {
	src, err := os.Open(from)
	if err != nil {
		return err
	}
	defer src.Close()
	if err := os.MkdirAll(filepath.Dir(to), 0o755); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(to), ".keelson-agent-*")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	if _, err := io.Copy(tmp, src); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Chmod(0o755); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	// Renaming over a running binary is fine on Linux: the old one keeps running until the restart.
	return os.Rename(tmp.Name(), to)
}

func readMeta(p Paths) meta {
	var m meta
	if b, err := os.ReadFile(p.Meta()); err == nil {
		_ = json.Unmarshal(b, &m)
	}
	return m
}

func writeMeta(sys System, p Paths, m meta) error {
	b, err := json.MarshalIndent(m, "", "  ")
	if err != nil {
		return err
	}
	return put(sys, p.Meta(), append(b, '\n'), 0o644, "root", "root")
}

func contains(list []string, s string) bool {
	for _, v := range list {
		if v == s {
			return true
		}
	}
	return false
}

func waitHealthy(ctx context.Context, o Options, caPEM []byte, client Leaf) error {
	var last error
	deadline := time.Now().Add(25 * time.Second)
	for time.Now().Before(deadline) {
		if last = o.HealthCheck(o.Listen, caPEM, client); last == nil {
			return nil
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(500 * time.Millisecond):
		}
	}
	return last
}

// checkHealth asks the agent for /v1/health the way the dashboard will: over TLS 1.3 with a client certificate.
func checkHealth(listen string, caPEM []byte, client Leaf) error {
	pool := x509.NewCertPool()
	if !pool.AppendCertsFromPEM(caPEM) {
		return errors.New("bad CA certificate")
	}
	cert, err := tls.X509KeyPair(client.CertPEM, client.KeyPEM)
	if err != nil {
		return err
	}
	_, port, _ := net.SplitHostPort(listen)
	hc := &http.Client{
		Timeout: 3 * time.Second,
		Transport: &http.Transport{TLSClientConfig: &tls.Config{
			RootCAs: pool, Certificates: []tls.Certificate{cert}, MinVersion: tls.VersionTLS13, ServerName: "localhost",
		}},
	}
	resp, err := hc.Get("https://" + net.JoinHostPort("127.0.0.1", port) + "/v1/health")
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("health answered %d (is the Docker engine reachable by the %s account?)", resp.StatusCode, ServiceUser)
	}
	return nil
}

func ufwRuleExists(sys System, from string, port int) bool {
	exists, _ := sys.UfwRule(from, port)
	return exists
}
