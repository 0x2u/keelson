package notify

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/0x2u/keelson/agent/internal/config"
	"github.com/0x2u/keelson/agent/internal/sysinfo"
)

// --- delivery is recorded, and the sender is told -----------------------------------------------------------------

func TestDeliveryIsRecordedAndTheSenderIsToldWhetherItGotThrough(t *testing.T) {
	for name, tc := range map[string]struct {
		senders []Sender
		status  string
		got     bool
	}{
		"delivered":  {[]Sender{&fakeSender{name: "a"}}, StatusDelivered, true},
		"partial":    {[]Sender{&fakeSender{name: "a"}, &fakeSender{name: "b", fails: 100}}, StatusPartial, true},
		"failed":     {[]Sender{&fakeSender{name: "b", fails: 100}}, StatusFailed, false},
		"no channel": {nil, StatusNoChannel, false},
	} {
		t.Run(name, func(t *testing.T) {
			n := newNotifier(&config.Notifications{}, tc.senders...)
			l := OpenLedger("", quiet)
			n.SetLedger(l)
			told := make(chan bool, 1)
			n.Start()
			n.Emit(Event{Type: config.EventAppDown, App: "web", Done: func(ok bool) { told <- ok }})
			n.Close(time.Second)
			if got := <-told; got != tc.got {
				t.Errorf("told %v, want %v", got, tc.got)
			}
			if r := l.Events(10); len(r) != 1 || r[0].Status != tc.status {
				t.Errorf("history: %+v", r)
			}
		})
	}
}

func TestAnEventThatIsNotSelectedIsNotSentNorRecordedAndTheSenderKnows(t *testing.T) {
	s := &fakeSender{name: "a"}
	n := newNotifier(&config.Notifications{}, s)
	l := OpenLedger("", quiet)
	n.SetLedger(l)
	n.Start()
	var told, ok bool
	n.Emit(Event{Type: config.EventDiskHigh, Done: func(d bool) { told, ok = true, d }})
	n.Close(time.Second)
	if !told || ok || len(s.delivered()) != 0 || len(l.Events(10)) != 0 {
		t.Errorf("told=%v delivered=%v sent=%d recorded=%d", told, ok, len(s.delivered()), len(l.Events(10)))
	}
}

func TestAFailedChannelIsNamedInTheHistoryWithoutItsError(t *testing.T) {
	n := newNotifier(&config.Notifications{}, &fakeSender{name: "webhook", fails: 100}, &fakeSender{name: "telegram"})
	l := OpenLedger("", quiet)
	n.SetLedger(l)
	n.Start()
	n.Emit(Event{Type: config.EventAppDown})
	n.Close(time.Second)
	r := l.Events(1)[0]
	if r.Status != StatusPartial || len(r.FailedChannels) != 1 || r.FailedChannels[0] != "webhook" {
		t.Errorf("%+v", r)
	}
}

// --- the ledger ---------------------------------------------------------------------------------------------------

func TestTheLedgerKeepsTheNewestEventsAndSurvivesARestart(t *testing.T) {
	path := filepath.Join(t.TempDir(), "n.json")
	l := OpenLedger(path, quiet)
	for i := range KeepHistory + 5 {
		l.Add(Record{Event: Event{Type: config.EventJobFailed, Job: string(rune('a' + i%26)), Time: time.Unix(int64(i), 0)}, Status: StatusDelivered})
	}
	l.SetJobAlert("backup", JobAlert{At: time.Unix(99, 0), Delivered: false})
	again := OpenLedger(path, quiet)
	if got := again.Events(1000); len(got) != KeepHistory || got[0].Time.Unix() != int64(KeepHistory+4) {
		t.Errorf("%d events, newest first: %v", len(got), got[0].Time)
	}
	if a, ok := again.JobAlert("backup"); !ok || a.Delivered || a.At.Unix() != 99 {
		t.Errorf("the alert state of a job must survive a restart: %+v %v", a, ok)
	}
	again.ClearJobAlert("backup")
	if _, ok := OpenLedger(path, quiet).JobAlert("backup"); ok {
		t.Error("a cleared alert stays cleared")
	}
	if got := again.Events(3); len(got) != 3 {
		t.Errorf("limit: %d", len(got))
	}
	if n := again.Count(config.EventJobFailed, time.Unix(int64(KeepHistory+3), 0)); n != 2 {
		t.Errorf("count since: %d", n)
	}
}

