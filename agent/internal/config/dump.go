package config

import (
	"bytes"
	"encoding/json"
	"sort"
	"strings"
)

// RuntimeJSON describes what a configuration makes the agent run, as neutral JSON: the effective runtime, with every
// default resolved and every secret hidden. It is the safety net of schema changes (see docs/schema.md and
// `keelson-agent config dump`): the same running behaviour must give the same bytes whatever the YAML spelling is, so
// the key names below are the dump's own (they are not the YAML keys and must not follow a rename of them), durations
// are seconds, sizes are bytes, lists that have no meaning in their order are sorted by name, and nothing depends on
// the text of the files (no hash, no line, no file name).
//
// Secrets are never printed: the values of env, preview env, job HTTP headers and body, the query of a job URL, the
// webhook and heartbeat URLs, the value of a build argument or command-line argument named like a secret (see
// secretName) are replaced by Hidden. The names stay, so a changed set of variables still shows. Files that hold a
// secret (password_file, secret_key_file, bot_token_file, secret_file) are paths and are printed as such; they are
// never read.
func (c *Config) RuntimeJSON() ([]byte, error) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	enc.SetIndent("", "  ")
	if err := enc.Encode(c.runtime()); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

// runtimeDumpFormat is the version of the dump's own layout, not of the configuration schema.
const runtimeDumpFormat = 1

type rtDump struct {
	Format          int               `json:"dump_format"`
	Apps            []rtApp           `json:"apps"`
	Jobs            []rtJob           `json:"jobs"`
	Databases       []rtDatabase      `json:"databases"`
	Previews        []rtPreview       `json:"previews"`
	Registries      []rtRegistry      `json:"registries"`
	Proxy           *rtProxy          `json:"proxy"`
	Notifications   *rtNotifications  `json:"notifications"`
	ManagedPostgres rtManagedPostgres `json:"managed_postgres"`
}

type rtApp struct {
	Name   string `json:"name"`
	Parent string `json:"parent,omitempty"` // only on the synthesized instance of a preview
	// Project and Environment are the labels as the agent has them (a project file's entries carry their file's
	// project); EffectiveProject is where the dashboard files the app (the label, or the app's name).
	Project              string            `json:"project"`
	EffectiveProject     string            `json:"effective_project"`
	Environment          string            `json:"environment"`
	Image                string            `json:"image"`
	EnvFile              string            `json:"env_file"`
	Env                  map[string]string `json:"env"`
	Command              []string          `json:"command"`
	Volumes              []string          `json:"volumes"`
	Network              string            `json:"network"`
	RestartPolicy        string            `json:"restart_policy"` // what Docker gets: "" is "no"
	StopTimeoutSeconds   float64           `json:"stop_timeout_seconds"`
	HealthTimeoutSeconds float64           `json:"health_timeout_seconds"`
	StableAfterSeconds   float64           `json:"stable_after_seconds"`
	StableAfterExplicit  bool              `json:"stable_after_explicit"`
	DrainSeconds         *float64          `json:"drain_seconds"`
	SoakSeconds          *float64          `json:"soak_seconds"`
	Verify               []rtVerify        `json:"verify"`
	Analysis             *rtAnalysis       `json:"analysis"`
	KeepImages           int               `json:"keep_images"`
	Log                  rtLog             `json:"log"`
	Routing              rtRouting         `json:"routing"`
	Release              *rtRelease        `json:"release"`
	Build                *rtBuild          `json:"build"`
	// ExtraNetworks are the Docker networks the app's containers join besides their own; ManagedDatabases are the
	// databases the agent created for the app.
	ExtraNetworks    []string         `json:"extra_networks"`
	ManagedDatabases []rtAppManagedDB `json:"managed_databases"`
}

type rtAppManagedDB struct {
	Name   string `json:"name"`
	EnvKey string `json:"env_key"`
}

type rtVerify struct {
	Path   string `json:"path"`
	Status int    `json:"status"`
}

type rtAnalysis struct {
	Address string     `json:"address"`
	Metrics []rtMetric `json:"metrics"`
}

