package jobs

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"filippo.io/age"

	"github.com/0x2u/keelson/agent/internal/config"
	"github.com/0x2u/keelson/agent/internal/notify"
	"github.com/0x2u/keelson/agent/internal/store"
)

var quiet = slog.New(slog.NewTextHandler(io.Discard, nil))

type fakeApps struct {
	mu      sync.Mutex
	ran     []string // "app: cmd"
	runErr  error
	runOut  []string
	env     map[string]string
	runHold chan struct{} // when set, RunOneOff blocks until closed
}

func (f *fakeApps) RunOneOff(ctx context.Context, app string, cmd []string, out func(string)) error {
	f.mu.Lock()
	f.ran = append(f.ran, app+": "+strings.Join(cmd, " "))
	hold, err, lines := f.runHold, f.runErr, f.runOut
	f.mu.Unlock()
	if hold != nil {
		select {
		case <-hold:
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	for _, l := range lines {
		out(l)
	}
	return err
}

func (f *fakeApps) EnvVar(app, name string) (string, error) {
	if v, ok := f.env[app+"."+name]; ok {
		return v, nil
	}
	return "", errors.New(name + " is not set")
}

type events struct {
	mu  sync.Mutex
	all []notify.Event
	// undelivered makes Done report that no channel got the event.
	undelivered bool
}

func (e *events) Emit(ev notify.Event) {
	e.mu.Lock()
	e.all = append(e.all, ev)
	fail := e.undelivered
	e.mu.Unlock()
	if ev.Done != nil {
		ev.Done(!fail)
	}
}

func (e *events) types() string {
	e.mu.Lock()
	defer e.mu.Unlock()
	var out []string
	for _, ev := range e.all {
		out = append(out, ev.Type+":"+ev.Job)
	}
	return strings.Join(out, ",")
}

type fakeBackups struct {
	mu  sync.Mutex
	ran []string
	out []string
	err error
}

func (f *fakeBackups) Backup(_ context.Context, database string, out func(string)) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.ran = append(f.ran, database)
	for _, l := range f.out {
		out(l)
	}
	return f.err
}

type rig struct {
	t       *testing.T
	s       *Scheduler
	st      *store.Store
	apps    *fakeApps
	backups *fakeBackups
	ev      *events
	cfg     *config.Config
	now     time.Time
}

func newRig(t *testing.T, jobs ...config.Job) *rig {
	t.Helper()
	st, err := store.Open(filepath.Join(t.TempDir(), "a.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	for i := range jobs {
		if jobs[i].Timeout == nil {
			jobs[i].Timeout = config.D(10 * time.Second)
		}
		if jobs[i].AlertAfter == nil {
			jobs[i].AlertAfter = intp(1)
		}
		if jobs[i].Cron == "" {
			jobs[i].Cron = "* * * * *"
		}
		if jobs[i].HTTP != nil && jobs[i].HTTP.Method == "" {
			jobs[i].HTTP.Method = "GET"
		}
	}
	r := &rig{t: t, st: st, apps: &fakeApps{env: map[string]string{}}, backups: &fakeBackups{}, ev: &events{}, cfg: &config.Config{Jobs: jobs}, now: time.Date(2026, 10, 18, 12, 0, 0, 0, time.UTC)}
	r.s = New(r.cfg, st, r.apps, r.backups, r.ev, quiet)
	r.s.now = func() time.Time { return r.now }
	return r
}

// run triggers a job by hand and waits for the run to end.
func (r *rig) run(name string) store.JobRun {
	r.t.Helper()
	id, done, err := r.s.Trigger(name)
	if err != nil {
		r.t.Fatalf("Trigger(%s): %v", name, err)
	}
	<-done
	run, err := r.st.JobRun(context.Background(), id)
	if err != nil {
		r.t.Fatal(err)
	}
	return run
}

func httpJob(name, url string) config.Job {
	return config.Job{Name: name, HTTP: &config.JobHTTP{URL: url}}
}

// --- http ------------------------------------------------------------------

func TestHTTPJobSendsTheRequestWithABearerFromAFileAndRecordsTheBody(t *testing.T) {
	var got *http.Request
	var body string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got = r
		b, _ := io.ReadAll(r.Body)
		body = string(b)
		io.WriteString(w, `{"ok":true,"checks":12}`)
	}))
	defer srv.Close()

	secret := filepath.Join(t.TempDir(), "secret")
	os.WriteFile(secret, []byte("cron-secret\n"), 0o600)
	j := httpJob("monitoring", srv.URL+"/api/cron/monitoring")
	j.HTTP.Method = "POST"
	j.HTTP.Body = `{"force":true}`
	j.HTTP.Headers = map[string]string{"X-Source": "keelson"}
	j.HTTP.Bearer = &config.JobBearer{File: secret}
	r := newRig(t, j)

	run := r.run("monitoring")
	if run.Status != store.JobSucceeded || run.Output != `{"ok":true,"checks":12}` || run.Trigger != "manual" {
		t.Fatalf("unexpected run: %+v", run)
	}
	if got.Method != "POST" || got.URL.Path != "/api/cron/monitoring" || got.Header.Get("Authorization") != "Bearer cron-secret" ||
		got.Header.Get("X-Source") != "keelson" || got.Header.Get("Content-Type") != "application/json" || body != `{"force":true}` {
		t.Errorf("unexpected request: %v %v body=%q", got.Method, got.Header, body)
	}
}