func TestAnUnreadableLedgerIsSetAsideAndNeverStopsTheAgent(t *testing.T) {
	path := filepath.Join(t.TempDir(), "n.json")
	os.WriteFile(path, []byte("{not json"), 0o600)
	l := OpenLedger(path, quiet)
	l.Add(Record{Event: Event{Type: config.EventAppDown}, Status: StatusDelivered})
	if _, err := os.Stat(path + ".corrupt"); err != nil {
		t.Errorf("the unreadable file is kept for inspection: %v", err)
	}
	if len(OpenLedger(path, quiet).Events(5)) != 1 {
		t.Error("the new ledger works")
	}
	var nilLedger *Ledger
	nilLedger.Add(Record{}) // a notifier without a ledger records nothing, and does not crash
	if nilLedger.Events(3) != nil {
		t.Error("nil ledger")
	}
}

// --- the engine ---------------------------------------------------------------------------------------------------

func TestTheEngineIsDownAfterSeveralFailedProbesAndAnnouncedOnceAndWhenItIsBack(t *testing.T) {
	var fail bool
	var root string
	rec := &recorder{}
	w := NewEngineWatcher(func(context.Context) (string, error) {
		if fail {
			return "", errors.New("connection refused")
		}
		return "/var/lib/docker", nil
	}, rec.emit, 3, func(r string) { root = r }, quiet)
	w.Check(context.Background())
	if root != "/var/lib/docker" {
		t.Errorf("the engine says where it keeps its data: %q", root)
	}
	fail = true
	w.Check(context.Background())
	w.Check(context.Background())
	if len(rec.events) != 0 {
		t.Fatalf("an engine restart (an upgrade) is not an outage: %s", rec.types())
	}
	w.Check(context.Background())
	w.Check(context.Background())
	if rec.types() != "engine.down:" {
		t.Fatalf("down is announced once: %s", rec.types())
	}
	fail = false
	w.Check(context.Background())
	if rec.types() != "engine.down:,engine.recovered:" {
		t.Errorf("and when it answers again: %s", rec.types())
	}
}

// --- disk and memory ----------------------------------------------------------------------------------------------

func hostWith(usedPercent float64, availPercent float64, dev uint64) HostReader {
	return func(paths ...string) sysinfo.Host {
		h := sysinfo.Host{Memory: &sysinfo.Memory{Total: 1000, Available: uint64(availPercent * 10)}}
		if len(paths) > 0 {
			h.Disk = &sysinfo.Disk{Path: paths[0], Total: 1000, Free: uint64((100 - usedPercent) * 10), Dev: dev}
		}
		return h
	}
}

func TestDiskHighHasHysteresisAndTwoPathsOnOneFilesystemCountOnce(t *testing.T) {
	rec := &recorder{}
	used := 90.0
	m := NewHostMonitor(func(p ...string) sysinfo.Host { return hostWith(used, 50, 7)(p...) }, func() []string { return []string{"/var/lib/docker", "/var/lib/keelson"} }, rec.emit, 85, 10, quiet)
	m.Check()
	m.Check()
	if rec.types() != "disk.high:" {
		t.Fatalf("one alert for two paths on the same filesystem, and none again while it stays high: %s", rec.types())
	}
	used = 82 // under the threshold but not 5 points under: still high
	m.Check()
	used = 79
	m.Check()
	if rec.types() != "disk.high:,disk.recovered:" {
		t.Fatalf("recovered only 5 points below: %s", rec.types())
	}
	used = 86
	m.Check()
	if rec.types() != "disk.high:,disk.recovered:,disk.high:" {
		t.Errorf("and it can alert again: %s", rec.types())
	}
}

func TestMemoryLowAlertsOnceAndRearmsOnlyWellAboveTheThreshold(t *testing.T) {
	rec := &recorder{}
	avail := 5.0
	m := NewHostMonitor(func(p ...string) sysinfo.Host { return hostWith(10, avail, 1)(p...) }, func() []string { return nil }, rec.emit, 85, 10, quiet)
	m.Check()
	m.Check()
	avail = 12 // above 10 but not 15
	m.Check()
	avail = 8
	m.Check()
	if rec.types() != "memory.low:" {
		t.Fatalf("a value hovering around the threshold alerts once: %s", rec.types())
	}
	avail = 30
	m.Check()
	avail = 4
	m.Check()
	if rec.types() != "memory.low:,memory.low:" {
		t.Errorf("re-armed after a real recovery: %s", rec.types())
	}
}

