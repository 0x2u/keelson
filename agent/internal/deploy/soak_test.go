package deploy

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/0x2u/keelson/agent/internal/config"
	"github.com/0x2u/keelson/agent/internal/proxy"
	"github.com/0x2u/keelson/agent/internal/store"
)

// newSoakApp is a host-network app (two local servers stand in for its instances) that watches each new version for 120ms.
func newSoakApp(t *testing.T, mutate ...func(*config.App)) *hostApp {
	t.Helper()
	soak := 120 * time.Millisecond
	h := newHostApp(t, append([]func(*config.App){func(a *config.App) {
		a.Domains = []string{"example.com"}
		a.Soak = config.D(soak)
		a.Verify = []config.Verify{{Path: "/products/1"}}
	}}, mutate...)...)
	h.d.soakEvery = 15 * time.Millisecond
	return h
}

// after runs fn once the proxy has switched to the instance on the given port (the first time it does).
func (h *hostApp) afterSwitchTo(port int, fn func()) {
	var once sync.Once
	h.px.mu.Lock()
	h.px.onApply = func(routes []proxy.Route) {
		for _, r := range routes {
			if r.Upstream == "127.0.0.1:"+strconv.Itoa(port) {
				once.Do(fn)
			}
		}
	}
	h.px.mu.Unlock()
}

func TestSoakHoldsAndOnlyThenStopsThePreviousVersion(t *testing.T) {
	h := newSoakApp(t)
	if dep := h.deploy("v1"); dep.Status != store.StatusSucceeded {
		t.Fatalf("%s: %s", dep.Status, dep.Error)
	}
	old := h.state().Container
	dep := h.deploy("v2")
	if dep.Status != store.StatusSucceeded {
		t.Fatalf("%s: %s", dep.Status, dep.Error)
	}
	ev := h.events(dep.ID)
	watching, held, stopping := strings.Index(ev, "watching the new version"), strings.Index(ev, "held for the full"), strings.Index(ev, "stopping previous container")
	if watching < 0 || held < watching || stopping < held {
		t.Errorf("the previous version is stopped after the soak, not before it:\n%s", ev)
	}
	if h.eng.container(old) != nil {
		t.Error("the previous container must be gone once the soak held")
	}
}

func TestAFailingPageDuringTheSoakSwitchesBackAndRollsBack(t *testing.T) {
	h := newSoakApp(t)
	h.deploy("v1")
	serving := h.state()
	h.afterSwitchTo(h.ports[1], func() { h.status[1].Store(500) })

	dep := h.deploy("v2")
	if dep.Status != store.StatusRolledBack || !strings.Contains(dep.Error, "failed during the soak") {
		t.Fatalf("a new version that breaks during the soak is rolled back: %s: %s", dep.Status, dep.Error)
	}
	if got := h.state(); got.Container != serving.Container || got.HostPort != serving.HostPort || got.Ref != serving.Ref {
		t.Errorf("app_state must point at the previous container again: %+v, was %+v", got, serving)
	}
	if got := h.upstream2(); got != "127.0.0.1:"+strconv.Itoa(h.ports[0]) {
		t.Errorf("traffic must go back to the previous version, the route is %q", got)
	}
	h.mustImage(serving.Container, repo+":v1")
	for name := range h.eng.snapshot() {
		if name != serving.Container {
			t.Errorf("the new container must be removed, found %s", name)
		}
	}
	ev := h.events(dep.ID)
	for _, want := range []string{"the new version failed during the soak", "switching traffic back", "answered 500"} {
		if !strings.Contains(ev, want) {
			t.Errorf("events must say %q:\n%s", want, ev)
		}
	}
}

// upstream2 is the upstream of the last applied route for example.com (the proxied harness has its own helper for a
// different app shape).
func (h *hostApp) upstream2() string {
	for _, r := range h.px.last() {
		if len(r.Hosts) > 0 && r.Hosts[0] == "example.com" {
			return r.Upstream
		}
	}
	return ""
}

