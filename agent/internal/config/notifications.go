package config

import (
	"errors"
	"fmt"
	"net/url"
	"time"
)

// Event types an agent can send. They are the values of Notifications.Events
// and the "type" of a webhook payload.
const (
	EventDeploymentSucceeded      = "deployment.succeeded"
	EventDeploymentFailed         = "deployment.failed"
	EventDeploymentRolledBack     = "deployment.rolled_back"
	EventDeploymentRollbackFailed = "deployment.rollback_failed"
	EventAppDown                  = "app.down"
	EventAppRecovered             = "app.recovered"
	EventJobFailed                = "job.failed"
	EventJobRecovered             = "job.recovered"
	EventCertificateExpiring      = "certificate.expiring"
	EventCertificateRenewed       = "certificate.renewed"
	EventProxyDrifted             = "proxy.drifted"
	// The events below are never part of DefaultEvents: they are sent only when events lists them.
	EventJobMissed            = "job.missed"
	EventEngineDown           = "engine.down"
	EventEngineRecovered      = "engine.recovered"
	EventDiskHigh             = "disk.high"
	EventDiskRecovered        = "disk.recovered"
	EventMemoryLow            = "memory.low"
	EventAgentStarted         = "agent.started"
	EventDashboardUnreachable = "dashboard.unreachable"
	EventDashboardRecovered   = "dashboard.recovered"
)

// DefaultEvents is what is sent when Notifications.Events is empty: everything
// that needs attention, without the success of every routine deployment.
var DefaultEvents = []string{
	EventDeploymentFailed,
	EventDeploymentRolledBack,
	EventDeploymentRollbackFailed,
	EventAppDown,
	EventAppRecovered,
	EventJobFailed,
	EventJobRecovered,
	EventCertificateExpiring,
	EventCertificateRenewed,
	EventProxyDrifted,
}

var knownEvents = map[string]bool{
	EventDeploymentSucceeded:      true,
	EventDeploymentFailed:         true,
	EventDeploymentRolledBack:     true,
	EventDeploymentRollbackFailed: true,
	EventAppDown:                  true,
	EventAppRecovered:             true,
	EventJobFailed:                true,
	EventJobRecovered:             true,
	EventJobMissed:                true,
	EventEngineDown:               true,
	EventEngineRecovered:          true,
	EventDiskHigh:                 true,
	EventDiskRecovered:            true,
	EventMemoryLow:                true,
	EventAgentStarted:             true,
	EventCertificateExpiring:      true,
	EventCertificateRenewed:       true,
	EventProxyDrifted:             true,
	EventDashboardUnreachable:     true,
	EventDashboardRecovered:       true,
}

const (
	DefaultHeartbeatEvery = 5 * time.Minute
	MinHeartbeatEvery     = 30 * time.Second
	DefaultTelegramAPI    = "https://api.telegram.org"

	// DefaultDiskAlertPercent is the share of a filesystem in use from which disk.high is raised; the alert ends
	// when the use falls AlertHysteresis points below it. DefaultMemoryAlertPercent is the share of memory still
	// available under which memory.low is raised; it re-arms AlertHysteresis points above.
	DefaultDiskAlertPercent   = 85
	DefaultMemoryAlertPercent = 10
	AlertHysteresis           = 5
	// DefaultAlertCooldown is the time an app that went down must wait before a new app.down is sent for it.
	DefaultAlertCooldown = 5 * time.Minute
	// DefaultCertWarnDays is how many days before a certificate expires certificate.expiring is raised. The warning is
	// raised again as the time left crosses the shorter steps (notify.CertWarnSteps), not every day.
	DefaultCertWarnDays = 14
	MaxCertWarnDays     = 90
	// DashboardDownAfter is how long the link to the dashboard must stay down before dashboard.unreachable is raised:
	// a reconnection takes seconds, and a dashboard being updated must not page anyone.
	DashboardDownAfter = 3 * time.Minute
)

// Notifications says how the agent tells you something is wrong. It runs in
// the agent, not in the dashboard: the dashboard may well be switched off
// when a deployment fails or a container dies.
type Notifications struct {
	// Name labels this server in messages. Empty means the hostname.
	Name string `yaml:"name"`
	// Events lists what to send. Absent means DefaultEvents; an empty list sends nothing.
	Events    []string   `yaml:"events"`
	Webhooks  []Webhook  `yaml:"webhooks"`
	Telegram  *Telegram  `yaml:"telegram"`
	Heartbeat *Heartbeat `yaml:"heartbeat"`
	// DiskAlertPercent is the use of the filesystem holding the engine's data or the agent's data above which
	// disk.high is raised; default 85.
	DiskAlertPercent *int `yaml:"disk_alert_percent"`
	// MemoryAlertPercent is the share of memory still available under which memory.low is raised; default 10.
	MemoryAlertPercent *int `yaml:"memory_alert_percent"`
	// AlertCooldown is the time an app that went down and came back must wait before it can alert again, so a
	// flapping app does not send a pair of messages every cycle; default 5m, 0s turns it off.
	AlertCooldown *Duration `yaml:"alert_cooldown"`
	// CertWarnDays is how many days before a certificate expires certificate.expiring is raised; default 14, at most 90.
	CertWarnDays *int `yaml:"cert_warn_days"`
}

