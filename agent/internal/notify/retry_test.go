package notify

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/0x2u/keelson/agent/internal/config"
)

// pendingLedger is a history as a restarted agent would find it: one event nobody ever saw, of each kind that is
// worth trying again, plus what must be left alone.
func pendingLedger(t *testing.T, path string) *Ledger {
	t.Helper()
	l := OpenLedger(path, quiet)
	now := time.Now()
	l.Add(Record{Event: Event{Type: config.EventAppDown, App: "web", Title: "web is down", Time: now.Add(-time.Minute)}, Status: StatusFailed})
	l.Add(Record{Event: Event{Type: config.EventJobFailed, Job: "backup", Title: "backup failed", Time: now.Add(-2 * time.Minute)}, Status: StatusNoChannel})
	l.Add(Record{Event: Event{Type: config.EventAppRecovered, App: "web", Title: "web is back", Time: now.Add(-3 * time.Minute)}, Status: StatusDropped})
	l.Add(Record{Event: Event{Type: config.EventAppDown, App: "old", Title: "too old", Time: now.Add(-48 * time.Hour)}, Status: StatusFailed})
	l.Add(Record{Event: Event{Type: config.EventAppDown, App: "tried", Title: "given up on", Time: now.Add(-time.Minute)}, Status: StatusFailed, Retries: RetryLimit})
	l.Add(Record{Event: Event{Type: config.EventDeploymentFailed, App: "web", Title: "already delivered", Time: now.Add(-time.Minute)}, Status: StatusDelivered})
	return l
}

// startService runs a service whose only channel is hook, with that ledger, and waits for the retry to have run.
func startService(t *testing.T, l *Ledger, hook *fakeSender, nc *config.Notifications) *Service {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	svc := NewService(ctx, &fakeSource{}, quiet)
	svc.retryAfter, svc.retryGap = time.Millisecond, time.Millisecond
	svc.SetHooks(Hooks{Ledger: l})
	n, err := New(nc, quiet)
	if err != nil {
		t.Fatal(err)
	}
	n.senders = []Sender{hook}
	n.backoff, n.sleep = func(int) time.Duration { return 0 }, func(context.Context, time.Duration) error { return nil }
	svc.swap(nc, n)
	t.Cleanup(func() { svc.Close(time.Second) })
	return svc
}

func waitForDelivered(t *testing.T, hook *fakeSender, n int) []Event {
	t.Helper()
	for deadline := time.Now().Add(3 * time.Second); time.Now().Before(deadline); time.Sleep(5 * time.Millisecond) {
		if got := hook.delivered(); len(got) >= n {
			time.Sleep(20 * time.Millisecond) // let a wrong extra one show up
			return hook.delivered()
		}
	}
	t.Fatalf("waited for %d deliveries, got %+v", n, hook.delivered())
	return nil
}

func TestWhatNeverGotThroughIsSentAgainWhenChannelsAreBack(t *testing.T) {
	l := pendingLedger(t, "")
	hook := &fakeSender{name: "webhook"}
	svc := startService(t, l, hook, &config.Notifications{})

	got := waitForDelivered(t, hook, 3)
	titles := map[string]bool{}
	for _, e := range got {
		titles[e.Title] = true
	}
	if len(got) != 3 || !titles["web is down"] || !titles["backup failed"] || !titles["web is back"] {
		t.Fatalf("the three events nobody saw are sent again, and nothing else: %+v", got)
	}
	if got[0].Title != "web is back" {
		t.Errorf("oldest first, got %q", got[0].Title)
	}
	// The history keeps one line per event, now delivered, with the attempt counted.
	for _, r := range svc.Events(10) {
		switch r.Title {
		case "web is down", "backup failed", "web is back":
			if r.Status != StatusDelivered || r.Retries != 1 {
				t.Errorf("%q: status %s after %d retries", r.Title, r.Status, r.Retries)
			}
		case "too old", "given up on":
			if r.Status != StatusFailed || r.Retries > RetryLimit {
				t.Errorf("%q must be left alone: %s, %d retries", r.Title, r.Status, r.Retries)
			}
		}
	}
	if n := len(svc.Events(20)); n != 6 {
		t.Errorf("a retry updates the record, it does not add one: %d records", n)
	}
}

func TestAnEventTurnedOffSinceItWasRaisedIsNotSentAgain(t *testing.T) {
	l := pendingLedger(t, "")
	hook := &fakeSender{name: "webhook"}
	startService(t, l, hook, &config.Notifications{Events: []string{config.EventJobFailed}})
	got := waitForDelivered(t, hook, 1)
	if len(got) != 1 || got[0].Title != "backup failed" {
		t.Errorf("only what the configuration still selects: %+v", got)
	}
}

func TestARetryThatFailsAgainIsCountedAndGivenUpOn(t *testing.T) {
	l := OpenLedger("", quiet)
	l.Add(Record{Event: Event{Type: config.EventAppDown, App: "web", Title: "web is down", Time: time.Now()}, Status: StatusFailed})
	down := &fakeSender{name: "webhook", fails: 1000}
	svc := startService(t, l, down, &config.Notifications{})
	for deadline := time.Now().Add(3 * time.Second); time.Now().Before(deadline); time.Sleep(5 * time.Millisecond) {
		if svc.Events(1)[0].Retries == 1 {
			break
		}
	}
	r := svc.Events(1)[0]
	if r.Status != StatusFailed || r.Retries != 1 || len(r.FailedChannels) != 1 {
		t.Fatalf("a failed retry is recorded as one: %+v", r)
	}
	if got := l.Pending(time.Now(), RetryMaxAge, 1); len(got) != 0 {
		t.Errorf("and it is not pending any more once the limit is reached: %+v", got)
	}
}

func TestThePendingEventsSurviveARestartOfTheAgent(t *testing.T) {
	path := filepath.Join(t.TempDir(), "notifications.json")
	l := pendingLedger(t, path)
	if _, err := os.Stat(path); err != nil {
		t.Fatal(err)
	}
	// What a restarted agent reads: the same file, the sequence numbers kept.
	again := OpenLedger(path, quiet)
	pending := again.Pending(time.Now(), RetryMaxAge, RetryLimit)
	if len(pending) != 3 {
		t.Fatalf("got %d pending events, want 3", len(pending))
	}
	for _, r := range pending {
		if r.Seq == 0 {
			t.Fatalf("a record read back has no sequence number: %+v", r)
		}
	}
	again.Update(pending[0].Seq, StatusDelivered, nil)
	third := OpenLedger(path, quiet)
	if got := third.Pending(time.Now(), RetryMaxAge, RetryLimit); len(got) != 2 {
		t.Errorf("an event delivered on the second try is not tried a third time: %+v", got)
	}
	if next := l.Add(Record{Event: Event{Type: config.EventAppDown, Time: time.Now()}, Status: StatusDelivered}); next <= pending[len(pending)-1].Seq {
		t.Errorf("the next record must get a new number: %d", next)
	}
}
