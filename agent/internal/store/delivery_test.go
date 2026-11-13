package store

import (
	"testing"
	"time"
)

// deployed records one finished deployment of app: started `ago` before now, lasting `took`, ending with status, and
// carrying the time of its commit when committed is not zero.
func deployed(t *testing.T, s *Store, app string, now time.Time, ago, took time.Duration, status string, committed time.Duration) string {
	t.Helper()
	id := NewID()
	d := Deployment{ID: id, App: app, Ref: "o/" + app + ":v", Trigger: "api", StartedAt: now.Add(-ago)}
	if committed != 0 {
		at := now.Add(-committed)
		d.CommittedAt = &at
	}
	if err := s.CreateDeployment(ctx, d); err != nil {
		t.Fatal(err)
	}
	if err := s.Finish(ctx, id, status, "", "o/"+app+":v", now.Add(-ago+took)); err != nil {
		t.Fatal(err)
	}
	return id
}

func down(t *testing.T, s *Store, app string, at time.Time, isDown bool) {
	t.Helper()
	if err := s.RecordAppState(ctx, app, isDown, at); err != nil {
		t.Fatal(err)
	}
}

func TestDeliveryCountsTheOutcomesAndTheFrequency(t *testing.T) {
	s := open(t)
	now := t0
	for range 6 {
		deployed(t, s, "web", now, 24*time.Hour, time.Minute, StatusSucceeded, 0)
	}
	deployed(t, s, "web", now, 20*time.Hour, time.Minute, StatusFailed, 0)
	deployed(t, s, "web", now, 10*time.Hour, time.Minute, StatusRolledBack, 0)
	deployed(t, s, "api", now, 5*time.Hour, time.Minute, StatusRollbackFailed, 0)
	// Older than the window, and still running: neither counts.
	deployed(t, s, "web", now, 40*24*time.Hour, time.Minute, StatusSucceeded, 0)
	if err := s.CreateDeployment(ctx, Deployment{ID: NewID(), App: "web", Ref: "o/web:v", Trigger: "api", StartedAt: now}); err != nil {
		t.Fatal(err)
	}

	d, err := s.Delivery(ctx, "", now.Add(-3*24*time.Hour), now)
	if err != nil {
		t.Fatal(err)
	}
	want := DeploymentCounts{Total: 9, Succeeded: 6, Failed: 1, RolledBack: 1, RollbackFailed: 1}
	if d.Deployments != want {
		t.Fatalf("got %+v, want %+v", d.Deployments, want)
	}
	if got := d.PerDay; got != 2 {
		t.Errorf("six successes over three days is %v a day, want 2", got)
	}
	if d.ChangeFailureRatio == nil || *d.ChangeFailureRatio != 3.0/9.0 {
		t.Errorf("three of nine failed: %v", d.ChangeFailureRatio)
	}

	one, err := s.Delivery(ctx, "api", now.Add(-3*24*time.Hour), now)
	if err != nil {
		t.Fatal(err)
	}
	if one.Deployments.Total != 1 || one.Deployments.RollbackFailed != 1 || *one.ChangeFailureRatio != 1 {
		t.Errorf("one app's own numbers: %+v", one.Deployments)
	}
}

func TestDeliveryHasNoRatioWithoutAFinishedDeployment(t *testing.T) {
	s := open(t)
	d, err := s.Delivery(ctx, "", t0.Add(-24*time.Hour), t0)
	if err != nil {
		t.Fatal(err)
	}
	if d.ChangeFailureRatio != nil || d.PerDay != 0 || d.Deployments.Total != 0 {
		t.Errorf("a quiet server has no failure rate to show: %+v", d)
	}
	if d.Restore.MedianSeconds != nil || d.LeadTime.MedianSeconds != nil || d.LeadTime.Covered != nil {
		t.Errorf("and no restore or lead time: %+v %+v", d.Restore, d.LeadTime)
	}
}