type rtMetric struct {
	Name            string   `json:"name"`
	Query           string   `json:"query"`
	Max             *float64 `json:"max"`
	Min             *float64 `json:"min"`
	IntervalSeconds float64  `json:"interval_seconds"`
	FailureLimit    int      `json:"failure_limit"`
	NoData          string   `json:"no_data"`
}

type rtLog struct {
	Driver       string `json:"driver"`
	MaxSizeBytes int64  `json:"max_size_bytes"`
	MaxFile      int    `json:"max_file"`
}

type rtPort struct {
	HostIP        string `json:"host_ip"`
	HostPort      string `json:"host_port"`
	ContainerPort string `json:"container_port"`
	Proto         string `json:"proto"`
}

type rtRouting struct {
	Proxied bool     `json:"proxied"`
	Domains []string `json:"domains"`
	// PublishedPorts are fixed Docker port mappings; ProxyContainerPort is the container port the proxy forwards to
	// (the agent publishes it on a random loopback port); HostPorts are the two ports a host-network app alternates
	// between, told to it through the variable HostPortEnv.
	PublishedPorts     []rtPort `json:"published_ports"`
	ProxyContainerPort int      `json:"proxy_container_port"`
	HostPorts          []int    `json:"host_ports"`
	HostPortEnv        string   `json:"host_port_env"`
	HealthPath         string   `json:"health_path"`
}

type rtRelease struct {
	OnRollback bool     `json:"on_rollback"`
	Steps      []rtStep `json:"steps"`
}

// rtStep is one release step: Kind is host, container or backup. Argv is the program and its arguments of a host
// step, the command of a container step; Image overrides the repository of a container step; Database is the
// database a backup step takes a backup of.
type rtStep struct {
	Name              string   `json:"name"`
	Kind              string   `json:"kind"`
	Argv              []string `json:"argv"`
	Dir               string   `json:"dir"`
	Image             string   `json:"image"`
	Database          string   `json:"database"`
	TimeoutSeconds    float64  `json:"timeout_seconds"`
	ContinueOnFailure bool     `json:"continue_on_failure"`
}

type rtBuild struct {
	Preset         string            `json:"preset"`
	Dockerfile     string            `json:"dockerfile"`
	Install        string            `json:"install"`
	BuildCommand   string            `json:"build_command"`
	Start          string            `json:"start"`
	OutputDir      string            `json:"output_dir"`
	Node           string            `json:"node"`
	SPA            *bool             `json:"spa"`
	Standalone     bool              `json:"standalone"`
	Context        string            `json:"context"`
	Target         string            `json:"target"`
	Args           map[string]string `json:"args"`
	TimeoutSeconds float64           `json:"timeout_seconds"`
	MemoryBytes    int64             `json:"memory_bytes"`
	CPUs           float64           `json:"cpus"`
	MaxSourceBytes int64             `json:"max_source_bytes"`
	Network        string            `json:"network"`
	// EffectiveNetwork is the network the build really runs on (see App.BuildNetwork).
	EffectiveNetwork string   `json:"effective_network"`
	Database         bool     `json:"database"`
	Platform         string   `json:"platform"`
	BuilderOnly      bool     `json:"builder_only"` // a build-only app: nothing runs here
	SourceHosts      []string `json:"source_hosts"`
}

type rtJob struct {
	Name    string `json:"name"`
	Project string `json:"project"`
	Kind    string `json:"kind"` // http, host, container or backup
	// Synthesized marks a job that is not written in a file: the backup job of a database. Database names it.
	Synthesized         bool     `json:"synthesized"`
	Database            string   `json:"database"`
	Schedule            string   `json:"schedule"`
	Timezone            string   `json:"timezone"`
	TimeoutSeconds      float64  `json:"timeout_seconds"`
	AlertAfter          int      `json:"alert_after"`
	RealertAfterSeconds float64  `json:"realert_after_seconds"`
	CatchUp             bool     `json:"catch_up"`
	Paused              bool     `json:"paused"`
	Argv                []string `json:"argv"` // host: the program and its arguments; container: the command
	Dir                 string   `json:"dir"`
	ContainerApp        string   `json:"container_app"`
	HTTP                *rtHTTP  `json:"http"`
}

