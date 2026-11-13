package deploy

import (
	"bytes"
	"context"
	"errors"
	"log/slog"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/0x2u/keelson/agent/internal/build"
	"github.com/0x2u/keelson/agent/internal/config"
	"github.com/0x2u/keelson/agent/internal/docker"
	"github.com/0x2u/keelson/agent/internal/store"
)

const buildToken = "ghs_SecretInstallationToken"

// fakeBuilder stands for package build: one slot, validation, and a scripted build.
type fakeBuilder struct {
	mu          sync.Mutex
	busy        bool
	reqs        []build.Request
	validateErr error
	err         error
	// sourceErr fails the build before the image build starts: the download of the source did not work.
	sourceErr error
	lines     []string
	// gate, when set, makes Build wait until it is closed (or the context ends).
	gate    chan struct{}
	started chan struct{}
	// onBuild, when set, runs during the build: what a real build leaves on the engine.
	onBuild func()
}

func newFakeBuilder() *fakeBuilder { return &fakeBuilder{started: make(chan struct{}, 8)} }

func (b *fakeBuilder) TryAcquire() (func(), bool) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.busy {
		return nil, false
	}
	b.busy = true
	var once sync.Once
	return func() {
		once.Do(func() {
			b.mu.Lock()
			b.busy = false
			b.mu.Unlock()
		})
	}, true
}

func (b *fakeBuilder) Validate(build.Request) error { return b.validateErr }

func (b *fakeBuilder) Build(ctx context.Context, req build.Request, emit build.Emit) (string, error) {
	b.mu.Lock()
	b.reqs = append(b.reqs, req)
	gate, lines, err, sourceErr := b.gate, b.lines, b.err, b.sourceErr
	b.mu.Unlock()
	b.started <- struct{}{}
	emit("info", "downloading source from "+req.Source.Host())
	if sourceErr != nil {
		return "", sourceErr
	}
	emit("info", build.BuildingLine(req.Ref()))
	if b.onBuild != nil {
		b.onBuild()
	}
	for _, l := range lines {
		emit("info", l)
	}
	if gate != nil {
		select {
		case <-gate:
		case <-ctx.Done():
			return "", errors.New("build canceled")
		}
	}
	if err != nil {
		return "", err
	}
	emit("info", "built "+req.Ref())
	return req.Ref(), nil
}

func (b *fakeBuilder) requests() []build.Request {
	b.mu.Lock()
	defer b.mu.Unlock()
	return append([]build.Request(nil), b.reqs...)
}

func testBuildConfig() *config.Build {
	return &config.Build{
		Dockerfile: "Dockerfile", Context: ".", Target: "runner", Args: map[string]string{"A": "b"},
		Timeout: config.D(time.Minute), Memory: sz("2g"), CPUs: ptr(2.0), MaxSource: sz("512m"), SourceHosts: []string{"api.github.com"},
	}
}

func testSource() build.Source {
	return build.Source{URL: "https://api.github.com/repos/o/r/tarball/" + sha(1), Token: buildToken}
}

// syncBuffer is a log destination that tests can read while deployments write to it.
type syncBuffer struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (s *syncBuffer) Write(p []byte) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.Write(p)
}

func (s *syncBuffer) String() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.String()
}

type buildHarness struct {
	*harness
	b    *fakeBuilder
	logs *syncBuffer
}

// newBuildHarness is a harness whose app "web" (and a second app "api") can be built.
func newBuildHarness(t *testing.T) *buildHarness {
	t.Helper()
	h := newHarness(t, func(a *config.App) { a.Build = testBuildConfig() })
	other := h.app
	other.Name, other.Image = "api", "ghcr.io/o/api"
	nobuild := h.app
	nobuild.Name, nobuild.Build = "static", nil
	h.d.cfg.Store(&config.Config{Apps: []config.App{h.app, other, nobuild}, Proxy: &config.Proxy{}})
	logs := &syncBuffer{}
	h.d.log = slog.New(slog.NewTextHandler(logs, &slog.HandlerOptions{Level: slog.LevelDebug}))
	b := newFakeBuilder()
	h.d.SetBuilder(b)
	return &buildHarness{harness: h, b: b, logs: logs}
}

func (h *buildHarness) startBuild(app string, n int) (store.Deployment, error) {
	h.t.Helper()
	src := testSource()
	id, done, err := h.d.StartBuild(context.Background(), app, sha(n), src, nil)
	if err != nil {
		return store.Deployment{}, err
	}
	<-done
	dep, err := h.st.Deployment(context.Background(), id)
	if err != nil {
		h.t.Fatal(err)
	}
	return dep, nil
}

func (h *buildHarness) events(id string) []string {
	h.t.Helper()
	evs, err := h.st.Events(context.Background(), id, 0)
	if err != nil {
		h.t.Fatal(err)
	}
	out := make([]string, len(evs))
	for i, e := range evs {
		out[i] = e.Message
	}
	return out
}

