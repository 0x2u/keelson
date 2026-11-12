package store

import (
	"context"
	"math"
	"sort"
	"time"
)

// AvailabilityRetention is how long the transitions of an app are kept.
const AvailabilityRetention = 30 * 24 * time.Hour

// MaxIncidents is how many incidents an availability answer lists.
const MaxIncidents = 50

const (
	stateUp   = "up"
	stateDown = "down"
)

// Incident is one period when an app was down, as the app watcher judged it. End is nil while it lasts.
type Incident struct {
	Start time.Time  `json:"start"`
	End   *time.Time `json:"end"`
	// DurationSeconds runs to the end of the range for an incident that is still going.
	DurationSeconds int64 `json:"duration_seconds"`
}

// Availability is how much of a range an app was up, over the part of it that was recorded.
type Availability struct {
	From time.Time `json:"from"`
	To   time.Time `json:"to"`
	// Since is where the recorded part starts: the range's start, or later when the agent has watched the app for less
	// time than the range. Nil when the app has not been judged yet, which is also when UptimePercent is nil.
	Since          *time.Time `json:"since"`
	CoveredSeconds int64      `json:"covered_seconds"`
	DownSeconds    int64      `json:"down_seconds"`
	UptimePercent  *float64   `json:"uptime_percent"`
	// Incidents that touch the range, newest first.
	Incidents []Incident `json:"incidents"`
}

type appTransition struct {
	down bool
	at   time.Time
}

// RecordAppState records that an app went down, or came back (or was first judged healthy), at the given instant, and
// deletes what is past the retention, except the newest row of each app before it: it is the state the app was in when the
// retained period began.
func (s *Store) RecordAppState(ctx context.Context, app string, down bool, at time.Time) error {
	state := stateUp
	if down {
		state = stateDown
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.ExecContext(ctx, `INSERT INTO app_transitions (app, ts, state) VALUES (?,?,?)`, app, ms(at), state); err != nil {
		return err
	}
	cutoff := ms(at.Add(-AvailabilityRetention))
	if _, err := tx.ExecContext(ctx, `
		DELETE FROM app_transitions WHERE ts < ?1 AND id NOT IN (
			SELECT MAX(id) FROM app_transitions WHERE ts < ?1 GROUP BY app
		)`, cutoff); err != nil {
		return err
	}
	return tx.Commit()
}

// AppDownStates returns, for every app that has a record, whether it was down at its last transition.
func (s *Store) AppDownStates(ctx context.Context) (map[string]bool, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT app, state FROM app_transitions WHERE id IN (SELECT MAX(id) FROM app_transitions GROUP BY app)`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]bool{}
	for rows.Next() {
		var app, state string
		if err := rows.Scan(&app, &state); err != nil {
			return nil, err
		}
		out[app] = state == stateDown
	}
	return out, rows.Err()
}

// AppAvailability computes the availability of an app over [from, to] from its recorded transitions.
func (s *Store) AppAvailability(ctx context.Context, app string, from, to time.Time) (Availability, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT ts, state FROM app_transitions WHERE app = ? ORDER BY ts, id`, app)
	if err != nil {
		return Availability{}, err
	}
	defer rows.Close()
	var ts []appTransition
	for rows.Next() {
		var at int64
		var state string
		if err := rows.Scan(&at, &state); err != nil {
			return Availability{}, err
		}
		ts = append(ts, appTransition{down: state == stateDown, at: time.UnixMilli(at).UTC()})
	}
	if err := rows.Err(); err != nil {
		return Availability{}, err
	}
	return computeAvailability(ts, from, to), nil
}

// computeAvailability turns transitions (oldest first) into the answer for [from, to]. The app's state is known from its
// first transition on; before that nothing is claimed. Time after the last transition keeps its state.
func computeAvailability(ts []appTransition, from, to time.Time) Availability {
	a := Availability{From: from.UTC(), To: to.UTC(), Incidents: []Incident{}}
	if len(ts) == 0 || ts[0].at.After(to) {
		return a
	}

	type span struct{ start, end time.Time } // end is zero while open
	var spans []span
	for _, t := range ts {
		open := len(spans) > 0 && spans[len(spans)-1].end.IsZero()
		switch {
		case t.down && !open:
			spans = append(spans, span{start: t.at})
		case !t.down && open:
			spans[len(spans)-1].end = t.at
		}
	}

	since := ts[0].at
	if since.Before(from) {
		since = from
	}
	covered := to.Sub(since)
	var down time.Duration
	for _, sp := range spans {
		end := sp.end
		ongoing := end.IsZero() || end.After(to)
		if ongoing {
			end = to
		}
		if !sp.start.Before(to) || end.Before(from) {
			continue // not in the range at all
		}
		lo := sp.start
		if lo.Before(since) {
			lo = since
		}
		if end.After(lo) {
			down += end.Sub(lo)
		}
		inc := Incident{Start: sp.start.UTC(), DurationSeconds: int64(end.Sub(sp.start) / time.Second)}
		if !ongoing {
			e := end.UTC()
			inc.End = &e
		}
		a.Incidents = append(a.Incidents, inc)
	}
	sort.SliceStable(a.Incidents, func(i, j int) bool { return a.Incidents[i].Start.After(a.Incidents[j].Start) })
	if len(a.Incidents) > MaxIncidents {
		a.Incidents = a.Incidents[:MaxIncidents]
	}

	s := since.UTC()
	a.Since = &s
	a.CoveredSeconds = int64(covered / time.Second)
	a.DownSeconds = int64(down / time.Second)
	if covered > 0 {
		pct := math.Round((1-float64(down)/float64(covered))*100*10000) / 10000
		a.UptimePercent = &pct
	}
	return a
}
