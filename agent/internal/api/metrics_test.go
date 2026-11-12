package api

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http/httptest"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/0x2u/keelson/agent/internal/databases"
	"github.com/0x2u/keelson/agent/internal/deploy"
	"github.com/0x2u/keelson/agent/internal/docker"
	"github.com/0x2u/keelson/agent/internal/jobs"
	"github.com/0x2u/keelson/agent/internal/store"
	"github.com/0x2u/keelson/agent/internal/sysinfo"
)

var (
	t0 = time.Date(2026, 11, 10, 12, 0, 0, 0, time.UTC)

	metricsApps = []deploy.AppStatus{
		{Name: "shop", Project: "shop", Environment: "production",
			Container:      &docker.Detail{RestartCount: 2, State: docker.State{Running: true, StartedAt: &t0, Health: "healthy"}},
			LastDeployment: &store.Deployment{Status: store.StatusSucceeded, StartedAt: t0}},
		{Name: "blog", Container: &docker.Detail{State: docker.State{Running: true, Health: "unhealthy"}},
			LastDeployment: &store.Deployment{Status: store.StatusRolledBack, StartedAt: t0.Add(time.Hour)}},
		{Name: "stopped"},
		{Name: "builder", BuildOnly: true},
	}
)

type metricsDeployments struct {
	fakeDeployments
	err error
}

func (m *metricsDeployments) Apps(context.Context) ([]deploy.AppStatus, error) {
	return metricsApps, m.err
}

type metricsJobs struct{ fakeJobs }

func (metricsJobs) Jobs(context.Context) ([]jobs.Status, error) {
	next := t0.Add(time.Hour)
	return []jobs.Status{
		{Name: "report", Project: "shop", NextRun: &next, LastRun: &store.JobRun{Status: store.JobFailed, StartedAt: t0}},
		{Name: "backup-shop", LastRun: &store.JobRun{Status: store.JobRunning, StartedAt: t0}, Running: true, Paused: false},
	}, nil
}

// Runs is newest first: a failure after two successes, the latest of which is what "last success" must report.
func (metricsJobs) Runs(_ context.Context, name string, _ int) ([]store.JobRun, error) {
	switch name {
	case "report":
		return []store.JobRun{
			{Status: store.JobFailed, StartedAt: t0},
			{Status: store.JobSucceeded, StartedAt: t0.Add(-24 * time.Hour)},
			{Status: store.JobSucceeded, StartedAt: t0.Add(-48 * time.Hour)},
		}, nil
	case "backup-shop":
		return []store.JobRun{{Status: store.JobFailed, StartedAt: t0.Add(-2 * time.Hour)}}, nil
	}
	return nil, nil
}

type metricsDatabases struct{ fakeDatabases }

func (metricsDatabases) Databases(context.Context) ([]databases.View, error) {
	return []databases.View{
		{Name: "shop", Project: "shop", Backup: &databases.BackupView{Job: "backup-shop", LastRun: &databases.LastRun{Status: store.JobFailed}}},
		{Name: "no-backups"},
	}, nil
}

type metricsProofs struct{}

func (metricsProofs) Proofs(context.Context) ([]store.Proof, error) {
	return []store.Proof{{Kind: store.ProofRestore, Subject: "shop", At: t0.Add(-72 * time.Hour)}}, nil
}

func scrape(t *testing.T, f *fakeDocker, deployOpts *DeployOptions) (int, string) {
	t.Helper()
	h, err := New(f, Options{Token: testToken, Version: "9.9.9", Logger: slog.New(slog.NewTextHandler(io.Discard, nil)),
		Host: func(...string) sysinfo.Host {
			up := int64(3600)
			return sysinfo.Host{CPUs: 4, UptimeSeconds: &up, Load: &sysinfo.Load{One: 0.5, Five: 1, Fifteen: 2},
				Memory: &sysinfo.Memory{Total: 8 << 30, Available: 3 << 30}, Disk: &sysinfo.Disk{Path: "/var/lib/docker", Total: 100, Free: 40}}
		},
		Deploy: deployOpts})
	if err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(h)
	defer srv.Close()
	resp := do(t, "GET", srv.URL+"/metrics", testToken)
	b, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, string(b)
}

func fullDeploy(apps *metricsDeployments) *DeployOptions {
	return &DeployOptions{Deployments: apps, Secret: testSecret, Jobs: &metricsJobs{}, Databases: &metricsDatabases{}, Proofs: metricsProofs{}}
}

// has says whether the exposition holds exactly this series line.
func has(body, series string) bool {
	for _, l := range strings.Split(body, "\n") {
		if l == series {
			return true
		}
	}
	return false
}

