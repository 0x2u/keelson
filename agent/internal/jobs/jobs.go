// Package jobs runs the scheduled jobs of an apps file: HTTP calls to an app,
// commands on the host, commands in a one-off container. It replaces the cron
// workflows that call an app's endpoints from outside and the crontab of the
// server, and it keeps the history of every run.
package jobs

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/0x2u/keelson/agent/internal/config"
	"github.com/0x2u/keelson/agent/internal/hostexec"
	"github.com/0x2u/keelson/agent/internal/notify"
	"github.com/0x2u/keelson/agent/internal/store"
)

const (
	keepRuns         = 200
	maxBody          = 2048
	maxOutputKept    = 4096
	maxTick          = time.Minute // re-read the clock at least this often: it can jump
	failureLookback  = 50
	shutdownGraceMax = 30 * time.Second
)

// ErrUnknownJob is returned for a job that is not configured.
var ErrUnknownJob = errors.New("unknown job")

// ErrBusy is returned when a job is already running.
var ErrBusy = errors.New("the job is already running")

// Apps is what container and bearer-from-app jobs need from the deployer.
type Apps interface {
	RunOneOff(ctx context.Context, app string, command []string, out func(line string)) error
	EnvVar(app, name string) (string, error)
}

// Backups runs the backup of a database: the job of kind "backup".
type Backups interface {
	Backup(ctx context.Context, database string, out func(line string)) error
}

// Scheduler fires jobs at their times.
type Scheduler struct {
	cfg     *config.Config
	store   *store.Store
	apps    Apps
	backups Backups
	emit    notify.Emitter
	log     *slog.Logger
	now     func() time.Time
	http    *http.Client

	mu    sync.Mutex
	state map[string]*jobState
	wake  chan struct{}
	wg    sync.WaitGroup

	// alerts is the job.failed state of each failure streak when no ledger keeps it (tests, an emitter without one).
	alerts map[string]notify.JobAlert
}

// retryUndelivered is how long after a job.failed that did not get through the next failed run may try again.
const retryUndelivered = 15 * time.Minute

// ledger is where the alert state of jobs is kept across restarts: the notification service's, when the emitter has one.
func (s *Scheduler) ledger() *notify.Ledger {
	if l, ok := s.emit.(interface{ Ledger() *notify.Ledger }); ok {
		return l.Ledger()
	}
	return nil
}

