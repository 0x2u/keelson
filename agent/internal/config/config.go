// Package config loads the declarative description of the apps an agent
// manages. The file is the desired state: it is written by the operator (and
// later by the dashboard), and read by the agent.
package config

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"sort"
	"strconv"
	"strings"
	"time"
)

const (
	DefaultStopTimeout   = 10 * time.Second
	DefaultHealthTimeout = 90 * time.Second
	DefaultStableAfter   = 10 * time.Second
	// MinHealthTimeout is the shortest health timeout: below it the new container could not even start.
	MinHealthTimeout  = time.Second
	DefaultKeepImages = 3
	MaxKeepImages     = 100
	// DefaultRestart is the restart policy of an app that names none: it comes back after a reboot or a crash.
	DefaultRestart = "unless-stopped"
)

var restartAllowed = map[string]bool{"": true, "no": true, "always": true, "unless-stopped": true, "on-failure": true}

// ValidName reports whether s is a well-formed app, job or database name.
func ValidName(s string) bool { return namePattern.MatchString(s) }

// Registry holds credentials for pulling private images.
type Registry struct {
	// Host is the registry host, such as ghcr.io.
	Host     string `yaml:"host"`
	Username string `yaml:"username"`
	// PasswordFile is read at every pull, so a rotated token needs no restart.
	PasswordFile string `yaml:"password_file"`
}

// App is one container the agent deploys and keeps running.
type App struct {
	Name string `yaml:"name"`
	// Project and Environment place the app in the dashboard's Projects view: the same project on several servers
	// (or several apps of one server) with a different environment each, such as production and staging. They label
	// only: nothing here changes how the app runs. Both are optional; the dashboard reads a missing project as the
	// app's name and a missing environment as "production".
	Project string `yaml:"project"`
	// Stage is the environment (the field is named so because App already has an Environment method).
	Stage string `yaml:"environment"`
	// Image is the repository without tag or digest. Deploy requests only
	// choose the tag or digest, never the repository: whoever can call the
	// deploy API cannot make the agent run an arbitrary image.
	Image   string            `yaml:"image"`
	EnvFile string            `yaml:"env_file"`
	Env     map[string]string `yaml:"env"`
	// Publish are the fixed port mappings "[hostip:]hostport:containerport[/proto]".
	Publish []string `yaml:"publish"`
	// Volumes are "source:target[:mode]" binds.
	Volumes []string `yaml:"volumes"`
	// Network is a network name, or "host".
	Network string `yaml:"network"`
	// Restart is the Docker restart policy: no, always, unless-stopped or on-failure. Default unless-stopped.
	Restart string   `yaml:"restart"`
	Command []string `yaml:"command"`
	// StopTimeout is the grace period before the old container is killed. Default 10s; 0s kills at once.
	StopTimeout *Duration `yaml:"stop_timeout"`
	// HealthTimeout bounds the wait for the new container to become healthy. Default 90s.
	HealthTimeout *Duration `yaml:"health_timeout"`
	// StableAfter is how long a container must keep running (an image without HEALTHCHECK) or keep reporting healthy
	// (an image with one, only when the file sets stable_after) before the traffic switches. Default 10s.
	StableAfter *Duration `yaml:"stable_after"`
	// StableAfterSet says the file gave stable_after: an image with a HEALTHCHECK then has to stay healthy that long
	// too. Without it such an image counts as healthy at its first healthy report, as it always did. Never read from
	// the file.
	StableAfterSet bool `yaml:"-"`
	// Domains route public hostnames to the app through the reverse proxy.
	// An app with domains is deployed blue/green: the new container runs next
	// to the old one and traffic switches once it is healthy, so there is no
	// outage. It needs Port and the top-level proxy section.
	Domains []string `yaml:"domains"`
	// Port is the port of a blue/green app: the container port the proxy forwards to (the agent publishes it on a random
	// loopback host port), or, with network: host, the two host ports the app alternates between and the variable
	// that tells it which one to listen on. See PortSpec.
	Port PortSpec `yaml:"port"`
	// ContainerPort, HostPorts and PortEnv are Port as the runtime reads it. Never read from the file.
	ContainerPort int    `yaml:"-"`
	HostPorts     []int  `yaml:"-"`
	PortEnv       string `yaml:"-"`
	// HealthPath, if set, is requested over HTTP on the new container's port
	// and must answer 2xx before traffic switches. It checks the port the new
	// container really listens on, which an image HEALTHCHECK with a fixed
	// port would not.
	HealthPath string `yaml:"health_path"`
	// Release runs between the pull and the switch: backup, migration.
	Release *Release `yaml:"release"`
	// Log sets how Docker keeps the container's output. Without it, logs are rotated (json-file, 10 MiB, 3 files): an
	// app that logs a lot must not fill the disk.
	Log *Log `yaml:"log"`
	// KeepImages is how many of the most recently deployed versions stay on the server (the running one included);
	// older images of this app are removed after a successful deployment. Default 3.
	KeepImages *int `yaml:"keep_images"`
	// Drain is how long the previous version keeps running after the proxy has switched to the new one, so that
	// requests a proxy worker still routes to it are not refused. Default 5s; 0s stops it at once.
	Drain *Duration `yaml:"drain"`
	// Soak is how long the previous version keeps running after the traffic switch (and the drain) while the new one
	// is watched; if it fails the traffic goes back to the previous version. Default 30s; 0s turns it off. Only for
	// blue/green apps.
	Soak *Duration `yaml:"soak"`
	// Verify lists pages requested on the new container during the soak, next to health_path.
	Verify []Verify `yaml:"verify"`
	// Build, when set, lets the dashboard have this agent build the image from a source archive (a GitHub App
	// installation) instead of pulling one CI built. See Build.
	Build *Build `yaml:"build"`
	// Previews is the template of the app's per-pull-request environments. See Previews.
	Previews *Previews `yaml:"previews"`
	// Database is the database the agent creates for the app on its managed PostgreSQL. See AppDatabase.
	Database *AppDatabase `yaml:"database"`
	// Source links the app to the repository it is built from. See Source.
	Source *Source `yaml:"source"`
	// Deploy chooses how the app is deployed. See Deploy.
	Deploy *Deploy `yaml:"deploy"`

	// Parent is set only on the instance of a preview: the name of the app whose template made it. It is never
	// read from the file. It tells the deployer which managed variables (the parent's preview scope) apply.
	Parent string `yaml:"-"`
}

