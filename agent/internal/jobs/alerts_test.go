package jobs

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/0x2u/keelson/agent/internal/config"
	"github.com/0x2u/keelson/agent/internal/store"
)

func failing(name string) config.Job {
	return config.Job{Name: name, Action: config.Action{Host: []string{"sh", "-c", "exit 1"}}}
}

// A job.failed that Telegram never got must not mean silence until the job succeeds: it is tried again at a later failed
// run, but not at every minute of an outage.
func TestAFailureAlertThatDidNotGetThroughIsSentAgain(t *testing.T) {
	r := newRig(t, failing("backup"))
	r.ev.undelivered = true
	r.run("backup")
	r.run("backup") // seconds later: not again
	if got := r.ev.types(); got != "job.failed:backup" {
		t.Fatalf("one attempt, then wait: %s", got)
	}
	r.now = r.now.Add(20 * time.Minute)
	r.run("backup")
	if got := r.ev.types(); got != "job.failed:backup,job.failed:backup" {
		t.Fatalf("an alert that did not arrive is tried again at a later failure: %s", got)
	}
	r.ev.undelivered = false
	r.now = r.now.Add(20 * time.Minute)
	r.run("backup") // this one arrives
	r.now = r.now.Add(20 * time.Minute)
	r.run("backup") // delivered: now only the realert interval counts
	if n := strings.Count(r.ev.types(), "job.failed"); n != 3 {
		t.Fatalf("once it arrived, no more until realert_after: %s", r.ev.types())
	}
}

func TestAContinuingStreakIsRepeatedEveryRealertAfterAndNotBeforeAndNeverWithZero(t *testing.T) {
	day := 24 * time.Hour
	for name, tc := range map[string]struct {
		realert *config.Duration
		want    int
	}{
		"default 24h": {nil, 2},
		"never":       {config.D(0), 1},
		"1h":          {config.D(time.Hour), 3},
	} {
		t.Run(name, func(t *testing.T) {
			j := failing("j")
			j.RealertAfter = tc.realert
			r := newRig(t, j)
			r.run("j")
			r.now = r.now.Add(90 * time.Minute)
			r.run("j")
			r.now = r.now.Add(day)
			r.run("j")
			if n := strings.Count(r.ev.types(), "job.failed"); n != tc.want {
				t.Errorf("%d alerts, want %d: %s", n, tc.want, r.ev.types())
			}
		})
	}
}

func intp(n int) *int { return &n }

func TestTheAlertSaysHowManyRunsFailedAndRecoveryEndsTheStreak(t *testing.T) {
	j := config.Job{Name: "j", Schedule: config.Schedule{AlertAfter: intp(2)}, Action: config.Action{Host: []string{"sh", "-c", `test -f "$OKFILE"`}}}
	t.Setenv("OKFILE", t.TempDir()+"/ok")
	r := newRig(t, j)
	r.run("j")
	r.run("j")
	r.ev.mu.Lock()
	msg := r.ev.all[0].Message
	r.ev.mu.Unlock()
	if !strings.Contains(msg, "2 failed runs in a row") {
		t.Errorf("message: %q", msg)
	}
	if _, still := r.s.alertOf("j"); !still {
		t.Fatal("the alert of the streak is remembered")
	}
	r.st.CreateJobRun(context.Background(), store.JobRun{ID: "ok", Job: "j", Trigger: "manual", Status: store.JobRunning, StartedAt: r.now.Add(time.Second)})
	r.st.FinishJobRun(context.Background(), "ok", store.JobSucceeded, "", "", r.now.Add(2*time.Second))
	r.s.report(j, store.JobSucceeded, "", "")
	if _, still := r.s.alertOf("j"); still {
		t.Error("a success ends the streak")
	}
}

// An error page is for the run's output, not for a chat.
func TestAnHTTPFailureAlertCarriesNoResponseBody(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(500)
		w.Write([]byte("<html>Internal error: DATABASE_URL=postgres://u:pw@db/x</html>"))
	}))
	defer srv.Close()
	r := newRig(t, httpJob("cron", srv.URL))
	run := r.run("cron")
	if !strings.Contains(run.Output, "DATABASE_URL") {
		t.Fatalf("the run keeps the body: %q", run.Output)
	}
	r.ev.mu.Lock()
	defer r.ev.mu.Unlock()
	if m := r.ev.all[0].Message; strings.Contains(m, "DATABASE_URL") || !strings.Contains(m, "HTTP 500") {
		t.Errorf("the alert says the status, not the body: %q", m)
	}
}

func scheduledRun(r *rig, job string, at time.Time) {
	ctx := context.Background()
	id := store.NewID()
	r.st.CreateJobRun(ctx, store.JobRun{ID: id, Job: job, Trigger: "schedule", Status: store.JobRunning, StartedAt: at})
	r.st.FinishJobRun(ctx, id, store.JobSucceeded, "", "", at.Add(time.Second))
}