type rtHTTP struct {
	URL          string            `json:"url"`
	Method       string            `json:"method"`
	Headers      map[string]string `json:"headers"`
	Body         string            `json:"body"`
	Bearer       *rtBearer         `json:"bearer"`
	ExpectStatus []int             `json:"expect_status"`
}

type rtBearer struct {
	File string `json:"file"`
	App  string `json:"app"`
	Env  string `json:"env"`
}

type rtDatabase struct {
	Name string `json:"name"`
	// Project is the project the database is filed under: its own label, and for a managed one the project of the
	// app it was created for (the same for its backup job).
	Project      string    `json:"project"`
	Engine       string    `json:"engine"`
	Host         string    `json:"host"`
	Port         int       `json:"port"`
	Database     string    `json:"database"`
	User         string    `json:"user"`
	PasswordFile string    `json:"password_file"`
	SSLMode      string    `json:"ssl_mode"`
	Version      int       `json:"version"`
	Network      string    `json:"network"`
	Managed      bool      `json:"managed"`
	App          string    `json:"app"`
	EnvKey       string    `json:"env_key"`
	Backup       *rtBackup `json:"backup"`
}

type rtBackup struct {
	Schedule       string          `json:"schedule"`
	Timezone       string          `json:"timezone"`
	Recipients     []string        `json:"recipients"`
	Keep           int             `json:"keep"`
	KeepDays       int             `json:"keep_days"`
	KeepPreDeploy  int             `json:"keep_pre_deploy"`
	TimeoutSeconds float64         `json:"timeout_seconds"`
	AlertAfter     int             `json:"alert_after"`
	Paused         bool            `json:"paused"`
	Destinations   []rtDestination `json:"destinations"`
}

// rtDestination is one place a backup goes; Kind is local or s3.
type rtDestination struct {
	Kind          string `json:"kind"`
	Dir           string `json:"dir"`
	Endpoint      string `json:"endpoint"`
	Region        string `json:"region"`
	Bucket        string `json:"bucket"`
	Prefix        string `json:"prefix"`
	AccessKeyID   string `json:"access_key_id"`
	SecretKeyFile string `json:"secret_key_file"`
}

type rtPreview struct {
	App        string            `json:"app"`
	Domain     string            `json:"domain"`
	EnvFile    string            `json:"env_file"`
	Env        map[string]string `json:"env"`
	TTLSeconds float64           `json:"ttl_seconds"`
	Max        int               `json:"max"`
	// InstanceExample is the app the template synthesizes for pull request 1: what an instance inherits from its
	// parent (and what it does not) is part of the runtime.
	InstanceExample rtApp `json:"instance_example"`
}

type rtRegistry struct {
	Host         string `json:"host"`
	Username     string `json:"username"`
	PasswordFile string `json:"password_file"`
}

type rtProxy struct {
	Type           string          `json:"type"`
	Admin          string          `json:"admin"`
	ACMEEmail      string          `json:"acme_email"`
	TLS            string          `json:"tls"`
	TrustedProxies []string        `json:"trusted_proxies"`
	ClientIPHeader string          `json:"client_ip_header"`
	AccessLog      string          `json:"access_log"`
	Certificates   []rtCertificate `json:"certificates"`
	Sites          []rtSite        `json:"sites"`
	UpstreamsFile  string          `json:"upstreams_file"`
	Test           []string        `json:"test"`
	Reload         []string        `json:"reload"`
}

type rtCertificate struct {
	CertFile string `json:"cert_file"`
	KeyFile  string `json:"key_file"`
}

type rtSite struct {
	Kind      string            `json:"kind"` // static, upstream or redirect
	Hosts     []string          `json:"hosts"`
	Root      string            `json:"root"`
	NotFound  string            `json:"not_found"`
	Immutable []string          `json:"immutable"`
	TryFiles  []string          `json:"try_files"`
	Index     string            `json:"index"`
	Upstream  string            `json:"upstream"`
	Redirect  *rtRedirect       `json:"redirect"`
	Headers   map[string]string `json:"headers"`
}

