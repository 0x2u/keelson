package notify

import (
	"context"
	"log/slog"
	"reflect"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/0x2u/keelson/agent/internal/config"
)

// Service is the agent's notifier as the rest of the agent sees it: one stable Emitter, whose channels follow
// the notifications section of the configuration. A changed section rebuilds the senders, the app watcher and
// the heartbeat without a restart; without a section, events are dropped.
type Service struct {
	ctx context.Context
	src Source
	log *slog.Logger

	mu     sync.RWMutex
	n      *Notifier
	cancel context.CancelFunc

	hooks Hooks
	// retryAfter is the wait before the pending events are sent again, retryGap the pause between two of them; the
	// tests shorten both.
	retryAfter, retryGap time.Duration
	// engineRoot is where the engine keeps its data, as the engine last said: the disk check measures its filesystem.
	engineRoot atomic.Value // string
	started    bool         // agent.started was handled for this process
}

// Hooks are what the service needs besides the source of app states. Every field is optional: without one, the matching
// part is off.
type Hooks struct {
	// Ledger keeps the history of events and the alert state of jobs; it survives a reconfiguration and a restart.
	Ledger *Ledger
	// Engine asks the container engine whether it answers; without it engine.down and engine.recovered are never sent.
	Engine EngineProbe
	// Host reads memory and disk usage, DataPaths are the agent's own directories to measure (the engine's data
	// directory is added once the engine has said where it is); without Host, disk.high and memory.low are never sent.
	Host      HostReader
	DataPaths []string
	// Version is shown in the agent.started message.
	Version string
	// Proven is told when a test reached every channel (and there was one), so that the proof outlives the process. It is how
	// "the alert channel works" becomes a fact the agent can show; without it nothing is recorded.
	Proven func(ctx context.Context, at time.Time) error
	// CertNames lists the names whose certificate is watched (the domains the proxy of this server serves), and
	// CertProbe reads the certificate served for one of them; without either, certificate.expiring is never sent.
	CertNames func() []string
	CertProbe CertProbe
}

// SetHooks must be called before the first Reconfigure.
func (s *Service) SetHooks(h Hooks) { s.hooks = h }

// Ledger is the history of the notifications of this agent; nil when none is kept.
func (s *Service) Ledger() *Ledger { return s.hooks.Ledger }

// Events lists the newest notifications first, with how each delivery ended.
func (s *Service) Events(limit int) []Record { return s.hooks.Ledger.Events(limit) }

// NewService returns a Service with nothing configured. src is what the app watcher observes. Call Reconfigure
// with the first configuration.
func NewService(ctx context.Context, src Source, log *slog.Logger) *Service {
	if log == nil {
		log = slog.Default()
	}
	return &Service{ctx: ctx, src: src, log: log, retryAfter: RetryAfter, retryGap: retryGap}
}

// Emit implements Emitter.
func (s *Service) Emit(e Event) {
	s.mu.RLock()
	n := s.n
	s.mu.RUnlock()
	if n != nil {
		n.Emit(e)
	}
}

// Prepare implements the configuration manager's applier: it builds the new notifier now, where a mistyped secret
// path can still be refused, and returns the function that swaps it in.
func (s *Service) Prepare(old, next *config.Config) (func(), error) {
	if sameNotifications(old.Notifications, next.Notifications) {
		return func() {}, nil
	}
	built, err := s.build(next.Notifications)
	if err != nil {
		return nil, err
	}
	return func() { s.swap(next.Notifications, built) }, nil
}

// Reconfigure applies the first configuration at start.
func (s *Service) Reconfigure(nc *config.Notifications) error {
	built, err := s.build(nc)
	if err != nil {
		return err
	}
	s.swap(nc, built)
	return nil
}

// ChannelResult is how a test delivery went on one channel. The reason is a kind, never the error: an error may quote a URL
// that carries a token.
type ChannelResult struct {
	// Channel is the kind of channel: "webhook" or "telegram".
	Channel string `json:"channel"`
	OK      bool   `json:"ok"`
	Reason  string `json:"reason,omitempty"`
}

// Test sends a test message to every channel of the notifier in force, once and at the same time, and reports how each one
// went; no channel configured is an empty answer. It is not an event: nothing is queued or recorded in the history. When
// every channel delivered, the proof is recorded.
func (s *Service) Test(ctx context.Context) ([]ChannelResult, error) {
	s.mu.RLock()
	n := s.n
	s.mu.RUnlock()
	out := []ChannelResult{}
	if n == nil {
		return out, nil
	}
	all := true
	for _, r := range n.Test(ctx) {
		kind, _, _ := strings.Cut(r.Channel, " ")
		c := ChannelResult{Channel: kind, OK: r.Err == nil}
		if r.Err != nil {
			all = false
			c.Reason = Reason(r.Err)
			s.log.Warn("notification test not delivered", "channel", r.Channel, "reason", c.Reason, "err", r.Err)
		}
		out = append(out, c)
	}
	if all && len(out) > 0 && s.hooks.Proven != nil {
		if err := s.hooks.Proven(ctx, time.Now()); err != nil {
			return nil, err
		}
	}
	return out, nil
}

// Channels names the senders in force.
func (s *Service) Channels() []string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if s.n == nil {
		return nil
	}
	return s.n.Channels()
}

// Close flushes the queued events of the notifier in force.
func (s *Service) Close(timeout time.Duration) {
	s.mu.Lock()
	n, cancel := s.n, s.cancel
	s.n, s.cancel = nil, nil
	s.mu.Unlock()
	if cancel != nil {
		cancel()
	}
	if n != nil {
		n.Close(timeout)
	}
}

func sameNotifications(a, b *config.Notifications) bool {
	return reflect.DeepEqual(a, b)
}