// Webhook receives every event as a JSON POST.
type Webhook struct {
	URL string `yaml:"url"`
	// SecretFile, if set, holds a secret: the body is signed with it
	// (HMAC-SHA256, hex, in X-Keelson-Signature as "sha256=<hex>").
	SecretFile string `yaml:"secret_file"`
}

// Telegram sends events to a chat through a bot.
type Telegram struct {
	BotTokenFile string `yaml:"bot_token_file"`
	ChatID       string `yaml:"chat_id"`
	// APIURL is the Bot API server, default https://api.telegram.org. Set it
	// for a self-hosted Bot API server.
	APIURL string `yaml:"api_url"`
}

// Heartbeat pings a URL at a regular interval, for an external dead-man
// switch (such as Healthchecks.io) that alerts you when the pings stop: the
// only way to learn that a whole server, or the agent itself, is gone.
type Heartbeat struct {
	URL string `yaml:"url"`
	// Every is the interval of the pings. Default 5m, at least 30s.
	Every *Duration `yaml:"every"`
}

// EventList is what is sent: the events of the file, the defaults when it lists none (the key is absent).
func (n *Notifications) EventList() []string {
	if n.Events == nil {
		return DefaultEvents
	}
	return n.Events
}

// DiskAlert is the use of the filesystem from which disk.high is raised.
func (n *Notifications) DiskAlert() int {
	if n.DiskAlertPercent == nil {
		return DefaultDiskAlertPercent
	}
	return *n.DiskAlertPercent
}

// MemoryAlert is the share of memory still available under which memory.low is raised.
func (n *Notifications) MemoryAlert() int {
	if n.MemoryAlertPercent == nil {
		return DefaultMemoryAlertPercent
	}
	return *n.MemoryAlertPercent
}

// Cooldown is the time an app that went down and came back waits before it can alert again.
func (n *Notifications) Cooldown() time.Duration {
	if n.AlertCooldown == nil {
		return DefaultAlertCooldown
	}
	return n.AlertCooldown.Std()
}

// CertWarn is how many days before a certificate expires certificate.expiring is raised.
func (n *Notifications) CertWarn() int {
	if n.CertWarnDays == nil {
		return DefaultCertWarnDays
	}
	return *n.CertWarnDays
}

// Interval is how often the heartbeat pings.
func (h *Heartbeat) Interval() time.Duration {
	if h.Every == nil {
		return DefaultHeartbeatEvery
	}
	return h.Every.Std()
}

// EventEnabled reports whether the event type is selected.
func (n *Notifications) EventEnabled(eventType string) bool {
	for _, e := range n.EventList() {
		if e == eventType {
			return true
		}
	}
	return false
}

func httpURL(raw string) error {
	u, err := url.Parse(raw)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return fmt.Errorf("%q must be an http(s) URL", raw)
	}
	return nil
}

func (c *Config) validateNotifications() error {
	n := c.Notifications
	if n == nil {
		return nil
	}
	for _, e := range n.Events {
		if !knownEvents[e] {
			return fmt.Errorf("notifications: unknown event %q", e)
		}
	}
	// Hysteresis needs room below the disk threshold and above the memory one.
	switch {
	case n.DiskAlertPercent == nil:
		v := DefaultDiskAlertPercent
		n.DiskAlertPercent = &v
	case *n.DiskAlertPercent <= AlertHysteresis || *n.DiskAlertPercent > 100:
		return fmt.Errorf("notifications: disk_alert_percent must be between %d and 100", AlertHysteresis+1)
	}
	switch {
	case n.MemoryAlertPercent == nil:
		v := DefaultMemoryAlertPercent
		n.MemoryAlertPercent = &v
	case *n.MemoryAlertPercent < 1 || *n.MemoryAlertPercent > 100-AlertHysteresis:
		return fmt.Errorf("notifications: memory_alert_percent must be between 1 and %d", 100-AlertHysteresis)
	}
	switch {
	case n.AlertCooldown == nil:
		n.AlertCooldown = D(DefaultAlertCooldown)
	case n.AlertCooldown.Std() < 0:
		return errors.New("notifications: alert_cooldown must not be negative")
	}
	switch {
	case n.CertWarnDays == nil:
		n.CertWarnDays = new(DefaultCertWarnDays)
	case *n.CertWarnDays < 1 || *n.CertWarnDays > MaxCertWarnDays:
		return fmt.Errorf("notifications: cert_warn_days must be between 1 and %d", MaxCertWarnDays)
	}
	for _, w := range n.Webhooks {
		if err := httpURL(w.URL); err != nil {
			return fmt.Errorf("notifications: webhook url: %w", err)
		}
	}
	if t := n.Telegram; t != nil {
		if t.BotTokenFile == "" || t.ChatID == "" {
			return errors.New("notifications: telegram needs bot_token_file and chat_id")
		}
		if t.APIURL == "" {
			t.APIURL = DefaultTelegramAPI
		}
		if err := httpURL(t.APIURL); err != nil {
			return fmt.Errorf("notifications: telegram api_url: %w", err)
		}
	}
	if h := n.Heartbeat; h != nil {
		if err := httpURL(h.URL); err != nil {
			return fmt.Errorf("notifications: heartbeat url: %w", err)
		}
		switch {
		case h.Every == nil:
			h.Every = D(DefaultHeartbeatEvery)
		case h.Every.Std() < MinHeartbeatEvery:
			return fmt.Errorf("notifications: heartbeat every must be at least %s", MinHeartbeatEvery)
		}
	}
	return nil
}