// The agent (or the server) was down over a scheduled time: nothing ran, and nothing said so.
func TestScheduledRunsMissedWhileTheAgentWasDownAreRecordedAndAlertedOnce(t *testing.T) {
	j := config.Job{Name: "backup", Schedule: config.Schedule{Cron: "30 3 * * *"}, Action: config.Action{Host: []string{"true"}}}
	r := newRig(t, j)
	scheduledRun(r, "backup", time.Date(2026, 10, 15, 3, 30, 0, 0, time.UTC)) // the last night it ran
	r.now = time.Date(2026, 10, 18, 12, 0, 0, 0, time.UTC)                    // 16, 17 and 18 at 03:30 did not

	r.s.noteMissed(r.now)
	if got := r.ev.types(); got != "job.missed:backup" {
		t.Fatalf("one event for the whole outage: %s", got)
	}
	r.ev.mu.Lock()
	msg := r.ev.all[0].Title + " " + r.ev.all[0].Message
	r.ev.mu.Unlock()
	if !strings.Contains(msg, "missed 3 run(s)") || !strings.Contains(msg, "2026-10-16 03:30") {
		t.Errorf("the event says how many and since when: %q", msg)
	}
	runs, _ := r.st.JobRuns(context.Background(), "backup", 10)
	if runs[0].Status != store.JobMissed || !strings.Contains(runs[0].Detail, "3 scheduled run(s)") {
		t.Errorf("the run list shows it: %+v", runs[0])
	}
	r.s.noteMissed(r.now) // the next start: those are accounted for
	if got := r.ev.types(); got != "job.missed:backup" {
		t.Errorf("a miss is reported once: %s", got)
	}
}

func TestMissedRunsAreNotInventedForNewPausedOrManuallyRunJobs(t *testing.T) {
	r := newRig(t,
		config.Job{Name: "new", Schedule: config.Schedule{Cron: "30 3 * * *"}, Action: config.Action{Host: []string{"true"}}},
		config.Job{Name: "paused", Schedule: config.Schedule{Cron: "30 3 * * *", Paused: true}, Action: config.Action{Host: []string{"true"}}},
		config.Job{Name: "manual", Schedule: config.Schedule{Cron: "30 3 * * *"}, Action: config.Action{Host: []string{"true"}}},
		config.Job{Name: "old", Schedule: config.Schedule{Cron: "30 3 * * *"}, Action: config.Action{Host: []string{"true"}}},
	)
	scheduledRun(r, "paused", time.Date(2026, 10, 1, 3, 30, 0, 0, time.UTC))
	r.st.CreateJobRun(context.Background(), store.JobRun{ID: "m", Job: "manual", Trigger: "manual", Status: store.JobSucceeded, StartedAt: time.Date(2026, 10, 1, 3, 30, 0, 0, time.UTC)})
	scheduledRun(r, "old", time.Date(2026, 9, 1, 3, 30, 0, 0, time.UTC))
	r.now = time.Date(2026, 10, 18, 12, 0, 0, 0, time.UTC)
	r.s.noteMissed(r.now)
	if got := r.ev.types(); got != "job.missed:old" {
		t.Errorf("only a job that ran on schedule before can have missed something, and only within a week: %s", got)
	}
	r.ev.mu.Lock()
	title := r.ev.all[0].Title
	r.ev.mu.Unlock()
	if !strings.Contains(title, "missed 7 run(s)") { // the nights of the 12th to the 18th: the ones older than a week are not counted
		t.Errorf("only the last week counts: %q", title)
	}
}

func TestCatchUpRunsAMissedJobOnceLate(t *testing.T) {
	j := config.Job{Name: "backup", Schedule: config.Schedule{Cron: "30 3 * * *", CatchUp: true}, Action: config.Action{Host: []string{"true"}}}
	r := newRig(t, j)
	scheduledRun(r, "backup", time.Date(2026, 10, 15, 3, 30, 0, 0, time.UTC))
	r.now = time.Date(2026, 10, 18, 12, 0, 0, 0, time.UTC)
	r.s.noteMissed(r.now)
	r.s.Shutdown(5 * time.Second)
	runs, _ := r.st.JobRuns(context.Background(), "backup", 10)
	var late int
	for _, run := range runs {
		if run.Trigger == "catch-up" && run.Status == store.JobSucceeded {
			late++
		}
	}
	if late != 1 {
		t.Errorf("one late run, not one per missed night: %+v", runs)
	}
}

func TestAMissedRunDoesNotBreakAFailureStreak(t *testing.T) {
	runs := []store.JobRun{{Status: store.JobFailed}, {Status: store.JobMissed}, {Status: store.JobSkipped}, {Status: store.JobFailed}, {Status: store.JobSucceeded}}
	if got := failureStreak(runs); got != 2 {
		t.Errorf("a miss is not a success: %d", got)
	}
}
