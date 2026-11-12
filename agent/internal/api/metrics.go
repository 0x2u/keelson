package api

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/0x2u/keelson/agent/internal/store"
)

// GET /metrics: what this agent knows, in the Prometheus text exposition format, so the team that already runs Prometheus
// and Grafana can alert on a failed deployment, a dead app, a job that stopped running, a backup that is too old or a restore
// that was never tried, without a second tool. It is the same data as the JSON routes, read at the moment of the scrape: the
// agent keeps no registry and adds no dependency. It is authenticated like every other read (the bearer token, and the client
// certificate when mutual TLS is on): Prometheus sends the token with `authorization.credentials_file`.
//
// A part that cannot be read (the engine does not answer, the database is locked) leaves its series out and says so in
// keelson_collector_success, instead of failing the scrape: the rest is still worth having, and a missing series is what an
// alert on `absent()` is for.

const metricsContentType = "text/plain; version=0.0.4; charset=utf-8"

type sample struct {
	labels string // already formatted: {a="b",c="d"}, or empty
	value  float64
}

type family struct {
	name, help, typ string
	samples         []sample
}

// exposition collects the series of one scrape, grouped by name so each family is written once, with its help and type.
type exposition struct {
	order []*family
	byKey map[string]*family
}

func newExposition() *exposition { return &exposition{byKey: map[string]*family{}} }

// add records one series. labels are name, value pairs.
func (e *exposition) add(name, typ, help string, value float64, labels ...string) {
	f := e.byKey[name]
	if f == nil {
		f = &family{name: name, help: help, typ: typ}
		e.byKey[name] = f
		e.order = append(e.order, f)
	}
	f.samples = append(f.samples, sample{formatLabels(labels), value})
}

func (e *exposition) gauge(name, help string, value float64, labels ...string) {
	e.add(name, "gauge", help, value, labels...)
}

func (e *exposition) flag(name, help string, on bool, labels ...string) {
	v := 0.0
	if on {
		v = 1
	}
	e.add(name, "gauge", help, v, labels...)
}

