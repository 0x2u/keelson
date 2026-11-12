package notify

import (
	"fmt"
	"log/slog"
	"sync"
	"time"

	"github.com/0x2u/keelson/agent/internal/config"
)

// LinkWatcher turns the link an agent keeps open to the dashboard into dashboard.unreachable and dashboard.recovered.
//
// It is the only thing that can say that a server and its dashboard lost each other, and it says it where there are
// channels: in the agent. The dashboard cannot: it has none, and a dashboard that is itself off would say nothing. A
// server that is gone altogether says nothing either, by definition: that is what the heartbeat is for.
//
// A reconnection takes seconds and the dashboard is restarted for every update, so the alert waits for the link to
// have been down for `after` (see config.DashboardDownAfter).
type LinkWatcher struct {
	emit  func(Event)
	after time.Duration
	log   *slog.Logger
	now   func() time.Time

	mu        sync.Mutex
	down      bool      // the link is not up
	downSince time.Time // when it went down (zero while it is up)
	reason    string    // why it went down, as the relay said
	alerted   bool      // dashboard.unreachable was sent for this outage
	timer     *time.Timer
}

// NewLinkWatcher returns a watcher that alerts once the link has been down for after.
func NewLinkWatcher(after time.Duration, emit func(Event), log *slog.Logger) *LinkWatcher {
	if log == nil {
		log = slog.Default()
	}
	return &LinkWatcher{emit: emit, after: after, log: log, now: time.Now}
}

// Connected is called when the agent is talking to the dashboard again. A nil watcher (an agent with no apps file,
// which has no notifications either) does nothing.
func (w *LinkWatcher) Connected() {
	if w == nil {
		return
	}
	w.mu.Lock()
	alerted, since := w.alerted, w.downSince
	w.down, w.alerted, w.reason, w.downSince = false, false, "", time.Time{}
	if w.timer != nil {
		w.timer.Stop()
		w.timer = nil
	}
	w.mu.Unlock()
	if alerted {
		w.emit(Event{
			Type: config.EventDashboardRecovered, Severity: SeverityInfo,
			Title:   "The dashboard and this server are talking again",
			Message: fmt.Sprintf("The link was down for %s. Deployments and the dashboard's pages work again.", w.now().Sub(since).Round(time.Second)),
		})
	}
}

// Disconnected is called when a connection to the dashboard ended or could not be made. reason says why, without any
// URL: the relay has already stripped it.
func (w *LinkWatcher) Disconnected(reason string) {
	if w == nil {
		return
	}
	w.mu.Lock()
	defer w.mu.Unlock()
	w.reason = reason
	if w.down {
		return // one outage, however many failed attempts it takes
	}
	w.down, w.downSince = true, w.now()
	w.timer = time.AfterFunc(w.after, w.alert)
}

// alert runs once the link has been down for the whole grace period.
func (w *LinkWatcher) alert() {
	w.mu.Lock()
	if !w.down || w.alerted {
		w.mu.Unlock()
		return
	}
	w.alerted = true
	down, reason := w.now().Sub(w.downSince).Round(time.Second), w.reason
	w.mu.Unlock()
	w.emit(Event{
		Type: config.EventDashboardUnreachable, Severity: SeverityWarning,
		Title:   "This server cannot reach the dashboard",
		Message: fmt.Sprintf("The link has been down for %s (%s), and the agent keeps retrying. The apps keep running and their alerts keep coming, but the dashboard shows this server as unreachable and nothing can be deployed from it until the link is back.", down, reason),
	})
}

// Stop releases the pending timer. It is safe to call more than once.
func (w *LinkWatcher) Stop() {
	if w == nil {
		return
	}
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.timer != nil {
		w.timer.Stop()
		w.timer = nil
	}
}