type rtRedirect struct {
	To   string `json:"to"`
	Code int    `json:"code"`
}

type rtNotifications struct {
	Name string `json:"name"`
	// Events is what is really sent: the defaults when the file lists none. Sorted.
	Events               []string     `json:"events"`
	Webhooks             []rtWebhook  `json:"webhooks"`
	Telegram             *rtTelegram  `json:"telegram"`
	Heartbeat            *rtHeartbeat `json:"heartbeat"`
	DiskAlertPercent     int          `json:"disk_alert_percent"`
	MemoryAlertPercent   int          `json:"memory_alert_percent"`
	AlertCooldownSeconds float64      `json:"alert_cooldown_seconds"`
}

type rtWebhook struct {
	URL        string `json:"url"`
	SecretFile string `json:"secret_file"`
}

type rtTelegram struct {
	BotTokenFile string `json:"bot_token_file"`
	ChatID       string `json:"chat_id"`
	APIURL       string `json:"api_url"`
}

type rtHeartbeat struct {
	URL          string  `json:"url"`
	EverySeconds float64 `json:"every_seconds"`
}

type rtManagedPostgres struct {
	Version     int    `json:"version"`
	Port        int    `json:"port"`
	MemoryBytes int64  `json:"memory_bytes"`
	Image       string `json:"image"`
}

func (c *Config) runtime() rtDump {
	d := rtDump{
		Format:     runtimeDumpFormat,
		Apps:       []rtApp{},
		Jobs:       []rtJob{},
		Databases:  []rtDatabase{},
		Previews:   []rtPreview{},
		Registries: []rtRegistry{},
	}
	for _, a := range c.Apps {
		d.Apps = append(d.Apps, c.appRuntime(a))
	}
	sort.SliceStable(d.Apps, func(i, j int) bool { return d.Apps[i].Name < d.Apps[j].Name })

	for _, j := range c.Jobs {
		d.Jobs = append(d.Jobs, c.jobRuntime(j))
	}
	sort.SliceStable(d.Jobs, func(i, j int) bool { return d.Jobs[i].Name < d.Jobs[j].Name })

	for _, db := range c.Databases {
		d.Databases = append(d.Databases, c.databaseRuntime(db))
	}
	sort.SliceStable(d.Databases, func(i, j int) bool { return d.Databases[i].Name < d.Databases[j].Name })

	for _, parent := range c.PreviewApps() {
		p := *parent.Previews
		d.Previews = append(d.Previews, rtPreview{
			App: parent.Name, Domain: p.Domain, EnvFile: p.EnvFile, Env: hiddenValues(p.Env),
			TTLSeconds: p.TTLFor().Seconds(), Max: p.MaxCount(),
			InstanceExample: c.appRuntime(p.Instance(parent, 1)),
		})
	}
	sort.SliceStable(d.Previews, func(i, j int) bool { return d.Previews[i].App < d.Previews[j].App })

	for _, r := range c.Registries {
		d.Registries = append(d.Registries, rtRegistry{Host: r.Host, Username: r.Username, PasswordFile: r.PasswordFile})
	}
	if c.Proxy != nil {
		d.Proxy = proxyRuntime(c.Proxy)
	}
	if c.Notifications != nil {
		d.Notifications = notificationsRuntime(c.Notifications)
	}
	p := c.PostgresSettings()
	d.ManagedPostgres = rtManagedPostgres{Version: p.Version, Port: p.Port, MemoryBytes: p.MemoryBytes(), Image: p.Image()}
	return d
}

