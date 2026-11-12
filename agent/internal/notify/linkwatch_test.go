package notify

import (
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/0x2u/keelson/agent/internal/config"
)

// linkRig collects what the watcher says, from any goroutine (the alert fires on a timer).
type linkRig struct {
	w  *LinkWatcher
	mu sync.Mutex
	ev []Event
}

func newLinkRig(after time.Duration) *linkRig {
	r := &linkRig{}
	r.w = NewLinkWatcher(after, func(e Event) {
		r.mu.Lock()
		defer r.mu.Unlock()
		r.ev = append(r.ev, e)
	}, quiet)
	return r
}

func (r *linkRig) events() []Event {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]Event(nil), r.ev...)
}

// waitFor returns the events once there are n of them, or fails.
func (r *linkRig) waitFor(t *testing.T, n int) []Event {
	t.Helper()
	for deadline := time.Now().Add(2 * time.Second); time.Now().Before(deadline); time.Sleep(5 * time.Millisecond) {
		if got := r.events(); len(got) >= n {
			return got
		}
	}
	t.Fatalf("waited for %d events, got %+v", n, r.events())
	return nil
}

func TestALinkThatComesBackBeforeTheGracePeriodSaysNothing(t *testing.T) {
	r := newLinkRig(time.Hour)
	defer r.w.Stop()
	r.w.Connected()
	r.w.Disconnected("connection refused")
	r.w.Connected()
	time.Sleep(20 * time.Millisecond)
	if got := r.events(); len(got) != 0 {
		t.Errorf("a reconnection within the grace period is not an incident: %+v", got)
	}
}

func TestALinkThatStaysDownIsAnnouncedOnceAndItsReturnToo(t *testing.T) {
	r := newLinkRig(20 * time.Millisecond)
	defer r.w.Stop()
	r.w.Connected()
	r.w.Disconnected("connection refused")
	r.w.Disconnected("connection refused") // the retries of one outage
	r.w.Disconnected("no data for 45s")

	ev := r.waitFor(t, 1)
	if ev[0].Type != config.EventDashboardUnreachable || ev[0].Severity != SeverityWarning {
		t.Fatalf("%+v", ev[0])
	}
	if !strings.Contains(ev[0].Message, "no data for 45s") {
		t.Errorf("the message carries the latest reason: %q", ev[0].Message)
	}
	time.Sleep(40 * time.Millisecond)
	if got := r.events(); len(got) != 1 {
		t.Fatalf("one message per outage, however many attempts: %+v", got)
	}

	r.w.Connected()
	ev = r.waitFor(t, 2)
	if ev[1].Type != config.EventDashboardRecovered || !strings.Contains(ev[1].Message, "down for") {
		t.Errorf("%+v", ev[1])
	}
}

func TestALinkThatBreaksAgainIsAnnouncedAgain(t *testing.T) {
	r := newLinkRig(10 * time.Millisecond)
	defer r.w.Stop()
	for range 2 {
		r.w.Disconnected("connection refused")
		r.w.Connected()
	}
	// the second outage is a new incident, so unreachable and recovered are said twice
	r.w.Disconnected("connection refused")
	ev := r.waitFor(t, 1)
	if ev[0].Type != config.EventDashboardUnreachable {
		t.Fatalf("%+v", ev[0])
	}
}

func TestANilWatcherDoesNothing(t *testing.T) {
	var w *LinkWatcher // an agent with no apps file has no notifications
	w.Connected()
	w.Disconnected("connection refused")
	w.Stop()
}