// Stop is the grace period before a container of the app is killed.
func (a App) Stop() time.Duration {
	if a.StopTimeout == nil {
		return DefaultStopTimeout
	}
	return a.StopTimeout.Std()
}

// HealthWait bounds the wait for a new container to become healthy.
func (a App) HealthWait() time.Duration {
	if a.HealthTimeout == nil {
		return DefaultHealthTimeout
	}
	return a.HealthTimeout.Std()
}

// StableWait is how long a container must stay up (or healthy) before the traffic switches.
func (a App) StableWait() time.Duration {
	if a.StableAfter == nil {
		return DefaultStableAfter
	}
	return a.StableAfter.Std()
}

// Config is the parsed apps file.
type Config struct {
	Registries []Registry `yaml:"registries"`
	Apps       []App      `yaml:"apps"`
	Proxy      *Proxy     `yaml:"proxy"`
	// Notifications is optional: without it the agent only logs.
	Notifications *Notifications `yaml:"notifications"`
	// Databases are existing PostgreSQL servers to back up and restore. Each one with a backups section also
	// appears in Jobs once the file is parsed. The databases the agent creates for apps (App.Database) are listed
	// here too once the file is parsed.
	Databases []Database `yaml:"databases"`
	// Jobs run on a schedule.
	Jobs []Job `yaml:"jobs"`
	// ManagedPostgres tunes the managed PostgreSQL (one container per server, a database and a role per app). Optional:
	// the defaults apply, and nothing runs until the first managed database is asked for.
	ManagedPostgres *ManagedPostgres `yaml:"managed_postgres"`
	// BuildLimits are what this server accepts to build for other servers. See BuildLimits.
	BuildLimits *BuildLimits `yaml:"build_limits"`
}

// Proxy types.
const (
	ProxyCaddy = "caddy"
	ProxyNginx = "nginx"
)