func TestDeliveryMeasuresTheOutagesOfEveryWatchedApp(t *testing.T) {
	s := open(t)
	now := t0
	down(t, s, "web", now.Add(-10*time.Hour), false)
	down(t, s, "web", now.Add(-8*time.Hour), true)
	down(t, s, "web", now.Add(-7*time.Hour), false) // one hour
	down(t, s, "api", now.Add(-6*time.Hour), false)
	down(t, s, "api", now.Add(-5*time.Hour), true)
	down(t, s, "api", now.Add(-4*time.Hour), false) // one hour
	down(t, s, "api", now.Add(-2*time.Hour), true)  // still down

	d, err := s.Delivery(ctx, "", now.Add(-24*time.Hour), now)
	if err != nil {
		t.Fatal(err)
	}
	if d.Restore.Incidents != 3 || d.Restore.Ongoing != 1 {
		t.Fatalf("three outages, one of them going: %+v", d.Restore)
	}
	if *d.Restore.MedianSeconds != 3600 || *d.Restore.LongestSeconds != 7200 {
		t.Errorf("median an hour, longest the two hours of the open one: %+v", d.Restore)
	}
	one, err := s.Delivery(ctx, "web", now.Add(-24*time.Hour), now)
	if err != nil {
		t.Fatal(err)
	}
	if one.Restore.Incidents != 1 || one.Restore.Ongoing != 0 {
		t.Errorf("only that app's outages: %+v", one.Restore)
	}
}

func TestDeliveryMeasuresTheLeadTimeOverTheDeploymentsThatKnowTheirCommit(t *testing.T) {
	s := open(t)
	now := t0
	// Three successes: committed 2 h, 4 h and 10 h before they finished; one success with no commit time.
	deployed(t, s, "web", now, 10*time.Hour, time.Minute, StatusSucceeded, 12*time.Hour)
	deployed(t, s, "web", now, 8*time.Hour, time.Minute, StatusSucceeded, 12*time.Hour)
	deployed(t, s, "web", now, 6*time.Hour, time.Minute, StatusSucceeded, 16*time.Hour)
	deployed(t, s, "web", now, 4*time.Hour, time.Minute, StatusSucceeded, 0)
	// A failure with a commit time is not a lead time: it never reached production.
	deployed(t, s, "web", now, 3*time.Hour, time.Minute, StatusFailed, 20*time.Hour)

	d, err := s.Delivery(ctx, "", now.Add(-24*time.Hour), now)
	if err != nil {
		t.Fatal(err)
	}
	if d.LeadTime.Deployments != 3 {
		t.Fatalf("three deployments carry their commit: %+v", d.LeadTime)
	}
	if got := *d.LeadTime.Covered; got != 0.75 {
		t.Errorf("three of the four successes: %v", got)
	}
	// 2 h, 4 h and 10 h, each plus the minute the deployment took: the median is 4 h 1 min.
	if got := *d.LeadTime.MedianSeconds; got != 4*3600+60 {
		t.Errorf("median %v s", got)
	}
	if got := *d.LeadTime.P90Seconds; got <= 4*3600+60 || got > 10*3600+60 {
		t.Errorf("p90 %v s must sit between the median and the longest", got)
	}
}

func TestACommitTimeAfterTheDeploymentIsIgnored(t *testing.T) {
	s := open(t)
	now := t0
	// A clock that is wrong on one side would otherwise show a negative lead time.
	deployed(t, s, "web", now, 2*time.Hour, time.Minute, StatusSucceeded, -time.Hour)
	d, err := s.Delivery(ctx, "", now.Add(-24*time.Hour), now)
	if err != nil {
		t.Fatal(err)
	}
	if d.LeadTime.Deployments != 0 || d.LeadTime.MedianSeconds != nil {
		t.Errorf("%+v", d.LeadTime)
	}
}

func TestACommitTimeSurvivesTheDeploymentRecord(t *testing.T) {
	s := open(t)
	id := deployed(t, s, "web", t0, time.Hour, time.Minute, StatusSucceeded, 3*time.Hour)
	got, err := s.Deployment(ctx, id)
	if err != nil {
		t.Fatal(err)
	}
	if got.CommittedAt == nil || !got.CommittedAt.Equal(t0.Add(-3*time.Hour)) {
		t.Errorf("the deployment keeps the time of its commit: %+v", got.CommittedAt)
	}
	plain := deployed(t, s, "web", t0, time.Hour, time.Minute, StatusSucceeded, 0)
	if got, _ := s.Deployment(ctx, plain); got.CommittedAt != nil {
		t.Errorf("a deployment nobody dated has none: %+v", got.CommittedAt)
	}
}

func TestQuantileInterpolates(t *testing.T) {
	for _, tc := range []struct {
		values []float64
		q      float64
		want   float64
	}{
		{[]float64{5}, 0.5, 5},
		{[]float64{1, 3}, 0.5, 2},
		{[]float64{1, 2, 3}, 0.5, 2},
		{[]float64{1, 2, 3, 4}, 0.9, 3.7},
		{[]float64{1, 2, 3}, 1, 3},
	} {
		if got := quantile(tc.values, tc.q); got != tc.want {
			t.Errorf("quantile(%v, %v) = %v, want %v", tc.values, tc.q, got, tc.want)
		}
	}
}
