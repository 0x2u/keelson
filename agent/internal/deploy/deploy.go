// Package deploy replaces a running app with a new image, keeping the old
// container until the new one is proven healthy, and restores it otherwise.
//
// A deployment never changes anything before the new image is pulled and the
// app's environment file is read, so the common failures (unknown tag, bad
// credentials, missing env file) leave the running container untouched.
package deploy

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/0x2u/keelson/agent/internal/appenv"
	"github.com/0x2u/keelson/agent/internal/config"
	"github.com/0x2u/keelson/agent/internal/docker"
	"github.com/0x2u/keelson/agent/internal/notify"
	"github.com/0x2u/keelson/agent/internal/proxy"
	"github.com/0x2u/keelson/agent/internal/store"
)

// Errors returned synchronously when a deployment cannot be started.
var (
	ErrUnknownApp       = errors.New("unknown app")
	ErrInvalidTarget    = errors.New("invalid deployment target")
	ErrBusy             = errors.New("a deployment is already running for this app")
	ErrNoRollbackTarget = errors.New("no previous successful deployment to roll back to")
	// ErrBuildOnly: the app is only built on this server (build.only): it cannot be deployed, rolled back or given an image.
	ErrBuildOnly = errors.New("this app is built here and runs on another server")
	// ErrNoImage: that image of the app was neither built nor received on this server.
	ErrNoImage = errors.New("no such image was built or received here")
	// ErrBadArchive: an archive sent for import is not exactly the one image it was announced as.
	ErrBadArchive = errors.New("the archive is not the announced image")
)

// PlatformError: an archive sent for import holds an image for another platform than the engine's, which could not run
// it.
type PlatformError struct{ Image, Engine string }

func (e *PlatformError) Error() string {
	return fmt.Sprintf("image is for %s but this server runs %s", e.Image, e.Engine)
}

const (
	prevSuffix     = ".prev"
	overallTimeout = 15 * time.Minute

	// TriggerRollback is the trigger recorded on the deployments that put back an earlier version.
	TriggerRollback = "rollback"
)

var (
	tagPattern    = regexp.MustCompile(`^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$`)
	digestPattern = regexp.MustCompile(`^sha256:[a-f0-9]{64}$`)
)

// Engine is the part of the Docker engine a deployment needs.
type Engine interface {
	Inspect(ctx context.Context, id string) (*docker.Detail, error)
	ImageRepoDigests(ctx context.Context, id string) ([]string, error)
	ListByLabel(ctx context.Context, label string) ([]docker.Container, error)
	Pull(ctx context.Context, repo, ref, auth string, progress func(string)) error
	Create(ctx context.Context, spec docker.ContainerSpec) (string, error)
	Start(ctx context.Context, id string) error
	Stop(ctx context.Context, id string, timeoutSec int) error
	Rename(ctx context.Context, id, newName string) error
	Remove(ctx context.Context, id string) error
	// RemoveThrowaway removes a container made to run once (a release step, a job) with its anonymous volumes.
	RemoveThrowaway(ctx context.Context, id string) error
	Wait(ctx context.Context, id string) (int, error)
	Logs(ctx context.Context, id string, opt docker.LogOptions, fn func(docker.LogLine) error) error
	ListImages(ctx context.Context, repo string) ([]docker.Image, error)
	// ListDanglingImages lists the untagged images nothing builds on: the stages a multi-stage build leaves behind.
	ListDanglingImages(ctx context.Context) ([]docker.Image, error)
	RemoveImage(ctx context.Context, ref string) error
	// Info says which platform the engine runs images for: an imported image must be for it.
	Info(ctx context.Context) (*docker.EngineInfo, error)
	// SaveImage and LoadImage move an image between servers as a tar archive (docker save, docker load).
	SaveImage(ctx context.Context, ref string) (io.ReadCloser, error)
	LoadImage(ctx context.Context, archive io.Reader) error
}

// DriftChecker is implemented by proxy drivers that can tell whether the live proxy still serves what they generate
// for routes, as Reconcile uses it to restore a proxy that lost its configuration.
type DriftChecker interface {
	Drifted(ctx context.Context, routes []proxy.Route) bool
}