func (h *buildHarness) pulls() []string {
	var out []string
	for _, op := range h.eng.opsList() {
		if strings.HasPrefix(op, "pull ") {
			out = append(out, op)
		}
	}
	return out
}

// noTokenAnywhere fails when the token is in what the agent records or logs for a deployment.
func (h *buildHarness) noTokenAnywhere(deps ...store.Deployment) {
	h.t.Helper()
	if strings.Contains(h.logs.String(), buildToken) {
		h.t.Errorf("the token is in the agent's log:\n%s", h.logs.String())
	}
	for _, dep := range deps {
		if strings.Contains(dep.Error, buildToken) || strings.Contains(dep.Ref, buildToken) {
			h.t.Errorf("the token is in the deployment record: %+v", dep)
		}
		for _, e := range h.events(dep.ID) {
			if strings.Contains(e, buildToken) {
				h.t.Errorf("the token is in an event: %s", e)
			}
		}
	}
	list, err := h.st.ListDeployments(context.Background(), "", 100)
	if err != nil {
		h.t.Fatal(err)
	}
	for _, dep := range list {
		if strings.Contains(dep.Error, buildToken) {
			h.t.Errorf("the token is in a deployment error: %s", dep.Error)
		}
	}
	audits, _ := h.st.Audit(context.Background(), 100, 0)
	for _, a := range audits {
		if strings.Contains(a.Detail+a.Path+a.Actor, buildToken) {
			h.t.Errorf("the token is in an audit entry: %+v", a)
		}
	}
}

func TestBuildThenDeployInOneDeploymentWithoutPulling(t *testing.T) {
	h := newBuildHarness(t)
	h.b.lines = []string{"Step 1/3 : FROM scratch", "Successfully built abc"}

	dep, err := h.startBuild("web", 1)
	if err != nil {
		t.Fatal(err)
	}
	ref := repo + ":" + sha(1)
	if dep.Status != store.StatusSucceeded || dep.Trigger != "build" || dep.Ref != ref {
		t.Fatalf("%+v", dep)
	}
	h.mustImage("web", ref)
	if p := h.pulls(); len(p) != 0 {
		t.Errorf("an image built here must not be pulled: %v", p)
	}

	// One deployment log covers both phases, in order.
	events := strings.Join(h.events(dep.ID), "\n")
	var last int
	for _, want := range []string{
		"downloading source from api.github.com", "building " + ref, "Step 1/3 : FROM scratch", "Successfully built abc", "built " + ref,
		"deploying " + ref + " to web", "from this server (not pulled)", "waiting for web to become healthy", "web is healthy", "deployment succeeded",
	} {
		i := strings.Index(events[last:], want)
		if i < 0 {
			t.Fatalf("missing or out of order: %q in\n%s", want, events)
		}
		last += i + len(want)
	}
	if strings.Contains(events, "pulling") {
		t.Errorf("no pull step is logged:\n%s", events)
	}

	// The builder got exactly what the app's file says, and the request's source.
	reqs := h.b.requests()
	if len(reqs) != 1 || reqs[0].Image != repo || reqs[0].SHA != sha(1) || reqs[0].Config.Target != "runner" || reqs[0].Source.Token != buildToken {
		t.Fatalf("%+v", reqs)
	}
	h.noTokenAnywhere(dep)

	// The slot is free again.
	if _, err := h.startBuild("api", 2); err != nil {
		t.Errorf("the build slot must be released: %v", err)
	}
}

func TestBuildReplacesTheRunningVersionThroughTheUsualSwap(t *testing.T) {
	h := newBuildHarness(t)
	h.deploy("v1") // pulled, CI-built
	dep, err := h.startBuild("web", 1)
	if err != nil || dep.Status != store.StatusSucceeded {
		t.Fatalf("%v %+v", err, dep)
	}
	if dep.PreviousRef != repo+":v1" {
		t.Errorf("previous ref: %q", dep.PreviousRef)
	}
	h.mustImage("web", repo+":"+sha(1))
	if h.eng.container("web.prev") != nil {
		t.Error("the previous container must be removed after success")
	}
}

