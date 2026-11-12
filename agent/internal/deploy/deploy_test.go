package deploy

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/0x2u/keelson/agent/internal/config"
	"github.com/0x2u/keelson/agent/internal/docker"
	"github.com/0x2u/keelson/agent/internal/proxy"
	"github.com/0x2u/keelson/agent/internal/store"
)

const repo = "ghcr.io/o/web"

type fakeCtr struct {
	image    string
	running  bool
	health   string
	exitCode int
	labels   map[string]string
	ports    []docker.Port
	env      []string
	network  string
	spec     docker.ContainerSpec
	outcome  relOutcome
}

func (f *fakeEngine) ListByLabel(_ context.Context, label string) ([]docker.Container, error) {
	k, v, hasValue := strings.Cut(label, "=")
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []docker.Container
	for name, c := range f.ctrs {
		have, ok := c.labels[k]
		if ok && (!hasValue || have == v) { // like the engine's filter: a bare key is a presence test
			state := "exited"
			if c.running {
				state = "running"
			}
			out = append(out, docker.Container{Name: name, Labels: c.labels, Image: c.image, State: state, Created: f.started[name].Unix()})
		}
	}
	return out, nil
}

// fakeEngine is an in-memory Docker engine. How a started container behaves
// is chosen by image: "crash" exits, "unhealthy" fails its healthcheck,
// "nohc" runs without a healthcheck, anything else becomes healthy.
type fakeEngine struct {
	mu       sync.Mutex
	ctrs     map[string]*fakeCtr
	ops      []string
	behavior map[string]string // image ref -> behavior
	pullErr  error
	pullGate chan struct{} // when set, Pull blocks until it is closed
	started  map[string]time.Time
	nextPort int
	// digests are the registry digests an image reference is known by.
	digests map[string][]string
	// release scripts release containers (those created with a Cmd for a step).
	release func(docker.ContainerSpec) relOutcome
	// images are the local images ListImages reports; removeErr scripts RemoveImage per reference; removedImages records it.
	images        []docker.Image
	removeErr     map[string]error
	removedImages []string
	// dangling are the untagged leaf images ListDanglingImages reports.
	dangling []docker.Image
	// missingImages are references that are not on the engine (a built image that was pruned).
	missingImages map[string]bool
	// volumesRemoved are the containers removed with their anonymous volumes (throwaway ones).
	volumesRemoved []string
	// output is what a container printed, by image reference; logsErr and logsHang script a engine that cannot or will not
	// give the logs; logTails records the Tail of each Logs call.
	output   map[string][]string
	logsErr  error
	logsHang bool
	logTails []string
	// stopTimeouts records the grace period of each Stop; rePort, when set, is the host port a container gets when it is
	// started again after it ran (the engine picks a new random one).
	stopTimeouts []int
	rePort       uint16
	// saved is what SaveImage streams, by reference; loaded records what LoadImage received; loadErr scripts it.
	saved   map[string][]byte
	loaded  [][]byte
	loadErr error
	// platform is what Info reports (linux/amd64 when nil); infoErr scripts its failure.
	platform *docker.EngineInfo
	infoErr  error
}

func newFakeEngine() *fakeEngine {
	return &fakeEngine{ctrs: map[string]*fakeCtr{}, behavior: map[string]string{}, started: map[string]time.Time{}}
}

func (f *fakeEngine) log(format string, a ...any) {
	f.ops = append(f.ops, fmt.Sprintf(format, a...))
}

func (f *fakeEngine) opsList() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.ops...)
}

func (f *fakeEngine) container(name string) *fakeCtr {
	f.mu.Lock()
	defer f.mu.Unlock()
	if c, ok := f.ctrs[name]; ok {
		cp := *c
		return &cp
	}
	return nil
}

func (f *fakeEngine) put(name, image string, running bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.ctrs[name] = &fakeCtr{image: image, running: running, health: "healthy"}
}

var notFound = &docker.Error{Status: 404, Message: "no such container"}

func (f *fakeEngine) Inspect(_ context.Context, name string) (*docker.Detail, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	c, ok := f.ctrs[name]
	if !ok {
		return nil, notFound
	}
	st := docker.State{Running: c.running, Health: c.health, ExitCode: c.exitCode}
	if c.running {
		t := f.started[name]
		if t.IsZero() {
			t = time.Now().Add(-time.Hour)
		}
		st.StartedAt = &t
	}
	return &docker.Detail{Name: name, Image: c.image, ImageID: "id:" + c.image, State: st, Ports: c.ports, Env: c.env}, nil
}