// Proxy routes public hostnames to app containers.
type Proxy interface {
	Apply(ctx context.Context, routes []proxy.Route) error
}

// Target selects what to deploy: exactly one of Tag or Digest.
type Target struct {
	Tag    string `json:"tag,omitempty"`
	Digest string `json:"digest,omitempty"`
}

// Ref returns the image reference to run for repo.
func (t Target) Ref(repo string) (string, error) {
	switch {
	case t.Tag != "" && t.Digest == "" && tagPattern.MatchString(t.Tag):
		return repo + ":" + t.Tag, nil
	case t.Digest != "" && t.Tag == "" && digestPattern.MatchString(t.Digest):
		return repo + "@" + t.Digest, nil
	}
	return "", ErrInvalidTarget
}

// splitRef splits repo:tag or repo@digest into the repository and the
// tag-or-digest the engine's pull endpoint expects.
func splitRef(ref string) (repo, tagOrDigest string) {
	if i := strings.Index(ref, "@"); i >= 0 {
		return ref[:i], ref[i+1:]
	}
	i := strings.LastIndex(ref, ":")
	return ref[:i], ref[i+1:]
}

// Deployer runs deployments. It is safe for concurrent use; at most one
// deployment runs per app.
type Deployer struct {
	eng   Engine
	store *store.Store
	// cfg is replaced when the configuration is reloaded: read it through config().
	cfg atomic.Pointer[config.Config]
	// proxy is nil when no app has domains; replaced by a reload: read it through proxyDriver().
	proxy        Proxy
	pxMu         sync.RWMutex
	proxyFactory func(*config.Proxy) Proxy
	log          *slog.Logger
	// PollEvery is how often container health is checked.
	PollEvery time.Duration
	// soakEvery is how often the new version is looked at during the soak (a few seconds: each round requests every
	// verify path).
	soakEvery time.Duration
	now       func() time.Time
	http      *http.Client // health_path probes
	prom      *http.Client // Prometheus queries of an analysis (the per-query timeout is the context's)
	emitter   notify.Emitter
	// builder builds images for StartBuild; nil when the agent cannot build. buildCtx ends when the agent shuts down,
	// which cancels a running build.
	builder Builder
	// env holds the variables set through the API; nil when none are stored (tests, read-only use).
	env         *appenv.Service
	buildCtx    context.Context
	buildCancel context.CancelFunc

	// backups runs the `backup` release steps; nil until SetBackuper.
	backups Backuper

	mu     sync.Mutex
	active map[string]bool
	// swapping counts the open swap windows per app (see BeginSwap in notify.go); guarded by mu.
	swapping map[string]int
	// stopping is set when the agent is shutting down: previews are neither created nor removed any more.
	stopping atomic.Bool

	// proxyMu serializes changes to the proxy and to app_state, which must
	// move together: a route must never point at a container that app_state
	// does not know about.
	proxyMu    sync.Mutex
	applied    []proxy.Route
	appliedSet bool
}

// New returns a Deployer. px may be nil when no app is deployed blue/green.
func New(eng Engine, st *store.Store, cfg *config.Config, px Proxy, log *slog.Logger) *Deployer {
	if log == nil {
		log = slog.Default()
	}
	probe := &http.Client{
		Timeout: 3 * time.Second,
		// A redirect is an answer, not a failure to follow.
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}
	d := &Deployer{eng: eng, store: st, proxy: px, log: log, PollEvery: time.Second, soakEvery: 3 * time.Second, now: time.Now, http: probe, prom: &http.Client{}, active: map[string]bool{}}
	d.buildCtx, d.buildCancel = context.WithCancel(context.Background())
	d.cfg.Store(cfg)
	return d
}

