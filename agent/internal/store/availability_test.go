package store

import (
	"testing"
	"time"
)

func tr(down bool, at time.Duration) appTransition { return appTransition{down: down, at: t0.Add(at)} }

func TestAvailabilityCountsOnlyTheRecordedPartOfTheRange(t *testing.T) {
	// Judged healthy 2 h ago, down for 30 min starting 1 h ago: over a 24 h range only the last 2 h are known.
	to := t0.Add(2 * time.Hour)
	a := computeAvailability([]appTransition{tr(false, 0), tr(true, time.Hour), tr(false, 90*time.Minute)}, to.Add(-24*time.Hour), to)
	if a.Since == nil || !a.Since.Equal(t0) {
		t.Fatalf("the record starts at the first judgement, not at the start of the range: %+v", a.Since)
	}
	if a.CoveredSeconds != 7200 || a.DownSeconds != 1800 || a.UptimePercent == nil || *a.UptimePercent != 75 {
		t.Errorf("75%% of the 2 recorded hours: %+v", a)
	}
	if len(a.Incidents) != 1 || a.Incidents[0].End == nil || a.Incidents[0].DurationSeconds != 1800 || !a.Incidents[0].Start.Equal(t0.Add(time.Hour)) {
		t.Errorf("one closed incident of 30 minutes: %+v", a.Incidents)
	}
}

func TestAvailabilityOfAnOngoingIncidentRunsToTheEndOfTheRange(t *testing.T) {
	to := t0.Add(10 * time.Hour)
	a := computeAvailability([]appTransition{tr(false, 0), tr(true, 8*time.Hour)}, to.Add(-24*time.Hour), to)
	if len(a.Incidents) != 1 || a.Incidents[0].End != nil || a.Incidents[0].DurationSeconds != 7200 {
		t.Errorf("an incident that lasts has no end: %+v", a.Incidents)
	}
	if *a.UptimePercent != 80 {
		t.Errorf("8 of 10 hours: %v", *a.UptimePercent)
	}
}

func TestAvailabilityClipsAnIncidentThatBeganBeforeTheRangeButListsItWhole(t *testing.T) {
	// A 10 h outage from t0+1h to t0+11h; the range is the 5 h before t0+12h.
	to := t0.Add(12 * time.Hour)
	ts := []appTransition{tr(false, 0), tr(true, time.Hour), tr(false, 11*time.Hour)}
	a := computeAvailability(ts, to.Add(-5*time.Hour), to)
	if a.DownSeconds != 4*3600 || a.CoveredSeconds != 5*3600 || *a.UptimePercent != 20 {
		t.Errorf("only the 4 h inside the range count against it: %+v", a)
	}
	if len(a.Incidents) != 1 || a.Incidents[0].DurationSeconds != 10*3600 {
		t.Errorf("the incident is listed with its real duration: %+v", a.Incidents)
	}
	// An incident wholly before the range is not part of it.
	a = computeAvailability(ts, to.Add(-30*time.Minute), to)
	if len(a.Incidents) != 0 || a.DownSeconds != 0 || *a.UptimePercent != 100 {
		t.Errorf("an old incident is out: %+v", a)
	}
}

func TestAvailabilityNeverClaimsWhatWasNotWatched(t *testing.T) {
	a := computeAvailability(nil, t0, t0.Add(time.Hour))
	if a.Since != nil || a.UptimePercent != nil || a.Incidents == nil || len(a.Incidents) != 0 {
		t.Errorf("no record: no uptime, an empty list: %+v", a)
	}
	// First judged after the end of the range.
	a = computeAvailability([]appTransition{tr(false, 2*time.Hour)}, t0, t0.Add(time.Hour))
	if a.Since != nil || a.UptimePercent != nil {
		t.Errorf("judged only later: %+v", a)
	}
	// Judged at the very end: known, but no time covered yet.
	a = computeAvailability([]appTransition{tr(false, time.Hour)}, t0, t0.Add(time.Hour))
	if a.Since == nil || a.UptimePercent != nil || a.CoveredSeconds != 0 {
		t.Errorf("nothing covered yet: %+v", a)
	}
}

func TestAvailabilityListsNewestIncidentsFirstAndAtMostFifty(t *testing.T) {
	var ts []appTransition
	ts = append(ts, tr(false, 0))
	for i := 0; i < 60; i++ {
		ts = append(ts, tr(true, time.Duration(2*i+1)*time.Minute), tr(false, time.Duration(2*i+2)*time.Minute))
	}
	a := computeAvailability(ts, t0, t0.Add(3*time.Hour))
	if len(a.Incidents) != MaxIncidents || !a.Incidents[0].Start.After(a.Incidents[1].Start) {
		t.Fatalf("newest first, capped: %d", len(a.Incidents))
	}
	if !a.Incidents[0].Start.Equal(t0.Add(119 * time.Minute)) {
		t.Errorf("the newest incident leads: %s", a.Incidents[0].Start)
	}
	if a.DownSeconds != 60*60 {
		t.Errorf("the cap is on the list, not on the total: %d", a.DownSeconds)
	}
}

func TestAppTransitionsAreStoredPrunedAfterThirtyDaysAndKeepTheStateAtTheCutoff(t *testing.T) {
	st := open(t)
	day := 24 * time.Hour
	rec := func(app string, down bool, at time.Duration) {
		t.Helper()
		if err := st.RecordAppState(ctx, app, down, t0.Add(at)); err != nil {
			t.Fatal(err)
		}
	}
	rec("web", false, 0)
	rec("web", true, 10*day)
	rec("web", false, 11*day)
	rec("db", false, 5*day)
	// 45 days in: the cutoff is day 15. web's newest row before it (up, day 11) is kept as its state then; db's (up, day 5)
	// too; web's older rows go.
	rec("web", true, 45*day)

	states, err := st.AppDownStates(ctx)
	if err != nil || len(states) != 2 || !states["web"] || states["db"] {
		t.Fatalf("last state per app: %v, %v", states, err)
	}
	a, err := st.AppAvailability(ctx, "web", t0.Add(15*day), t0.Add(46*day))
	if err != nil {
		t.Fatal(err)
	}
	if a.Since == nil || !a.Since.Equal(t0.Add(15*day)) {
		t.Errorf("the state at the cutoff is still known, so the whole range is covered: %+v", a.Since)
	}
	if len(a.Incidents) != 1 || a.Incidents[0].End != nil || a.DownSeconds != 86400 {
		t.Errorf("only the ongoing incident remains: %+v", a)
	}
	var n int
	if err := st.db.QueryRow(`SELECT COUNT(*) FROM app_transitions WHERE app = 'web'`).Scan(&n); err != nil || n != 2 {
		t.Errorf("web keeps its baseline and the new row: %d, %v", n, err)
	}
}