// Proxy configures the reverse proxy the agent drives for blue/green apps.
//
// With Caddy the agent owns the whole Caddy configuration: use a Caddy
// dedicated to Keelson. With nginx the agent owns one small file of upstream
// blocks and reloads nginx; the server blocks stay yours.
type Proxy struct {
	// Type is "caddy" (the default) or "nginx".
	Type string `yaml:"type"`

	// Caddy: Admin is its admin API, default http://127.0.0.1:2019.
	Admin string `yaml:"admin"`
	// ACMEEmail is the contact address for the certificate authority.
	ACMEEmail string `yaml:"acme_email"`
	// TLS is "" for public certificates (ACME) or "internal" for Caddy's own
	// local CA, useful for development.
	TLS string `yaml:"tls"`
	// Sites are served next to the apps: static files, a fixed upstream or a redirect. See Site.
	Sites []Site `yaml:"sites"`
	// Certificates are certificate and key files Caddy serves as they are, for the names they cover (a Cloudflare origin
	// certificate, say). Caddy asks no certificate authority for a name one of them covers.
	Certificates []Certificate `yaml:"certificates"`
	// AccessLog is a file Caddy writes one JSON line to for every request it serves (absolute path, as Caddy sees it).
	// Caddy rotates it (100 MiB, ten files, ninety days). Empty: no access log.
	AccessLog string `yaml:"access_log"`
	// TrustedProxies are the ranges (CIDR or IP) of proxies in front of this Caddy, such as Cloudflare. Requests
	// from them are believed about the client address; upstreams then receive the real client in X-Forwarded-For.
	TrustedProxies []string `yaml:"trusted_proxies"`
	// ClientIPHeader is the header a trusted proxy puts the client address in, such as CF-Connecting-IP.
	// Default: the last untrusted address of X-Forwarded-For.
	ClientIPHeader string `yaml:"client_ip_header"`

	// nginx: UpstreamsFile is the file the agent writes, one "upstream
	// keelson_<app> { server 127.0.0.1:<port>; }" block per app. Include it
	// from the http block and point proxy_pass at those upstreams.
	UpstreamsFile string `yaml:"upstreams_file"`
	// Test is an optional command run before reloading, such as [nginx, -t].
	// If it fails the previous file is restored and the deployment fails.
	Test []string `yaml:"test"`
	// Reload is the command that makes nginx re-read its configuration.
	Reload []string `yaml:"reload"`
}

// DefaultPortEnv is the variable that tells an app on host ports which one to listen on.
const DefaultPortEnv = "PORT"

// DefaultProxyAdmin is where Caddy's admin API listens by default.
const DefaultProxyAdmin = "http://127.0.0.1:2019"

// inferredProxied is what the routing keys alone say: domains, a container port or host ports.
func (a App) inferredProxied() bool {
	return len(a.Domains) > 0 || a.Port.Container > 0 || len(a.Port.Host) > 0
}

// Proxied reports whether the app is deployed blue/green behind a proxy (deploy.strategy switch, which is what its
// routing implies unless it says otherwise). A builder (build.only) runs nothing, so it never is.
func (a App) Proxied() bool {
	return !a.BuildOnly() && a.Strategy() == StrategySwitch
}

// App returns the app with the given name.
func (c *Config) App(name string) (App, bool) {
	for _, a := range c.Apps {
		if a.Name == name {
			return a, true
		}
	}
	return App{}, false
}

// Load reads and validates the apps file alone. Unknown keys are errors, so a typo
// cannot silently disable a setting. LoadFrom also reads the project files next to it.
func Load(path string) (*Config, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	c, issues := Parse(data)
	if c == nil {
		return nil, fmt.Errorf("%s: %w", path, LoadIssues(issues))
	}
	return c, nil
}

// Issue severities.
const (
	SeverityError   = "error"
	SeverityWarning = "warning"
)

// Issue is one problem found in a configuration: where, and what.
type Issue struct {
	Severity string `json:"severity"`
	// Path says where: "apps[web]", "jobs[backup]", "proxy", "proxy.sites[0]", "notifications", "registries[ghcr.io]", "yaml".
	Path string `json:"path"`
	// Line is the 1-based line in the document, when known.
	Line    int    `json:"line,omitempty"`
	Message string `json:"message"`
	// Code names a warning that needs acknowledgement before it is applied.
	Code string `json:"code,omitempty"`
	// File and Project say which document the issue is in when the configuration has project files: File is
	// "projects.d/<project>.yaml" (Project is then the project) or the apps file's name (Project empty). Both are empty
	// for a configuration made of the apps file alone, and Line counts in that file.
	File    string `json:"file,omitempty"`
	Project string `json:"project,omitempty"`
}