// Start begins deploying target for app and returns the deployment ID at once.
// The deployment runs in the background, independent of the caller's context:
// a dropped HTTP connection must not abort a half-finished swap. done is
// closed when the deployment has reached its final status.
func (d *Deployer) Start(ctx context.Context, app string, target Target, trigger string) (id string, done <-chan struct{}, err error) {
	a, ok := d.config().App(app)
	if !ok {
		return "", nil, ErrUnknownApp
	}
	if a.BuildOnly() {
		return "", nil, ErrBuildOnly
	}
	ref, err := target.Ref(a.Image)
	if err != nil {
		return "", nil, err
	}
	// A tag this server built itself exists nowhere else: deploying it again (an older build, the one before a bad
	// release) must use the local image, not ask a registry that has never heard of it.
	local, err := d.store.BuiltHere(ctx, a.Name, ref)
	if err != nil {
		return "", nil, err
	}
	if !local && a.Build != nil && target.Tag != "" {
		// An app with a build block gets its images from this server: a tag it never built is not in any registry the
		// operator controls, and `keelson-local/<app>` names exist on Docker Hub for anyone to register, so pulling one
		// would run a stranger's image. An image already on the engine is used as it is, without a pull.
		if _, err := d.eng.ImageRepoDigests(ctx, ref); err != nil {
			if !docker.IsNotFound(err) {
				return "", nil, fmt.Errorf("look for the local image %s: %w", ref, err)
			}
			return "", nil, fmt.Errorf("%w: %s is not on this server and %s has a build block, so it never pulls a tag it did not build: deploy a tag built here, or remove the build block to deploy a registry image", ErrNoImage, ref, a.Name)
		}
		local = true
	}
	return d.start(ctx, a, ref, trigger, launchOpts{local: local})
}

// Rollback redeploys the most recent successful image that is not the one
// currently running.
func (d *Deployer) Rollback(ctx context.Context, app string) (id string, done <-chan struct{}, err error) {
	a, ok := d.config().App(app)
	if !ok {
		return "", nil, ErrUnknownApp
	}
	if a.BuildOnly() {
		return "", nil, ErrBuildOnly
	}
	current, err := d.currentRef(ctx, a)
	if err != nil {
		return "", nil, err
	}
	past, err := d.store.Succeeded(ctx, a.Name, 50)
	if err != nil {
		return "", nil, err
	}
	for _, p := range past {
		if p.Ref != current {
			// A rollback record of a built image is itself no proof the image came from a registry: ask whether any
			// deployment of this ref built it here.
			local, err := d.store.BuiltHere(ctx, a.Name, p.Ref)
			if err != nil {
				return "", nil, err
			}
			return d.start(ctx, a, p.Ref, TriggerRollback, launchOpts{local: local})
		}
	}
	return "", nil, ErrNoRollbackTarget
}

func (d *Deployer) start(ctx context.Context, a config.App, ref, trigger string, opts launchOpts) (string, <-chan struct{}, error) {
	if !d.reserve(a.Name) {
		return "", nil, ErrBusy
	}
	id := store.NewID()
	done, err := d.launch(ctx, a, id, ref, trigger, opts)
	if err != nil {
		return "", nil, err
	}
	return id, done, nil
}

// reserve takes the app's lock: at most one deployment (or removal of a preview) runs per name. It reports false when
// the name is taken.
func (d *Deployer) reserve(name string) bool {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.active[name] {
		return false
	}
	d.active[name] = true
	return true
}

// launch records the deployment id of a reserved app and runs it in the background. The lock is released when the
// deployment ends, or at once when it cannot be recorded.
func (d *Deployer) launch(ctx context.Context, a config.App, id, ref, trigger string, opts launchOpts) (<-chan struct{}, error) {
	err := d.store.CreateDeployment(ctx, store.Deployment{ID: id, App: a.Name, Ref: ref, Trigger: trigger, StartedAt: d.now()})
	if err != nil {
		d.release(a.Name)
		opts.abandon()
		return nil, err
	}

	done := make(chan struct{})
	go func() {
		defer close(done)
		defer d.release(a.Name)
		d.run(id, a, ref, trigger, opts)
	}()
	return done, nil
}

func (d *Deployer) release(app string) {
	d.mu.Lock()
	delete(d.active, app)
	delete(d.swapping, app) // a swap window nobody closed ends with the deployment
	d.mu.Unlock()
}

