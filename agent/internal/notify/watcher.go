package notify

import (
	"context"
	"fmt"
	"log/slog"
	"time"

	"github.com/0x2u/keelson/agent/internal/config"
)

// AppState is what the watcher needs to know about one configured app.
type AppState struct {
	Name string
	// Present is false when the app has no container: not deployed yet, or gone.
	Present    bool
	Running    bool
	Restarting bool
	Health     string // "starting", "healthy", "unhealthy" or "" without a HEALTHCHECK
	ExitCode   int
	// Busy means a deployment is changing the app right now: its container is
	// expected to stop, start and be unhealthy for a while.
	Busy bool
}

// Source reports the state of every configured app.
type Source interface {
	Observe(ctx context.Context) ([]AppState, error)
}

// Watcher turns changes in app state into app.down and app.recovered events.
//
// An alert needs several bad observations in a row, so a restart or a deploy
// that takes a few seconds does not page anyone, and an app is announced once
// when it goes down and once when it is back, not on every observation.
type Watcher struct {
	src       Source
	emit      func(Event)
	every     time.Duration
	threshold int
	log       *slog.Logger
	now       func() time.Time
	apps      map[string]*watched
	// cooldown is how long after an app.down the next one for the same app is held back; 0 sends every one.
	cooldown time.Duration
	// record, when set, is told when an app goes down and when it is up again: see AvailabilityWatcher.
	record AvailabilitySink
}

// Observation rhythm of the app watcher: three bad observations 15 s apart make an app down, so a restart or a slow deploy
// stays quiet. The alerts and the availability record use the same, so that they say the same thing.
const (
	WatchEvery     = 15 * time.Second
	WatchThreshold = 3
)

// AvailabilitySink keeps the app's up and down transitions.
type AvailabilitySink interface {
	// AppDownStates says, for each app on record, whether it was down at its last transition.
	AppDownStates(ctx context.Context) (map[string]bool, error)
	RecordAppState(ctx context.Context, app string, down bool, at time.Time) error
}

// NewAvailabilityWatcher watches the apps like the one behind the alerts, and records when each goes down and comes back
// instead of sending anything. It judges the same way (the consecutive-observation threshold, no verdict while an app is
// being deployed or warming up) but not the alert cooldown: an app that is down is recorded as down whether or not its
// alert was held back. An incident that was open when the agent stopped stays open until the app is seen healthy.
func NewAvailabilityWatcher(src Source, sink AvailabilitySink, log *slog.Logger) *Watcher {
	w := NewWatcher(src, func(Event) {}, WatchEvery, WatchThreshold, log)
	w.record = sink
	return w
}

type watched struct {
	seen     bool // the app has had a container while we were watching
	bad      int
	down     bool // the app is down for the availability record: bad reached the threshold, no recovery since
	recorded bool // the record has a state for the app
	alerted  bool
	held     bool // an app.down is waiting for the cooldown to end
	since    time.Time
	lastDown time.Time // when app.down was last sent for the app
}

// NewWatcher watches src every interval; threshold consecutive bad
// observations make an app "down".
func NewWatcher(src Source, emit func(Event), every time.Duration, threshold int, log *slog.Logger) *Watcher {
	if log == nil {
		log = slog.Default()
	}
	return &Watcher{src: src, emit: emit, every: every, threshold: threshold, log: log, now: time.Now, apps: map[string]*watched{}}
}

// SetCooldown holds back an app.down while the previous one for the same app is younger than d: a flapping app
// then sends one pair of messages per cooldown, not one per cycle. The first app.down of an app is never held.
func (w *Watcher) SetCooldown(d time.Duration) { w.cooldown = d }

// problem describes what is wrong with an app, or "" if nothing is.
func problem(a AppState) string {
	switch {
	case !a.Present:
		return "The container is gone"
	case a.Restarting:
		return "The container keeps restarting"
	case !a.Running:
		return fmt.Sprintf("The container is not running (exit code %d)", a.ExitCode)
	case a.Health == "unhealthy":
		return "The container is unhealthy"
	}
	return ""
}