func (c *Config) appRuntime(a App) rtApp {
	out := rtApp{
		Name: a.Name, Parent: a.Parent, Project: a.Project, EffectiveProject: effectiveProject(a), Environment: a.Stage,
		Image: a.Image, EnvFile: a.EnvFile, Env: hiddenValues(a.Env), Command: redactArgv(a.Command), Volumes: strs(a.Volumes),
		Network: a.Network, RestartPolicy: restartPolicy(a.Restart),
		StopTimeoutSeconds:   a.Stop().Seconds(),
		HealthTimeoutSeconds: a.HealthWait().Seconds(), StableAfterSeconds: a.StableWait().Seconds(), StableAfterExplicit: a.StableAfterSet,
		DrainSeconds: seconds(a.Drain), SoakSeconds: seconds(a.Soak),
		Verify: []rtVerify{}, KeepImages: a.keepImagesRaw(),
		ExtraNetworks: strs(c.ExtraNetworks(a)), ManagedDatabases: []rtAppManagedDB{},
	}
	for _, v := range a.Verify {
		out.Verify = append(out.Verify, rtVerify{Path: v.Path, Status: v.Status})
	}
	if a.Analysis != nil {
		out.Analysis = &rtAnalysis{Address: a.Analysis.PrometheusAddress(), Metrics: []rtMetric{}}
		for _, m := range a.Analysis.Metrics {
			out.Analysis.Metrics = append(out.Analysis.Metrics, rtMetric{
				Name: m.Name, Query: m.Query, Max: m.Max, Min: m.Min,
				IntervalSeconds: m.EveryOrDefault().Seconds(), FailureLimit: m.LimitOrDefault(), NoData: m.NoData,
			})
		}
	}
	if a.Log != nil {
		out.Log = rtLog{Driver: a.Log.Driver, MaxSizeBytes: a.Log.MaxSizeOrDefault().Bytes(), MaxFile: a.Log.MaxFileOrDefault()}
	}
	out.Routing = rtRouting{
		Proxied: a.Proxied(), Domains: strs(a.Domains), PublishedPorts: []rtPort{}, ProxyContainerPort: a.ContainerPort,
		HostPorts: append([]int{}, a.HostPorts...), HostPortEnv: a.PortEnv, HealthPath: a.HealthPath,
	}
	for _, p := range a.Publish {
		if m, err := ParsePort(p); err == nil {
			out.Routing.PublishedPorts = append(out.Routing.PublishedPorts, rtPort{HostIP: m.HostIP, HostPort: m.HostPort, ContainerPort: m.ContainerPort, Proto: m.Proto})
		}
	}
	if a.Release != nil {
		r := &rtRelease{OnRollback: a.Release.OnRollback, Steps: []rtStep{}}
		for _, s := range a.Release.Steps {
			r.Steps = append(r.Steps, stepRuntime(s))
		}
		out.Release = r
	}
	if b := a.Build; b != nil {
		out.Build = &rtBuild{
			Preset: b.Preset, Dockerfile: b.Dockerfile, Install: b.Install, BuildCommand: b.BuildCommand, Start: b.Start,
			OutputDir: b.OutputDir, Node: b.Node, SPA: b.SPA, Standalone: b.Standalone, Context: b.Context, Target: b.Target,
			Args: buildArgs(b.Args), TimeoutSeconds: b.TimeoutFor().Seconds(), MemoryBytes: b.MemoryBytes(), CPUs: b.CPUCount(),
			MaxSourceBytes: b.MaxSourceBytes(), Network: b.Network, EffectiveNetwork: a.BuildNetwork(), Database: b.Database,
			Platform: b.Platform, BuilderOnly: b.Only, SourceHosts: strs(b.SourceHosts),
		}
	}
	for _, db := range c.Databases {
		if db.Managed && db.App == a.Name {
			out.ManagedDatabases = append(out.ManagedDatabases, rtAppManagedDB{Name: db.Name, EnvKey: db.EnvKey})
		}
	}
	sort.SliceStable(out.ManagedDatabases, func(i, j int) bool { return out.ManagedDatabases[i].Name < out.ManagedDatabases[j].Name })
	return out
}

func stepRuntime(s ReleaseStep) rtStep {
	out := rtStep{Name: s.Name, Argv: []string{}, Dir: s.Dir, Database: s.Backup,
		TimeoutSeconds: s.RunTimeout().Seconds(), ContinueOnFailure: s.ContinueOnFailure}
	switch {
	case s.Backup != "":
		out.Kind = "backup"
	case len(s.Host) > 0:
		out.Kind, out.Argv = "host", redactArgv(s.Host)
	default:
		out.Kind = "container"
		if s.Container != nil {
			out.Argv, out.Image = redactArgv(s.Container.Command), s.Container.Image
		}
	}
	return out
}