func TestAFailedBuildDeploysNothingAndLeavesTheServingVersionAlone(t *testing.T) {
	h := newBuildHarness(t)
	h.deploy("v1")
	h.eng.mu.Lock()
	h.eng.ops = nil
	h.eng.mu.Unlock()
	h.b.lines = []string{"Step 2/2 : RUN false"}
	h.b.err = errors.New("build failed: the command 'false' returned a non-zero code: 1 " + buildToken)

	dep, err := h.startBuild("web", 2)
	if err != nil {
		t.Fatal(err)
	}
	if dep.Status != store.StatusFailed || !strings.Contains(dep.Error, "build failed: the command 'false' returned a non-zero code: 1") || dep.FinishedAt == nil {
		t.Fatalf("%+v", dep)
	}
	for _, op := range h.eng.opsList() {
		t.Errorf("a failed build must not touch the engine, got %q", op)
	}
	h.mustImage("web", repo+":v1")
	evs := strings.Join(h.events(dep.ID), "\n")
	if !strings.Contains(evs, "RUN false") || !strings.Contains(evs, "deployment failed") || strings.Contains(evs, "deploying") {
		t.Errorf("events:\n%s", evs)
	}

	// The failure is on record, rollback still targets the version that served, and a new build can start.
	if _, err := h.startBuild("web", 3); err != nil {
		t.Errorf("the slot must be free after a failure: %v", err)
	}
}

func TestOnlyOneBuildRunsAtATimeAndAppsAreLockedToo(t *testing.T) {
	h := newBuildHarness(t)
	h.b.gate = make(chan struct{})

	id1, done1, err := h.d.StartBuild(context.Background(), "web", sha(1), testSource(), nil)
	if err != nil {
		t.Fatal(err)
	}
	<-h.b.started
	if _, _, err := h.d.StartBuild(context.Background(), "web", sha(2), testSource(), nil); !errors.Is(err, ErrBusy) {
		t.Errorf("the same app: want ErrBusy, got %v", err)
	}
	if _, _, err := h.d.StartBuild(context.Background(), "api", sha(2), testSource(), nil); !errors.Is(err, ErrBuildBusy) {
		t.Errorf("another app while a build runs: want ErrBuildBusy, got %v", err)
	}
	// A refused request leaves nothing behind.
	list, _ := h.st.ListDeployments(context.Background(), "api", 10)
	if len(list) != 0 {
		t.Errorf("a refused build recorded a deployment: %+v", list)
	}
	// Ordinary deployments of other apps are not held up by a build.
	if _, done, err := h.d.Start(context.Background(), "api", Target{Tag: "v1"}, "api"); err != nil {
		t.Errorf("a deployment of another app must not wait for the build: %v", err)
	} else {
		<-done
	}

	close(h.b.gate)
	<-done1
	if dep, _ := h.st.Deployment(context.Background(), id1); dep.Status != store.StatusSucceeded {
		t.Errorf("%+v", dep)
	}
	if _, err := h.startBuild("api", 3); err != nil {
		t.Errorf("after the build the slot is free: %v", err)
	}
}

func TestBuildRequestsAreRefusedBeforeAnythingIsRecorded(t *testing.T) {
	h := newBuildHarness(t)
	ctx := context.Background()
	if _, _, err := h.d.StartBuild(ctx, "nope", sha(1), testSource(), nil); !errors.Is(err, ErrUnknownApp) {
		t.Errorf("unknown app: %v", err)
	}
	if _, _, err := h.d.StartBuild(ctx, "static", sha(1), testSource(), nil); !errors.Is(err, ErrNoBuild) {
		t.Errorf("app without a build block: %v", err)
	}
	h.b.validateErr = build.ErrSourceHost
	if _, _, err := h.d.StartBuild(ctx, "web", sha(1), testSource(), nil); !errors.Is(err, build.ErrSourceHost) {
		t.Errorf("validation: %v", err)
	}
	h.b.validateErr = nil
	if list, _ := h.st.ListDeployments(ctx, "", 10); len(list) != 0 {
		t.Errorf("refused requests recorded deployments: %+v", list)
	}
	// A refusal must not have held the app or the slot.
	if dep, err := h.startBuild("web", 1); err != nil || dep.Status != store.StatusSucceeded {
		t.Errorf("%v %+v", err, dep)
	}

	// An agent that cannot build says the same as an app that has no block.
	h2 := newHarness(t, func(a *config.App) { a.Build = testBuildConfig() })
	if _, _, err := h2.d.StartBuild(ctx, "web", sha(1), testSource(), nil); !errors.Is(err, ErrNoBuild) {
		t.Errorf("no builder: %v", err)
	}
}

func TestShutdownRefusesAndCancelsBuilds(t *testing.T) {
	h := newBuildHarness(t)
	h.b.gate = make(chan struct{}) // never closed: only the shutdown ends it
	id, done, err := h.d.StartBuild(context.Background(), "web", sha(1), testSource(), nil)
	if err != nil {
		t.Fatal(err)
	}
	<-h.b.started
	h.d.BeginShutdown()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("a build must be canceled when the agent shuts down")
	}
	if dep, _ := h.st.Deployment(context.Background(), id); dep.Status != store.StatusFailed || !strings.Contains(dep.Error, "canceled") {
		t.Errorf("%+v", dep)
	}
	if _, _, err := h.d.StartBuild(context.Background(), "web", sha(2), testSource(), nil); !errors.Is(err, ErrShuttingDown) {
		t.Errorf("got %v", err)
	}
}