func (e *exposition) write(w io.Writer) {
	for _, f := range e.order {
		fmt.Fprintf(w, "# HELP %s %s\n# TYPE %s %s\n", f.name, strings.NewReplacer(`\`, `\\`, "\n", `\n`).Replace(f.help), f.name, f.typ)
		sort.SliceStable(f.samples, func(i, j int) bool { return f.samples[i].labels < f.samples[j].labels })
		for _, s := range f.samples {
			// Plain decimals: a Unix time reads as 1794315600, not 1.7943156e+09.
			fmt.Fprintf(w, "%s%s %s\n", f.name, s.labels, strconv.FormatFloat(s.value, 'f', -1, 64))
		}
	}
}

var labelEscaper = strings.NewReplacer(`\`, `\\`, `"`, `\"`, "\n", `\n`)

// formatLabels writes name, value pairs as {name="value",...}, in the order given. A pair with an empty value is left out:
// Prometheus treats an empty label as an absent one.
func formatLabels(pairs []string) string {
	var b strings.Builder
	for i := 0; i+1 < len(pairs); i += 2 {
		if pairs[i+1] == "" {
			continue
		}
		if b.Len() == 0 {
			b.WriteByte('{')
		} else {
			b.WriteByte(',')
		}
		b.WriteString(pairs[i])
		b.WriteString(`="`)
		b.WriteString(labelEscaper.Replace(pairs[i+1]))
		b.WriteByte('"')
	}
	if b.Len() == 0 {
		return ""
	}
	b.WriteByte('}')
	return b.String()
}

func seconds(t time.Time) float64 { return float64(t.UnixMilli()) / 1000 }

func (s *server) metrics(w http.ResponseWriter, r *http.Request) {
	start := s.now()
	ctx, cancel := context.WithTimeout(r.Context(), requestTimeout)
	defer cancel()
	e := newExposition()

	collect := func(name string, fn func() error) {
		err := fn()
		if err != nil {
			s.log.Warn("metrics collector failed", "collector", name, "err", err)
		}
		e.flag("keelson_collector_success", "1 when the part of the answer named by collector could be read, 0 when its series are missing from this scrape.", err == nil, "collector", name)
	}

	e.gauge("keelson_agent_info", "The agent: its version, and whether it is read-only (no apps file).", 1, "version", s.version, "read_only", strconv.FormatBool(s.deploy == nil))
	collect("engine", func() error { return s.engineMetrics(ctx, e) })
	if s.deploy != nil {
		collect("apps", func() error { return s.appMetrics(ctx, e) })
		if s.deploy.Jobs != nil {
			collect("jobs", func() error { return s.jobMetrics(ctx, e) })
		}
		if s.deploy.Databases != nil {
			collect("backups", func() error { return s.backupMetrics(ctx, e) })
		}
		if s.deploy.Proofs != nil {
			collect("proofs", func() error { return s.proofMetrics(ctx, e) })
		}
	}
	e.gauge("keelson_scrape_duration_seconds", "How long this answer took to collect.", s.now().Sub(start).Seconds())

	w.Header().Set("Content-Type", metricsContentType)
	w.Header().Set("Cache-Control", "no-store")
	e.write(w)
}

// engineMetrics is the engine and the machine: the engine's answer, and what the host reports about itself. The host's
// numbers are written even when the engine does not answer.
func (s *server) engineMetrics(ctx context.Context, e *exposition) error {
	info, err := s.d.Info(ctx)
	e.flag("keelson_engine_up", "1 when the Docker engine answers.", err == nil)
	root := ""
	if err == nil {
		root = info.RootDir
		e.gauge("keelson_engine_containers", "Containers on the engine, by state.", float64(info.Running), "state", "running")
		e.gauge("keelson_engine_containers", "Containers on the engine, by state.", float64(info.Containers), "state", "total")
		e.gauge("keelson_engine_images", "Images on the engine.", float64(info.Images))
	}
	h := s.host(root, "/")
	e.gauge("keelson_host_cpus", "Logical CPUs of the machine.", float64(h.CPUs))
	if h.UptimeSeconds != nil {
		e.gauge("keelson_host_uptime_seconds", "Seconds since the machine booted.", float64(*h.UptimeSeconds))
	}
	if l := h.Load; l != nil {
		e.gauge("keelson_host_load", "Load average, by window.", l.One, "window", "1m")
		e.gauge("keelson_host_load", "Load average, by window.", l.Five, "window", "5m")
		e.gauge("keelson_host_load", "Load average, by window.", l.Fifteen, "window", "15m")
	}
	if m := h.Memory; m != nil {
		e.gauge("keelson_host_memory_bytes", "Memory of the machine: the total and what is available without swapping.", float64(m.Total), "kind", "total")
		e.gauge("keelson_host_memory_bytes", "Memory of the machine: the total and what is available without swapping.", float64(m.Available), "kind", "available")
	}
	if d := h.Disk; d != nil {
		e.gauge("keelson_host_disk_bytes", "The disk the engine keeps its data on (else the root): its size and what is free.", float64(d.Total), "path", d.Path, "kind", "total")
		e.gauge("keelson_host_disk_bytes", "The disk the engine keeps its data on (else the root): its size and what is free.", float64(d.Free), "path", d.Path, "kind", "free")
	}
	return err
}

func (s *server) appMetrics(ctx context.Context, e *exposition) error {
	apps, err := s.deploy.Deployments.Apps(ctx)
	if err != nil {
		return err
	}
	for _, a := range apps {
		if a.BuildOnly {
			continue
		}
		l := []string{"app", a.Name, "project", a.Project, "environment", a.Environment}
		c := a.Container
		up := c != nil && c.State.Running && !c.State.Restarting && c.State.Health != "unhealthy"
		e.flag("keelson_app_up", "1 when the app's container runs and is neither restarting nor reported unhealthy.", up, l...)
		if c != nil {
			e.gauge("keelson_app_container_restarts", "Times the engine restarted the app's container since it was created.", float64(c.RestartCount), l...)
			e.flag("keelson_app_oom_killed", "1 when the engine killed the app's container for running out of memory.", c.State.OOMKilled, l...)
			if c.State.StartedAt != nil && c.State.Running {
				e.gauge("keelson_app_started_timestamp_seconds", "When the app's container started (Unix seconds).", seconds(*c.State.StartedAt), l...)
			}
		}
		if d := a.LastDeployment; d != nil && d.Status != store.StatusRunning {
			e.flag("keelson_app_last_deployment_success", "1 when the app's last deployment succeeded, 0 when it failed, was rolled back or could not roll back.", d.Status == store.StatusSucceeded, l...)
			e.gauge("keelson_app_last_deployment_timestamp_seconds", "When the app's last finished deployment started (Unix seconds), by how it ended.", seconds(d.StartedAt), append(l, "status", d.Status)...)
		}
		if d := a.LastDeployment; d != nil {
			e.flag("keelson_app_deploying", "1 while a deployment of the app is running.", d.Status == store.StatusRunning, l...)
		}
	}
	return nil
}

func (s *server) jobMetrics(ctx context.Context, e *exposition) error {
	list, err := s.deploy.Jobs.Jobs(ctx)
	if err != nil {
		return err
	}
	for _, j := range list {
		l := []string{"job", j.Name, "project", j.Project}
		e.flag("keelson_job_paused", "1 when the job is paused and will not run on its schedule.", j.Paused, l...)
		e.flag("keelson_job_running", "1 while a run of the job is in progress.", j.Running, l...)
		if j.NextRun != nil {
			e.gauge("keelson_job_next_run_timestamp_seconds", "When the job runs next (Unix seconds); absent when it is paused.", seconds(*j.NextRun), l...)
		}
		if r := j.LastRun; r != nil {
			e.gauge("keelson_job_last_run_timestamp_seconds", "When the job's latest run started (Unix seconds).", seconds(r.StartedAt), l...)
			// A run still going, or dropped because the previous one was, says nothing about whether the job works.
			switch r.Status {
			case store.JobSucceeded:
				e.flag("keelson_job_last_run_success", "1 when the job's latest finished run succeeded, 0 when it failed or was missed.", true, l...)
			case store.JobFailed, store.JobMissed:
				e.flag("keelson_job_last_run_success", "1 when the job's latest finished run succeeded, 0 when it failed or was missed.", false, l...)
			}
		}
		if at, ok, err := s.lastSuccess(ctx, j.Name); err != nil {
			return err
		} else if ok {
			e.gauge("keelson_job_last_success_timestamp_seconds", "When the job last succeeded (Unix seconds), within its recent runs; absent when none did.", seconds(at), l...)
		}
	}
	return nil
}

// recentRuns is how far back a job's history is searched for its last success.
const recentRuns = 50

// lastSuccess is when the latest successful run of a job started, among its recent runs.
func (s *server) lastSuccess(ctx context.Context, job string) (time.Time, bool, error) {
	if s.deploy.Jobs == nil {
		return time.Time{}, false, nil
	}
	runs, err := s.deploy.Jobs.Runs(ctx, job, recentRuns)
	if err != nil {
		return time.Time{}, false, err
	}
	for _, r := range runs { // newest first
		if r.Status == store.JobSucceeded {
			return r.StartedAt, true, nil
		}
	}
	return time.Time{}, false, nil
}

// backupMetrics is what an operator wants to be woken for: a database that has a backup section and no recent success.
func (s *server) backupMetrics(ctx context.Context, e *exposition) error {
	dbs, err := s.deploy.Databases.Databases(ctx)
	if err != nil {
		return err
	}
	for _, d := range dbs {
		b := d.Backup
		if b == nil {
			continue
		}
		l := []string{"database", d.Name, "project", d.Project}
		e.flag("keelson_backup_scheduled", "1 when the database has a backup schedule that is not paused.", !b.Paused, l...)
		if b.LastRun != nil {
			switch b.LastRun.Status {
			case store.JobSucceeded:
				e.flag("keelson_backup_last_run_success", "1 when the database's latest finished backup run succeeded, 0 when it failed or was missed.", true, l...)
			case store.JobFailed, store.JobMissed:
				e.flag("keelson_backup_last_run_success", "1 when the database's latest finished backup run succeeded, 0 when it failed or was missed.", false, l...)
			}
		}
		if at, ok, err := s.lastSuccess(ctx, b.Job); err != nil {
			return err
		} else if ok {
			e.gauge("keelson_backup_last_success_timestamp_seconds", "When the database's last backup run succeeded (Unix seconds), within its recent runs; absent when none did.", seconds(at), l...)
		}
	}
	return nil
}

// proofMetrics are the proofs the agent has seen: a key that opened a backup, a restore tried into a scratch database, a
// delivered test notification. A backup is only worth what has been proven about it.
func (s *server) proofMetrics(ctx context.Context, e *exposition) error {
	proofs, err := s.deploy.Proofs.Proofs(ctx)
	if err != nil {
		return err
	}
	for _, p := range proofs {
		e.gauge("keelson_proof_timestamp_seconds", "When the agent last saw this proven (Unix seconds): kind is restore (a backup restored into a scratch database), key (a private key opened a backup) or alert (a test notification was delivered); subject is what it was proven for.", seconds(p.At), "kind", p.Kind, "subject", p.Subject)
	}
	return nil
}