// Check makes one observation pass.
func (w *Watcher) Check(ctx context.Context) error {
	states, err := w.src.Observe(ctx)
	if err != nil {
		return err
	}
	listed := make(map[string]bool, len(states))
	for _, a := range states {
		listed[a.Name] = true
		st := w.apps[a.Name]
		if st == nil {
			st = &watched{}
			w.apps[a.Name] = st
		}
		if a.Present {
			st.seen = true
		}
		if a.Busy {
			st.bad = 0 // the swap window leaves no verdict, and its observations must not add up with later ones
		}
		if !st.seen || a.Busy || (a.Present && a.Running && a.Health == "starting") {
			continue // never deployed, being replaced, or still warming up: no verdict
		}

		if p := problem(a); p != "" {
			st.bad++
			if st.bad >= w.threshold && !st.down {
				st.down, st.recorded = true, true
				w.persist(ctx, a.Name, true)
			}
			if st.bad >= w.threshold && !st.alerted {
				now := w.now()
				if !st.lastDown.IsZero() && now.Sub(st.lastDown) < w.cooldown {
					// A flapping app: the last alert is too recent. If it is still down when the cooldown ends,
					// it alerts then; if it came back before, nobody is told about the blip.
					if !st.held {
						st.held = true
						w.log.Info("app.down held back: the app alerted recently", "app", a.Name, "cooldown", w.cooldown)
					}
					continue
				}
				st.alerted, st.held, st.since, st.lastDown = true, false, now, now
				w.emit(Event{
					Type: config.EventAppDown, Severity: SeverityCritical, App: a.Name,
					Title: a.Name + " is down", Message: p + ".",
				})
			}
			continue
		}
		st.bad, st.held = 0, false
		if st.down || !st.recorded {
			st.down, st.recorded = false, true
			w.persist(ctx, a.Name, false) // the first healthy verdict of an app starts its record
		}
		if st.alerted {
			st.alerted = false
			w.emit(Event{
				Type: config.EventAppRecovered, Severity: SeverityInfo, App: a.Name,
				Title:   a.Name + " is back",
				Message: fmt.Sprintf("It was down for %s.", w.now().Sub(st.since).Round(time.Second)),
			})
		}
	}
	// An app that left the configuration while down is no longer down: its incident ends with it.
	for name, st := range w.apps {
		if !listed[name] && st.down {
			st.down, st.bad, st.alerted, st.held = false, 0, false, false
			w.persist(ctx, name, false)
		}
	}
	return nil
}

// persist tells the availability record about a transition. A record that cannot be written is logged, not retried: the
// next transition writes its own row.
func (w *Watcher) persist(ctx context.Context, app string, down bool) {
	if w.record == nil {
		return
	}
	if err := w.record.RecordAppState(ctx, app, down, w.now()); err != nil && ctx.Err() == nil {
		w.log.Warn("app availability could not be recorded", "app", app, "down", down, "err", err)
	}
}

// seed loads the state the record ended with, so that an app that was down when the agent stopped is still one now, and
// an app that was up is not recorded as newly seen.
func (w *Watcher) seed(ctx context.Context) {
	if w.record == nil {
		return
	}
	known, err := w.record.AppDownStates(ctx)
	if err != nil {
		w.log.Warn("app availability could not be read", "err", err)
		return
	}
	for app, down := range known {
		st := &watched{recorded: true, down: down}
		if down {
			st.seen = true // it has been judged: a missing container counts against it
		}
		w.apps[app] = st
	}
}

// Run checks every interval until ctx ends.
func (w *Watcher) Run(ctx context.Context) {
	w.seed(ctx)
	t := time.NewTicker(w.every)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			if err := w.Check(ctx); err != nil && ctx.Err() == nil {
				w.log.Warn("app watcher could not observe the apps", "err", err)
			}
		}
	}
}