func TestHTTPJobTakesItsBearerFromAnAppsEnvironment(t *testing.T) {
	var auth string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { auth = r.Header.Get("Authorization") }))
	defer srv.Close()
	j := httpJob("track", srv.URL)
	j.HTTP.Bearer = &config.JobBearer{App: "shop", Env: "CRON_SECRET"}
	r := newRig(t, j)
	r.apps.env["shop.CRON_SECRET"] = "from-the-app"

	if run := r.run("track"); run.Status != store.JobSucceeded || auth != "Bearer from-the-app" {
		t.Errorf("status %s, auth %q", run.Status, auth)
	}
	delete(r.apps.env, "shop.CRON_SECRET")
	if run := r.run("track"); run.Status != store.JobFailed || !strings.Contains(run.Detail, "CRON_SECRET") {
		t.Errorf("a missing secret must fail the run with the reason: %+v", run)
	}
}

func TestHTTPJobStatusHandling(t *testing.T) {
	status := 200
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if status == 301 {
			w.Header().Set("Location", "/elsewhere")
		}
		w.WriteHeader(status)
		io.WriteString(w, "body text")
	}))
	defer srv.Close()
	any2xx := httpJob("any", srv.URL)
	only204 := httpJob("only204", srv.URL)
	only204.HTTP.ExpectStatus = []int{204}
	r := newRig(t, any2xx, only204)

	for _, c := range []struct {
		job    string
		status int
		want   string
		detail string
	}{
		{"any", 200, store.JobSucceeded, ""},
		{"any", 204, store.JobSucceeded, ""},
		{"any", 500, store.JobFailed, "HTTP 500"},
		{"any", 404, store.JobFailed, "HTTP 404"},
		{"any", 301, store.JobFailed, "HTTP 301"}, // a redirect is not followed: the URL is wrong
		{"only204", 204, store.JobSucceeded, ""},
		{"only204", 200, store.JobFailed, "HTTP 200"},
	} {
		status = c.status
		if run := r.run(c.job); run.Status != c.want || run.Detail != c.detail {
			t.Errorf("%s answering %d: %s %q, want %s %q", c.job, c.status, run.Status, run.Detail, c.want, c.detail)
		}
	}
	if run := r.run("any"); run.Status != store.JobFailed && run.Output != "body text" {
		t.Errorf("the start of the body is kept: %q", run.Output)
	}
}

func TestHTTPJobErrorsNeverRevealTheURLToken(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	url := srv.URL + "/cron?token=SUPERSECRET"
	srv.Close()
	r := newRig(t, httpJob("leaky", url))
	run := r.run("leaky")
	if run.Status != store.JobFailed || strings.Contains(run.Detail, "SUPERSECRET") {
		t.Errorf("got %+v", run)
	}
	jobs, _ := r.s.Jobs(context.Background())
	if strings.Contains(jobs[0].Target, "SUPERSECRET") || !strings.Contains(jobs[0].Target, "/cron") {
		t.Errorf("the status must show host and path but not the query: %q", jobs[0].Target)
	}
}