func TestRollbackToABuiltImageDoesNotPull(t *testing.T) {
	h := newBuildHarness(t)
	if dep, err := h.startBuild("web", 1); err != nil || dep.Status != store.StatusSucceeded {
		t.Fatalf("%v %+v", err, dep)
	}
	if dep, err := h.startBuild("web", 2); err != nil || dep.Status != store.StatusSucceeded {
		t.Fatalf("%v %+v", err, dep)
	}

	id, done, err := h.d.Rollback(context.Background(), "web")
	if err != nil {
		t.Fatal(err)
	}
	<-done
	dep, _ := h.st.Deployment(context.Background(), id)
	if dep.Status != store.StatusSucceeded || dep.Ref != repo+":"+sha(1) || dep.Trigger != "rollback" {
		t.Fatalf("%+v", dep)
	}
	h.mustImage("web", repo+":"+sha(1))
	if p := h.pulls(); len(p) != 0 {
		t.Errorf("a rollback to an image built here must not pull: %v", p)
	}
	h.noTokenAnywhere(dep)
}

// A tag the server built is deployed from the server, whatever asks for it (the deploy API, the dashboard's dialog):
// a registry has never seen it, so pulling it would fail and leave the operator unable to go back to an older build.
func TestDeployingATagBuiltHereDoesNotPull(t *testing.T) {
	h := newBuildHarness(t)
	for i := 1; i <= 2; i++ {
		if dep, err := h.startBuild("web", i); err != nil || dep.Status != store.StatusSucceeded {
			t.Fatalf("%v %+v", err, dep)
		}
	}

	id, done, err := h.d.Start(context.Background(), "web", Target{Tag: sha(1)}, "api")
	if err != nil {
		t.Fatal(err)
	}
	<-done
	dep, _ := h.st.Deployment(context.Background(), id)
	if dep.Status != store.StatusSucceeded || dep.Ref != repo+":"+sha(1) || dep.Trigger != "api" {
		t.Fatalf("%+v", dep)
	}
	h.mustImage("web", repo+":"+sha(1))
	if p := h.pulls(); len(p) != 0 {
		t.Errorf("a tag built here must not be pulled: %v", p)
	}
}

// A rollback that lands on a built image is recorded as a "rollback", and the next rollback may pick that record: the
// image still came from a build, so it must not be pulled, and when it is gone the explanation must stay the clear one.
func TestRollbackOfARollbackToABuiltImageDoesNotPullAndExplainsWhenGone(t *testing.T) {
	h := newBuildHarness(t)
	h.startBuild("web", 1)
	h.startBuild("web", 2)
	for i, want := range []string{sha(1), sha(2), sha(1)} {
		id, done, err := h.d.Rollback(context.Background(), "web")
		if err != nil {
			t.Fatal(err)
		}
		<-done
		dep, _ := h.st.Deployment(context.Background(), id)
		if dep.Status != store.StatusSucceeded || dep.Ref != repo+":"+want {
			t.Fatalf("rollback %d: %+v", i, dep)
		}
	}
	if p := h.pulls(); len(p) != 0 {
		t.Fatalf("rollbacks between images built here must not pull: %v", p)
	}

	h.eng.missingImages = map[string]bool{repo + ":" + sha(2): true}
	id, done, err := h.d.Rollback(context.Background(), "web")
	if err != nil {
		t.Fatal(err)
	}
	<-done
	dep, _ := h.st.Deployment(context.Background(), id)
	if dep.Status != store.StatusFailed || !strings.Contains(dep.Error, "built on this server and is not here any more") {
		t.Fatalf("%+v", dep)
	}
	if p := h.pulls(); len(p) != 0 {
		t.Errorf("a missing built image must not be pulled: %v", p)
	}
	h.mustImage("web", repo+":"+sha(1))
}

func TestRollbackToABuiltImageThatIsGoneFailsClearlyAndKeepsServing(t *testing.T) {
	h := newBuildHarness(t)
	h.startBuild("web", 1)
	h.startBuild("web", 2)
	h.eng.missingImages = map[string]bool{repo + ":" + sha(1): true}

	id, done, err := h.d.Rollback(context.Background(), "web")
	if err != nil {
		t.Fatal(err)
	}
	<-done
	dep, _ := h.st.Deployment(context.Background(), id)
	if dep.Status != store.StatusFailed || !strings.Contains(dep.Error, "built on this server and is not here any more") {
		t.Fatalf("%+v", dep)
	}
	h.mustImage("web", repo+":"+sha(2))
}