// ImageRepoDigests answers for the image id Inspect gives ("id:" + the reference the container was created from), and
// for a plain reference. A reference in missingImages is not on the engine: it answers 404 like the real one.
func (f *fakeEngine) ImageRepoDigests(_ context.Context, id string) ([]string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.missingImages[id] {
		return nil, &docker.Error{Status: 404, Message: "no such image"}
	}
	return f.digests[strings.TrimPrefix(id, "id:")], nil
}

func (f *fakeEngine) Pull(ctx context.Context, repo, ref, auth string, progress func(string)) error {
	f.mu.Lock()
	f.log("pull %s %s", repo, ref)
	gate, err := f.pullGate, f.pullErr
	f.mu.Unlock()
	if gate != nil {
		select {
		case <-gate:
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	if err == nil {
		progress("Status: Downloaded newer image")
	}
	return err
}

func (f *fakeEngine) Create(_ context.Context, s docker.ContainerSpec) (string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.log("create %s %s", s.Name, s.Image)
	if _, exists := f.ctrs[s.Name]; exists {
		return "", &docker.Error{Status: 409, Message: "name already in use"}
	}
	c := &fakeCtr{image: s.Image, labels: s.Labels, env: s.Env, network: s.NetworkMode, spec: s}
	for _, p := range s.Ports {
		cp, _ := strconv.Atoi(p.ContainerPort)
		f.nextPort++
		c.ports = append(c.ports, docker.Port{PrivatePort: uint16(cp), PublicPort: uint16(40000 + f.nextPort), Type: p.Proto})
	}
	f.ctrs[s.Name] = c
	return "id-" + s.Name, nil
}

func (f *fakeEngine) Start(_ context.Context, name string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.log("start %s", name)
	c, ok := f.ctrs[name]
	if !ok {
		return notFound
	}
	c.running = true
	c.health = "healthy"
	if _, ran := f.started[name]; ran && f.rePort != 0 {
		for i := range c.ports {
			c.ports[i].PublicPort = f.rePort
		}
	}
	f.started[name] = time.Now()
	if c.spec.Labels["keelson.release"] == "true" && f.release != nil {
		c.outcome = f.release(c.spec) // once per container, here, in the deploying goroutine
	}
	switch f.behavior[c.image] {
	case "crash":
		c.running, c.health, c.exitCode = false, "", 1
	case "unhealthy":
		c.health = "unhealthy"
	case "nohc":
		c.health = ""
	}
	return nil
}

func (f *fakeEngine) Stop(_ context.Context, name string, timeout int) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.log("stop %s", name)
	f.stopTimeouts = append(f.stopTimeouts, timeout)
	c, ok := f.ctrs[name]
	if !ok {
		return notFound
	}
	c.running = false
	return nil
}

func (f *fakeEngine) Rename(_ context.Context, name, to string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.log("rename %s %s", name, to)
	c, ok := f.ctrs[name]
	if !ok {
		return notFound
	}
	if _, taken := f.ctrs[to]; taken {
		return &docker.Error{Status: 409, Message: "name already in use"}
	}
	delete(f.ctrs, name)
	f.ctrs[to] = c
	return nil
}

// relOutcome scripts what a release container does when it runs.
type relOutcome struct {
	exit  int
	lines []string
	hang  bool // never exits on its own: only the context ends the wait
}

func (f *fakeEngine) Wait(ctx context.Context, name string) (int, error) {
	f.mu.Lock()
	c, ok := f.ctrs[name]
	f.log("wait %s", name)
	var out relOutcome
	if ok {
		out = c.outcome
	}
	f.mu.Unlock()
	if !ok {
		return 0, notFound
	}
	if out.hang {
		<-ctx.Done()
		return 0, ctx.Err()
	}
	return out.exit, nil
}

func (f *fakeEngine) Logs(ctx context.Context, name string, opt docker.LogOptions, fn func(docker.LogLine) error) error {
	f.mu.Lock()
	var lines []string
	c, ok := f.ctrs[name]
	if ok {
		lines = c.outcome.lines
		if lines == nil {
			lines = f.output[c.image]
		}
	}
	hang, lerr := f.logsHang, f.logsErr
	f.logTails = append(f.logTails, opt.Tail)
	f.mu.Unlock()
	if !ok {
		return notFound
	}
	if hang {
		<-ctx.Done()
		return ctx.Err()
	}
	if lerr != nil {
		return lerr
	}
	for _, l := range lines {
		if err := fn(docker.LogLine{Stream: "stdout", Line: l}); err != nil {
			return err
		}
	}
	return nil
}

func (f *fakeEngine) Remove(_ context.Context, name string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.log("remove %s", name)
	if _, ok := f.ctrs[name]; !ok {
		return notFound
	}
	delete(f.ctrs, name)
	return nil
}

// RemoveThrowaway removes a container together with its anonymous volumes: the fake records which containers went
// that way, to tell them from an app's, whose volumes stay.
func (f *fakeEngine) RemoveThrowaway(ctx context.Context, name string) error {
	err := f.Remove(ctx, name)
	f.mu.Lock()
	defer f.mu.Unlock()
	f.volumesRemoved = append(f.volumesRemoved, name)
	return err
}

type harness struct {
	t   *testing.T
	eng *fakeEngine
	st  *store.Store
	d   *Deployer
	app config.App
	px  *fakeProxy
}

// fakeProxy records the routes applied to it.
type fakeProxy struct {
	mu    sync.Mutex
	calls [][]proxy.Route
	err   error
	// onApply, if set, runs before each successful Apply, without the lock.
	onApply func([]proxy.Route)
}

func (p *fakeProxy) Apply(_ context.Context, routes []proxy.Route) error {
	p.mu.Lock()
	err, hook := p.err, p.onApply
	p.mu.Unlock()
	if err != nil {
		return err
	}
	if hook != nil {
		hook(routes)
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	p.calls = append(p.calls, append([]proxy.Route(nil), routes...))
	return nil
}

// label marks a container as belonging to app, like a real deployment does.
func (f *fakeEngine) label(name, app string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.ctrs[name].labels = map[string]string{"keelson.app": app}
}

// snapshot returns the names of all containers.
func (f *fakeEngine) snapshot() map[string]bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := map[string]bool{}
	for name := range f.ctrs {
		out[name] = true
	}
	return out
}

func (p *fakeProxy) last() []proxy.Route {
	p.mu.Lock()
	defer p.mu.Unlock()
	if len(p.calls) == 0 {
		return nil
	}
	return p.calls[len(p.calls)-1]
}

func (p *fakeProxy) count() int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return len(p.calls)
}

