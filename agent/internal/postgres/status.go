package postgres

import (
	"context"
	"time"

	"github.com/0x2u/keelson/agent/internal/config"
)

// Status is what GET /v1/postgres says about the instance. It holds no secret.
type Status struct {
	// Exists is false until the first managed database is created (or the container is lost).
	Exists bool `json:"exists"`
	// State is the container's: "missing", "created", "running", "restarting", "exited"...
	State   string `json:"state"`
	Running bool   `json:"running"`
	// Health is the container's HEALTHCHECK: "starting", "healthy", "unhealthy"; empty when it does not exist.
	Health    string `json:"health"`
	Container string `json:"container"`
	Image     string `json:"image"`
	// Major is the PostgreSQL major version of the image.
	Major int `json:"major"`
	// ServerVersion and SizeBytes are what the server itself says (the size is that of all its databases); empty
	// and zero while the instance does not answer. They are kept for a minute.
	ServerVersion string `json:"server_version"`
	SizeBytes     int64  `json:"size_bytes"`
	Volume        string `json:"volume"`
	Network       string `json:"network"`
	// Host and Port are what an app on a Docker network connects to.
	Host string `json:"host"`
	// Port is the loopback port the instance is published on, the one an app on the host network connects to; 0
	// when the container is not published.
	Port        int   `json:"port"`
	MemoryBytes int64 `json:"memory_bytes"`
	// SettingsCurrent is false when the postgres section of the apps file asks for another image, port or memory than
	// the container was created with: settings only apply to a new container.
	SettingsCurrent bool `json:"settings_current"`
	// Databases are the databases the agent created.
	Databases []StatusDatabase `json:"databases"`
}

// StatusDatabase is a managed database in the status.
type StatusDatabase struct {
	Name   string `json:"name"`
	App    string `json:"app"`
	EnvKey string `json:"env_key"`
}

// Status describes the instance. It never starts anything.
func (m *Manager) Status(ctx context.Context) (Status, error) {
	cfg := m.cfg.Config()
	set := cfg.PostgresSettings()
	st := Status{
		State: "missing", Container: config.ManagedPostgresContainer, Volume: config.ManagedPostgresVolume,
		Network: config.ManagedPostgresNetwork, Host: config.ManagedPostgresContainer, SettingsCurrent: true,
		Databases: []StatusDatabase{}, Image: set.Image(), Major: set.Version, MemoryBytes: set.MemoryBytes(),
	}
	for _, d := range cfg.ManagedDatabases() {
		st.Databases = append(st.Databases, StatusDatabase{Name: d.Name, App: d.App, EnvKey: d.EnvKey})
	}
	d, err := m.inspect(ctx)
	if err != nil {
		return Status{}, err
	}
	if d == nil {
		return st, nil
	}
	in := instanceOf(d)
	st.Exists, st.State, st.Running, st.Health = true, d.State.Status, d.State.Running, d.State.Health
	st.Image, st.Port, st.MemoryBytes = d.Image, in.hostPort, d.MemoryLimit
	st.Major = majorOf(d.Image)
	st.SettingsCurrent = d.Labels[specLabel] == specHash(set)
	if d.State.Running && d.State.Health == "healthy" {
		st.ServerVersion, st.SizeBytes = m.live(ctx, d.Image)
	}
	return st, nil
}

// live returns the server's version and size, asking at most once a minute. A failure is an empty answer: the status
// is still worth showing.
func (m *Manager) live(ctx context.Context, image string) (string, int64) {
	m.mu.Lock()
	if p := m.probe; p != nil && m.now().Sub(p.at) < probeTTL {
		m.mu.Unlock()
		return p.version, p.size
	}
	m.mu.Unlock()
	// Taking the operation's place keeps the probe from running beside a change of the instance.
	end, err := m.begin()
	if err != nil {
		return "", 0
	}
	defer end()
	pw, err := readSecret(m.superFile())
	if err != nil {
		return "", 0
	}
	runCtx, cancel := context.WithTimeout(ctx, psqlTimeout)
	defer cancel()
	version, size, err := m.serverInfo(runCtx, image, pw)
	if err != nil {
		m.log.Warn("the managed PostgreSQL did not answer the status query", "err", m.scrub(err.Error(), pw))
		return "", 0
	}
	m.mu.Lock()
	m.probe = &probed{at: time.Now(), version: version, size: size}
	m.mu.Unlock()
	return version, size
}

// majorOf reads the major version from "postgres:16-alpine".
func majorOf(image string) int {
	_, tag, _ := cutLast(image, ":")
	n := 0
	for _, c := range tag {
		if c < '0' || c > '9' {
			break
		}
		n = n*10 + int(c-'0')
	}
	return n
}

func cutLast(s, sep string) (before, after string, ok bool) {
	for i := len(s) - len(sep); i >= 0; i-- {
		if s[i:i+len(sep)] == sep {
			return s[:i], s[i+len(sep):], true
		}
	}
	return s, "", false
}