func (c *Config) normalize() error {
	issues := c.validate()
	if len(issues) == 0 {
		return nil
	}
	errs := make([]error, len(issues))
	for i, is := range issues {
		errs[i] = errors.New(is.Message)
	}
	return errors.Join(errs...)
}

// validate checks the whole configuration and applies defaults. It reports every problem, one per app,
// job or section, so a broken file lists everything that is wrong and not only its first fault.
func (c *Config) validate() []Issue {
	var out []Issue
	add := func(path string, err error) {
		out = append(out, Issue{Severity: SeverityError, Path: path, Message: err.Error()})
	}
	seen := map[string]bool{}
	for i := range c.Apps {
		a := &c.Apps[i]
		if err := c.validateApp(a, seen); err != nil {
			add("apps["+a.Name+"]", fmt.Errorf("app %q: %w", a.Name, err))
		}
	}
	for _, r := range c.Registries {
		if r.Host == "" || r.Username == "" || r.PasswordFile == "" {
			add("registries["+r.Host+"]", fmt.Errorf("registry %q: host, username and password_file are required", r.Host))
		}
	}
	if err := validateManagedPostgres(c.ManagedPostgres); err != nil {
		add("managed_postgres", err)
	}
	if err := validateBuildLimits(c.BuildLimits); err != nil {
		add("build_limits", err)
	}
	if err := c.validateProxy(); err != nil {
		add("proxy", err)
	} else if c.Proxy != nil && c.Proxy.Type == ProxyCaddy {
		out = append(out, c.siteIssues()...)
	}
	if err := c.validateNotifications(); err != nil {
		add("notifications", err)
	}
	out = append(out, c.appDatabaseIssues()...)
	out = append(out, c.databaseIssues()...)
	out = append(out, c.releaseBackupIssues()...)
	out = append(out, c.jobIssues()...)
	out = append(out, c.previewIssues()...)
	return out
}

// validateApp checks one app, fills its defaults and records its name in seen. The error has no "app" prefix.
func (c *Config) validateApp(a *App, seen map[string]bool) error {
	if !namePattern.MatchString(a.Name) {
		return fmt.Errorf("name must match %s", namePattern)
	}
	if seen[a.Name] {
		return errors.New("duplicate name")
	}
	seen[a.Name] = true
	for _, f := range []struct{ key, value string }{{"project", a.Project}, {"environment", a.Stage}} {
		if f.value != "" && !namePattern.MatchString(f.value) {
			return fmt.Errorf("%s must match %s", f.key, namePattern)
		}
	}
	if err := validateRepository(a.Image); err != nil {
		return err
	}
	if !restartAllowed[a.Restart] {
		return errors.New("restart must be one of no, always, unless-stopped, on-failure")
	}
	if a.Restart == "" {
		a.Restart = DefaultRestart
	}
	for _, p := range a.Publish {
		if _, err := ParsePort(p); err != nil {
			return err
		}
	}
	for _, v := range a.Volumes {
		if parts := strings.Split(v, ":"); len(parts) < 2 || len(parts) > 3 || parts[0] == "" || parts[1] == "" {
			return fmt.Errorf("volume %q must be source:target[:mode]", v)
		}
	}
	a.ContainerPort, a.HostPorts = a.Port.Container, slices.Clone(a.Port.Host)
	if a.BuildOnly() {
		if err := validateBuildOnly(a); err != nil {
			return err
		}
	} else if err := validateRouting(a); err != nil {
		return err
	}
	if err := c.validateRelease(a); err != nil {
		return err
	}
	if err := validateBuild(a); err != nil {
		return err
	}
	if a.Source != nil {
		if err := validateSource(a.Source); err != nil {
			return err
		}
	}
	switch {
	case a.StopTimeout == nil:
		a.StopTimeout = D(DefaultStopTimeout)
	case a.StopTimeout.Std() < 0:
		return errors.New("stop_timeout must not be negative")
	}
	switch {
	case a.HealthTimeout == nil:
		a.HealthTimeout = D(DefaultHealthTimeout)
	case a.HealthTimeout.Std() < MinHealthTimeout:
		return fmt.Errorf("health_timeout must be at least %s", FormatDuration(MinHealthTimeout))
	}
	switch {
	case a.StableAfter == nil:
		a.StableAfter, a.StableAfterSet = D(DefaultStableAfter), false
	case a.StableAfter.Std() < 0:
		return errors.New("stable_after must not be negative")
	default:
		a.StableAfterSet = true
	}
	if err := validateLog(a); err != nil {
		return err
	}
	if err := validateKeepImages(a); err != nil {
		return err
	}
	if err := validateDrain(a); err != nil {
		return err
	}
	return validateSoak(a)
}