func (c *Config) jobRuntime(j Job) rtJob {
	project := j.Project
	if db, ok := c.Database(j.Database); ok && j.Database != "" {
		project = c.databaseProject(db)
	}
	tz := j.Timezone
	if tz == "" {
		tz = "UTC"
	}
	out := rtJob{
		Name: j.Name, Project: project, Kind: j.Kind(), Synthesized: j.Managed, Database: j.Database,
		Schedule: j.Cron, Timezone: tz, TimeoutSeconds: j.RunTimeout().Seconds(), AlertAfter: j.AlertThreshold(),
		RealertAfterSeconds: j.Realert().Seconds(), CatchUp: j.CatchUp, Paused: j.Paused, Argv: []string{}, Dir: j.Dir,
	}
	switch out.Kind {
	case "host":
		out.Argv = redactArgv(j.Host)
	case "container":
		if j.Container != nil {
			out.ContainerApp, out.Argv = j.Container.App, redactArgv(j.Container.Command)
		}
	case "http":
		h := j.HTTP
		rh := &rtHTTP{URL: maskQuery(h.URL), Method: h.Method, Headers: hiddenValues(h.Headers), ExpectStatus: append([]int{}, h.ExpectStatus...)}
		if h.Body != "" {
			rh.Body = Hidden
		}
		if b := h.Bearer; b != nil {
			rh.Bearer = &rtBearer{File: b.File, App: b.App, Env: b.Env}
		}
		out.HTTP = rh
	}
	return out
}

// databaseProject is the project a database is filed under: its label, and for a managed one that of the app it was
// created for, so that the label an entry happens to carry cannot make two equal runtimes differ.
func (c *Config) databaseProject(d Database) string {
	if d.Managed {
		if a, ok := c.App(d.App); ok {
			return effectiveProject(a)
		}
	}
	return d.Project
}

func (c *Config) databaseRuntime(d Database) rtDatabase {
	out := rtDatabase{
		Name: d.Name, Project: c.databaseProject(d), Engine: d.Engine, Host: d.Host, Port: d.Port, Database: d.Database, User: d.User,
		PasswordFile: d.PasswordFile, SSLMode: d.SSLMode, Version: d.Version, Network: d.Network,
		Managed: d.Managed, App: d.App, EnvKey: d.EnvKey,
	}
	if b := d.Backups; b != nil {
		tz := b.Timezone
		if tz == "" {
			tz = "UTC"
		}
		rb := &rtBackup{
			Schedule: b.Cron, Timezone: tz, Recipients: strs(b.Recipients), Keep: b.KeepCount(), KeepDays: b.KeepDays,
			KeepPreDeploy: b.KeepPreDeployCount(), TimeoutSeconds: b.RunTimeout().Seconds(), AlertAfter: b.AlertThreshold(), Paused: b.Paused,
			Destinations: []rtDestination{},
		}
		for _, dest := range b.AllDestinations() {
			switch {
			case dest.Local != nil:
				rb.Destinations = append(rb.Destinations, rtDestination{Kind: "local", Dir: dest.Local.Dir})
			case dest.S3 != nil:
				s := dest.S3
				rb.Destinations = append(rb.Destinations, rtDestination{Kind: "s3", Endpoint: s.Endpoint, Region: s.Region, Bucket: s.Bucket,
					Prefix: s.Prefix, AccessKeyID: s.AccessKeyID, SecretKeyFile: s.SecretKeyFile})
			}
		}
		out.Backup = rb
	}
	return out
}