// --- host and container ----------------------------------------------------

func TestHostJobRunsWithoutTheAgentsSecretsAndKeepsTheOutputTail(t *testing.T) {
	t.Setenv("KEELSON_TOKEN", "agent-secret")
	j := config.Job{Name: "backup", Action: config.Action{Host: []string{"sh", "-c", `echo "job=$KEELSON_JOB token=[$KEELSON_TOKEN]"; echo oops >&2; exit 4`}}}
	r := newRig(t, j)
	run := r.run("backup")
	if run.Status != store.JobFailed || !strings.Contains(run.Detail, "exit status 4") {
		t.Fatalf("got %+v", run)
	}
	if !strings.Contains(run.Output, "job=backup token=[]") || !strings.Contains(run.Output, "oops") {
		t.Errorf("output: %q", run.Output)
	}
}

func TestHostJobOutputIsCutToItsTail(t *testing.T) {
	j := config.Job{Name: "chatty", Action: config.Action{Host: []string{"sh", "-c", `i=0; while [ $i -lt 2000 ]; do echo "line number $i of the output"; i=$((i+1)); done`}}}
	r := newRig(t, j)
	run := r.run("chatty")
	if run.Status != store.JobSucceeded || len(run.Output) > maxOutputKept+8 {
		t.Fatalf("status %s, %d bytes kept", run.Status, len(run.Output))
	}
	if !strings.Contains(run.Output, "line number 1999") || strings.Contains(run.Output, "line number 0 ") {
		t.Errorf("the tail must be kept, not the head")
	}
}

func TestJobsTimeOut(t *testing.T) {
	j := config.Job{Name: "stuck", Schedule: config.Schedule{Timeout: config.D(150 * time.Millisecond)}, Action: config.Action{Host: []string{"sleep", "30"}}}
	r := newRig(t, j)
	started := time.Now()
	run := r.run("stuck")
	if run.Status != store.JobFailed || run.Detail != "timed out after 150ms" || time.Since(started) > 5*time.Second {
		t.Errorf("got %+v after %s", run, time.Since(started))
	}
}

func TestContainerJobRunsInTheAppsOneOffContainer(t *testing.T) {
	j := config.Job{Name: "reindex", Action: config.Action{Container: &config.ContainerAction{App: "shop", Command: []string{"node", "reindex.js"}}}}
	r := newRig(t, j)
	r.apps.runOut = []string{"reindexed 120 items"}
	run := r.run("reindex")
	if run.Status != store.JobSucceeded || run.Output != "reindexed 120 items" || r.apps.ran[0] != "shop: node reindex.js" {
		t.Errorf("got %+v, ran %v", run, r.apps.ran)
	}
	r.apps.runErr = errors.New("exit code 2")
	if run := r.run("reindex"); run.Status != store.JobFailed || run.Detail != "exit code 2" {
		t.Errorf("got %+v", run)
	}
}

// --- scheduling ------------------------------------------------------------

func TestOnlyDueUnpausedJobsFireAndTheNextRunMovesOn(t *testing.T) {
	due := config.Job{Name: "due", Schedule: config.Schedule{Cron: "*/5 * * * *"}, Action: config.Action{Host: []string{"true"}}}
	later := config.Job{Name: "later", Schedule: config.Schedule{Cron: "0 4 * * *"}, Action: config.Action{Host: []string{"true"}}}
	paused := config.Job{Name: "paused", Schedule: config.Schedule{Cron: "*/5 * * * *", Paused: true}, Action: config.Action{Host: []string{"true"}}}
	r := newRig(t, due, later, paused)
	r.s.state["due"].next = r.now.Add(-time.Second)
	r.s.state["later"].next = r.now.Add(4 * time.Hour)
	r.s.state["paused"].next = r.now.Add(-time.Second)

	r.s.fireDue(r.now)
	r.s.Shutdown(5 * time.Second)

	count := func(job string) int {
		runs, _ := r.st.JobRuns(context.Background(), job, 10)
		return len(runs)
	}
	if count("due") != 1 || count("later") != 0 || count("paused") != 0 {
		t.Errorf("runs: due=%d later=%d paused=%d", count("due"), count("later"), count("paused"))
	}
	if got := r.s.state["due"].next; !got.Equal(time.Date(2026, 10, 18, 12, 5, 0, 0, time.UTC)) {
		t.Errorf("next run of a */5 job at 12:00:00 must be 12:05, got %s", got)
	}
	runs, _ := r.st.JobRuns(context.Background(), "due", 1)
	if runs[0].Trigger != "schedule" {
		t.Errorf("trigger %q", runs[0].Trigger)
	}

	r.s.fireDue(r.now) // nothing is due any more
	r.s.Shutdown(5 * time.Second)
	if count("due") != 1 {
		t.Error("a job must not fire twice for the same time")
	}
}