// validateRouting checks the routing keys and the deploy strategy of one app, and fills the runtime form of its port.
// Whether the proxy can serve them is checked by validateProxy.
func validateRouting(a *App) error {
	a.ContainerPort, a.HostPorts, a.PortEnv = a.Port.Container, slices.Clone(a.Port.Host), ""
	hostMode := len(a.Port.Host) > 0
	if a.Port.Container != 0 && hostMode {
		return errors.New("port: set container (an app with its own network) or host (an app on network: host), not both")
	}
	if a.Port.Container < 0 || a.Port.Container > 65535 {
		return errors.New("port must be a port number between 1 and 65535")
	}
	if a.Deploy != nil {
		switch a.Deploy.Strategy {
		case "", StrategySwitch, StrategyReplace:
		default:
			return fmt.Errorf("deploy.strategy must be %s or %s", StrategySwitch, StrategyReplace)
		}
		switch {
		case a.Deploy.Strategy == StrategyReplace && a.inferredProxied():
			return errors.New("deploy.strategy replace deploys in place, so it cannot have domains or port: remove them, or use strategy switch")
		case a.Deploy.Strategy == StrategySwitch && !a.inferredProxied():
			return errors.New("deploy.strategy switch needs a port or domains to route to")
		}
	}
	if !a.Proxied() {
		if a.HealthPath != "" {
			return errors.New("health_path is only used with deploy.strategy switch (an app with port or domains)")
		}
		if a.Port.Env != "" {
			return errors.New("port.env is only used with port.host")
		}
		return nil
	}
	if len(a.Publish) > 0 {
		return errors.New("publish cannot be combined with deploy.strategy switch: the agent chooses the host port itself, and two containers cannot share one during a switch (use deploy.strategy replace to publish fixed ports)")
	}

	if hostMode {
		if a.Network != "host" {
			return errors.New("port.host needs network: host")
		}
		if len(a.Port.Host) != 2 || a.Port.Host[0] == a.Port.Host[1] {
			return errors.New("port.host must be two different ports: the agent alternates between them")
		}
		for _, p := range a.Port.Host {
			if p < 1 || p > 65535 {
				return fmt.Errorf("port.host: %d is not a valid port number", p)
			}
		}
		a.PortEnv = a.Port.Env
		if a.PortEnv == "" {
			a.PortEnv = DefaultPortEnv
		}
		if !envNamePattern.MatchString(a.PortEnv) {
			return fmt.Errorf("port.env %q is not a valid environment variable name", a.PortEnv)
		}
	} else {
		if a.Network == "host" {
			return errors.New("network: host needs port.host (two host ports), not a container port")
		}
		if a.Port.Container < 1 || a.Port.Container > 65535 {
			return errors.New("port (1-65535) is required with domains")
		}
		if a.Port.Env != "" {
			return errors.New("port.env is only used with port.host")
		}
	}

	if a.HealthPath != "" && (!strings.HasPrefix(a.HealthPath, "/") || strings.ContainsAny(a.HealthPath, " \t\r\n")) {
		return fmt.Errorf("health_path %q must start with / and contain no spaces", a.HealthPath)
	}
	for i, d := range a.Domains {
		d = strings.ToLower(strings.TrimSpace(d))
		if len(d) > 253 || !domainPattern.MatchString(d) {
			return fmt.Errorf("domain %q is not a valid hostname", a.Domains[i])
		}
		a.Domains[i] = d
	}
	return nil
}