func proxyRuntime(p *Proxy) *rtProxy {
	out := &rtProxy{
		Type: p.Type, Admin: p.Admin, ACMEEmail: p.ACMEEmail, TLS: p.TLS, TrustedProxies: strs(p.TrustedProxies),
		ClientIPHeader: p.ClientIPHeader, AccessLog: p.AccessLog, Certificates: []rtCertificate{}, Sites: []rtSite{},
		UpstreamsFile: p.UpstreamsFile, Test: strs(p.Test), Reload: strs(p.Reload),
	}
	for _, c := range p.Certificates {
		out.Certificates = append(out.Certificates, rtCertificate{CertFile: c.CertFile, KeyFile: c.KeyFile})
	}
	for _, s := range p.Sites {
		rs := rtSite{
			Kind: s.Kind(), Hosts: strs(s.Hosts), Root: s.Root, NotFound: s.NotFound, Immutable: strs(s.Immutable),
			TryFiles: strs(s.TryFiles), Index: s.Index, Upstream: s.Upstream, Headers: copyMap(s.Headers),
		}
		if s.Redirect != nil {
			rs.Redirect = &rtRedirect{To: s.Redirect.To, Code: s.Redirect.Code}
		}
		out.Sites = append(out.Sites, rs)
	}
	return out
}

func notificationsRuntime(n *Notifications) *rtNotifications {
	events := strs(n.EventList())
	sort.Strings(events)
	out := &rtNotifications{
		Name: n.Name, Events: events, Webhooks: []rtWebhook{},
		DiskAlertPercent: n.DiskAlert(), MemoryAlertPercent: n.MemoryAlert(),
		AlertCooldownSeconds: n.Cooldown().Seconds(),
	}
	for _, w := range n.Webhooks {
		out.Webhooks = append(out.Webhooks, rtWebhook{URL: Hidden, SecretFile: w.SecretFile})
	}
	if t := n.Telegram; t != nil {
		out.Telegram = &rtTelegram{BotTokenFile: t.BotTokenFile, ChatID: t.ChatID, APIURL: t.APIURL}
	}
	if h := n.Heartbeat; h != nil {
		out.Heartbeat = &rtHeartbeat{URL: Hidden, EverySeconds: h.Interval().Seconds()}
	}
	return out
}

// restartPolicy is the policy Docker applies: an app that names none gets "no".
func restartPolicy(r string) string {
	if r == "" {
		return "no"
	}
	return r
}

func seconds(d *Duration) *float64 {
	if d == nil {
		return nil
	}
	s := d.Std().Seconds()
	return &s
}

// strs is s as a non-nil copy, so an empty list is "[]" and never "null".
func strs(s []string) []string { return append([]string{}, s...) }

func copyMap(m map[string]string) map[string]string {
	out := make(map[string]string, len(m))
	for k, v := range m {
		out[k] = v
	}
	return out
}

// hiddenValues keeps the names of m and hides every value.
func hiddenValues(m map[string]string) map[string]string {
	out := make(map[string]string, len(m))
	for k := range m {
		out[k] = Hidden
	}
	return out
}

// buildArgs hides the value of a build argument named like a secret (the others are not secret, by contract).
func buildArgs(m map[string]string) map[string]string {
	out := copyMap(m)
	for k := range out {
		if secretName(k) {
			out[k] = Hidden
		}
	}
	return out
}

// maskQuery hides what follows the "?" of a URL: a token often sits there.
func maskQuery(u string) string {
	if i := strings.IndexByte(u, '?'); i >= 0 && i < len(u)-1 {
		return u[:i+1] + Hidden
	}
	return u
}

// redactArgv hides the secret-looking arguments of a command, the way Redact does for the document: the element after
// a flag named like a secret ("--token abc"), "--token=abc" and "API_KEY=abc".
func redactArgv(items []string) []string {
	out := make([]string, len(items))
	prevFlag := ""
	for i, v := range items {
		out[i] = v
		flag := prevFlag
		prevFlag = ""
		switch {
		case strings.HasPrefix(v, "-"):
			if name, val, ok := strings.Cut(v, "="); ok {
				if secretName(name) && val != "" {
					out[i] = name + "=" + Hidden
				}
			} else {
				prevFlag = v
			}
		case flag != "":
			if secretName(strings.TrimLeft(flag, "-")) && v != "" {
				out[i] = Hidden
			}
		default:
			if name, val, ok := strings.Cut(v, "="); ok && identifier.MatchString(name) && secretName(name) && val != "" {
				out[i] = name + "=" + Hidden
			}
		}
	}
	return out
}