func TestAJobStillRunningIsSkippedNotStackedAndNotAlerted(t *testing.T) {
	j := config.Job{Name: "slow", Schedule: config.Schedule{Cron: "* * * * *"}, Action: config.Action{Container: &config.ContainerAction{App: "shop", Command: []string{"x"}}}}
	r := newRig(t, j)
	r.apps.runHold = make(chan struct{})

	first, done, err := r.s.Trigger("slow")
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := r.s.Trigger("slow"); !errors.Is(err, ErrBusy) {
		t.Errorf("want ErrBusy, got %v", err)
	}
	r.s.state["slow"].next = r.now.Add(-time.Second)
	r.s.fireDue(r.now)

	close(r.apps.runHold)
	<-done
	runs, _ := r.st.JobRuns(context.Background(), "slow", 10)
	var skipped, ok int
	for _, run := range runs {
		switch run.Status {
		case store.JobSkipped:
			skipped++
		case store.JobSucceeded:
			ok++
		}
	}
	if skipped != 1 || ok != 1 || len(runs) != 2 {
		t.Errorf("want one skipped and one succeeded run, got %+v", runs)
	}
	if r.ev.types() != "" {
		t.Errorf("a skip is not an incident: %s", r.ev.types())
	}
	_ = first
}

func TestManualTriggerWorksOnPausedJobsAndRejectsUnknownOnes(t *testing.T) {
	r := newRig(t, config.Job{Name: "p", Schedule: config.Schedule{Paused: true}, Action: config.Action{Host: []string{"true"}}})
	if run := r.run("p"); run.Status != store.JobSucceeded || run.Trigger != "manual" {
		t.Errorf("got %+v", run)
	}
	if _, _, err := r.s.Trigger("nope"); !errors.Is(err, ErrUnknownJob) {
		t.Errorf("want ErrUnknownJob, got %v", err)
	}
	if _, err := r.s.Runs(context.Background(), "nope", 5); !errors.Is(err, ErrUnknownJob) {
		t.Errorf("want ErrUnknownJob, got %v", err)
	}
}

func TestBackupJobRunsTheDatabaseBackupAndAlertsThroughJobFailed(t *testing.T) {
	id, err := age.GenerateX25519Identity()
	if err != nil {
		t.Fatal(err)
	}
	cfg, issues := config.Parse([]byte(`
databases:
  - name: shop
    host: 127.0.0.1
    database: shop
    user: shop
    backup:
      schedule: "0 3 * * *"
      recipients: ["` + id.Recipient().String() + `"]
      destination: {local: {dir: /var/backups/keelson}}
`))
	if cfg == nil {
		t.Fatalf("config: %v", issues)
	}
	r := newRig(t, cfg.Jobs...)

	j, ok := r.cfg.Job("backup-shop")
	if !ok || j.Kind() != "backup" {
		t.Fatalf("the synthesized job is missing: %+v", r.cfg.Jobs)
	}
	r.backups.out = []string{"backup shop/x: 12 objects"}
	run := r.run("backup-shop")
	if run.Status != store.JobSucceeded || run.Output != "backup shop/x: 12 objects" || strings.Join(r.backups.ran, ",") != "shop" {
		t.Errorf("got %+v, backed up %v", run, r.backups.ran)
	}
	jobs, _ := r.s.Jobs(context.Background())
	if jobs[0].Kind != "backup" || jobs[0].Target != "backup of database shop" {
		t.Errorf("job status: %+v", jobs[0])
	}

	r.backups.err = errors.New("dump: pg_dump exited with code 1: FATAL: password authentication failed")
	run = r.run("backup-shop")
	if run.Status != store.JobFailed || !strings.Contains(run.Detail, "password authentication failed") {
		t.Errorf("got %+v", run)
	}
	if r.ev.types() != "job.failed:backup-shop" {
		t.Errorf("a failed backup must raise job.failed, got %q", r.ev.types())
	}
}