func (s *Scheduler) alertOf(job string) (notify.JobAlert, bool) {
	if l := s.ledger(); l != nil {
		return l.JobAlert(job)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	a, ok := s.alerts[job]
	return a, ok
}

func (s *Scheduler) setAlert(job string, a notify.JobAlert) {
	if l := s.ledger(); l != nil {
		l.SetJobAlert(job, a)
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.alerts == nil {
		s.alerts = map[string]notify.JobAlert{}
	}
	s.alerts[job] = a
}

func (s *Scheduler) clearAlert(job string) {
	if l := s.ledger(); l != nil {
		l.ClearJobAlert(job)
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.alerts, job)
}

type jobState struct {
	next    time.Time
	running bool
}

// New returns a Scheduler. emit may be nil.
func New(cfg *config.Config, st *store.Store, apps Apps, backups Backups, emit notify.Emitter, log *slog.Logger) *Scheduler {
	if log == nil {
		log = slog.Default()
	}
	s := &Scheduler{
		cfg: cfg, store: st, apps: apps, backups: backups, emit: emit, log: log, now: time.Now,
		state: map[string]*jobState{},
		wake:  make(chan struct{}, 1),
		http: &http.Client{
			// A redirect from a cron endpoint means the URL is wrong (http to
			// https, a login page): count it as a failure, do not follow it.
			CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
		},
	}
	for _, j := range cfg.Jobs {
		s.state[j.Name] = &jobState{}
	}
	return s
}

// Recover marks runs that were still running when the agent stopped as failed.
// Call it once before Run.
func (s *Scheduler) Recover(ctx context.Context) error {
	runs, err := s.store.RunningJobRuns(ctx)
	if err != nil {
		return err
	}
	for _, r := range runs {
		if err := s.store.FinishJobRun(ctx, r.ID, store.JobFailed, "interrupted: the agent restarted", "", s.now()); err != nil {
			return err
		}
	}
	return nil
}

// Run fires jobs until ctx ends. Runs already started are not interrupted:
// call Shutdown to wait for them.
func (s *Scheduler) Run(ctx context.Context) {
	now := s.now()
	s.noteMissed(now)
	s.mu.Lock()
	for _, j := range s.cfg.Jobs {
		if !j.Paused {
			s.state[j.Name].next = j.ParsedSchedule().Next(now)
		}
	}
	s.mu.Unlock()

	for {
		wait := maxTick
		if next, ok := s.earliest(); ok {
			if d := next.Sub(s.now()); d < wait {
				wait = max(d, 0)
			}
		}
		t := time.NewTimer(wait)
		select {
		case <-ctx.Done():
			t.Stop()
			return
		case <-s.wake:
			// The configuration changed: work out the wait again.
			t.Stop()
			continue
		case <-t.C:
		}
		s.fireDue(s.now())
	}
}

func (s *Scheduler) earliest() (time.Time, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	var best time.Time
	for _, j := range s.cfg.Jobs {
		st := s.state[j.Name]
		if st == nil {
			continue
		}
		if j.Paused || st.next.IsZero() {
			continue
		}
		if best.IsZero() || st.next.Before(best) {
			best = st.next
		}
	}
	return best, !best.IsZero()
}

// fireDue starts every job whose time has come and schedules its next run.
func (s *Scheduler) fireDue(now time.Time) {
	for _, j := range s.jobList() {
		s.mu.Lock()
		st := s.state[j.Name]
		due := st != nil && !j.Paused && !st.next.IsZero() && !st.next.After(now)
		if due {
			st.next = j.ParsedSchedule().Next(now)
		}
		s.mu.Unlock()
		if !due {
			continue
		}
		if _, _, err := s.start(j, "schedule"); errors.Is(err, ErrBusy) {
			s.skip(j)
		} else if err != nil {
			s.log.Error("could not start a scheduled job", "job", j.Name, "err", err)
		}
	}
}

// skip records that a firing was dropped because the previous run is still going.
func (s *Scheduler) skip(j config.Job) {
	ctx := context.Background()
	id := store.NewID()
	at := s.now()
	if err := s.store.CreateJobRun(ctx, store.JobRun{ID: id, Job: j.Name, Trigger: "schedule", Status: store.JobRunning, StartedAt: at}); err != nil {
		s.log.Error("record skipped job run", "job", j.Name, "err", err)
		return
	}
	_ = s.store.FinishJobRun(ctx, id, store.JobSkipped, "the previous run is still going", "", at)
	s.log.Warn("scheduled job skipped: the previous run is still going", "job", j.Name)
}

// Trigger runs a job now, whatever its schedule (and even if paused). It
// returns the run ID at once; done closes when the run has ended.
func (s *Scheduler) Trigger(name string) (string, <-chan struct{}, error) {
	j, ok := s.job(name)
	if !ok {
		return "", nil, ErrUnknownJob
	}
	return s.start(j, "manual")
}

func (s *Scheduler) start(j config.Job, trigger string) (string, <-chan struct{}, error) {
	s.mu.Lock()
	st := s.state[j.Name]
	if st == nil {
		s.mu.Unlock()
		return "", nil, ErrUnknownJob
	}
	if st.running {
		s.mu.Unlock()
		return "", nil, ErrBusy
	}
	st.running = true
	s.mu.Unlock()

	id := store.NewID()
	startedAt := s.now()
	if err := s.store.CreateJobRun(context.Background(), store.JobRun{ID: id, Job: j.Name, Trigger: trigger, Status: store.JobRunning, StartedAt: startedAt}); err != nil {
		s.release(j.Name)
		return "", nil, err
	}

	done := make(chan struct{})
	s.wg.Add(1)
	go func() {
		defer s.wg.Done()
		defer close(done)
		defer s.release(j.Name)
		s.execute(j, id)
	}()
	return id, done, nil
}

func (s *Scheduler) release(name string) {
	s.mu.Lock()
	if st := s.state[name]; st != nil {
		st.running = false
		// A job removed from the configuration while it ran is forgotten once it has finished.
		if !s.configured(name) {
			delete(s.state, name)
		}
	}
	s.mu.Unlock()
}

// Shutdown waits for running jobs to finish, up to the timeout.
func (s *Scheduler) Shutdown(timeout time.Duration) bool {
	done := make(chan struct{})
	go func() { s.wg.Wait(); close(done) }()
	select {
	case <-done:
		return true
	case <-time.After(min(timeout, shutdownGraceMax)):
		return false
	}
}

// tail keeps the last max bytes of the lines it is given.
type tail struct {
	lines []string
	size  int
}

func (t *tail) write(line string) {
	t.lines = append(t.lines, line)
	t.size += len(line) + 1
	for t.size > maxOutputKept && len(t.lines) > 1 {
		t.size -= len(t.lines[0]) + 1
		t.lines = t.lines[1:]
	}
}

func (t *tail) String() string { return strings.Join(t.lines, "\n") }

// execute runs one job and records and reports the outcome.
func (s *Scheduler) execute(j config.Job, runID string) {
	ctx, cancel := context.WithTimeout(context.Background(), j.RunTimeout())
	defer cancel()

	var out tail
	var err error
	switch j.Kind() {
	case "http":
		err = s.runHTTP(ctx, j, &out)
	case "host":
		err = hostexec.Run(ctx, j.Host, j.Dir, []string{"KEELSON_JOB=" + j.Name}, out.write)
	case "backup":
		err = s.backups.Backup(ctx, j.Database, out.write)
	default:
		err = s.apps.RunOneOff(ctx, j.Container.App, j.Container.Command, out.write)
	}

	status, detail := store.JobSucceeded, ""
	if err != nil {
		status, detail = store.JobFailed, err.Error()
		if errors.Is(ctx.Err(), context.DeadlineExceeded) {
			detail = fmt.Sprintf("timed out after %s", j.RunTimeout())
		}
	}
	bg := context.Background()
	if ferr := s.store.FinishJobRun(bg, runID, status, detail, out.String(), s.now()); ferr != nil {
		s.log.Error("record job run", "job", j.Name, "run", runID, "err", ferr)
	}
	if perr := s.store.PruneJobRuns(bg, j.Name, keepRuns); perr != nil {
		s.log.Warn("prune job runs", "job", j.Name, "err", perr)
	}
	s.log.Info("job run finished", "job", j.Name, "run", runID, "status", status, "detail", detail)
	s.report(j, status, detail, out.String())
}

// report raises job.failed once a failure streak reaches alert_after, and
// job.recovered when a job that had alerted succeeds again.
func (s *Scheduler) report(j config.Job, status, detail, output string) {
	if s.emit == nil {
		return
	}
	runs, err := s.store.JobRuns(context.Background(), j.Name, failureLookback)
	if err != nil {
		s.log.Error("read job history", "job", j.Name, "err", err)
		return
	}
	// runs[0] is the run that just ended.
	if status == store.JobFailed {
		if streak := failureStreak(runs); streak >= j.AlertThreshold() {
			s.alertFailure(j, streak, detail, output)
		}
		return
	}
	// A streak that alerted ends here (the ledger knows it; an agent upgraded in the middle of one is told by the history).
	_, alerted := s.alertOf(j.Name)
	s.clearAlert(j.Name)
	if alerted || (len(runs) > 1 && failureStreak(runs[1:]) >= j.AlertThreshold()) {
		s.emit.Emit(notify.Event{
			Type: config.EventJobRecovered, Severity: notify.SeverityInfo, Job: j.Name,
			Title: fmt.Sprintf("job %s is working again", j.Name),
		})
	}
}

// alertFailure raises job.failed for a failure streak that reached alert_after. It is raised when none was for this
// streak, again when the last one did not get through (Telegram unreachable at that moment: silence would follow until a
// success), and again each realert_after while the streak goes on. What was sent, and whether it arrived, is remembered.
func (s *Scheduler) alertFailure(j config.Job, streak int, detail, output string) {
	now := s.now()
	last, had := s.alertOf(j.Name)
	switch {
	case !had:
	case !last.Delivered && now.Sub(last.At) >= retryUndelivered:
	case last.Delivered && j.Realert() > 0 && now.Sub(last.At) >= j.Realert():
	default:
		return
	}
	msg := detail
	if streak > 1 {
		msg += fmt.Sprintf(" (%d failed runs in a row)", streak)
	}
	// What an HTTP endpoint answered stays in the run's output, not in the message: an error page is not for a chat. A
	// command's last line is, as it usually says what went wrong.
	if j.Kind() != "http" {
		if line := lastLine(output); line != "" {
			msg += "\n" + line
		}
	}
	// Pending until the notifier says: a second failed run in the next seconds must not send it twice.
	s.setAlert(j.Name, notify.JobAlert{At: now, Delivered: false})
	s.emit.Emit(notify.Event{
		Type: config.EventJobFailed, Severity: notify.SeverityWarning, Job: j.Name,
		Title: fmt.Sprintf("job %s failed", j.Name), Message: msg,
		Done: func(delivered bool) { s.setAlert(j.Name, notify.JobAlert{At: now, Delivered: delivered}) },
	})
}

// noteMissed finds the scheduled runs that did not happen because the agent was not running (a restart, a reboot of the
// server) and says so: one run recorded as missed per job, and one job.missed for the whole outage. With catch_up the
// job then runs once, late. Only a job that has run on schedule before can have missed anything; occurrences older than
// a week are not counted.
func (s *Scheduler) noteMissed(now time.Time) {
	ctx := context.Background()
	for _, j := range s.jobList() {
		if j.Paused {
			continue
		}
		runs, err := s.store.JobRuns(ctx, j.Name, keepRuns)
		if err != nil {
			continue
		}
		var last time.Time
		for _, r := range runs { // newest first
			if r.Trigger == "schedule" || r.Trigger == "catch-up" {
				last = r.StartedAt
				break
			}
		}
		if last.IsZero() {
			continue
		}
		var first, latest time.Time
		count := 0
		sched := j.ParsedSchedule()
		for t := sched.Next(last); !t.IsZero() && t.Before(now.Add(-time.Minute)) && count < 10000; t = sched.Next(t) {
			if now.Sub(t) > 7*24*time.Hour {
				continue
			}
			if count == 0 {
				first = t
			}
			latest = t
			count++
		}
		if count == 0 {
			continue
		}
		detail := fmt.Sprintf("%d scheduled run(s) did not happen between %s and %s: the agent was not running", count, first.UTC().Format("2006-01-02 15:04"), latest.UTC().Format("2006-01-02 15:04"))
		id := store.NewID()
		if err := s.store.CreateJobRun(ctx, store.JobRun{ID: id, Job: j.Name, Trigger: "schedule", Status: store.JobRunning, StartedAt: latest}); err == nil {
			_ = s.store.FinishJobRun(ctx, id, store.JobMissed, detail, "", latest)
		}
		s.log.Warn("scheduled runs were missed", "job", j.Name, "count", count, "first", first, "last", latest)
		if s.emit != nil {
			s.emit.Emit(notify.Event{
				Type: config.EventJobMissed, Severity: notify.SeverityWarning, Job: j.Name,
				Title: fmt.Sprintf("job %s missed %d run(s)", j.Name, count), Message: detail + ".",
			})
		}
		if j.CatchUp {
			if _, _, err := s.start(j, "catch-up"); err != nil {
				s.log.Error("could not run a missed job late", "job", j.Name, "err", err)
			}
		}
	}
}

// failureStreak counts the failures at the head of runs (newest first),
// ignoring skipped runs and runs still going.
func failureStreak(runs []store.JobRun) int {
	n := 0
	for _, r := range runs {
		switch r.Status {
		case store.JobSkipped, store.JobRunning, store.JobMissed:
			continue
		case store.JobFailed:
			n++
		default:
			return n
		}
	}
	return n
}

func lastLine(s string) string {
	s = strings.TrimSpace(s)
	if i := strings.LastIndex(s, "\n"); i >= 0 {
		s = s[i+1:]
	}
	if len(s) > 300 {
		s = s[:300] + "…"
	}
	return s
}

func (s *Scheduler) runHTTP(ctx context.Context, j config.Job, out *tail) error {
	h := j.HTTP
	var body io.Reader
	if h.Body != "" {
		body = strings.NewReader(h.Body)
	}
	req, err := http.NewRequestWithContext(ctx, h.Method, h.URL, body)
	if err != nil {
		return err
	}
	req.Header.Set("User-Agent", "keelson-agent")
	if h.Body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	for k, v := range h.Headers {
		req.Header.Set(k, v)
	}
	if b := h.Bearer; b != nil {
		secret, err := s.bearer(b)
		if err != nil {
			return err
		}
		req.Header.Set("Authorization", "Bearer "+secret)
	}

	resp, err := s.http.Do(req)
	if err != nil {
		// Go puts the URL in this error and the URL may carry a token.
		var ue *url.Error
		if errors.As(err, &ue) {
			return fmt.Errorf("request failed: %w", ue.Err)
		}
		return err
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(io.LimitReader(resp.Body, maxBody))
	out.write(strings.TrimSpace(string(b)))

	if !statusOK(resp.StatusCode, h.ExpectStatus) {
		return fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	return nil
}

func statusOK(code int, expected []int) bool {
	if len(expected) == 0 {
		return code/100 == 2
	}
	for _, e := range expected {
		if e == code {
			return true
		}
	}
	return false
}

func (s *Scheduler) bearer(b *config.JobBearer) (string, error) {
	if b.File != "" {
		raw, err := os.ReadFile(b.File)
		if err != nil {
			return "", fmt.Errorf("read bearer secret: %w", err)
		}
		secret := strings.TrimSpace(string(raw))
		if secret == "" {
			return "", errors.New("the bearer secret file is empty")
		}
		return secret, nil
	}
	return s.apps.EnvVar(b.App, b.Env)
}

// Status describes a configured job for the API.
type Status struct {
	Name string `json:"name"`
	// Project is the job's label: written in the job, or the project of the file it is in. Empty when neither says (the
	// dashboard then derives it from the app the job calls).
	Project  string        `json:"project,omitempty"`
	Schedule string        `json:"schedule"`
	Timezone string        `json:"timezone"`
	Kind     string        `json:"kind"`
	Target   string        `json:"target"`
	Paused   bool          `json:"paused"`
	Running  bool          `json:"running"`
	NextRun  *time.Time    `json:"next_run,omitempty"`
	LastRun  *store.JobRun `json:"last_run,omitempty"`
}

// target describes what a job does without secrets: a URL may carry a token
// in its query, and command arguments may carry anything.
func target(j config.Job) string {
	switch j.Kind() {
	case "http":
		u, err := url.Parse(j.HTTP.URL)
		if err != nil {
			return j.HTTP.Method
		}
		return fmt.Sprintf("%s %s://%s%s", j.HTTP.Method, u.Scheme, u.Host, u.Path)
	case "host":
		return j.Host[0]
	case "backup":
		return "backup of database " + j.Database
	}
	return "container of " + j.Container.App
}

// Jobs lists every job with its next and last run.
func (s *Scheduler) Jobs(ctx context.Context) ([]Status, error) {
	list := s.jobList()
	out := make([]Status, 0, len(list))
	for _, j := range list {
		tz := j.Timezone
		if tz == "" {
			tz = "UTC"
		}
		st := Status{Name: j.Name, Project: j.Project, Schedule: j.Cron, Timezone: tz, Kind: j.Kind(), Target: target(j), Paused: j.Paused}
		s.mu.Lock()
		if js := s.state[j.Name]; js != nil {
			st.Running = js.running
			if !j.Paused && !js.next.IsZero() {
				next := js.next.UTC()
				st.NextRun = &next
			}
		}
		s.mu.Unlock()

		runs, err := s.store.JobRuns(ctx, j.Name, 1)
		if err != nil {
			return nil, err
		}
		if len(runs) > 0 {
			st.LastRun = &runs[0]
		}
		out = append(out, st)
	}
	return out, nil
}

// Runs returns a job's recent runs, newest first.
func (s *Scheduler) Runs(ctx context.Context, name string, limit int) ([]store.JobRun, error) {
	if _, ok := s.job(name); !ok {
		return nil, ErrUnknownJob
	}
	return s.store.JobRuns(ctx, name, limit)
}

// jobList is the jobs in force. The slice is never modified, only replaced by a reload.
func (s *Scheduler) jobList() []config.Job {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.cfg.Jobs
}

func (s *Scheduler) job(name string) (config.Job, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.cfg.Job(name)
}

// configured reports whether a job is in the configuration in force. The caller holds s.mu.
func (s *Scheduler) configured(name string) bool {
	_, ok := s.cfg.Job(name)
	return ok
}

// Prepare implements confmgr.Applier. Jobs can always follow a new configuration: runs in progress finish with
// the definition they started with.
func (s *Scheduler) Prepare(_, next *config.Config) (func(), error) {
	return func() { s.reload(next) }, nil
}

// reload swaps the job definitions. A job whose schedule did not change keeps its next time; a new, resumed or
// rescheduled one gets a fresh one; a paused one has none. A job that is running keeps its running flag.
func (s *Scheduler) reload(next *config.Config) {
	now := s.now()
	s.mu.Lock()
	previous := map[string]config.Job{}
	for _, j := range s.cfg.Jobs {
		previous[j.Name] = j
	}
	state := map[string]*jobState{}
	for _, j := range next.Jobs {
		st := s.state[j.Name]
		if st == nil {
			st = &jobState{}
		}
		old, existed := previous[j.Name]
		switch {
		case j.Paused:
			st.next = time.Time{}
		case !existed || old.Paused || old.Cron != j.Cron || old.Timezone != j.Timezone || st.next.IsZero():
			st.next = j.ParsedSchedule().Next(now)
		}
		state[j.Name] = st
	}
	// A removed job that is still running stays known until it finishes, so its run can be recorded.
	for name, st := range s.state {
		if _, ok := state[name]; !ok && st.running {
			state[name] = st
		}
	}
	s.cfg, s.state = next, state
	s.mu.Unlock()
	select {
	case s.wake <- struct{}{}:
	default:
	}
}