func TestRollbackToAPulledImageStillPulls(t *testing.T) {
	h := newBuildHarness(t)
	// v1 was pulled in the days before the app had a build block (an app with one refuses to pull a tag it did not build).
	cfg := *h.d.config()
	withBuild := cfg.Apps[0]
	cfg.Apps = append([]config.App{withBuild}, cfg.Apps[1:]...)
	cfg.Apps[0].Build = nil
	h.d.cfg.Store(&cfg)
	h.deploy("v1")
	cfg.Apps = append([]config.App{withBuild}, cfg.Apps[1:]...)
	h.d.cfg.Store(&cfg)
	h.startBuild("web", 2)
	id, done, err := h.d.Rollback(context.Background(), "web")
	if err != nil {
		t.Fatal(err)
	}
	<-done
	dep, _ := h.st.Deployment(context.Background(), id)
	if dep.Status != store.StatusSucceeded || dep.Ref != repo+":v1" {
		t.Fatalf("%+v", dep)
	}
	if p := h.pulls(); len(p) != 2 { // the first deployment and the rollback
		t.Errorf("a registry image is pulled as before: %v", p)
	}
}

// buildPreviewHarness is the preview harness with a build block on the parent.
func newBuildPreviewHarness(t *testing.T, previews string) (*previewHarness, *fakeBuilder, *syncBuffer) {
	t.Helper()
	h := newPreviewHarness(t, previews)
	doc := strings.Replace(previewConfig(h.envFile, previews), "    port: 3000\n", "    port: 3000\n    build: {args: {NODE_ENV: production}}\n", 1)
	h.d.cfg.Store(parseConfig(t, doc))
	logs := &syncBuffer{}
	h.d.log = slog.New(slog.NewTextHandler(logs, &slog.HandlerOptions{Level: slog.LevelDebug}))
	b := newFakeBuilder()
	h.d.SetBuilder(b)
	return h, b, logs
}

func (h *previewHarness) previewBuild(pr, n int) (PreviewStarted, store.Deployment, error) {
	h.t.Helper()
	started, done, err := h.d.StartPreviewBuild(context.Background(), "web", pr, sha(n), testSource())
	if err != nil {
		return PreviewStarted{}, store.Deployment{}, err
	}
	<-done
	dep, derr := h.st.Deployment(context.Background(), started.DeploymentID)
	if derr != nil {
		h.t.Fatal(derr)
	}
	return started, dep, nil
}

// instance is the container an instance's proxy state points at, nil when it has none.
func (h *previewHarness) instance(name string) *fakeCtr {
	st, err := h.st.AppState(context.Background(), name)
	if err != nil {
		return nil
	}
	return h.eng.container(st.Container)
}
func TestPreviewBuildsAndDeploysTheInstance(t *testing.T) {
	h, b, logs := newBuildPreviewHarness(t, defaultPreviews)
	b.lines = []string{"Successfully built abc"}
	started, dep, err := h.previewBuild(12, 1)
	if err != nil {
		t.Fatal(err)
	}
	ref := "ghcr.io/o/web:" + sha(1)
	if dep.Status != store.StatusSucceeded || dep.Trigger != "preview" || dep.Ref != ref || started.Name != "web-pr-12" || started.URL != "https://pr-12-web.example.com" {
		t.Fatalf("%+v %+v", started, dep)
	}
	if c := h.instance("web-pr-12"); c == nil || c.image != ref || !c.running {
		t.Errorf("the instance must run the built image: %+v", c)
	}
	for _, op := range h.eng.opsList() {
		if strings.HasPrefix(op, "pull ") {
			t.Errorf("a built preview image must not be pulled: %s", op)
		}
	}
	reqs := b.requests()
	if len(reqs) != 1 || reqs[0].Image != "ghcr.io/o/web" || reqs[0].SHA != sha(1) || reqs[0].Config.Args["NODE_ENV"] != "production" || reqs[0].Port != 3000 {
		t.Fatalf("the instance builds with its parent's block and port: %+v", reqs)
	}
	evs, _ := h.st.Events(context.Background(), dep.ID, 0)
	var all []string
	for _, e := range evs {
		all = append(all, e.Message)
	}
	joined := strings.Join(all, "\n")
	for _, want := range []string{"downloading source", "building " + ref, "Successfully built abc", "built " + ref, "deploying " + ref + " to web-pr-12"} {
		if !strings.Contains(joined, want) {
			t.Errorf("missing %q in\n%s", want, joined)
		}
	}
	if strings.Contains(joined, buildToken) || strings.Contains(logs.String(), buildToken) {
		t.Error("the token leaked")
	}
	if rows := h.rows(); rows["web-pr-12"].Ref != ref || rows["web-pr-12"].DeploymentID != started.DeploymentID {
		t.Errorf("%+v", rows)
	}
	// Redeploying the same pull request builds again, in place.
	if _, dep, err := h.previewBuild(12, 2); err != nil || dep.Status != store.StatusSucceeded {
		t.Fatalf("%v %+v", err, dep)
	}
	if c := h.instance("web-pr-12"); c == nil || c.image != "ghcr.io/o/web:"+sha(2) {
		t.Errorf("%+v", c)
	}
}

