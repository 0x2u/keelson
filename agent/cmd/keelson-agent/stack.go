package main

import (
	"context"
	"fmt"
	"log/slog"
	"path/filepath"
	"time"

	"github.com/0x2u/keelson/agent/internal/api"
	"github.com/0x2u/keelson/agent/internal/build"
	"github.com/0x2u/keelson/agent/internal/config"
	"github.com/0x2u/keelson/agent/internal/confmgr"
	"github.com/0x2u/keelson/agent/internal/databases"
	"github.com/0x2u/keelson/agent/internal/deploy"
	"github.com/0x2u/keelson/agent/internal/docker"
	statshistory "github.com/0x2u/keelson/agent/internal/history"
	"github.com/0x2u/keelson/agent/internal/jobs"
	"github.com/0x2u/keelson/agent/internal/notify"
	"github.com/0x2u/keelson/agent/internal/postgres"
	"github.com/0x2u/keelson/agent/internal/store"
	"github.com/0x2u/keelson/agent/internal/sysinfo"
)

// stack is everything an agent with an apps file runs besides its HTTP API: the deployer and its builder, the jobs, the
// database service, the configuration manager and the managed PostgreSQL. `serve` puts the API on a listener and
// `connect` puts it on the dashboard's relay; the parts are the same.
type stack struct {
	deployer *deploy.Deployer
	notifier *notify.Service
	sched    *jobs.Scheduler
	dbs      *databases.Service
	pgm      *postgres.Manager
	st       *store.Store
	// api is what the API needs to serve deployments, configuration and the rest.
	api *api.DeployOptions

	closeDeploy func()
}

type stackConfig struct {
	socket, appsFile, projectsDir, dataDir, secret string
	log                                            *slog.Logger
	// buildMachine makes this a machine that only builds images (see config.BuildMachineIssues): what the API may be asked
	// to write is limited, and the routes of jobs, databases, previews and the managed PostgreSQL are not served.
	buildMachine bool
}

