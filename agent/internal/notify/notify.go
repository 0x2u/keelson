// Package notify tells an operator that something needs attention: a failed
// deployment, an app that went down or came back, a missing heartbeat. It runs
// inside the agent, so it keeps working when the dashboard is off.
//
// Delivery never blocks the agent: events go through a bounded queue to a
// background worker that retries with backoff. If a channel stays down, the
// event is logged and dropped rather than piled up.
package notify

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/0x2u/keelson/agent/internal/config"
)

// Severity orders how much an event matters.
const (
	SeverityInfo     = "info"
	SeverityWarning  = "warning"
	SeverityCritical = "critical"
)

// EventTest is the type of the message `notify-test` sends. It bypasses the
// event filter: its whole purpose is to prove a channel works.
const EventTest = "test"

// Event is one thing worth telling the operator.
type Event struct {
	Type     string    `json:"type"`
	Severity string    `json:"severity"`
	Server   string    `json:"server"`
	App      string    `json:"app,omitempty"`
	Time     time.Time `json:"time"`
	Title    string    `json:"title"`
	Message  string    `json:"message,omitempty"`

	DeploymentID string `json:"deployment_id,omitempty"`
	Job          string `json:"job,omitempty"`
	Ref          string `json:"ref,omitempty"`

	// Done, when set, is called once when the event is out of the agent's hands: with true when at least one
	// channel got it, false when none did, it was not selected, or it was dropped. It runs on the delivery
	// goroutine (or on the caller's when the event is refused at once) and must not block. It is not sent.
	Done func(delivered bool) `json:"-"`
}

// Sender delivers an event to one channel.
type Sender interface {
	Name() string
	Send(ctx context.Context, e Event) error
}

// Emitter is what the rest of the agent uses to report events.
type Emitter interface {
	Emit(e Event)
}

const (
	queueSize      = 64
	sendTimeout    = 10 * time.Second
	attempts       = 3
	drainTimeout   = 10 * time.Second
	defaultBackoff = time.Second
)

// Notifier filters events and delivers them to its senders in the background.
type Notifier struct {
	senders []Sender
	cfg     *config.Notifications
	server  string
	log     *slog.Logger
	// ledger keeps the history of what was sent; nil (in tests, and for the notify-test command) records nothing.
	ledger *Ledger

	queue chan Event
	stop  chan struct{}
	done  chan struct{}
	once  sync.Once

	// backoff is the wait before retry n; sleep is replaceable in tests.
	backoff func(retry int) time.Duration
	sleep   func(ctx context.Context, d time.Duration) error
}

// New builds a Notifier from the configuration, reading the secret files now
// so that a typo in a path fails at startup and not at the first incident.
func New(cfg *config.Notifications, log *slog.Logger) (*Notifier, error) {
	if log == nil {
		log = slog.Default()
	}
	n := &Notifier{
		cfg:     cfg,
		log:     log,
		queue:   make(chan Event, queueSize),
		stop:    make(chan struct{}),
		done:    make(chan struct{}),
		backoff: func(retry int) time.Duration { return defaultBackoff << (2 * retry) }, // 1s, 4s
		sleep:   sleepCtx,
	}
	n.server = cfg.Name
	if n.server == "" {
		n.server, _ = os.Hostname()
	}

	for _, w := range cfg.Webhooks {
		secret := ""
		if w.SecretFile != "" {
			b, err := os.ReadFile(w.SecretFile)
			if err != nil {
				return nil, fmt.Errorf("webhook secret: %w", err)
			}
			secret = strings.TrimSpace(string(b))
		}
		n.senders = append(n.senders, NewWebhook(w.URL, secret))
	}
	if t := cfg.Telegram; t != nil {
		b, err := os.ReadFile(t.BotTokenFile)
		if err != nil {
			return nil, fmt.Errorf("telegram bot token: %w", err)
		}
		token := strings.TrimSpace(string(b))
		if token == "" {
			return nil, errors.New("telegram bot token file is empty")
		}
		n.senders = append(n.senders, NewTelegram(t.APIURL, token, t.ChatID))
	}
	return n, nil
}

// SetLedger gives the notifier the history it records into. Call it before Start.
func (n *Notifier) SetLedger(l *Ledger) { n.ledger = l }

// Channels returns the names of the configured channels.
func (n *Notifier) Channels() []string {
	out := make([]string, len(n.senders))
	for i, s := range n.senders {
		out[i] = s.Name()
	}
	return out
}

