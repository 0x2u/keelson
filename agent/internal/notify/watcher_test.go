package notify

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/0x2u/keelson/agent/internal/config"
)

type fakeSource struct {
	states []AppState
	err    error
}

func (f *fakeSource) Observe(context.Context) ([]AppState, error) { return f.states, f.err }

type recorder struct{ events []Event }

func (r *recorder) emit(e Event) { r.events = append(r.events, e) }

func (r *recorder) types() string {
	var out []string
	for _, e := range r.events {
		out = append(out, e.Type+":"+e.App)
	}
	return strings.Join(out, ",")
}

func newWatcher(src Source, threshold int) (*Watcher, *recorder, *time.Time) {
	rec := &recorder{}
	w := NewWatcher(src, rec.emit, time.Second, threshold, quiet)
	clock := time.Date(2026, 1, 1, 12, 0, 0, 0, time.UTC)
	w.now = func() time.Time { return clock }
	return w, rec, &clock
}

var (
	up        = AppState{Name: "web", Present: true, Running: true, Health: "healthy"}
	exited    = AppState{Name: "web", Present: true, Running: false, ExitCode: 137}
	unhealthy = AppState{Name: "web", Present: true, Running: true, Health: "unhealthy"}
)

func check(t *testing.T, w *Watcher, src *fakeSource, s ...AppState) {
	t.Helper()
	src.states = s
	if err := w.Check(context.Background()); err != nil {
		t.Fatal(err)
	}
}

func TestAnAppIsDownOnlyAfterSeveralBadObservationsAndAnnouncedOnce(t *testing.T) {
	src := &fakeSource{}
	w, rec, _ := newWatcher(src, 3)
	check(t, w, src, up)
	check(t, w, src, exited)
	check(t, w, src, exited)
	if len(rec.events) != 0 {
		t.Fatalf("two bad observations are not enough: %s", rec.types())
	}
	check(t, w, src, exited)
	check(t, w, src, exited)
	check(t, w, src, exited)
	if rec.types() != "app.down:web" {
		t.Errorf("down must be announced once, got %s", rec.types())
	}
	e := rec.events[0]
	if e.Severity != SeverityCritical || !strings.Contains(e.Message, "exit code 137") {
		t.Errorf("unexpected event: %+v", e)
	}
}

func TestARecoveryIsAnnouncedWithTheOutageDuration(t *testing.T) {
	src := &fakeSource{}
	w, rec, clock := newWatcher(src, 1)
	check(t, w, src, up)
	check(t, w, src, unhealthy)
	*clock = clock.Add(95 * time.Second)
	check(t, w, src, up)
	if rec.types() != "app.down:web,app.recovered:web" {
		t.Fatalf("got %s", rec.types())
	}
	if !strings.Contains(rec.events[1].Message, "1m35s") {
		t.Errorf("recovery should say how long it was down: %q", rec.events[1].Message)
	}
	check(t, w, src, up)
	if len(rec.events) != 2 {
		t.Error("staying healthy must not repeat the recovery")
	}
}

func TestABlipShorterThanTheThresholdNeverAlerts(t *testing.T) {
	src := &fakeSource{}
	w, rec, _ := newWatcher(src, 3)
	check(t, w, src, up)
	check(t, w, src, exited)
	check(t, w, src, exited)
	check(t, w, src, up) // back before the third bad observation
	check(t, w, src, exited)
	check(t, w, src, exited)
	if len(rec.events) != 0 {
		t.Errorf("the counter must restart after a good observation: %s", rec.types())
	}
}

func TestADeploymentInProgressIsNotAnOutage(t *testing.T) {
	src := &fakeSource{}
	w, rec, _ := newWatcher(src, 1)
	check(t, w, src, up)
	busy := exited
	busy.Busy = true
	for range 5 {
		check(t, w, src, busy) // an in-place deployment stops the container on purpose
	}
	if len(rec.events) != 0 {
		t.Errorf("a busy app gets no verdict: %s", rec.types())
	}
	check(t, w, src, up)
	if len(rec.events) != 0 {
		t.Error("and no recovery either, since it never counted as down")
	}
}

func TestAContainerThatIsStillStartingGetsNoVerdict(t *testing.T) {
	src := &fakeSource{}
	w, rec, _ := newWatcher(src, 1)
	check(t, w, src, up)
	starting := AppState{Name: "web", Present: true, Running: true, Health: "starting"}
	check(t, w, src, starting)
	if len(rec.events) != 0 {
		t.Errorf("a health check that has not answered yet is not a failure: %s", rec.types())
	}
}

func TestAnAppThatWasNeverDeployedIsIgnoredButAVanishedOneIsNot(t *testing.T) {
	src := &fakeSource{}
	w, rec, _ := newWatcher(src, 1)
	for range 3 {
		check(t, w, src, AppState{Name: "web"}) // configured, never deployed
	}
	if len(rec.events) != 0 {
		t.Fatalf("an app with no container yet is not down: %s", rec.types())
	}
	check(t, w, src, up)
	check(t, w, src, AppState{Name: "web"}) // its container disappeared
	if rec.types() != "app.down:web" || !strings.Contains(rec.events[0].Message, "gone") {
		t.Errorf("got %s", rec.types())
	}
}

func TestRestartingContainersAndAppsAreTrackedIndependently(t *testing.T) {
	src := &fakeSource{}
	w, rec, _ := newWatcher(src, 1)
	api := AppState{Name: "api", Present: true, Running: true}
	check(t, w, src, up, api)
	check(t, w, src, AppState{Name: "web", Present: true, Running: true, Restarting: true}, api)
	if rec.types() != "app.down:web" || !strings.Contains(rec.events[0].Message, "restarting") {
		t.Errorf("got %s", rec.types())
	}
	check(t, w, src, up, AppState{Name: "api", Present: true, Running: false})
	if rec.types() != "app.down:web,app.recovered:web,app.down:api" {
		t.Errorf("got %s", rec.types())
	}
}

func TestObservationErrorsAreReturnedAndChangeNothing(t *testing.T) {
	src := &fakeSource{err: errors.New("docker unreachable")}
	w, rec, _ := newWatcher(src, 1)
	if err := w.Check(context.Background()); err == nil {
		t.Error("want the error")
	}
	if len(rec.events) != 0 {
		t.Error("not knowing is not the same as being down")
	}
}

func TestEventTypesAreTheConfiguredNames(t *testing.T) {
	src := &fakeSource{}
	w, rec, _ := newWatcher(src, 1)
	check(t, w, src, up)
	check(t, w, src, exited)
	check(t, w, src, up)
	if rec.events[0].Type != config.EventAppDown || rec.events[1].Type != config.EventAppRecovered {
		t.Errorf("types must match the names users put in `events`: %s", rec.types())
	}
}