func TestAFailedFirstPreviewBuildLeavesNoInstanceAndAFailedRebuildKeepsTheOldOne(t *testing.T) {
	h, b, _ := newBuildPreviewHarness(t, defaultPreviews)
	b.err = errors.New("build failed: nope")
	_, dep, err := h.previewBuild(5, 1)
	if err != nil {
		t.Fatal(err)
	}
	if dep.Status != store.StatusFailed || !strings.Contains(dep.Error, "build failed: nope") {
		t.Fatalf("%+v", dep)
	}
	if len(h.rows()) != 0 || h.instance("web-pr-5") != nil {
		t.Errorf("an instance that never served must not linger: %+v", h.rows())
	}

	b.err = nil
	if _, dep, _ := h.previewBuild(5, 2); dep.Status != store.StatusSucceeded {
		t.Fatalf("%+v", dep)
	}
	b.err = errors.New("build failed: again")
	_, dep, _ = h.previewBuild(5, 3)
	if dep.Status != store.StatusFailed {
		t.Fatalf("%+v", dep)
	}
	if c := h.instance("web-pr-5"); c == nil || c.image != "ghcr.io/o/web:"+sha(2) || !c.running {
		t.Errorf("the old version must keep serving: %+v", c)
	}
	if _, ok := h.rows()["web-pr-5"]; !ok {
		t.Error("the instance of a failed rebuild stays")
	}
}

func TestPreviewBuildRequestsAreRefusedWithoutSideEffects(t *testing.T) {
	h, b, _ := newBuildPreviewHarness(t, "    previews: {domain: 'pr-{pr}-web.example.com', max: 1}\n")
	ctx := context.Background()
	if _, dep, err := h.previewBuild(1, 1); err != nil || dep.Status != store.StatusSucceeded {
		t.Fatalf("%v %+v", err, dep)
	}

	// Busy: another build holds the slot. Creating pull request 2 would evict pull request 1 (max 1): not before the
	// build can start.
	release, ok := b.TryAcquire()
	if !ok {
		t.Fatal("slot")
	}
	if _, _, err := h.d.StartPreviewBuild(ctx, "web", 2, sha(2), testSource()); !errors.Is(err, ErrBuildBusy) {
		t.Errorf("want ErrBuildBusy, got %v", err)
	}
	if rows := h.rows(); len(rows) != 1 || rows["web-pr-1"].Name == "" {
		t.Errorf("a refused build must not evict or create anything: %+v", rows)
	}
	release()

	// The name must not stay reserved after a refusal.
	if _, dep, err := h.previewBuild(2, 2); err != nil || dep.Status != store.StatusSucceeded {
		t.Errorf("%v %+v", err, dep)
	}

	b.validateErr = build.ErrBadSHA
	if _, _, err := h.d.StartPreviewBuild(ctx, "web", 3, "nope", testSource()); !errors.Is(err, build.ErrBadSHA) {
		t.Errorf("%v", err)
	}
	b.validateErr = nil
	if _, _, err := h.d.StartPreviewBuild(ctx, "other", 3, sha(1), testSource()); !errors.Is(err, ErrNoPreview) {
		t.Errorf("%v", err)
	}
	if _, _, err := h.d.StartPreviewBuild(ctx, "web", 0, sha(1), testSource()); !errors.Is(err, ErrInvalidPR) {
		t.Errorf("%v", err)
	}
	h.d.BeginShutdown()
	if _, _, err := h.d.StartPreviewBuild(ctx, "web", 4, sha(1), testSource()); !errors.Is(err, ErrShuttingDown) {
		t.Errorf("%v", err)
	}
}

func TestPreviewBuildNeedsTheParentsBuildBlock(t *testing.T) {
	h := newPreviewHarness(t, defaultPreviews) // the parent has no build block
	b := newFakeBuilder()
	h.d.SetBuilder(b)
	if _, _, err := h.d.StartPreviewBuild(context.Background(), "web", 1, sha(1), testSource()); !errors.Is(err, ErrNoBuild) {
		t.Errorf("got %v", err)
	}
	if len(h.rows()) != 0 || len(b.requests()) != 0 {
		t.Error("nothing may be created or built")
	}
}