// Emit queues an event for delivery. It never blocks: with a full queue the
// oldest event is dropped, since the newest tells the most about now.
func (n *Notifier) Emit(e Event) {
	if e.Type != EventTest && !n.cfg.EventEnabled(e.Type) {
		// Not selected: nothing is sent and nothing is recorded, but the sender is told it did not get through.
		if e.Done != nil {
			e.Done(false)
		}
		return
	}
	if e.Server == "" {
		e.Server = n.server
	}
	if e.Time.IsZero() {
		e.Time = time.Now().UTC()
	}
	for {
		select {
		case n.queue <- e:
			return
		default:
		}
		select {
		case dropped := <-n.queue:
			n.log.Warn("notification queue full: dropping the oldest event", "type", dropped.Type, "app", dropped.App)
			n.record(dropped, StatusDropped, nil)
		default:
		}
	}
}

// Start launches the delivery worker.
func (n *Notifier) Start() {
	go n.run()
}

// Close stops accepting work, delivers what is queued (within the timeout) and
// returns. Call it after anything that can still emit has finished.
func (n *Notifier) Close(timeout time.Duration) {
	n.once.Do(func() { close(n.stop) })
	select {
	case <-n.done:
	case <-time.After(timeout):
		n.log.Warn("notifications still being delivered at exit")
	}
}

func (n *Notifier) run() {
	defer close(n.done)
	for {
		select {
		case e := <-n.queue:
			n.deliver(context.Background(), e)
		case <-n.stop:
			ctx, cancel := context.WithTimeout(context.Background(), drainTimeout)
			defer cancel()
			for {
				select {
				case e := <-n.queue:
					n.deliver(ctx, e)
				default:
					return
				}
			}
		}
	}
}

// deliver sends one event to every channel and records how it went. A failing channel does not hold back the
// others. The event counts as delivered when at least one channel got it: another channel being down must not make
// the sender of the alert believe nobody was told.
func (n *Notifier) deliver(ctx context.Context, e Event) {
	var wg sync.WaitGroup
	var mu sync.Mutex
	var failed []string
	for _, s := range n.senders {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if err := n.sendWithRetry(ctx, s, e); err != nil {
				n.log.Error("notification not delivered", "channel", s.Name(), "type", e.Type, "app", e.App, "err", err)
				mu.Lock()
				failed = append(failed, s.Name())
				mu.Unlock()
			}
		}()
	}
	wg.Wait()
	slices.Sort(failed)
	status := StatusDelivered
	switch {
	case len(n.senders) == 0:
		status = StatusNoChannel
	case len(failed) == len(n.senders):
		status = StatusFailed
	case len(failed) > 0:
		status = StatusPartial
	}
	n.record(e, status, failed)
}

// record puts the outcome of an event in the history and tells whoever asked to know.
func (n *Notifier) record(e Event, status string, failed []string) {
	r := Record{Event: e, Status: status, FailedChannels: failed}
	if e.Type != EventTest {
		n.ledger.Add(r)
	}
	if e.Done != nil {
		e.Done(r.Delivered())
	}
}

func (n *Notifier) sendWithRetry(ctx context.Context, s Sender, e Event) error {
	var err error
	for try := range attempts {
		sendCtx, cancel := context.WithTimeout(ctx, sendTimeout)
		err = s.Send(sendCtx, e)
		cancel()
		if err == nil {
			return nil
		}
		if try == attempts-1 {
			break
		}
		n.log.Warn("notification failed, will retry", "channel", s.Name(), "attempt", try+1, "err", err)
		if serr := n.sleep(ctx, n.backoff(try)); serr != nil {
			break
		}
	}
	return err
}

// Result is the outcome of a test delivery on one channel.
type Result struct {
	Channel string
	Err     error
}

// Test sends a test event to every channel at once and reports each outcome,
// without retries: it answers "does this channel work right now".
func (n *Notifier) Test(ctx context.Context) []Result {
	e := Event{
		Type: EventTest, Severity: SeverityInfo, Server: n.server, Time: time.Now().UTC(),
		Title: "Test notification from keelson-agent", Message: "If you can read this, this channel works.",
	}
	results := make([]Result, len(n.senders))
	var wg sync.WaitGroup
	for i, s := range n.senders {
		wg.Add(1)
		go func() {
			defer wg.Done()
			sendCtx, cancel := context.WithTimeout(ctx, sendTimeout)
			defer cancel()
			results[i] = Result{Channel: s.Name(), Err: s.Send(sendCtx, e)}
		}()
	}
	wg.Wait()
	return results
}

func sleepCtx(ctx context.Context, d time.Duration) error {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-t.C:
		return nil
	}
}