func TestANewContainerThatExitsOrTurnsUnhealthyDuringTheSoakRollsBack(t *testing.T) {
	for name, hurt := range map[string]func(c *fakeCtr){
		"exits":     func(c *fakeCtr) { c.running, c.exitCode = false, 1 },
		"unhealthy": func(c *fakeCtr) { c.health = "unhealthy" },
	} {
		t.Run(name, func(t *testing.T) {
			h := newSoakApp(t)
			h.deploy("v1")
			serving := h.state()
			h.afterSwitchTo(h.ports[1], func() {
				h.eng.mu.Lock()
				defer h.eng.mu.Unlock()
				for _, c := range h.eng.ctrs {
					if c.image == repo+":v2" {
						hurt(c)
					}
				}
			})
			dep := h.deploy("v2")
			if dep.Status != store.StatusRolledBack {
				t.Fatalf("%s: %s", dep.Status, dep.Error)
			}
			if got := h.state(); got.Container != serving.Container || got.Ref != serving.Ref {
				t.Errorf("the previous version must serve again: %+v", got)
			}
		})
	}
}

func TestAFirstDeploymentThatFailsDuringTheSoakIsReportedFailedAndKeptForInspection(t *testing.T) {
	h := newSoakApp(t)
	h.afterSwitchTo(h.ports[0], func() { h.status[0].Store(500) })
	dep := h.deploy("v1")
	if dep.Status != store.StatusFailed || !strings.Contains(dep.Error, "nothing was serving before it") {
		t.Fatalf("there is no previous version to go back to, and 'succeeded' would be false: %s: %s", dep.Status, dep.Error)
	}
	if h.eng.container(h.state().Container) == nil {
		t.Error("the only container stays: removing it would take the app down for sure")
	}
}

func TestWithoutASoakNothingIsWatchedAfterTheSwitch(t *testing.T) {
	h := newSoakApp(t, func(a *config.App) { a.Soak, a.Verify = nil, nil })
	h.deploy("v1")
	h.afterSwitchTo(h.ports[1], func() { h.status[1].Store(500) })
	dep := h.deploy("v2")
	if dep.Status != store.StatusSucceeded || strings.Contains(h.events(dep.ID), "watching the new version") {
		t.Fatalf("soak 0 is today's behaviour: %s: %s", dep.Status, dep.Error)
	}
}

// One request that fails is asked again at once: a dropped packet must not undo a good deployment.
func TestASoakRequestThatFailsOnceIsAskedAgainBeforeItCounts(t *testing.T) {
	var calls atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if calls.Add(1) == 1 {
			w.WriteHeader(502)
		}
	}))
	defer srv.Close()
	h := newHarness(t)
	port, _ := strconv.Atoi(srv.URL[strings.LastIndex(srv.URL, ":")+1:])
	h.eng.put("web-x", repo+":v1", true)
	if err := h.d.soakRound(context.Background(), "web-x", port, []soakCheck{{path: "/"}}); err != nil {
		t.Fatalf("a single failure is not a failure: %v", err)
	}
	failing := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(503) }))
	defer failing.Close()
	fport, _ := strconv.Atoi(failing.URL[strings.LastIndex(failing.URL, ":")+1:])
	if err := h.d.soakRound(context.Background(), "web-x", fport, []soakCheck{{path: "/"}}); err == nil || !strings.Contains(err.Error(), "answered 503") {
		t.Fatalf("two failures in a row count: %v", err)
	}
}

func TestVerifyPathsAreRequestedWithTheStatusTheyAreGiven(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/moved":
			http.Redirect(w, r, "/elsewhere", 301)
		case "/gone":
			w.WriteHeader(404)
		}
	}))
	defer srv.Close()
	h := newHarness(t)
	port, _ := strconv.Atoi(srv.URL[strings.LastIndex(srv.URL, ":")+1:])
	ctx := context.Background()
	for _, tc := range []struct {
		check soakCheck
		ok    bool
	}{
		{soakCheck{path: "/fine"}, true},
		{soakCheck{path: "/moved", status: 301}, true}, // a redirect is an answer, not followed
		{soakCheck{path: "/moved"}, false},             // and not a 2xx
		{soakCheck{path: "/gone", status: 404}, true},
		{soakCheck{path: "/gone"}, false},
	} {
		if err := h.d.soakRequest(ctx, port, tc.check); (err == nil) != tc.ok {
			t.Errorf("%+v: %v", tc.check, err)
		}
	}
	// health_path is always among the checks, once, and a verify entry for it adds nothing unless it wants another status.
	a := config.App{HealthPath: "/h", Verify: []config.Verify{{Path: "/h"}, {Path: "/p", Status: 200}, {Path: "/h", Status: 204}}}
	var paths []string
	for _, c := range h.d.soakChecks(a) {
		paths = append(paths, c.path+":"+strconv.Itoa(c.status))
	}
	if got := strings.Join(paths, " "); got != "/h:0 /p:200 /h:204" {
		t.Errorf("checks: %s", got)
	}
}