// --- a flapping app -----------------------------------------------------------------------------------------------

func TestAFlappingAppAlertsOncePerCooldownAndABlipInsideItIsNeverAnnounced(t *testing.T) {
	src := &fakeSource{}
	w, rec, clock := newWatcher(src, 1)
	w.SetCooldown(5 * time.Minute)
	check(t, w, src, up)
	check(t, w, src, exited) // the first one always alerts
	check(t, w, src, up)
	*clock = clock.Add(time.Minute)
	check(t, w, src, exited) // inside the cooldown: held back
	check(t, w, src, up)     // and it came back before the cooldown ended: nobody hears about the blip
	if rec.types() != "app.down:web,app.recovered:web" {
		t.Fatalf("one pair for a flapping app: %s", rec.types())
	}
	*clock = clock.Add(10 * time.Minute)
	check(t, w, src, exited)
	if !strings.HasSuffix(rec.types(), "app.down:web") || strings.Count(rec.types(), "app.down") != 2 {
		t.Errorf("past the cooldown it alerts again: %s", rec.types())
	}

	// Still down when the cooldown ends: the held alert goes out then.
	src2 := &fakeSource{}
	w2, rec2, clock2 := newWatcher(src2, 1)
	w2.SetCooldown(5 * time.Minute)
	check(t, w2, src2, up)
	check(t, w2, src2, exited)
	check(t, w2, src2, up)
	*clock2 = clock2.Add(time.Minute)
	check(t, w2, src2, exited)
	*clock2 = clock2.Add(5 * time.Minute)
	check(t, w2, src2, exited)
	if strings.Count(rec2.types(), "app.down") != 2 {
		t.Errorf("an outage that outlasts the cooldown is announced: %s", rec2.types())
	}
}

// --- the service wires it together --------------------------------------------------------------------------------

func TestTheServiceStartsTheWatchersForTheEventsAskedForAndSaysTheAgentStartedOnce(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	svc := NewService(ctx, &fakeSource{}, quiet)
	ledger := OpenLedger("", quiet)
	svc.SetHooks(Hooks{Ledger: ledger, Version: "v9"})
	hook := &fakeSender{name: "s"}
	nc := &config.Notifications{Events: []string{config.EventAgentStarted}}
	n, err := New(nc, quiet)
	if err != nil {
		t.Fatal(err)
	}
	n.senders = []Sender{hook}
	svc.swap(nc, n)
	n2, _ := New(nc, quiet)
	n2.senders = []Sender{hook}
	svc.swap(nc, n2) // a reconfiguration must not announce a start again
	time.Sleep(50 * time.Millisecond)
	svc.Close(time.Second)
	got := hook.delivered()
	if len(got) != 1 || got[0].Type != config.EventAgentStarted || !strings.Contains(got[0].Message, "v9") {
		t.Errorf("agent.started once per process: %+v", got)
	}
	if svc.Events(5) == nil || len(svc.Events(5)) != 1 {
		t.Errorf("and it is in the history: %+v", svc.Events(5))
	}
}

func TestARestartLoopAnnouncesTheStartOncePerMinute(t *testing.T) {
	ledger := OpenLedger("", quiet)
	ledger.Add(Record{Event: Event{Type: config.EventAgentStarted, Time: time.Now().Add(-10 * time.Second)}, Status: StatusDelivered})
	svc := NewService(context.Background(), &fakeSource{}, quiet)
	svc.SetHooks(Hooks{Ledger: ledger})
	hook := &fakeSender{name: "s"}
	nc := &config.Notifications{Events: []string{config.EventAgentStarted}}
	n, _ := New(nc, quiet)
	n.senders = []Sender{hook}
	n.SetLedger(ledger)
	n.Start()
	svc.announceStart(n)
	n.Close(time.Second)
	if len(hook.delivered()) != 0 {
		t.Error("a second start within a minute is not announced")
	}
	if last := ledger.Events(1)[0]; last.Status != StatusSuppressed {
		t.Errorf("but it is in the history, as suppressed: %+v", last)
	}
}