func newHarness(t *testing.T, mutate ...func(*config.App)) *harness {
	t.Helper()
	st, err := store.Open(filepath.Join(t.TempDir(), "agent.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	app := config.App{
		Name: "web", Image: repo, StopTimeout: config.D(time.Second),
		HealthTimeout: config.D(500 * time.Millisecond), StableAfter: config.D(20 * time.Millisecond),
	}
	for _, m := range mutate {
		m(&app)
	}
	eng := newFakeEngine()
	px := &fakeProxy{}
	d := New(eng, st, &config.Config{Apps: []config.App{app}, Proxy: &config.Proxy{}}, px, slog.New(slog.NewTextHandler(io.Discard, nil)))
	d.PollEvery = 5 * time.Millisecond
	return &harness{t: t, eng: eng, st: st, d: d, app: app, px: px}
}

// deploy runs a deployment to completion and returns its record.
func (h *harness) deploy(tag string) store.Deployment {
	h.t.Helper()
	id, done, err := h.d.Start(context.Background(), "web", Target{Tag: tag}, "api")
	if err != nil {
		h.t.Fatalf("Start(%s): %v", tag, err)
	}
	<-done
	dep, err := h.st.Deployment(context.Background(), id)
	if err != nil {
		h.t.Fatal(err)
	}
	return dep
}

func (h *harness) mustImage(name, want string) {
	h.t.Helper()
	c := h.eng.container(name)
	if c == nil || c.image != want || !c.running {
		h.t.Fatalf("container %s: want %s running, got %+v", name, want, c)
	}
}

func TestFirstDeployCreatesAndStartsWithoutStopping(t *testing.T) {
	h := newHarness(t)
	dep := h.deploy("v1")
	if dep.Status != store.StatusSucceeded {
		t.Fatalf("status %s: %s", dep.Status, dep.Error)
	}
	h.mustImage("web", repo+":v1")
	for _, op := range h.eng.opsList() {
		if strings.HasPrefix(op, "stop") || strings.HasPrefix(op, "rename") {
			t.Errorf("first deploy must not stop or rename, got %q", op)
		}
	}
}

func TestDeployReplacesRunningContainerAndCleansUp(t *testing.T) {
	h := newHarness(t)
	h.deploy("v1")
	dep := h.deploy("v2")

	if dep.Status != store.StatusSucceeded || dep.PreviousRef != repo+":v1" {
		t.Fatalf("unexpected deployment: %+v", dep)
	}
	h.mustImage("web", repo+":v2")
	if h.eng.container("web.prev") != nil {
		t.Error("previous container must be removed after success")
	}
	events, _ := h.st.Events(context.Background(), dep.ID, 0)
	if len(events) < 4 {
		t.Errorf("expected a progress log, got %d events", len(events))
	}
}

func TestUnhealthyDeployRestoresPreviousVersion(t *testing.T) {
	h := newHarness(t)
	h.deploy("v1")
	h.eng.behavior[repo+":v2"] = "unhealthy"

	dep := h.deploy("v2")
	if dep.Status != store.StatusRolledBack || !strings.Contains(dep.Error, "unhealthy") {
		t.Fatalf("want rolled_back with an unhealthy error, got %s: %q", dep.Status, dep.Error)
	}
	h.mustImage("web", repo+":v1")
	if h.eng.container("web.prev") != nil {
		t.Error("restored container must no longer be named .prev")
	}
}

func TestCrashingNewVersionRestoresPrevious(t *testing.T) {
	h := newHarness(t)
	h.deploy("v1")
	h.eng.behavior[repo+":v2"] = "crash"

	dep := h.deploy("v2")
	if dep.Status != store.StatusRolledBack || !strings.Contains(dep.Error, "exited with code 1") {
		t.Fatalf("got %s: %q", dep.Status, dep.Error)
	}
	h.mustImage("web", repo+":v1")
}

func TestFailedFirstDeployLeavesNothingBehind(t *testing.T) {
	h := newHarness(t)
	h.eng.behavior[repo+":v1"] = "crash"
	dep := h.deploy("v1")
	if dep.Status != store.StatusFailed {
		t.Fatalf("got %s", dep.Status)
	}
	if h.eng.container("web") != nil {
		t.Error("the failed container must be removed")
	}
}

func TestRollbackFailureIsReported(t *testing.T) {
	h := newHarness(t)
	h.deploy("v1")
	h.eng.behavior[repo+":v2"] = "crash"
	h.eng.behavior[repo+":v1"] = "crash" // the restored version fails too

	dep := h.deploy("v2")
	if dep.Status != store.StatusRollbackFailed {
		t.Fatalf("got %s: %s", dep.Status, dep.Error)
	}
}

func TestPullFailureLeavesRunningContainerUntouched(t *testing.T) {
	h := newHarness(t)
	h.deploy("v1")
	h.eng.mu.Lock()
	h.eng.pullErr = errors.New("manifest unknown")
	h.eng.ops = nil
	h.eng.mu.Unlock()

	dep := h.deploy("nope")
	if dep.Status != store.StatusFailed || !strings.Contains(dep.Error, "manifest unknown") {
		t.Fatalf("got %s: %q", dep.Status, dep.Error)
	}
	h.mustImage("web", repo+":v1")
	for _, op := range h.eng.opsList() {
		if strings.HasPrefix(op, "stop") || strings.HasPrefix(op, "remove") {
			t.Errorf("a failed pull must not touch containers, got %q", op)
		}
	}
}

func TestMissingEnvFileFailsBeforeAnythingHappens(t *testing.T) {
	h := newHarness(t, func(a *config.App) { a.EnvFile = filepath.Join(t.TempDir(), "absent.env") })
	h.eng.put("web", repo+":v1", true)

	dep := h.deploy("v2")
	if dep.Status != store.StatusFailed || !strings.Contains(dep.Error, "environment") {
		t.Fatalf("got %s: %q", dep.Status, dep.Error)
	}
	if ops := h.eng.opsList(); len(ops) != 0 {
		t.Errorf("no engine call expected, got %v", ops)
	}
	h.mustImage("web", repo+":v1")
}

func TestHealthWithoutHealthcheckNeedsStableRunning(t *testing.T) {
	h := newHarness(t)
	h.eng.behavior[repo+":v1"] = "nohc"
	start := time.Now()
	dep := h.deploy("v1")
	if dep.Status != store.StatusSucceeded {
		t.Fatalf("got %s: %s", dep.Status, dep.Error)
	}
	if time.Since(start) < h.app.StableWait() {
		t.Errorf("must wait StableAfter (%s) before declaring success", h.app.StableWait())
	}
}

func TestHealthTimeoutTriggersRollback(t *testing.T) {
	h := newHarness(t, func(a *config.App) {
		a.HealthTimeout = config.D(60 * time.Millisecond)
		a.StableAfter = config.D(time.Hour)
	})
	h.deploy("v1") // v1 has a healthcheck: succeeds at once
	h.eng.behavior[repo+":v2"] = "nohc"

	dep := h.deploy("v2")
	if dep.Status != store.StatusRolledBack || !strings.Contains(dep.Error, "not healthy after") {
		t.Fatalf("got %s: %q", dep.Status, dep.Error)
	}
}

func TestStaleRollbackContainerIsRemoved(t *testing.T) {
	h := newHarness(t)
	h.eng.put("web", repo+":v1", true)
	h.eng.put("web.prev", repo+":v0", false)

	dep := h.deploy("v2")
	if dep.Status != store.StatusSucceeded {
		t.Fatalf("got %s: %s", dep.Status, dep.Error)
	}
	h.mustImage("web", repo+":v2")
}

func TestOnlyOneDeploymentPerApp(t *testing.T) {
	h := newHarness(t)
	h.eng.pullGate = make(chan struct{})
	id, done, err := h.d.Start(context.Background(), "web", Target{Tag: "v1"}, "api")
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := h.d.Start(context.Background(), "web", Target{Tag: "v2"}, "api"); !errors.Is(err, ErrBusy) {
		t.Errorf("want ErrBusy while a deployment runs, got %v", err)
	}
	if h.d.Wait(20 * time.Millisecond) {
		t.Error("Wait must report a deployment still in flight")
	}
	close(h.eng.pullGate)
	<-done
	if _, _, err := h.d.Start(context.Background(), "web", Target{Tag: "v2"}, "api"); err != nil {
		t.Errorf("the app must be free again, got %v", err)
	}
	dep, _ := h.st.Deployment(context.Background(), id)
	if dep.Status != store.StatusSucceeded {
		t.Errorf("first deployment: %s", dep.Status)
	}
	h.d.Wait(time.Second)
}

func TestTargetsAreValidated(t *testing.T) {
	h := newHarness(t)
	digest := "sha256:" + strings.Repeat("a", 64)
	bad := []Target{
		{},
		{Tag: "v1", Digest: digest},
		{Tag: "../evil"},
		{Tag: "evil/image:v1"},
		{Tag: "v1@sha256:abc"},
		{Tag: "-v1"},
		{Tag: strings.Repeat("a", 129)},
		{Digest: "sha256:short"},
		{Digest: strings.ToUpper(digest)},
	}
	for _, tgt := range bad {
		if _, _, err := h.d.Start(context.Background(), "web", tgt, "api"); !errors.Is(err, ErrInvalidTarget) {
			t.Errorf("%+v: want ErrInvalidTarget, got %v", tgt, err)
		}
	}
	if ops := h.eng.opsList(); len(ops) != 0 {
		t.Errorf("invalid targets must not reach the engine: %v", ops)
	}
	if _, _, err := h.d.Start(context.Background(), "ghost", Target{Tag: "v1"}, "api"); !errors.Is(err, ErrUnknownApp) {
		t.Errorf("want ErrUnknownApp, got %v", err)
	}
}

func TestTargetCannotChangeRepository(t *testing.T) {
	ref, err := Target{Tag: "v1"}.Ref(repo)
	if err != nil || ref != repo+":v1" {
		t.Fatalf("got %q, %v", ref, err)
	}
	digest := "sha256:" + strings.Repeat("b", 64)
	ref, err = Target{Digest: digest}.Ref(repo)
	if err != nil || ref != repo+"@"+digest {
		t.Fatalf("got %q, %v", ref, err)
	}
}

func TestDigestDeployPullsByDigest(t *testing.T) {
	h := newHarness(t)
	digest := "sha256:" + strings.Repeat("c", 64)
	id, done, err := h.d.Start(context.Background(), "web", Target{Digest: digest}, "api")
	if err != nil {
		t.Fatal(err)
	}
	<-done
	dep, _ := h.st.Deployment(context.Background(), id)
	if dep.Status != store.StatusSucceeded {
		t.Fatalf("got %s: %s", dep.Status, dep.Error)
	}
	if ops := h.eng.opsList(); ops[0] != "pull "+repo+" "+digest {
		t.Errorf("unexpected pull: %v", ops[0])
	}
	h.mustImage("web", repo+"@"+digest)
}

func TestRollbackRedeploysPreviousSuccessfulImage(t *testing.T) {
	h := newHarness(t)
	if _, _, err := h.d.Rollback(context.Background(), "web"); !errors.Is(err, ErrNoRollbackTarget) {
		t.Fatalf("no history: want ErrNoRollbackTarget, got %v", err)
	}
	h.deploy("v1")
	if _, _, err := h.d.Rollback(context.Background(), "web"); !errors.Is(err, ErrNoRollbackTarget) {
		t.Fatalf("only the running image in history: want ErrNoRollbackTarget, got %v", err)
	}
	h.deploy("v2")

	id, done, err := h.d.Rollback(context.Background(), "web")
	if err != nil {
		t.Fatal(err)
	}
	<-done
	dep, _ := h.st.Deployment(context.Background(), id)
	if dep.Status != store.StatusSucceeded || dep.Trigger != "rollback" || dep.Ref != repo+":v1" {
		t.Fatalf("unexpected rollback: %+v", dep)
	}
	h.mustImage("web", repo+":v1")
}

func TestRollbackSkipsFailedDeployments(t *testing.T) {
	h := newHarness(t)
	h.deploy("v1")
	h.deploy("v2")
	h.eng.behavior[repo+":v3"] = "unhealthy"
	if dep := h.deploy("v3"); dep.Status != store.StatusRolledBack {
		t.Fatalf("setup: %s", dep.Status)
	}
	// v2 is running; v3 failed. The rollback target must be v1, not v3.
	id, done, err := h.d.Rollback(context.Background(), "web")
	if err != nil {
		t.Fatal(err)
	}
	<-done
	if dep, _ := h.st.Deployment(context.Background(), id); dep.Ref != repo+":v1" {
		t.Errorf("rolled back to %s, want v1", dep.Ref)
	}
}

func TestRecoverRestoresPreviousAfterInterruptedSwap(t *testing.T) {
	h := newHarness(t)
	// State left by a crash mid-swap: unverified new container + stopped previous.
	h.eng.put("web", repo+":v2", false)
	h.eng.put("web.prev", repo+":v1", false)
	crashed := store.Deployment{ID: "dead", App: "web", Ref: repo + ":v2", Trigger: "api", StartedAt: time.Now()}
	if err := h.st.CreateDeployment(context.Background(), crashed); err != nil {
		t.Fatal(err)
	}

	if err := h.d.Recover(context.Background()); err != nil {
		t.Fatal(err)
	}
	h.mustImage("web", repo+":v1")
	if h.eng.container("web.prev") != nil {
		t.Error("previous container must be renamed back")
	}
	dep, _ := h.st.Deployment(context.Background(), "dead")
	if dep.Status != store.StatusRolledBack {
		t.Errorf("got %s", dep.Status)
	}
}

func TestRecoverWithoutSwapOnlyMarksDeploymentInterrupted(t *testing.T) {
	h := newHarness(t)
	h.eng.put("web", repo+":v1", true)
	crashed := store.Deployment{ID: "dead", App: "web", Ref: repo + ":v2", Trigger: "api", StartedAt: time.Now()}
	if err := h.st.CreateDeployment(context.Background(), crashed); err != nil {
		t.Fatal(err)
	}

	if err := h.d.Recover(context.Background()); err != nil {
		t.Fatal(err)
	}
	h.mustImage("web", repo+":v1")
	dep, _ := h.st.Deployment(context.Background(), "dead")
	if dep.Status != store.StatusFailed || !strings.Contains(dep.Error, "interrupted") {
		t.Errorf("got %s: %q", dep.Status, dep.Error)
	}
}

func TestRegistryAuthIsReadFromFileAtPullTime(t *testing.T) {
	h := newHarness(t)
	pw := filepath.Join(t.TempDir(), "pw")
	os.WriteFile(pw, []byte("secret\n"), 0o600)
	h.d.config().Registries = []config.Registry{{Host: "ghcr.io", Username: "bot", PasswordFile: pw}}

	got, err := h.d.registryAuth(repo)
	if err != nil || got != docker.RegistryAuth("ghcr.io", "bot", "secret") {
		t.Errorf("got %q, %v", got, err)
	}
	if got, _ := h.d.registryAuth("docker.io/library/nginx"); got != "" {
		t.Error("no credentials must be sent to other registries")
	}
	os.Remove(pw)
	if _, err := h.d.registryAuth(repo); err == nil {
		t.Error("a missing password file must fail the deployment")
	}
}

// ptr points at a copy of v.
func ptr[T any](v T) *T { return &v }