// --- alerts ----------------------------------------------------------------

func TestFailureAlertsFireOncePerStreakAndRecoveryIsAnnounced(t *testing.T) {
	j := config.Job{Name: "flaky", Schedule: config.Schedule{AlertAfter: intp(2)}, Action: config.Action{Host: []string{"sh", "-c", `test -f "$OKFILE"`}}}
	okfile := filepath.Join(t.TempDir(), "ok")
	t.Setenv("OKFILE", okfile)
	r := newRig(t, j)

	r.run("flaky") // failure 1: under the threshold
	if r.ev.types() != "" {
		t.Fatalf("one failure must not alert with alert_after 2: %s", r.ev.types())
	}
	r.run("flaky") // failure 2: reaches it
	r.run("flaky") // failure 3: the streak goes on, no repeat
	if r.ev.types() != "job.failed:flaky" {
		t.Fatalf("want one alert for the streak, got %s", r.ev.types())
	}
	os.WriteFile(okfile, nil, 0o600)
	r.run("flaky")
	if r.ev.types() != "job.failed:flaky,job.recovered:flaky" {
		t.Fatalf("recovery must be announced, got %s", r.ev.types())
	}
	r.run("flaky")
	if len(strings.Split(r.ev.types(), ",")) != 2 {
		t.Error("staying healthy must not announce again")
	}
}

func TestRecoveryIsSilentWhenNoAlertWasSent(t *testing.T) {
	j := config.Job{Name: "blip", Schedule: config.Schedule{AlertAfter: intp(3)}, Action: config.Action{Host: []string{"sh", "-c", `test -f "$OKFILE"`}}}
	okfile := filepath.Join(t.TempDir(), "ok")
	t.Setenv("OKFILE", okfile)
	r := newRig(t, j)
	r.run("blip")
	r.run("blip")
	os.WriteFile(okfile, nil, 0o600)
	r.run("blip")
	if r.ev.types() != "" {
		t.Errorf("a failure that never alerted must not announce a recovery: %s", r.ev.types())
	}
}

func TestTheFailureAlertCarriesTheReasonAndTheLastOutputLine(t *testing.T) {
	r := newRig(t, config.Job{Name: "backup", Action: config.Action{Host: []string{"sh", "-c", "echo starting; echo 'pg_dump: connection refused'; exit 1"}}})
	r.run("backup")
	r.ev.mu.Lock()
	defer r.ev.mu.Unlock()
	e := r.ev.all[0]
	if e.Type != config.EventJobFailed || e.Job != "backup" || !strings.Contains(e.Message, "exit status 1") || !strings.Contains(e.Message, "pg_dump: connection refused") {
		t.Errorf("got %+v", e)
	}
}

// --- history ---------------------------------------------------------------

func TestRecoverMarksInterruptedRunsAsFailed(t *testing.T) {
	r := newRig(t, config.Job{Name: "j", Action: config.Action{Host: []string{"true"}}})
	r.st.CreateJobRun(context.Background(), store.JobRun{ID: "dead", Job: "j", Trigger: "schedule", Status: store.JobRunning, StartedAt: r.now})
	if err := r.s.Recover(context.Background()); err != nil {
		t.Fatal(err)
	}
	run, _ := r.st.JobRun(context.Background(), "dead")
	if run.Status != store.JobFailed || !strings.Contains(run.Detail, "interrupted") || run.FinishedAt == nil {
		t.Errorf("got %+v", run)
	}
}