func TestBuildPreviewAndAppBuildShareTheOneSlot(t *testing.T) {
	h, b, _ := newBuildPreviewHarness(t, defaultPreviews)
	b.gate = make(chan struct{})
	_, done, err := h.d.StartPreviewBuild(context.Background(), "web", 1, sha(1), testSource())
	if err != nil {
		t.Fatal(err)
	}
	<-b.started
	if _, _, err := h.d.StartBuild(context.Background(), "web", sha(2), testSource(), nil); !errors.Is(err, ErrBuildBusy) && !errors.Is(err, ErrBusy) {
		t.Errorf("a build of the app during a preview build: %v", err)
	}
	close(b.gate)
	<-done
}

// A preset's image listens on the app's port and its health check follows health_path: the request carries both.
func TestBuildRequestCarriesThePortAndHealthPathOfTheApp(t *testing.T) {
	h := newBuildHarness(t)
	app := h.app
	app.Port, app.ContainerPort, app.HealthPath = config.PortSpec{Container: 4000}, 4000, "/up"
	app.Build = &config.Build{Preset: config.PresetNode, Node: "22", Context: ".", Timeout: config.D(time.Minute), Memory: sz("2g"), CPUs: ptr(2.0), MaxSource: sz("512m"), SourceHosts: []string{"api.github.com"}}
	job, err := h.d.newBuildJob(context.Background(), app, sha(1), testSource())
	if err != nil {
		t.Fatal(err)
	}
	if job.req.Port != 4000 || job.req.HealthPath != "/up" || job.req.Config.Preset != config.PresetNode {
		t.Errorf("%+v", job.req)
	}
}

// With `database: true` the build runs on the network that reaches the app's managed database: the request says which.
func TestBuildRequestCarriesTheNetworkThatReachesTheDatabase(t *testing.T) {
	h := newBuildHarness(t)
	for name, tc := range map[string]struct {
		network, buildNetwork string
		database              bool
		want                  string
	}{
		"bridge app":        {"", "", true, config.ManagedPostgresNetwork},
		"host app":          {"host", "", true, config.BuildNetworkHost},
		"option off":        {"", "", false, ""},
		"network named":     {"", "custom", true, "custom"},
		"network named too": {"", "host", false, "host"},
	} {
		app := h.app
		app.Network = tc.network
		app.Build = &config.Build{Preset: config.PresetNode, Node: "22", Context: ".", Timeout: config.D(time.Minute), Memory: sz("2g"), CPUs: ptr(2.0), MaxSource: sz("512m"), SourceHosts: []string{"api.github.com"}, Network: tc.buildNetwork, Database: tc.database}
		job, err := h.d.newBuildJob(context.Background(), app, sha(1), testSource())
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		if got := job.req.BuildNetwork(); got != tc.want {
			t.Errorf("%s: the build network is %q, want %q", name, got, tc.want)
		}
	}
}

// The build is told when its database is one the agent made (and may be filled with tables by a Dockerfile), and only then:
// a build with no `database: true` never carries the mark, whatever else it is given.
func TestBuildRequestMarksAManagedDatabaseOnly(t *testing.T) {
	h := newBuildHarness(t)
	for _, database := range []bool{true, false} {
		app := h.app
		app.Build = &config.Build{Preset: config.PresetNode, Node: "22", Context: ".", Timeout: config.D(time.Minute), Memory: sz("2g"), CPUs: ptr(2.0), MaxSource: sz("512m"), SourceHosts: []string{"api.github.com"}, Database: database, Args: map[string]string{"NODE_ENV": "production"}}
		job, err := h.d.newBuildJob(context.Background(), app, sha(1), testSource())
		if err != nil {
			t.Fatal(err)
		}
		got, marked := job.req.Args[config.BuildDatabaseArg]
		if marked != database || (database && got != "1") {
			t.Errorf("database=%v: %s = %q (set: %v)", database, config.BuildDatabaseArg, got, marked)
		}
		if app.Build.Args["NODE_ENV"] != "production" || len(app.Build.Args) != 1 {
			t.Errorf("the app's own build block must not be changed: %v", app.Build.Args)
		}
	}
}

// The mark means "the empty database the agent created". Once the app has served, the database holds data: a build must not
// migrate it (a migration that fails there is recorded in the live database and refuses every deployment after it), but it
// still reads it, so the network and the URL stay.
func TestBuildRequestDropsTheDatabaseMarkOnceTheAppHasServed(t *testing.T) {
	h := newBuildHarness(t)
	app := h.app
	app.Build = &config.Build{Preset: config.PresetNode, Node: "22", Context: ".", Timeout: config.D(time.Minute), Memory: sz("2g"), CPUs: ptr(2.0), MaxSource: sz("512m"), SourceHosts: []string{"api.github.com"}, Database: true}
	cfg := *h.d.config()
	cfg.Apps = append([]config.App{app}, cfg.Apps[1:]...)
	h.d.cfg.Store(&cfg)

	job, err := h.d.newBuildJob(context.Background(), app, sha(1), testSource())
	if err != nil || job.req.Args[config.BuildDatabaseArg] != "1" {
		t.Fatalf("before the first deployment the database is the new one: %v %v", err, job.req.Args)
	}
	if dep, err := h.startBuild("web", 1); err != nil || dep.Status != store.StatusSucceeded {
		t.Fatalf("the first deployment must succeed: %v %+v", err, dep)
	}
	job, err = h.d.newBuildJob(context.Background(), app, sha(2), testSource())
	if err != nil {
		t.Fatal(err)
	}
	if v, marked := job.req.Args[config.BuildDatabaseArg]; marked {
		t.Errorf("after a successful deployment the build must not be told to migrate: %s=%q", config.BuildDatabaseArg, v)
	}
	if job.req.BuildNetwork() != config.ManagedPostgresNetwork {
		t.Errorf("the build still reads the database: network %q", job.req.BuildNetwork())
	}
}

