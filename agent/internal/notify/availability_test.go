package notify

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"
)

type fakeAvailability struct {
	states map[string]bool
	rows   []string // "web:down@12:00:30"
	err    error
}

func (f *fakeAvailability) AppDownStates(context.Context) (map[string]bool, error) {
	return f.states, f.err
}

func (f *fakeAvailability) RecordAppState(_ context.Context, app string, down bool, at time.Time) error {
	if f.err != nil {
		return f.err
	}
	state := "up"
	if down {
		state = "down"
	}
	f.rows = append(f.rows, app+":"+state+"@"+at.Format("15:04:05"))
	return nil
}

func (f *fakeAvailability) log() string { return strings.Join(f.rows, ",") }

// newTracker returns a watcher for the availability record, and the one for the alerts, fed by the same source and clock.
func newTracker(src Source, threshold int, sink *fakeAvailability) (rec, alerts *Watcher, ev *recorder, clock *time.Time) {
	alerts, ev, clock = newWatcher(src, threshold)
	rec = NewAvailabilityWatcher(src, sink, quiet)
	rec.threshold = threshold
	rec.now = func() time.Time { return *clock }
	return rec, alerts, ev, clock
}

func TestAvailabilityIsRecordedWhereTheAlertSaysDownAndWhereItSaysBack(t *testing.T) {
	src := &fakeSource{}
	sink := &fakeAvailability{}
	rec, alerts, events, clock := newTracker(src, 3, sink)
	step := func(s AppState) {
		t.Helper()
		src.states = []AppState{s}
		if err := rec.Check(context.Background()); err != nil {
			t.Fatal(err)
		}
		if err := alerts.Check(context.Background()); err != nil {
			t.Fatal(err)
		}
		*clock = clock.Add(15 * time.Second)
	}
	step(up)     // 12:00:00 first healthy verdict: the record starts
	step(exited) // :15
	step(exited) // :30
	if sink.log() != "web:up@12:00:00" {
		t.Fatalf("two bad observations are not an outage: %s", sink.log())
	}
	step(exited) // :45 the third: down
	step(exited)
	step(up) // 12:01:15
	if sink.log() != "web:up@12:00:00,web:down@12:00:45,web:up@12:01:15" {
		t.Errorf("one incident, down at the threshold, closed at the recovery: %s", sink.log())
	}
	// It is what the alerts said, at the same instants.
	if events.types() != "app.down:web,app.recovered:web" {
		t.Errorf("alerts: %s", events.types())
	}
}

func TestAvailabilityIgnoresBlipsDeploymentsAndWarmUps(t *testing.T) {
	src := &fakeSource{}
	sink := &fakeAvailability{}
	rec, _, _, _ := newTracker(src, 3, sink)
	check(t, rec, src, up)
	check(t, rec, src, exited)
	check(t, rec, src, exited)
	check(t, rec, src, up) // back before the third
	busy := exited
	busy.Busy = true
	for range 5 {
		check(t, rec, src, busy)
	}
	check(t, rec, src, AppState{Name: "web", Present: true, Running: true, Health: "starting"})
	if sink.log() != "web:up@12:00:00" {
		t.Errorf("only the first verdict is recorded: %s", sink.log())
	}
}

func TestAnAppNeverDeployedHasNoRecordUntilItIsFirstJudged(t *testing.T) {
	src := &fakeSource{}
	sink := &fakeAvailability{}
	rec, _, _, _ := newTracker(src, 1, sink)
	for range 3 {
		check(t, rec, src, AppState{Name: "web"})
	}
	if sink.log() != "" {
		t.Fatalf("an app with no container yet says nothing: %s", sink.log())
	}
	check(t, rec, src, up)
	if sink.log() != "web:up@12:00:00" {
		t.Errorf("got %s", sink.log())
	}
}

func TestAnIncidentOpenAtRestartContinuesAndAnAppOnRecordIsNotRecordedAgain(t *testing.T) {
	src := &fakeSource{}
	sink := &fakeAvailability{states: map[string]bool{"web": true, "api": false}}
	rec, _, _, clock := newTracker(src, 2, sink)
	rec.seed(context.Background())

	api := AppState{Name: "api", Present: true, Running: true}
	src.states = []AppState{exited, api}
	for range 3 {
		if err := rec.Check(context.Background()); err != nil {
			t.Fatal(err)
		}
	}
	if sink.log() != "" {
		t.Fatalf("web is already down on record, api already up: nothing new: %s", sink.log())
	}
	*clock = clock.Add(time.Minute)
	src.states = []AppState{up, api}
	if err := rec.Check(context.Background()); err != nil {
		t.Fatal(err)
	}
	if sink.log() != "web:up@12:01:00" {
		t.Errorf("the open incident closes when the app is seen healthy: %s", sink.log())
	}
}

func TestAnAppThatLeavesTheConfigurationWhileDownEndsItsIncident(t *testing.T) {
	src := &fakeSource{}
	sink := &fakeAvailability{}
	rec, _, _, _ := newTracker(src, 1, sink)
	check(t, rec, src, up)
	check(t, rec, src, exited)
	check(t, rec, src) // web is no longer configured
	if sink.log() != "web:up@12:00:00,web:down@12:00:00,web:up@12:00:00" {
		t.Errorf("got %s", sink.log())
	}
	check(t, rec, src)
	if len(sink.rows) != 3 {
		t.Errorf("once only: %s", sink.log())
	}
}

func TestARecordThatCannotBeWrittenOrReadDoesNotStopTheWatcher(t *testing.T) {
	src := &fakeSource{}
	sink := &fakeAvailability{err: errors.New("database is locked")}
	rec, _, _, _ := newTracker(src, 1, sink)
	rec.seed(context.Background())
	check(t, rec, src, up)
	check(t, rec, src, exited)
	check(t, rec, src, up)
	if len(sink.rows) != 0 {
		t.Error("nothing was written")
	}
	if rec.apps["web"].down {
		t.Error("the watcher kept its own state")
	}
}