func TestMetricsReportEachAppJobBackupAndProof(t *testing.T) {
	code, body := scrape(t, &fakeDocker{}, fullDeploy(&metricsDeployments{}))
	if code != 200 {
		t.Fatalf("status %d", code)
	}
	ts := func(tm time.Time) string { return fmt.Sprint(tm.Unix()) }
	for _, want := range []string{
		`keelson_agent_info{version="9.9.9",read_only="false"} 1`,
		`keelson_engine_up 1`,
		`keelson_host_cpus 4`,
		`keelson_host_disk_bytes{path="/var/lib/docker",kind="free"} 40`,
		`keelson_app_up{app="shop",project="shop",environment="production"} 1`,
		`keelson_app_container_restarts{app="shop",project="shop",environment="production"} 2`,
		`keelson_app_last_deployment_success{app="shop",project="shop",environment="production"} 1`,
		`keelson_app_up{app="blog"} 0`, // an unhealthy container is not up
		`keelson_app_last_deployment_success{app="blog"} 0`,
		`keelson_app_last_deployment_timestamp_seconds{app="blog",status="rolled_back"} ` + ts(t0.Add(time.Hour)),
		`keelson_app_up{app="stopped"} 0`,
		`keelson_job_last_run_success{job="report",project="shop"} 0`,
		// The latest run failed; the last success is the newest successful one, not the oldest.
		`keelson_job_last_success_timestamp_seconds{job="report",project="shop"} ` + ts(t0.Add(-24*time.Hour)),
		`keelson_job_running{job="backup-shop"} 1`,
		`keelson_backup_last_run_success{database="shop",project="shop"} 0`,
		`keelson_backup_scheduled{database="shop",project="shop"} 1`,
		`keelson_proof_timestamp_seconds{kind="restore",subject="shop"} ` + ts(t0.Add(-72*time.Hour)),
		`keelson_collector_success{collector="apps"} 1`,
		`keelson_collector_success{collector="backups"} 1`,
	} {
		if !has(body, want) {
			t.Errorf("missing series %q in:\n%s", want, body)
		}
	}
	for _, absent := range []string{
		"builder",    // a build-only app runs nothing
		"no-backups", // a database without a backup section has no backup series
		`keelson_job_last_run_success{job="backup-shop"`,                // a run still going says nothing
		`keelson_backup_last_success_timestamp_seconds{database="shop"`, // it never succeeded: the series is absent, not 0
	} {
		if strings.Contains(body, absent) {
			t.Errorf("%q must not be in the answer:\n%s", absent, body)
		}
	}
}

var (
	helpLine   = regexp.MustCompile(`^# HELP ([a-z_:][a-z0-9_:]*) .+$`)
	typeLine   = regexp.MustCompile(`^# TYPE ([a-z_:][a-z0-9_:]*) (gauge|counter)$`)
	sampleLine = regexp.MustCompile(`^([a-z_:][a-z0-9_:]*)(\{([a-z_][a-z0-9_]*="([^"\\]|\\.)*",?)+\})? (-?[0-9.e+-]+|NaN|\+Inf|-Inf)$`)
)

// The text format is strict: each family is announced once with its help and type, before any of its samples, and a sample
// is name{labels} value. A parser such as Prometheus refuses the whole scrape on a malformed line.
func TestMetricsAreWellFormedPrometheusText(t *testing.T) {
	_, body := scrape(t, &fakeDocker{}, fullDeploy(&metricsDeployments{}))
	if !strings.HasSuffix(body, "\n") {
		t.Error("the text must end with a newline")
	}
	announced := map[string]bool{}
	typed := map[string]bool{}
	var current string
	for _, l := range strings.Split(strings.TrimSuffix(body, "\n"), "\n") {
		switch {
		case helpLine.MatchString(l):
			name := helpLine.FindStringSubmatch(l)[1]
			if announced[name] {
				t.Errorf("family %s announced twice", name)
			}
			announced[name], current = true, name
		case typeLine.MatchString(l):
			name := typeLine.FindStringSubmatch(l)[1]
			if name != current || typed[name] {
				t.Errorf("TYPE of %s out of place: %q", name, l)
			}
			typed[name] = true
		case sampleLine.MatchString(l):
			if name := sampleLine.FindStringSubmatch(l)[1]; name != current {
				t.Errorf("sample %q is not under its own family (%s)", l, current)
			}
		default:
			t.Errorf("not Prometheus text: %q", l)
		}
	}
}

func TestMetricsLabelValuesAreEscaped(t *testing.T) {
	e := newExposition()
	e.gauge("keelson_x", "x", 1, "app", "a\"b\\c\nd", "empty", "")
	var b strings.Builder
	e.write(&b)
	if want := `keelson_x{app="a\"b\\c\nd"} 1`; !has(b.String(), want) {
		t.Errorf("want %s in:\n%s", want, b.String())
	}
}

func TestMetricsAPartThatFailsIsReportedAndTheRestIsStillThere(t *testing.T) {
	_, body := scrape(t, &fakeDocker{}, fullDeploy(&metricsDeployments{err: errors.New("engine busy")}))
	for _, want := range []string{`keelson_collector_success{collector="apps"} 0`, `keelson_collector_success{collector="jobs"} 1`, `keelson_collector_success{collector="engine"} 1`, `keelson_job_running{job="backup-shop"} 1`} {
		if !has(body, want) {
			t.Errorf("missing %q in:\n%s", want, body)
		}
	}
}

func TestMetricsEngineDownStillReportsTheHost(t *testing.T) {
	_, body := scrape(t, &fakeDocker{infoErr: errors.New("no engine")}, nil)
	for _, want := range []string{`keelson_engine_up 0`, `keelson_collector_success{collector="engine"} 0`, `keelson_host_cpus 4`, `keelson_agent_info{version="9.9.9",read_only="true"} 1`} {
		if !has(body, want) {
			t.Errorf("missing %q in:\n%s", want, body)
		}
	}
	if strings.Contains(body, "keelson_app_") || strings.Contains(body, `collector="apps"`) {
		t.Errorf("a read-only agent has no apps:\n%s", body)
	}
}

func TestMetricsNeedTheToken(t *testing.T) {
	h, err := New(&fakeDocker{}, Options{Token: testToken, Logger: slog.New(slog.NewTextHandler(io.Discard, nil))})
	if err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(h)
	defer srv.Close()
	if r := do(t, "GET", srv.URL+"/metrics", ""); r.StatusCode != 401 {
		t.Errorf("no token: %d", r.StatusCode)
	}
	if r := do(t, "GET", srv.URL+"/metrics", "wrong-token-wrong-token-wrong-token"); r.StatusCode != 401 {
		t.Errorf("wrong token: %d", r.StatusCode)
	}
}