func (s *Service) build(nc *config.Notifications) (*Notifier, error) {
	if nc == nil {
		return nil, nil
	}
	return New(nc, s.log)
}

func (s *Service) swap(nc *config.Notifications, n *Notifier) {
	var runCtx context.Context
	var cancel context.CancelFunc
	if n != nil {
		runCtx, cancel = context.WithCancel(s.ctx)
	}
	s.mu.Lock()
	oldN, oldCancel := s.n, s.cancel
	s.n, s.cancel = n, cancel
	s.mu.Unlock()

	if oldCancel != nil {
		oldCancel()
	}
	if oldN != nil {
		// Events already queued still go out, through the channels they were queued for.
		go oldN.Close(drainTimeout)
	}
	if n == nil {
		s.log.Info("notifications disabled")
		return
	}
	n.SetLedger(s.hooks.Ledger)
	n.Start()
	w := NewWatcher(s.src, n.Emit, WatchEvery, WatchThreshold, s.log)
	w.SetCooldown(nc.Cooldown())
	go w.Run(runCtx)
	s.startHostWatchers(runCtx, nc, n)
	s.announceStart(n)
	if nc.Heartbeat != nil {
		go RunHeartbeat(runCtx, nc.Heartbeat.URL, nc.Heartbeat.Interval(), s.log)
	}
	go s.retryPending(runCtx, n)
	s.log.Info("notifications enabled", "channels", n.Channels(), "heartbeat", nc.Heartbeat != nil)
}

// startHostWatchers runs the engine and the host checks, for the events the configuration asks for.
func (s *Service) startHostWatchers(ctx context.Context, nc *config.Notifications, n *Notifier) {
	if s.hooks.Engine != nil && (nc.EventEnabled(config.EventEngineDown) || nc.EventEnabled(config.EventEngineRecovered)) {
		w := NewEngineWatcher(s.hooks.Engine, n.Emit, engineThreshold, func(root string) { s.engineRoot.Store(root) }, s.log)
		go w.Run(ctx)
	}
	if s.hooks.Host != nil && (nc.EventEnabled(config.EventDiskHigh) || nc.EventEnabled(config.EventDiskRecovered) || nc.EventEnabled(config.EventMemoryLow)) {
		disk, mem := nc.DiskAlert(), nc.MemoryAlert()
		if disk == 0 {
			disk = config.DefaultDiskAlertPercent
		}
		if mem == 0 {
			mem = config.DefaultMemoryAlertPercent
		}
		paths := func() []string {
			out := append([]string(nil), s.hooks.DataPaths...)
			if root, _ := s.engineRoot.Load().(string); root != "" {
				out = append(out, root)
			}
			return out
		}
		go NewHostMonitor(s.hooks.Host, paths, n.Emit, disk, mem, s.log).Run(ctx)
	}
	if s.hooks.CertNames != nil && s.hooks.CertProbe != nil && (nc.EventEnabled(config.EventCertificateExpiring) || nc.EventEnabled(config.EventCertificateRenewed)) {
		go NewCertWatcher(s.hooks.CertNames, s.hooks.CertProbe, nc.CertWarn, n.Emit, s.log).Run(ctx)
	}
}

// Retry of what never got through. An agent that was restarted, or whose webhook was down, or that had no channel at
// all when a job failed, has events in its history that nobody ever saw; when channels are in force again they are
// sent once more, oldest first.
const (
	// RetryAfter is the wait before the pending events are tried, so that a restart does not send a burst before the
	// agent has settled (Service.retryAfter).
	RetryAfter = 30 * time.Second
	// RetryMaxAge is how old an event may be and still be worth sending: past that it is history, not news.
	RetryMaxAge = 24 * time.Hour
	// RetryLimit is how many times one event is tried again before it is left in the history as failed.
	RetryLimit = 3
	// retryGap is the pause between two retried events, so that a backlog does not hit a rate limit.
	retryGap = 2 * time.Second
)

// retryPending sends again what never reached a channel. It skips what the configuration in force does not select:
// an event turned off since it was raised is not news either.
func (s *Service) retryPending(ctx context.Context, n *Notifier) {
	if s.hooks.Ledger == nil || len(n.senders) == 0 {
		return
	}
	select {
	case <-ctx.Done():
		return
	case <-time.After(s.retryAfter):
	}
	pending := s.hooks.Ledger.Pending(time.Now(), RetryMaxAge, RetryLimit)
	sent := 0
	for _, r := range pending {
		if ctx.Err() != nil {
			return
		}
		if !n.cfg.EventEnabled(r.Type) {
			continue
		}
		if n.Resend(ctx, r) {
			sent++
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(s.retryGap):
		}
	}
	if len(pending) > 0 {
		s.log.Info("notifications that had not got through were sent again", "tried", len(pending), "delivered", sent)
	}
}

// announceStart sends agent.started once per process, so a crash loop or a reboot shows. A restart loop sends one a
// minute at most: the others are kept in the history as suppressed.
func (s *Service) announceStart(n *Notifier) {
	if s.started {
		return
	}
	s.started = true
	e := Event{Type: config.EventAgentStarted, Severity: SeverityInfo, Time: time.Now(), Title: "The agent started", Message: "keelson-agent " + s.hooks.Version + " is running. Apps keep their containers: this says the agent itself (re)started."}
	if last, ok := s.hooks.Ledger.Last(config.EventAgentStarted); ok && e.Time.Sub(last.Time) < time.Minute {
		if n.cfg.EventEnabled(e.Type) {
			s.hooks.Ledger.Add(Record{Event: e, Status: StatusSuppressed})
		}
		return
	}
	n.Emit(e)
}