// A multi-stage build leaves its builder stages as untagged images. After a successful build the ones that were already there
// go (nothing needs them), the ones this build made stay (the next build reuses their layers), and a failed build removes nothing.
func TestBuildRemovesTheLeftoversOfEarlierBuildsButKeepsItsOwn(t *testing.T) {
	h := newBuildHarness(t)
	h.eng.dangling = []docker.Image{{ID: "sha256:old1"}, {ID: "sha256:old2"}}
	h.b.onBuild = func() {
		h.eng.mu.Lock()
		h.eng.dangling = append(h.eng.dangling, docker.Image{ID: "sha256:new1"})
		h.eng.mu.Unlock()
	}
	dep, err := h.startBuild("web", 1)
	if err != nil || dep.Status != store.StatusSucceeded {
		t.Fatalf("%v %+v", err, dep)
	}
	if got := h.removed(); !slices.Equal(got, []string{"sha256:old1", "sha256:old2"}) {
		t.Errorf("removed %v, want the two images that were there before the build", got)
	}
	if !slices.ContainsFunc(h.events(dep.ID), func(e string) bool { return strings.Contains(e, "removed 2 untagged images left by earlier builds") }) {
		t.Errorf("the removal must be in the deployment's events: %v", h.events(dep.ID))
	}
}

func TestAFailedBuildRemovesNoLeftoverAndAnImageInUseIsNotAnError(t *testing.T) {
	h := newBuildHarness(t)
	h.eng.dangling = []docker.Image{{ID: "sha256:old1"}}
	h.b.err = errors.New("boom")
	if dep, err := h.startBuild("web", 1); err != nil || dep.Status != store.StatusFailed {
		t.Fatalf("%v %+v", err, dep)
	}
	if got := h.removed(); len(got) != 0 {
		t.Errorf("a failed build keeps the cache it made and removes nothing: %v", got)
	}

	h.b.err = nil
	h.eng.dangling = []docker.Image{{ID: "sha256:busy"}, {ID: "sha256:free"}}
	h.eng.removeErr = map[string]error{"sha256:busy": docker.ErrImageInUse}
	dep, err := h.startBuild("web", 2)
	if err != nil || dep.Status != store.StatusSucceeded {
		t.Fatalf("%v %+v", err, dep)
	}
	if got := h.removed(); !slices.Equal(got, []string{"sha256:free"}) {
		t.Errorf("removed %v", got)
	}
	for _, e := range h.events(dep.ID) {
		if strings.Contains(e, "could not remove") {
			t.Errorf("an image in use is expected, not worth a warning: %q", e)
		}
	}
}

// A build can succeed and its release or health check fail. The image is there: once the operator has fixed the cause,
// deploying the same tag uses it, instead of asking a registry that has never heard of it.
func TestATagWhoseDeploymentFailedAfterItsBuildIsDeployedWithoutPulling(t *testing.T) {
	h := newBuildHarness(t)
	h.eng.behavior = map[string]string{repo + ":" + sha(1): "unhealthy"}
	dep, err := h.startBuild("web", 1)
	if err != nil || dep.Status != store.StatusFailed {
		t.Fatalf("%v %+v", err, dep)
	}

	delete(h.eng.behavior, repo+":"+sha(1))
	id, done, err := h.d.Start(context.Background(), "web", Target{Tag: sha(1)}, "api")
	if err != nil {
		t.Fatal(err)
	}
	<-done
	dep, _ = h.st.Deployment(context.Background(), id)
	if dep.Status != store.StatusSucceeded || dep.Ref != repo+":"+sha(1) {
		t.Fatalf("%+v", dep)
	}
	if p := h.pulls(); len(p) != 0 {
		t.Errorf("an image whose build finished here must not be pulled: %v", p)
	}
}

// sz is a size from its text.
func sz(text string) *config.Size {
	n, err := config.ParseSize(text)
	if err != nil {
		panic(err)
	}
	v := config.Size(n)
	return &v
}