// With a HEALTHCHECK a container counted at its first healthy report, and still does, unless the file sets stable_after.
func TestStableAfterAlsoAppliesToAnImageWithAHealthcheckWhenTheFileSetsIt(t *testing.T) {
	for _, set := range []bool{false, true} {
		h := newHarness(t, func(a *config.App) {
			a.StableAfter, a.StableAfterSet = config.D(150*time.Millisecond), set
			a.HealthTimeout = config.D(2 * time.Second)
		})
		h.eng.put("web", repo+":v1", true) // healthy from the start
		start := time.Now()
		if err := h.d.waitHealthy(context.Background(), h.app, "web"); err != nil {
			t.Fatal(err)
		}
		took := time.Since(start)
		switch {
		case set && took < 140*time.Millisecond:
			t.Errorf("stable_after set: a healthy container must stay healthy that long, took %s", took)
		case !set && took > 100*time.Millisecond:
			t.Errorf("stable_after not set: a healthy container counts at once, took %s", took)
		}
	}
}

func TestAFirstDeploymentRefusesToAdoptARunningContainerWhoseHostPortIsUnknown(t *testing.T) {
	h := newHostApp(t)
	h.eng.put("web", "compose/web:1", true) // started by hand, no PORT in its environment
	dep := h.deploy("v1")
	if dep.Status != store.StatusFailed || !strings.Contains(dep.Error, "does not set PORT") {
		t.Fatalf("%s: %s", dep.Status, dep.Error)
	}
	for _, op := range h.eng.opsList() {
		if strings.HasPrefix(op, "create") || strings.HasPrefix(op, "pull") {
			t.Errorf("nothing may run before the refusal (a migration included): %q", op)
		}
	}
	if c := h.eng.container("web"); c == nil || !c.running {
		t.Error("the container that serves is left alone")
	}
}

func TestAnAppWithABuildBlockNeverPullsATagItDidNotBuild(t *testing.T) {
	h := newBuildHarness(t)
	h.eng.missingImages = map[string]bool{repo + ":zzz": true}
	_, _, err := h.d.Start(context.Background(), "web", Target{Tag: "zzz"}, "api")
	if !errors.Is(err, ErrNoImage) || !strings.Contains(err.Error(), "never pulls a tag it did not build") {
		t.Fatalf("a build app refuses a tag that is not here: %v", err)
	}
	if len(h.pulls()) != 0 {
		t.Errorf("nothing may be pulled from a registry the operator does not control: %v", h.pulls())
	}
}

// The 15-minute bound used to cover the pull, the release steps and the health gate together: a 20 minute backup step was
// cut at 15. Each phase has its own budget, and the deployment is bounded by their sum.
func TestTheDeploymentBudgetHoldsEveryPhaseAtItsOwnLength(t *testing.T) {
	soak, drain := 30*time.Second, 5*time.Second
	a := config.App{
		Name: "web", StopTimeout: config.D(10 * time.Second), HealthTimeout: config.D(time.Minute), StableAfter: config.D(10 * time.Second), Port: config.PortSpec{Container: 3000}, ContainerPort: 3000, Soak: config.D(soak), Drain: config.D(drain),
		Release: &config.Release{Steps: []config.ReleaseStep{{Name: "backup", Timeout: config.D(20 * time.Minute)}, {Name: "migrate", Timeout: config.D(10 * time.Minute), Action: config.Action{Container: &config.ContainerAction{Image: "o/migrator"}}}}},
	}
	if got := releaseBudget(a); got != 20*time.Minute+10*time.Minute+pullTimeout {
		t.Errorf("the release phase is the sum of its steps (and a pull for a step with its own image): %s", got)
	}
	if deployBudget(a) < 30*time.Minute+healthBudget(a)+soakBudget(a) {
		t.Errorf("the whole is at least the sum of its phases: %s", deployBudget(a))
	}
	if deployBudget(config.App{Name: "x", StopTimeout: config.D(10 * time.Second), HealthTimeout: config.D(time.Minute)}) <= 15*time.Minute {
		t.Error("even an app with no release step needs the pull's budget and the health gate's")
	}
	ctx, cancel := phaseContext(context.Background(), 0)
	defer cancel()
	if _, has := ctx.Deadline(); has {
		t.Error("a phase with no budget (no release step) must not expire at once")
	}
}