// validateProxy checks the proxy section and the cross-app routing rules.
func (c *Config) validateProxy() error {
	owner := map[string]string{}
	proxied := false
	for _, a := range c.Apps {
		if a.Proxied() {
			proxied = true
		}
		for _, d := range a.Domains {
			if other, dup := owner[d]; dup {
				return fmt.Errorf("domain %q is used by both %q and %q", d, other, a.Name)
			}
			owner[d] = a.Name
		}
	}
	if proxied && c.Proxy == nil {
		return errors.New("blue/green apps (with domains, port or host_ports) need a top-level proxy section (for Caddy it can be empty: proxy: {})")
	}
	if c.Proxy == nil {
		return nil
	}

	switch c.Proxy.Type {
	case "", ProxyCaddy:
		c.Proxy.Type = ProxyCaddy
		return c.validateCaddy()
	case ProxyNginx:
		return c.validateNginx()
	}
	return fmt.Errorf("proxy type must be %q or %q", ProxyCaddy, ProxyNginx)
}

func (c *Config) validateCaddy() error {
	p := c.Proxy
	if p.UpstreamsFile != "" || len(p.Test) > 0 || len(p.Reload) > 0 {
		return errors.New("upstreams_file, test and reload only apply to proxy type nginx")
	}
	for _, a := range c.Apps {
		if a.Proxied() && len(a.Domains) == 0 {
			return fmt.Errorf("app %q: with proxy type caddy a blue/green app needs domains to route", a.Name)
		}
	}
	if p.Admin == "" {
		p.Admin = DefaultProxyAdmin
	}
	u, err := url.Parse(p.Admin)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return fmt.Errorf("proxy admin %q must be an http(s) URL", p.Admin)
	}
	if p.TLS != "" && p.TLS != "internal" {
		return errors.New(`proxy tls must be empty or "internal"`)
	}
	return nil
}

func (c *Config) validateNginx() error {
	p := c.Proxy
	if p.Admin != "" || p.ACMEEmail != "" || p.TLS != "" || len(p.Sites) > 0 || len(p.Certificates) > 0 || p.AccessLog != "" || len(p.TrustedProxies) > 0 || p.ClientIPHeader != "" {
		return errors.New("admin, acme_email, tls, sites, certificates, access_log, trusted_proxies and client_ip_header only apply to proxy type caddy")
	}
	if !filepath.IsAbs(p.UpstreamsFile) {
		return errors.New("proxy upstreams_file must be an absolute path")
	}
	if len(p.Reload) == 0 {
		return errors.New("proxy reload is required: the command that makes nginx re-read its configuration, such as [systemctl, reload, nginx]")
	}
	for _, a := range c.Apps {
		if len(a.Domains) > 0 {
			return fmt.Errorf("app %q: domains are for proxy type caddy; with nginx the hosts live in your own server blocks", a.Name)
		}
	}
	return nil
}

var repoPattern = regexp.MustCompile(`^[a-z0-9]+([._-][a-z0-9]+)*(:[0-9]+)?(/[a-z0-9]+([._-][a-z0-9]+)*)*$`)

// validateRepository checks that image is a repository: no tag, no digest.
func validateRepository(image string) error {
	if image == "" {
		return fmt.Errorf("image is required")
	}
	if strings.Contains(image, "@") {
		return fmt.Errorf("image %q must not contain a digest: deploy requests choose the tag or digest", image)
	}
	if i := strings.LastIndex(image, ":"); i > strings.LastIndex(image, "/") {
		return fmt.Errorf("image %q must not contain a tag: deploy requests choose the tag or digest", image)
	}
	if !repoPattern.MatchString(image) {
		return fmt.Errorf("image %q is not a valid repository name", image)
	}
	return nil
}

// RegistryHost returns the registry an image repository lives on.
func RegistryHost(image string) string {
	first, _, found := strings.Cut(image, "/")
	if found && (strings.ContainsAny(first, ".:") || first == "localhost") {
		return first
	}
	return "docker.io"
}

// PortMapping is a parsed entry of App.Ports.
type PortMapping struct {
	HostIP        string
	HostPort      string
	ContainerPort string
	Proto         string // "tcp" or "udp"
}