// Wait blocks until no deployment is in flight or the timeout elapses, and
// reports whether all finished.
func (d *Deployer) Wait(timeout time.Duration) bool {
	deadline := time.Now().Add(timeout)
	for {
		d.mu.Lock()
		idle := len(d.active) == 0
		d.mu.Unlock()
		if idle {
			return true
		}
		if !time.Now().Before(deadline) {
			return false
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func (d *Deployer) event(id, level, format string, args ...any) {
	msg := fmt.Sprintf(format, args...)
	d.log.Info("deployment", "id", id, "level", level, "msg", msg)
	if err := d.store.AddEvent(context.Background(), id, level, msg, d.now()); err != nil {
		d.log.Error("record deployment event", "id", id, "err", err)
	}
}

// phase starts a pipeline phase of the deployment; the one running ends as done. A phase that cannot be recorded does not
// fail the deployment: the log and the final status are what it is judged by.
func (d *Deployer) phase(id, name string) {
	if err := d.store.BeginPhase(context.Background(), id, name, d.now()); err != nil {
		d.log.Error("record deployment phase", "id", id, "phase", name, "err", err)
	}
}

// endPhase ends the running phase of the deployment with status, for a phase that did not do its work (skipped).
func (d *Deployer) endPhase(id, status string) {
	if err := d.store.EndPhase(context.Background(), id, status, d.now()); err != nil {
		d.log.Error("record deployment phase", "id", id, "status", status, "err", err)
	}
}

// skipPhase records a phase the deployment deliberately does not go through.
func (d *Deployer) skipPhase(id, name string) {
	d.phase(id, name)
	d.endPhase(id, store.PhaseSkipped)
}

// finish records how a deployment ended: its status, the image that serves after it, and the phase that was running
// (done for a success, failed for anything else).
func (d *Deployer) finish(id, status string, cause error) {
	msg := ""
	if cause != nil {
		msg = cause.Error()
	}
	if err := d.store.Finish(context.Background(), id, status, msg, d.servingAfter(id, status), d.now()); err != nil {
		d.log.Error("record deployment result", "id", id, "err", err)
	}
	level := "info"
	if status != store.StatusSucceeded {
		level = "error"
	}
	d.event(id, level, "deployment %s", status)
	d.emitFinished(id)
}

// servingAfter is the image that serves once the deployment ended with status, "" when nothing known to does. A
// success serves its own image, unless it never reached the switch (an image built for another server runs nowhere
// here). A failed deployment that did not get to replace anything leaves the version that served; one that did
// leaves the previous version it recorded, if there was one, and a failed restore leaves nothing known to serve.
func (d *Deployer) servingAfter(id, status string) string {
	ctx := context.Background()
	dep, err := d.store.Deployment(ctx, id)
	if err != nil {
		d.log.Error("read deployment for its serving image", "id", id, "err", err)
		return ""
	}
	switched := slices.ContainsFunc(dep.Phases, func(p store.Phase) bool { return p.Name == store.PhaseSwitch })
	switch {
	case status == store.StatusSucceeded:
		if switched {
			return dep.Ref
		}
		return ""
	case status == store.StatusRollbackFailed:
		return ""
	case dep.PreviousRef != "":
		return dep.PreviousRef
	case switched:
		return ""
	}
	a, ok, err := d.lookupApp(ctx, dep.App)
	if err != nil || !ok {
		return ""
	}
	ref, err := d.currentRef(ctx, a)
	if err != nil {
		return ""
	}
	return ref
}

func (d *Deployer) run(id string, a config.App, ref, trigger string, opts launchOpts) {
	if opts.build != nil {
		d.phase(id, store.PhaseSource)
		err := d.runBuild(id, opts.build)
		if err == nil {
			// The image exists here from now on, whatever becomes of this deployment: when its release step or its health
			// check fails and the operator fixes the cause, deploying the same tag must use this image, not ask a registry.
			ctx, cancel := context.WithTimeout(context.Background(), cleanupTimeout)
			err = d.store.RecordImport(ctx, a.Name, ref, d.now())
			cancel()
		}
		if err != nil {
			// Nothing was touched: what serves keeps serving.
			d.finish(id, store.StatusFailed, err)
			if trigger == TriggerPreview {
				ctx, cancel := context.WithTimeout(context.Background(), cleanupTimeout)
				defer cancel()
				d.dropUnservedPreview(ctx, id, a.Name)
			}
			return
		}
	}

	// The bound of the whole deployment is the sum of the budgets of its phases (see budget.go), each of which has its own
	// context: none can use up what another needs.
	ctx, cancel := context.WithTimeout(context.Background(), deployBudget(a))
	defer cancel()

	if a.BuildOnly() || opts.elsewhere {
		// Nothing runs on this server: the image is built, kept for export, and the older ones are pruned as usual.
		d.event(id, "info", "%s is built here and runs elsewhere: nothing is deployed on this server", ref)
		d.pruneImages(ctx, id, a, ref)
		d.finish(id, store.StatusSucceeded, nil)
		return
	}

	status, cause := d.execute(ctx, id, a, ref, trigger, opts.build != nil || opts.local)
	if status == store.StatusSucceeded {
		// The swap is over; what is left is the cleanup of the old versions.
		if trigger == TriggerPreview {
			d.prunePreviewImages(ctx, id, a, ref)
		} else {
			d.pruneImages(ctx, id, a, ref)
		}
	}
	d.finish(id, status, cause)
	if trigger == TriggerPreview && status != store.StatusSucceeded {
		cctx, cancelCleanup := cleanupContext(ctx)
		defer cancelCleanup()
		d.dropUnservedPreview(cctx, id, a.Name)
	}
}

// execute performs the swap and returns the final status. local says the image is on this server and is not pulled
// (built here).
func (d *Deployer) execute(ctx context.Context, id string, a config.App, ref, trigger string, local bool) (string, error) {
	d.phase(id, store.PhaseRelease)
	d.event(id, "info", "deploying %s to %s", ref, a.Name)
	// Everything that can fail without touching the running container comes first.
	env, err := d.environment(a, id)
	if err != nil {
		return store.StatusFailed, fmt.Errorf("read environment: %w", err)
	}
	spec, err := buildSpec(a, ref, id, env)
	if err != nil {
		return store.StatusFailed, err
	}
	spec.ExtraNetworks = d.config().ExtraNetworks(a)
	// Refused before anything runs, the release steps (a migration) included.
	if err := d.checkAdoption(ctx, a); err != nil {
		return store.StatusFailed, err
	}
	if err := d.fetchImage(ctx, id, a, ref, local); err != nil {
		return store.StatusFailed, err
	}

	rctx, cancelRelease := phaseContext(ctx, releaseBudget(a))
	err = d.runRelease(rctx, id, a, ref, trigger, env)
	cancelRelease()
	if err != nil {
		return store.StatusFailed, err
	}
	if skipsRelease(a, trigger) {
		d.endPhase(id, store.PhaseSkipped)
	}

	d.phase(id, store.PhaseSwitch)
	if a.Proxied() {
		return d.executeProxied(ctx, id, a, ref, spec)
	}

	// From here on the context is the health phase's own: the pull and the release steps cannot have used it up.
	hctx, cancelHealth := context.WithTimeout(ctx, healthBudget(a))
	defer cancelHealth()

	prevName := a.Name + prevSuffix
	if _, err := d.eng.Inspect(hctx, prevName); err == nil {
		d.event(id, "warn", "removing stale container %s", prevName)
		if err := d.eng.Remove(hctx, prevName); err != nil {
			return store.StatusFailed, fmt.Errorf("remove stale %s: %w", prevName, err)
		}
	} else if !docker.IsNotFound(err) {
		return store.StatusFailed, err
	}

	cur, err := d.eng.Inspect(hctx, a.Name)
	hadPrev := err == nil
	if err != nil && !docker.IsNotFound(err) {
		return store.StatusFailed, err
	}

	if hadPrev {
		if err := d.store.SetPreviousRef(hctx, id, cur.Image); err != nil {
			return store.StatusFailed, err
		}
		// The serving container goes away from here until the new one is up or the old one is back.
		d.BeginSwap(a.Name)
		defer d.EndSwap(a.Name)
		d.event(id, "info", "stopping %s (running %s)", a.Name, cur.Image)
		if err := d.eng.Stop(hctx, a.Name, int(a.Stop().Seconds())); err != nil {
			return store.StatusFailed, fmt.Errorf("stop %s: %w", a.Name, err)
		}
		if err := d.eng.Rename(hctx, a.Name, prevName); err != nil {
			// Nothing has been replaced yet: bring the old container back.
			if serr := d.eng.Start(hctx, a.Name); serr != nil {
				return store.StatusRollbackFailed, fmt.Errorf("rename %s: %v; restart: %w", a.Name, err, serr)
			}
			return store.StatusFailed, fmt.Errorf("rename %s: %w", a.Name, err)
		}
	}

	newErr := d.startNew(hctx, id, a, spec)
	if newErr == nil {
		d.phase(id, store.PhaseLive)
		if hadPrev {
			if err := d.eng.Remove(hctx, prevName); err != nil {
				d.event(id, "warn", "could not remove previous container %s: %v", prevName, err)
			}
		}
		return store.StatusSucceeded, nil
	}

	// Whatever ended the attempt, the cleanup and the way back run on contexts that have not expired.
	cctx, cancelClean := cleanupContext(ctx)
	defer cancelClean()
	d.event(id, "error", "new container failed: %v", newErr)
	d.recordOutput(id, a.Name) // before the container goes: its output is the cause
	if err := d.eng.Remove(cctx, a.Name); err != nil && !docker.IsNotFound(err) {
		d.event(id, "warn", "could not remove failed container: %v", err)
	}
	if !hadPrev {
		return store.StatusFailed, newErr
	}
	d.event(id, "info", "restoring previous container (%s)", cur.Image)
	rctx, cancelRestore := restoreContext(ctx, a)
	defer cancelRestore()
	if err := d.restorePrevious(rctx, a); err != nil {
		d.recordOutput(id, a.Name) // the restored container stays: its output tells why it did not come back
		return store.StatusRollbackFailed, fmt.Errorf("%v; rollback failed: %w", newErr, err)
	}
	d.event(id, "info", "previous version restored and healthy")
	return store.StatusRolledBack, newErr
}

func (d *Deployer) startNew(ctx context.Context, id string, a config.App, spec docker.ContainerSpec) error {
	if _, err := d.eng.Create(ctx, spec); err != nil {
		return fmt.Errorf("create container: %w", err)
	}
	if err := d.eng.Start(ctx, spec.Name); err != nil {
		return fmt.Errorf("start container: %w", err)
	}
	d.event(id, "info", "waiting for %s to become healthy", spec.Name)
	if err := d.waitHealthy(ctx, a, spec.Name); err != nil {
		return err
	}
	d.event(id, "info", "%s is healthy", spec.Name)
	return nil
}

// restorePrevious puts the stopped "<app>.prev" container back in service.
func (d *Deployer) restorePrevious(ctx context.Context, a config.App) error {
	prevName := a.Name + prevSuffix
	if err := d.eng.Rename(ctx, prevName, a.Name); err != nil {
		return fmt.Errorf("rename %s: %w", prevName, err)
	}
	if err := d.eng.Start(ctx, a.Name); err != nil {
		return fmt.Errorf("start restored container: %w", err)
	}
	return d.waitHealthy(ctx, a, a.Name)
}

// waitHealthy waits until the container is healthy. With a HEALTHCHECK in the
// image that means "healthy"; without one it means "has kept running for
// StableAfter". A container that exits, restarts or turns unhealthy fails at
// once.
func (d *Deployer) waitHealthy(ctx context.Context, a config.App, name string) error {
	deadline := d.now().Add(a.HealthWait())
	var healthySince time.Time
	for {
		det, err := d.eng.Inspect(ctx, name)
		if err != nil {
			return err
		}
		st := det.State
		switch {
		case st.Restarting:
			return fmt.Errorf("container is restarting in a loop (exit code %d)", st.ExitCode)
		case !st.Running:
			return fmt.Errorf("container exited with code %d", st.ExitCode)
		case st.Health == "unhealthy":
			return errors.New("container reported unhealthy")
		case st.Health == "healthy":
			// An image with a HEALTHCHECK counts at its first healthy report, as it always did, unless the file sets
			// stable_after: it has to stay healthy that long.
			if !a.StableAfterSet {
				return nil
			}
			if healthySince.IsZero() {
				healthySince = d.now()
			}
			if d.now().Sub(healthySince) >= a.StableWait() {
				return nil
			}
		case st.Health == "" && st.StartedAt != nil && d.now().Sub(*st.StartedAt) >= a.StableWait():
			return nil
		}
		if !d.now().Before(deadline) {
			return fmt.Errorf("container not healthy after %s", a.HealthWait())
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(d.PollEvery):
		}
	}
}

func buildSpec(a config.App, ref, deploymentID string, env []string) (docker.ContainerSpec, error) {
	spec := docker.ContainerSpec{
		Name:          a.Name,
		Image:         ref,
		Env:           env,
		Labels:        map[string]string{"keelson.app": a.Name, "keelson.deployment": deploymentID},
		Cmd:           a.Command,
		Binds:         a.Volumes,
		NetworkMode:   a.Network,
		RestartPolicy: a.Restart,
		StopTimeout:   int(a.Stop().Seconds()),
	}
	if a.Log != nil {
		spec.LogDriver, spec.LogMaxSize, spec.LogMaxFile = a.Log.Driver, a.Log.MaxSizeOrDefault().DockerString(), a.Log.MaxFileOrDefault()
	}
	if a.Proxied() {
		// Blue/green: the new container lives next to the old one under its
		// own name. With its own network the app port is published on a random
		// loopback port; on the host network (host_ports) the app listens on the
		// port the agent chooses at deploy time.
		spec.Name = a.Name + "-" + deploymentID
		if a.ContainerPort > 0 {
			spec.Ports = []docker.PortBinding{{HostIP: "127.0.0.1", ContainerPort: strconv.Itoa(a.ContainerPort), Proto: "tcp"}}
		}
		return spec, nil
	}
	for _, p := range a.Publish {
		m, err := config.ParsePort(p)
		if err != nil {
			return spec, err
		}
		spec.Ports = append(spec.Ports, docker.PortBinding{HostIP: m.HostIP, HostPort: m.HostPort, ContainerPort: m.ContainerPort, Proto: m.Proto})
	}
	return spec, nil
}

// registryAuth returns the X-Registry-Auth value for the image's registry, or
// "" when no credentials are configured for it.
func (d *Deployer) registryAuth(image string) (string, error) {
	host := config.RegistryHost(image)
	for _, r := range d.config().Registries {
		if r.Host != host {
			continue
		}
		pw, err := os.ReadFile(r.PasswordFile)
		if err != nil {
			return "", fmt.Errorf("read registry password for %s: %w", host, err)
		}
		return docker.RegistryAuth(host, r.Username, strings.TrimSpace(string(pw))), nil
	}
	return "", nil
}

// Recover must run once at startup, before deployments are accepted. A
// deployment still marked running was cut short by a crash or restart. If its
// "<app>.prev" container exists the swap was interrupted before it was
// proven, so the previous version is restored; otherwise the running
// container was never touched.
func (d *Deployer) Recover(ctx context.Context) error {
	running, err := d.store.Running(ctx)
	if err != nil {
		return err
	}
	for _, dep := range running {
		a, ok, err := d.lookupApp(ctx, dep.App)
		if err != nil {
			return err
		}
		if !ok {
			d.finish(dep.ID, store.StatusFailed, errors.New("interrupted: agent restarted, app no longer configured"))
			continue
		}
		if a.Proxied() {
			if err := d.recoverProxied(ctx, dep, a); err != nil {
				return err
			}
			continue
		}
		prevName := a.Name + prevSuffix
		if _, err := d.eng.Inspect(ctx, prevName); err != nil {
			if !docker.IsNotFound(err) {
				return err
			}
			d.event(dep.ID, "warn", "interrupted by an agent restart; no swap was in progress")
			d.finish(dep.ID, store.StatusFailed, errors.New("interrupted: agent restarted"))
			continue
		}
		d.event(dep.ID, "warn", "interrupted by an agent restart during the swap; restoring the previous version")
		if err := d.eng.Remove(ctx, a.Name); err != nil && !docker.IsNotFound(err) {
			d.finish(dep.ID, store.StatusRollbackFailed, fmt.Errorf("interrupted: remove new container: %w", err))
			continue
		}
		if err := d.restorePrevious(ctx, a); err != nil {
			d.finish(dep.ID, store.StatusRollbackFailed, fmt.Errorf("interrupted: restore previous: %w", err))
			continue
		}
		d.finish(dep.ID, store.StatusRolledBack, errors.New("interrupted: agent restarted during the swap"))
	}
	if err := d.removeStaleReleases(ctx); err != nil {
		return err
	}
	if d.proxyDriver() != nil {
		if err := d.removeOrphans(ctx); err != nil {
			return err
		}
		if err := d.Reconcile(ctx); err != nil {
			// Caddy may simply not be up yet: the periodic reconcile retries.
			d.log.Warn("could not apply proxy routes at startup", "err", err)
		}
	}
	return nil
}

// AppStatus is the configured state of an app next to its live state.
type AppStatus struct {
	Name  string `json:"name"`
	Image string `json:"image"`
	// Project and Environment are the labels of the app, as written in the apps file or filled in from the project file it is in (empty when not set).
	Project     string `json:"project"`
	Environment string `json:"environment"`
	// Digest is the registry digest ("sha256:...") of the image the serving container runs, empty when the app is not
	// running or the image has none. It is what promoting this version to another environment deploys.
	Digest string `json:"digest"`
	// EnvChangedAt is when the variables set through the API last changed, in any scope (RFC 3339), empty when
	// there are none: the dashboard compares it with the serving deployment to tell that a redeploy is due.
	EnvChangedAt string `json:"env_changed_at"`
	// Domains are the public hostnames the proxy routes to the app, omitted when it has none: the dashboard shows the
	// first as the address of the site.
	Domains []string `json:"domains,omitempty"`
	// BuildOnly marks a builder (build.only): it builds an image and runs nothing, so it is not an environment of a
	// project. Omitted when false.
	BuildOnly      bool              `json:"build_only,omitempty"`
	Container      *docker.Detail    `json:"container"`
	LastDeployment *store.Deployment `json:"last_deployment"`
}

// Apps reports every configured app.
func (d *Deployer) Apps(ctx context.Context) ([]AppStatus, error) {
	cfg := d.config()
	out := make([]AppStatus, 0, len(cfg.Apps))
	for _, a := range cfg.Apps {
		s := AppStatus{Name: a.Name, Image: a.Image, Project: a.Project, Environment: a.Stage, Domains: a.Domains, BuildOnly: a.BuildOnly()}
		if d.env != nil {
			s.EnvChangedAt = d.env.ChangedAt(a.Name)
		}
		det, err := d.liveContainer(ctx, a)
		switch {
		case err == nil:
			s.Container = det
			if det != nil {
				s.Digest = d.servingDigest(ctx, a, det)
			}
		case !docker.IsNotFound(err):
			return nil, err
		}
		last, err := d.store.ListDeployments(ctx, a.Name, 1)
		if err != nil {
			return nil, err
		}
		if len(last) > 0 {
			s.LastDeployment = &last[0]
		}
		out = append(out, s)
	}
	return out, nil
}

// Deployment returns one deployment.
func (d *Deployer) Deployment(ctx context.Context, id string) (store.Deployment, error) {
	return d.store.Deployment(ctx, id)
}

// Deployments lists recent deployments, newest first.
func (d *Deployer) Deployments(ctx context.Context, app string, limit int) ([]store.Deployment, error) {
	return d.store.ListDeployments(ctx, app, limit)
}

// Events returns a deployment's log lines after seq.
func (d *Deployer) Events(ctx context.Context, id string, after int64) ([]store.Event, error) {
	return d.store.Events(ctx, id, after)
}

// servingDigest is the digest of the app's repository that the container's image is known by. A failure is not worth failing
// the listing for: the digest is only used to promote, which then says it has none.
func (d *Deployer) servingDigest(ctx context.Context, a config.App, det *docker.Detail) string {
	if det.ImageID == "" {
		return ""
	}
	digests, err := d.eng.ImageRepoDigests(ctx, det.ImageID)
	if err != nil {
		return ""
	}
	for _, rd := range digests {
		if repo, digest, ok := strings.Cut(rd, "@"); ok && repo == a.Image {
			return digest
		}
	}
	return ""
}