func TestJobsReportsNextAndLastRun(t *testing.T) {
	r := newRig(t, config.Job{Name: "j", Schedule: config.Schedule{Cron: "@every 10m"}, Action: config.Action{Host: []string{"echo", "secret-arg"}}})
	r.s.state["j"].next = r.now.Add(7 * time.Minute)
	r.run("j")
	jobs, err := r.s.Jobs(context.Background())
	if err != nil || len(jobs) != 1 {
		t.Fatal(err)
	}
	j := jobs[0]
	if j.Kind != "host" || j.Target != "echo" || j.Timezone != "UTC" || j.LastRun == nil || j.LastRun.Status != store.JobSucceeded ||
		j.NextRun == nil || !j.NextRun.Equal(r.now.Add(7*time.Minute)) {
		t.Errorf("unexpected status: %+v", j)
	}
	if strings.Contains(j.Target, "secret-arg") {
		t.Error("command arguments may hold secrets and must not be listed")
	}
}

func TestOldRunsArePruned(t *testing.T) {
	r := newRig(t, config.Job{Name: "j", Action: config.Action{Host: []string{"true"}}})
	for i := range keepRuns + 5 {
		id := string(rune('a'+i%26)) + string(rune('a'+i/26)) + "x"
		r.st.CreateJobRun(context.Background(), store.JobRun{ID: id, Job: "j", Trigger: "schedule", Status: store.JobRunning, StartedAt: r.now.Add(-time.Duration(i+1) * time.Minute)})
		r.st.FinishJobRun(context.Background(), id, store.JobSucceeded, "", "", r.now)
	}
	r.run("j")
	runs, _ := r.st.JobRuns(context.Background(), "j", 1000)
	if len(runs) != keepRuns {
		t.Errorf("want %d runs kept, got %d", keepRuns, len(runs))
	}
}

func TestShutdownWaitsForRunningJobs(t *testing.T) {
	j := config.Job{Name: "slow", Action: config.Action{Container: &config.ContainerAction{App: "shop", Command: []string{"x"}}}}
	r := newRig(t, j)
	r.apps.runHold = make(chan struct{})
	_, done, _ := r.s.Trigger("slow")
	if r.s.Shutdown(50 * time.Millisecond) {
		t.Error("Shutdown must report a run still in flight")
	}
	close(r.apps.runHold)
	<-done
	if !r.s.Shutdown(time.Second) {
		t.Error("Shutdown must return true once idle")
	}
}

func TestStatusCarriesTheProjectLabel(t *testing.T) {
	r := newRig(t,
		config.Job{Name: "labelled", Project: "shop", Action: config.Action{Host: []string{"/bin/true"}}},
		config.Job{Name: "plain", Action: config.Action{Host: []string{"/bin/true"}}},
	)
	list, err := r.s.Jobs(context.Background())
	if err != nil || len(list) != 2 || list[0].Project != "shop" || list[1].Project != "" {
		t.Fatalf("%+v %v", list, err)
	}
	raw, _ := json.Marshal(list)
	if !strings.Contains(string(raw), `"project":"shop"`) || strings.Count(string(raw), `"project"`) != 1 {
		t.Errorf("an unlabelled job has no project key, so the dashboard derives it: %s", raw)
	}
}

func TestBackupJobStatusFollowsItsDatabasesProject(t *testing.T) {
	cfg, issues := config.Parse([]byte(`
proxy: {}
databases:
  - name: shop
    project: shop
    host: db
    database: shop
    user: shop
    backup:
      schedule: "@daily"
      recipients: [age1ql3z7hjy54pw3hyww5ayyfg7zqgvc7w3j2elw8zmrj2kg5sfn9aqmcac8p]
      destination: {local: {dir: /var/backups}}
`))
	if cfg == nil {
		t.Fatal(issues)
	}
	r := newRig(t)
	r.s.reload(cfg)
	list, _ := r.s.Jobs(context.Background())
	if len(list) != 1 || list[0].Name != "backup-shop" || list[0].Kind != "backup" || list[0].Project != "shop" {
		t.Errorf("%+v", list)
	}
}