// ParsePort parses "[hostip:]hostport:containerport[/proto]".
func ParsePort(s string) (PortMapping, error) {
	spec, proto, _ := strings.Cut(s, "/")
	if proto == "" {
		proto = "tcp"
	}
	if proto != "tcp" && proto != "udp" {
		return PortMapping{}, fmt.Errorf("port %q: protocol must be tcp or udp", s)
	}
	parts := strings.Split(spec, ":")
	var m PortMapping
	switch len(parts) {
	case 2:
		m = PortMapping{HostPort: parts[0], ContainerPort: parts[1]}
	case 3:
		m = PortMapping{HostIP: parts[0], HostPort: parts[1], ContainerPort: parts[2]}
	default:
		return PortMapping{}, fmt.Errorf("port %q must be [hostip:]hostport:containerport[/proto]", s)
	}
	for _, p := range []string{m.HostPort, m.ContainerPort} {
		if n, err := strconv.Atoi(p); err != nil || n < 1 || n > 65535 {
			return PortMapping{}, fmt.Errorf("port %q: %q is not a valid port number", s, p)
		}
	}
	m.Proto = proto
	return m, nil
}

// Environment builds the container environment: the env file first, then env
// entries, which win on conflict. Order is deterministic: file order, then
// env keys sorted.
func (a App) Environment() ([]string, error) {
	vals := map[string]string{}
	var order []string
	set := func(k, v string) {
		if _, ok := vals[k]; !ok {
			order = append(order, k)
		}
		vals[k] = v
	}
	if a.EnvFile != "" {
		pairs, err := ReadEnvFile(a.EnvFile)
		if err != nil {
			return nil, err
		}
		for _, kv := range pairs {
			set(kv[0], kv[1])
		}
	}
	keys := make([]string, 0, len(a.Env))
	for k := range a.Env {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		set(k, a.Env[k])
	}
	out := make([]string, 0, len(order))
	for _, k := range order {
		out = append(out, k+"="+vals[k])
	}
	return out, nil
}

// ManagedEnvHeader is the first line of a file written by the agent for variables set through its API. It switches
// ReadEnvFile to the strict form those files use: every value is a JSON string (so multi-line and special values
// round-trip), and "#@" lines carry the metadata the agent keeps beside each key.
const ManagedEnvHeader = "# keelson-env v1"

// QuoteEnvValue writes v as the value of a line of a managed environment file: a JSON string.
func QuoteEnvValue(v string) string {
	var b strings.Builder
	enc := json.NewEncoder(&b)
	enc.SetEscapeHTML(false)
	_ = enc.Encode(v) // a string always encodes
	return strings.TrimSuffix(b.String(), "\n")
}

// ReadEnvFile parses a dotenv file: KEY=VALUE lines, # comments, optional
// "export " prefix, and matching single or double quotes around the value.
// There is no variable interpolation. A file that starts with ManagedEnvHeader
// is read in its strict form instead (see there).
func ReadEnvFile(path string) ([][2]string, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	return ParseEnv(f, path)
}

// ParseEnv is ReadEnvFile on a reader; name only appears in errors. Errors never include a value.
func ParseEnv(r io.Reader, name string) ([][2]string, error) {
	var out [][2]string
	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 64<<10), 1<<20)
	managed := false
	for n := 1; sc.Scan(); n++ {
		line := strings.TrimSpace(sc.Text())
		if n == 1 && line == ManagedEnvHeader {
			managed = true
			continue
		}
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		line = strings.TrimPrefix(line, "export ")
		k, v, ok := strings.Cut(line, "=")
		k = strings.TrimSpace(k)
		if !ok || k == "" {
			return nil, fmt.Errorf("%s:%d: expected KEY=VALUE", name, n)
		}
		v = strings.TrimSpace(v)
		if managed {
			var s string
			if err := json.Unmarshal([]byte(v), &s); err != nil {
				return nil, fmt.Errorf("%s:%d: the value of %s is not a quoted string", name, n, k)
			}
			v = s
		} else if len(v) >= 2 && (v[0] == '"' || v[0] == '\'') && v[len(v)-1] == v[0] {
			v = v[1 : len(v)-1]
		}
		out = append(out, [2]string{k, v})
	}
	return out, sc.Err()
}