// startStack opens the agent's state, starts its background work (it ends with ctx) and returns what the API serves.
func startStack(ctx context.Context, c stackConfig) (s *stack, err error) {
	admin := docker.NewAdmin(c.socket)
	s = &stack{}
	var fallback *confmgr.Fallback
	if s.deployer, s.st, fallback, s.closeDeploy, err = openDeploy(admin, location(c.appsFile, c.projectsDir), c.dataDir, c.log, true); err != nil {
		return nil, err
	}
	// Every failure below returns a nil stack, which would leave this function nothing to close: it keeps its own pointer.
	started := s
	defer func() {
		if err != nil {
			started.close()
		}
	}()
	// Builds run on this server's own engine: of an app whose file entry has a build block when the dashboard asks for one,
	// and of an image another server asks for (POST /v1/builds), held to the build_limits of the file.
	builder := build.New(admin)
	builder.UsePlatformEngine(docker.NewCLI(c.socket))
	s.deployer.SetBuilder(builder)
	s.notifier = notify.NewService(ctx, s.deployer, c.log)
	s.notifier.SetHooks(notify.Hooks{
		Ledger: notify.OpenLedger(filepath.Join(c.dataDir, "notifications.json"), c.log),
		Engine: func(ctx context.Context) (string, error) {
			info, err := admin.Info(ctx)
			if err != nil {
				return "", err
			}
			return info.RootDir, nil
		},
		Host:      func(paths ...string) sysinfo.Host { return sysinfo.Read(sysinfo.ProcDir(), paths...) },
		DataPaths: []string{c.dataDir},
		Version:   version,
		Proven:    func(ctx context.Context, at time.Time) error { return s.st.RecordProof(ctx, store.ProofAlert, "", at) },
		CertNames: func() []string { return notify.CertNames(s.deployer.Config()) },
		CertProbe: notify.LocalCertProbe,
	})
	if err = s.notifier.Reconfigure(s.deployer.Config().Notifications); err != nil {
		return nil, err
	}
	s.deployer.SetEmitter(s.notifier)
	if err = s.deployer.Recover(ctx); err != nil {
		return nil, fmt.Errorf("recover interrupted deployments: %w", err)
	}
	// Docker may give a restarted container another random host port.
	go s.deployer.RunReconciler(ctx, 10*time.Second)
	// Preview environments expire, and a removed template takes its instances with it.
	go s.deployer.RunPreviewSweeper(ctx, time.Minute)

	// A short record of what the containers use, for the dashboard's charts.
	// The host's own load, memory and disk are recorded in the same cycle; the disk is the one under the agent's data.
	recorder := statshistory.New(docker.New(c.socket), s.st, c.log)
	recorder.SampleHost(func() sysinfo.Host { return sysinfo.Read(sysinfo.ProcDir(), c.dataDir, "/") }, s.st)
	go recorder.Run(ctx)
	// When the apps went down and came back, as the alerts judge it, whether or not notifications are configured.
	go notify.NewAvailabilityWatcher(s.deployer, s.st, c.log).Run(ctx)

	// The scheduler always exists, so a first job can be added while the agent runs. Backups are its jobs of
	// kind "backup"; the database service also serves the database routes and runs restores.
	s.dbs = databases.New(databases.Options{Config: s.deployer.Config(), Store: s.st, Engine: admin, DataDir: c.dataDir, Log: c.log})
	s.deployer.SetBackuper(s.dbs)
	// A restore test cut short by a stop of the agent left a scratch database behind: it is dropped now.
	if err = s.dbs.RecoverRestoreTests(ctx); err != nil {
		return nil, fmt.Errorf("recover interrupted restore tests: %w", err)
	}
	s.sched = jobs.New(s.deployer.Config(), s.st, s.deployer, s.dbs, s.notifier, c.log)
	if err = s.sched.Recover(ctx); err != nil {
		return nil, fmt.Errorf("recover interrupted jobs: %w", err)
	}
	go s.sched.Run(ctx)

	// The apps file can change while the agent runs: the manager validates, writes and versions the
	// changes and hands the new configuration to each part, which applies it or refuses it first.
	s.deployer.SetProxyFactory(newProxy)
	manager, err := newManager(c, s.st, s.deployer.Config(), fallback, s.deployer, s.sched, s.notifier, s.dbs)
	if err != nil {
		return nil, err
	}
	if c.buildMachine {
		manager.Restrict(config.BuildMachineIssues)
	}
	go manager.Watch(ctx, configPollEvery)
	// The managed PostgreSQL: nothing runs until the apps file declares a database the agent created; then the
	// instance is brought up at once and kept up, whatever happened to its container (or to Docker) meanwhile.
	s.pgm = postgres.New(postgres.Options{Engine: admin, Config: manager, Env: s.deployer.Env(), Busy: s.dbs.Busy, DataDir: c.dataDir, Log: c.log})
	go s.pgm.Run(ctx, postgresReconcileEvery)
	s.api = &api.DeployOptions{Deployments: s.deployer, Secret: c.secret, Replays: s.st, Jobs: s.sched, Databases: s.dbs, Previews: s.deployer, Config: manager, Audit: s.st, History: s.st, HostHistory: s.st, Availability: s.st, Delivery: s.st, Env: s.deployer.Env(), Postgres: s.pgm, Images: s.deployer, StagingDir: imageStaging(c.dataDir), Alerts: s.notifier, Proofs: s.st, Builds: s.deployer}
	if c.buildMachine {
		s.api.Jobs, s.api.Databases, s.api.Previews, s.api.Postgres = nil, nil, nil, nil
	}
	c.log.Info("configuration is editable at run time", "file", c.appsFile, "jobs", len(s.deployer.Config().Jobs))
	return s, nil
}

// beginShutdown stops the creation and removal of previews; the sweeper has stopped with the context.
func (s *stack) beginShutdown() { s.deployer.BeginShutdown() }

// drain waits for what is still running, after the API stopped taking requests. An operation on the managed PostgreSQL
// is cut short by the shutdown and repeated by its client: every step is idempotent.
func (s *stack) drain(log *slog.Logger) {
	if !s.deployer.Wait(60 * time.Second) {
		log.Warn("deployments still running at exit; they are reconciled at the next start")
	}
	if !s.pgm.Shutdown(30 * time.Second) {
		log.Warn("an operation on the managed PostgreSQL is still running at exit; repeat it after the next start")
	}
	// The database service goes first: it cancels the backups (run by the scheduler) and the restores, whose
	// containers are removed before the scheduler is waited for and the process exits.
	if !s.dbs.Shutdown(30 * time.Second) {
		log.Warn("a backup or restore is still running at exit; it is marked failed at the next start")
	}
	if !s.sched.Shutdown(30 * time.Second) {
		log.Warn("jobs still running at exit; they are marked failed at the next start")
	}
}

// close flushes the queued notifications, after the last deployment ended, and releases the state.
func (s *stack) close() {
	if s.notifier != nil {
		s.notifier.Close(10 * time.Second)
	}
	s.closeDeploy()
}
