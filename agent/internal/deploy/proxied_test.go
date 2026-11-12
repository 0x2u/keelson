package deploy

import (
	"bytes"
	"context"
	"errors"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/0x2u/keelson/agent/internal/config"
	"github.com/0x2u/keelson/agent/internal/docker"
	"github.com/0x2u/keelson/agent/internal/proxy"
	"github.com/0x2u/keelson/agent/internal/store"
)

func newProxiedHarness(t *testing.T) *harness {
	return newHarness(t, func(a *config.App) {
		a.Domains = []string{"example.com", "www.example.com"}
		a.Port, a.ContainerPort = config.PortSpec{Container: 3000}, 3000
	})
}

func (h *harness) state() store.AppState {
	h.t.Helper()
	st, err := h.st.AppState(context.Background(), "web")
	if err != nil {
		h.t.Fatalf("app state: %v", err)
	}
	return st
}

// upstreamOf returns the upstream the last applied route for example.com uses.
func (h *harness) upstream() string {
	for _, r := range h.px.last() {
		if r.Hosts[0] == "example.com" {
			return r.Upstream
		}
	}
	return ""
}

func TestProxiedFirstDeployPublishesLoopbackPortAndRoutesTraffic(t *testing.T) {
	h := newProxiedHarness(t)
	dep := h.deploy("v1")
	if dep.Status != store.StatusSucceeded {
		t.Fatalf("got %s: %s", dep.Status, dep.Error)
	}

	st := h.state()
	if st.Container != "web-"+dep.ID || st.Ref != repo+":v1" || st.HostPort == 0 {
		t.Fatalf("unexpected state: %+v", st)
	}
	h.mustImage(st.Container, repo+":v1")
	if got, want := h.upstream(), "127.0.0.1:"+strconv.Itoa(st.HostPort); got != want {
		t.Errorf("route points at %q, want %q", got, want)
	}
	if routes := h.px.last(); len(routes) != 1 || len(routes[0].Hosts) != 2 || routes[0].Hosts[1] != "www.example.com" {
		t.Errorf("both domains must share the route: %+v", routes)
	}
	for _, op := range h.eng.opsList() {
		if strings.HasPrefix(op, "stop") || strings.HasPrefix(op, "rename") {
			t.Errorf("a first deploy has nothing to stop or rename: %q", op)
		}
	}
}

func TestProxiedSwitchKeepsTheOldVersionServingUntilTheProxyMoves(t *testing.T) {
	h := newProxiedHarness(t)
	first := h.deploy("v1")
	oldName := h.state().Container

	// At the instant the proxy is told to switch, the old container must
	// still be running: that is what makes the switch outage-free.
	var oldRunningAtSwitch, newRunningAtSwitch bool
	h.px.onApply = func(routes []proxy.Route) {
		if c := h.eng.container(oldName); c != nil {
			oldRunningAtSwitch = c.running
		}
		for name := range h.eng.snapshot() {
			if name != oldName && strings.HasPrefix(name, "web-") {
				newRunningAtSwitch = h.eng.container(name).running
			}
		}
	}
	second := h.deploy("v2")

	if second.Status != store.StatusSucceeded || second.PreviousRef != repo+":v1" {
		t.Fatalf("unexpected deployment: %+v", second)
	}
	if !oldRunningAtSwitch || !newRunningAtSwitch {
		t.Errorf("both versions must be running when traffic switches (old=%v new=%v)", oldRunningAtSwitch, newRunningAtSwitch)
	}
	if h.eng.container(oldName) != nil {
		t.Error("the old container must be removed after the switch")
	}
	st := h.state()
	if st.Container != "web-"+second.ID || h.upstream() != "127.0.0.1:"+strconv.Itoa(st.HostPort) || st.Container == "web-"+first.ID {
		t.Errorf("traffic not moved to the new container: %+v upstream=%s", st, h.upstream())
	}
}

func TestProxiedPreviousVersionIsStoppedOnlyAfterTheDrain(t *testing.T) {
	drain := 250 * time.Millisecond
	h := newHarness(t, func(a *config.App) {
		a.Domains = []string{"example.com"}
		a.Port, a.ContainerPort = config.PortSpec{Container: 3000}, 3000
		a.Drain = config.D(drain)
	})
	h.deploy("v1")

	var appliedAt time.Time
	h.px.onApply = func([]proxy.Route) { appliedAt = time.Now() }
	second := h.deploy("v2")
	if second.Status != store.StatusSucceeded {
		t.Fatalf("got %s: %s", second.Status, second.Error)
	}
	// The deployment ends once the old container is gone, so this is how long it was kept after the switch.
	if kept := time.Since(appliedAt); kept < drain {
		t.Errorf("the previous version was stopped %s after the switch, before the %s drain", kept, drain)
	}
	if ev := h.events(second.ID); !strings.Contains(ev, "letting the previous version finish") {
		t.Errorf("the log must say why the deployment waits:\n%s", ev)
	}
}

func TestProxiedZeroDrainStopsThePreviousVersionAtOnce(t *testing.T) {
	h := newProxiedHarness(t) // Drain is not set: no wait
	h.deploy("v1")
	second := h.deploy("v2")
	if ev := h.events(second.ID); strings.Contains(ev, "letting the previous version finish") {
		t.Errorf("no drain was asked for:\n%s", ev)
	}
}

func TestProxiedUnhealthyDeployLeavesTheOldVersionServing(t *testing.T) {
	h := newProxiedHarness(t)
	h.deploy("v1")
	before := h.state()
	routesBefore := h.px.count()
	h.eng.behavior[repo+":v2"] = "unhealthy"

	dep := h.deploy("v2")
	if dep.Status != store.StatusFailed || !strings.Contains(dep.Error, "unhealthy") {
		t.Fatalf("got %s: %q", dep.Status, dep.Error)
	}
	if h.state() != before {
		t.Error("app state must not change")
	}
	if h.px.count() != routesBefore {
		t.Error("the proxy must not be touched by a failed deployment")
	}
	h.mustImage(before.Container, repo+":v1")
	if h.eng.container("web-"+dep.ID) != nil {
		t.Error("the failed container must be removed")
	}
	for _, op := range h.eng.opsList() {
		if op == "stop "+before.Container {
			t.Error("the serving container must never be stopped by a failed deployment")
		}
	}
}

func TestProxiedProxyFailureAbortsBeforeStoppingTheOldVersion(t *testing.T) {
	h := newProxiedHarness(t)
	h.deploy("v1")
	before := h.state()
	h.px.err = errors.New("caddy down")

	dep := h.deploy("v2")
	if dep.Status != store.StatusFailed || !strings.Contains(dep.Error, "caddy down") {
		t.Fatalf("got %s: %q", dep.Status, dep.Error)
	}
	h.mustImage(before.Container, repo+":v1")
	if h.state() != before {
		t.Error("app state must not move when the proxy refused the switch")
	}
	if h.eng.container("web-"+dep.ID) != nil {
		t.Error("the unrouted container must be removed")
	}
}

func TestProxiedFirstDeployFailureLeavesNothing(t *testing.T) {
	h := newProxiedHarness(t)
	h.eng.behavior[repo+":v1"] = "crash"
	dep := h.deploy("v1")
	if dep.Status != store.StatusFailed {
		t.Fatalf("got %s", dep.Status)
	}
	if _, err := h.st.AppState(context.Background(), "web"); !errors.Is(err, store.ErrNotFound) {
		t.Error("no app state may be recorded")
	}
	if h.px.count() != 0 {
		t.Error("nothing may be routed")
	}
	if h.eng.container("web-"+dep.ID) != nil {
		t.Error("the failed container must be removed")
	}
}

func TestProxiedRollbackUsesTheServedImage(t *testing.T) {
	h := newProxiedHarness(t)
	h.deploy("v1")
	h.deploy("v2")

	id, done, err := h.d.Rollback(context.Background(), "web")
	if err != nil {
		t.Fatal(err)
	}
	<-done
	dep, _ := h.st.Deployment(context.Background(), id)
	if dep.Status != store.StatusSucceeded || dep.Ref != repo+":v1" {
		t.Fatalf("unexpected rollback: %+v", dep)
	}
	if h.state().Ref != repo+":v1" {
		t.Errorf("now serving %s", h.state().Ref)
	}
}

func TestReconcileFollowsAHostPortChangeAndSkipsNoOps(t *testing.T) {
	h := newProxiedHarness(t)
	h.deploy("v1")
	ctx := context.Background()
	st := h.state()

	n := h.px.count()
	if err := h.d.Reconcile(ctx); err != nil {
		t.Fatal(err)
	}
	if h.px.count() != n {
		t.Error("an unchanged configuration must not be pushed again")
	}

	// The engine hands the restarted container another host port.
	h.eng.mu.Lock()
	h.eng.ctrs[st.Container].ports[0].PublicPort = 41234
	h.eng.mu.Unlock()
	if err := h.d.Reconcile(ctx); err != nil {
		t.Fatal(err)
	}
	if h.upstream() != "127.0.0.1:41234" || h.state().HostPort != 41234 {
		t.Errorf("route %q / state %d did not follow the new port", h.upstream(), h.state().HostPort)
	}

	// A container that is gone loses its route instead of leaving a dead one.
	h.eng.mu.Lock()
	delete(h.eng.ctrs, st.Container)
	h.eng.mu.Unlock()
	if err := h.d.Reconcile(ctx); err != nil {
		t.Fatal(err)
	}
	if len(h.px.last()) != 0 {
		t.Errorf("a missing container must have no route: %+v", h.px.last())
	}
}

func TestRecoverBeforeSwitchRemovesTheNewContainerAndKeepsServing(t *testing.T) {
	h := newProxiedHarness(t)
	h.deploy("v1")
	serving := h.state()

	// A deployment that created and started its container, then died.
	h.eng.put("web-deadbeefdeadbeef", repo+":v2", true)
	h.eng.label("web-deadbeefdeadbeef", "web")
	h.eng.put("web", "unrelated", true) // not in the blue/green naming scheme
	h.eng.label("web", "web")
	crashed := store.Deployment{ID: "deadbeefdeadbeef", App: "web", Ref: repo + ":v2", Trigger: "api", StartedAt: time.Now()}
	if err := h.st.CreateDeployment(context.Background(), crashed); err != nil {
		t.Fatal(err)
	}

	if err := h.d.Recover(context.Background()); err != nil {
		t.Fatal(err)
	}
	dep, _ := h.st.Deployment(context.Background(), "deadbeefdeadbeef")
	if dep.Status != store.StatusFailed || !strings.Contains(dep.Error, "interrupted") {
		t.Errorf("got %s: %q", dep.Status, dep.Error)
	}
	if h.eng.container("web-deadbeefdeadbeef") != nil {
		t.Error("the orphaned new container must be removed")
	}
	h.mustImage(serving.Container, repo+":v1")
	if h.eng.container("web") == nil {
		t.Error("a container outside the blue/green naming scheme must never be removed")
	}
	if h.state() != serving {
		t.Error("serving state must be unchanged")
	}
}

func TestRecoverAfterSwitchKeepsTheNewVersionAndRemovesTheOldOne(t *testing.T) {
	h := newProxiedHarness(t)
	h.deploy("v1")
	oldName := h.state().Container

	// Crash right after app_state moved, before the old container was removed.
	newName := "web-aaaaaaaaaaaaaaaa"
	h.eng.put(newName, repo+":v2", true)
	h.eng.label(newName, "web")
	h.eng.ctrs[newName].ports = h.eng.ctrs[oldName].ports
	if err := h.st.SetAppState(context.Background(), store.AppState{App: "web", Container: newName, HostPort: h.state().HostPort, Ref: repo + ":v2"}, time.Now()); err != nil {
		t.Fatal(err)
	}
	crashed := store.Deployment{ID: "aaaaaaaaaaaaaaaa", App: "web", Ref: repo + ":v2", Trigger: "api", StartedAt: time.Now()}
	h.st.CreateDeployment(context.Background(), crashed)

	if err := h.d.Recover(context.Background()); err != nil {
		t.Fatal(err)
	}
	dep, _ := h.st.Deployment(context.Background(), "aaaaaaaaaaaaaaaa")
	if dep.Status != store.StatusSucceeded {
		t.Errorf("a deployment interrupted after the switch is a success, got %s", dep.Status)
	}
	h.mustImage(newName, repo+":v2")
	if h.eng.container(oldName) != nil {
		t.Error("the superseded container must be removed")
	}
}

func TestAppsReportsTheServingContainerOfProxiedApps(t *testing.T) {
	h := newProxiedHarness(t)
	apps, err := h.d.Apps(context.Background())
	if err != nil || len(apps) != 1 || apps[0].Container != nil {
		t.Fatalf("before any deploy there is no container: %+v, %v", apps, err)
	}
	dep := h.deploy("v1")
	apps, err = h.d.Apps(context.Background())
	if err != nil || apps[0].Container == nil || apps[0].Container.Name != "web-"+dep.ID {
		t.Errorf("got %+v, %v", apps, err)
	}
}

// --- host network, ports alternated by the agent ---------------------------

// hostApp is an app on the host network that listens on one of two ports. Two
// local HTTP servers stand in for the instances, so the health_path probe has
// something real to ask.
type hostApp struct {
	*harness
	ports  [2]int
	status [2]atomic.Int32 // answer of each instance's health endpoint
}

func newHostApp(t *testing.T, mutate ...func(*config.App)) *hostApp {
	t.Helper()
	ha := &hostApp{}
	for i := range ha.ports {
		i := i
		ha.status[i].Store(200)
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(int(ha.status[i].Load()))
		}))
		t.Cleanup(srv.Close)
		port, err := strconv.Atoi(srv.URL[strings.LastIndex(srv.URL, ":")+1:])
		if err != nil {
			t.Fatal(err)
		}
		ha.ports[i] = port
	}
	envFile := filepath.Join(t.TempDir(), ".env")
	if err := os.WriteFile(envFile, []byte("PORT=1234\nKEEP=me\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	ha.harness = newHarness(t, append([]func(*config.App){func(a *config.App) {
		a.Network = "host"
		a.Port = config.PortSpec{Host: ha.ports[:], Env: "PORT"}
		a.HostPorts = ha.ports[:]
		a.PortEnv = "PORT"
		a.HealthPath = "/api/health"
		a.EnvFile = envFile
		a.HealthTimeout = config.D(200 * time.Millisecond)
	}}, mutate...)...)
	return ha
}

func envOf(c *fakeCtr, key string) []string {
	var out []string
	for _, e := range c.env {
		if strings.HasPrefix(e, key+"=") {
			out = append(out, e)
		}
	}
	return out
}

func TestHostPortsFirstDeployUsesTheFirstPortAndOverridesTheEnvFile(t *testing.T) {
	h := newHostApp(t)
	dep := h.deploy("v1")
	if dep.Status != store.StatusSucceeded {
		t.Fatalf("got %s: %s", dep.Status, dep.Error)
	}
	st := h.state()
	c := h.eng.container(st.Container)
	if st.HostPort != h.ports[0] || c.network != "host" || len(c.ports) != 0 {
		t.Errorf("state %+v, network %q, published ports %v", st, c.network, c.ports)
	}
	if got := envOf(c, "PORT"); len(got) != 1 || got[0] != "PORT="+strconv.Itoa(h.ports[0]) {
		t.Errorf("the chosen port must replace the env file's PORT, got %v", got)
	}
	if len(envOf(c, "KEEP")) != 1 {
		t.Error("the rest of the environment must be kept")
	}
	routes := h.px.last()
	if len(routes) != 1 || routes[0].App != "web" || routes[0].Upstream != "127.0.0.1:"+strconv.Itoa(h.ports[0]) {
		t.Errorf("unexpected routes: %+v", routes)
	}
}

func TestHostPortsAlternateBetweenDeployments(t *testing.T) {
	h := newHostApp(t)
	want := []int{h.ports[0], h.ports[1], h.ports[0], h.ports[1]}
	for i, w := range want {
		dep := h.deploy("v" + strconv.Itoa(i))
		if dep.Status != store.StatusSucceeded {
			t.Fatalf("deployment %d: %s: %s", i, dep.Status, dep.Error)
		}
		if got := h.state().HostPort; got != w {
			t.Errorf("deployment %d: port %d, want %d", i, got, w)
		}
	}
	// Only the serving container is left: the old one is gone every time.
	n := 0
	for name := range h.eng.snapshot() {
		if strings.HasPrefix(name, "web-") {
			n++
		}
	}
	if n != 1 {
		t.Errorf("want exactly one container left, got %d", n)
	}
}

func TestHostPortsFailedProbeKeepsTheOldVersionServing(t *testing.T) {
	for name, status := range map[string]int32{"server error": 500, "redirect": 302, "not found": 404} {
		t.Run(name, func(t *testing.T) {
			h := newHostApp(t)
			h.deploy("v1")
			before := h.state()
			routes := h.px.count()
			h.status[1].Store(status) // the instance the next deployment will use

			dep := h.deploy("v2")
			if dep.Status != store.StatusFailed || !strings.Contains(dep.Error, "health check") {
				t.Fatalf("got %s: %q", dep.Status, dep.Error)
			}
			if h.state() != before || h.px.count() != routes {
				t.Error("neither the state nor the proxy may change")
			}
			h.mustImage(before.Container, repo+":v1")
			if h.eng.container("web-"+dep.ID) != nil {
				t.Error("the failed container must be removed")
			}
		})
	}
}

func TestHostPortsProbeCatchesWhatTheImageHealthcheckMisses(t *testing.T) {
	// The image's own HEALTHCHECK probes a fixed port, so Docker calls the new
	// container "healthy" even though nothing answers on its port.
	h := newHostApp(t)
	h.deploy("v1")
	h.status[1].Store(503)
	h.eng.behavior[repo+":v2"] = "healthy" // what Docker would report

	if dep := h.deploy("v2"); dep.Status != store.StatusFailed {
		t.Fatalf("a container Docker calls healthy but whose port does not answer must fail, got %s", dep.Status)
	}
}

func TestHostPortsAdoptsTheRunningContainerAndPicksTheOtherPort(t *testing.T) {
	h := newHostApp(t)
	// What docker compose left behind: a container named after the app, on port 0.
	h.eng.put("web", "ghcr.io/o/web:legacy", true)
	h.eng.mu.Lock()
	h.eng.ctrs["web"].env = []string{"PORT=" + strconv.Itoa(h.ports[0])}
	h.eng.mu.Unlock()

	dep := h.deploy("v1")
	if dep.Status != store.StatusSucceeded || dep.PreviousRef != "ghcr.io/o/web:legacy" {
		t.Fatalf("got %s (%s): %+v", dep.Status, dep.Error, dep)
	}
	if got := h.state().HostPort; got != h.ports[1] {
		t.Errorf("the new container must avoid the legacy port: got %d, legacy %d", got, h.ports[0])
	}
	if h.eng.container("web") != nil {
		t.Error("the adopted container must be stopped and removed after the switch")
	}
	ops := strings.Join(h.eng.opsList(), "|")
	if strings.Index(ops, "stop web") < strings.Index(ops, "start web-") {
		t.Errorf("the legacy container must keep serving until the new one runs: %s", ops)
	}
}

func TestHostPortsLeavesAStoppedContainerAlone(t *testing.T) {
	h := newHostApp(t)
	h.eng.put("web", "ghcr.io/o/web:old", false)
	dep := h.deploy("v1")
	if dep.Status != store.StatusSucceeded || dep.PreviousRef != "" {
		t.Fatalf("got %+v", dep)
	}
	if h.eng.container("web") == nil {
		t.Error("a stopped container is not ours to remove")
	}
	if h.state().HostPort != h.ports[0] {
		t.Errorf("nothing is serving: the first port is free, got %d", h.state().HostPort)
	}
}

func TestHostPortsReconcileReplacesTheRouteOfAContainerThatIsNotRunningByThePlaceholder(t *testing.T) {
	h := newHostApp(t)
	h.deploy("v1")
	st := h.state()
	n := h.px.count()
	if err := h.d.Reconcile(context.Background()); err != nil {
		t.Fatal(err)
	}
	if h.px.count() != n {
		t.Error("nothing changed: nothing to push")
	}

	h.eng.mu.Lock()
	h.eng.ctrs[st.Container].running = false
	h.eng.mu.Unlock()
	if err := h.d.Reconcile(context.Background()); err != nil {
		t.Fatal(err)
	}
	if got := h.px.last(); len(got) != 1 || !got[0].Down || got[0].Upstream != "127.0.0.1:"+strconv.Itoa(h.ports[0]) {
		t.Errorf("a stopped container must lose its own route, the placeholder stays: %+v", got)
	}
	if h.state() != st {
		t.Error("the recorded port is fixed in this mode and must not be rewritten")
	}
}

func TestPickHostPortAndEnvHelpers(t *testing.T) {
	ports := []int{3000, 3001}
	for _, c := range []struct {
		current int
		has     bool
		want    int
	}{{0, false, 3000}, {3000, true, 3001}, {3001, true, 3000}, {9999, true, 3000}} {
		if got := pickHostPort(ports, c.current, c.has); got != c.want {
			t.Errorf("pickHostPort(%d,%v) = %d, want %d", c.current, c.has, got, c.want)
		}
	}
	env := withEnv([]string{"A=1", "PORT=3000", "PORTAL=x", "B=2"}, "PORT", "3001")
	if strings.Join(env, ",") != "A=1,PORTAL=x,B=2,PORT=3001" {
		t.Errorf("withEnv: %v", env)
	}
	for in, want := range map[string]int{"PORT=3000": 3000, "PORT=": 0, "PORT=abc": 0, "PORT=70000": 0, "OTHER=1": 0} {
		if got := envPort([]string{in}, "PORT"); got != want {
			t.Errorf("envPort(%q) = %d, want %d", in, got, want)
		}
	}
}

func TestProxyViewSaysWhatServesEachDomainAndWhatHasNoRoute(t *testing.T) {
	h := newProxiedHarness(t)

	before, err := h.d.Proxy(context.Background())
	if err != nil || before == nil {
		t.Fatalf("a proxied app means there is a proxy to describe: %v %v", before, err)
	}
	if len(before.Routes) != 0 || len(before.Unrouted) != 1 || before.Unrouted[0].App != "web" || before.Unrouted[0].Reason != "never deployed" {
		t.Errorf("before any deployment the app is unrouted: %+v", before)
	}

	dep := h.deploy("v1")
	after, err := h.d.Proxy(context.Background())
	if err != nil || len(after.Routes) != 1 || len(after.Unrouted) != 0 {
		t.Fatalf("after the deployment: %+v %v", after, err)
	}
	r, st := after.Routes[0], h.state()
	if r.App != "web" || r.Upstream != h.upstream() || r.Container != "web-"+dep.ID || r.Ref != repo+":v1" || !r.Running || len(r.Domains) != 2 {
		t.Errorf("route: %+v (state %+v)", r, st)
	}

	// The serving container disappears before the reconciler has noticed: the view must not claim it is up.
	_ = h.eng.Remove(context.Background(), st.Container)
	gone, err := h.d.Proxy(context.Background())
	if err != nil || len(gone.Routes) != 1 || gone.Routes[0].Running {
		t.Errorf("a vanished container must show as not running: %+v %v", gone, err)
	}
}

func TestProxyViewIsEmptyWithoutAProxy(t *testing.T) {
	h := newHarness(t)
	h.d.pxMu.Lock()
	h.d.proxy = nil
	h.d.pxMu.Unlock()
	if v, err := h.d.Proxy(context.Background()); v != nil || err != nil {
		t.Errorf("got %+v, %v", v, err)
	}
}

func TestAppsReportsTheProjectEnvironmentAndTheDigestOfTheImageThatServes(t *testing.T) {
	h := newHarness(t, func(a *config.App) {
		a.Project, a.Stage = "shop", "staging"
	})
	h.eng.digests = map[string][]string{
		repo + ":v1": {"other/repo@sha256:aaaa", repo + "@sha256:" + strings.Repeat("b", 64)},
		repo + ":v2": nil, // an image with no registry digest (built locally)
	}
	h.deploy("v1")

	apps, err := h.d.Apps(context.Background())
	if err != nil || len(apps) != 1 {
		t.Fatalf("%+v %v", apps, err)
	}
	a := apps[0]
	if a.Project != "shop" || a.Environment != "staging" {
		t.Errorf("the labels of the apps file must be reported as written: %q %q", a.Project, a.Environment)
	}
	// Only a digest of this app's own repository counts: that is what a promotion deploys.
	if a.Digest != "sha256:"+strings.Repeat("b", 64) {
		t.Errorf("digest %q", a.Digest)
	}

	h.deploy("v2")
	if apps, _ := h.d.Apps(context.Background()); apps[0].Digest != "" {
		t.Errorf("an image with no registry digest reports none, got %q", apps[0].Digest)
	}
}

func TestReconcileFailureIsLoggedOnceWhileTheCauseIsTheSame(t *testing.T) {
	var buf bytes.Buffer
	d := &Deployer{log: slog.New(slog.NewTextHandler(&buf, nil))}
	var last string
	fail := errors.New("nginx rejected the configuration: host not found in upstream")
	for i := 0; i < 5; i++ {
		d.logReconcile(&last, fail)
	}
	if n := strings.Count(buf.String(), "proxy reconcile failed"); n != 1 {
		t.Fatalf("the same failure said %d times:\n%s", n, buf.String())
	}
	d.logReconcile(&last, errors.New("another cause"))
	if n := strings.Count(buf.String(), "proxy reconcile failed"); n != 2 {
		t.Fatalf("a different failure must be said:\n%s", buf.String())
	}
	d.logReconcile(&last, nil)
	d.logReconcile(&last, nil)
	if n := strings.Count(buf.String(), "proxy reconcile recovered"); n != 1 {
		t.Fatalf("the recovery is said once:\n%s", buf.String())
	}
	d.logReconcile(&last, fail)
	if n := strings.Count(buf.String(), "proxy reconcile failed"); n != 3 {
		t.Fatalf("a failure after a recovery is news again:\n%s", buf.String())
	}
}

// nginx names keelson_<app> in the operator's server block: if the agent's file lacks that upstream, the whole configuration
// is invalid. An app with no serving container therefore stays in the file, marked down.
func TestNginxKeepsAnUpstreamForAnAppThatHasNoRoute(t *testing.T) {
	h := newHostApp(t)
	cfg := *h.d.config()
	cfg.Proxy = &config.Proxy{Type: config.ProxyNginx, UpstreamsFile: "/unused", Reload: []string{"true"}}
	h.d.cfg.Store(&cfg)

	if err := h.d.Reconcile(context.Background()); err != nil {
		t.Fatal(err)
	}
	last := h.px.last()
	if len(last) != 1 || last[0].App != "web" || !last[0].Down || last[0].Upstream != "127.0.0.1:"+strconv.Itoa(h.ports[0]) {
		t.Fatalf("an app that was never deployed keeps a placeholder on its first host port: %+v", last)
	}

	h.deploy("v1")
	last = h.px.last()
	if len(last) != 1 || last[0].Down || last[0].Upstream != "127.0.0.1:"+strconv.Itoa(h.state().HostPort) {
		t.Fatalf("a serving app has its real route: %+v", last)
	}

	st := h.state()
	h.eng.mu.Lock()
	h.eng.ctrs[st.Container].running = false
	h.eng.mu.Unlock()
	if err := h.d.Reconcile(context.Background()); err != nil {
		t.Fatal(err)
	}
	if last = h.px.last(); len(last) != 1 || !last[0].Down {
		t.Fatalf("a container that stopped leaves a placeholder, not a hole: %+v", last)
	}
}

// Under Caddy a host without a route answers an empty 200. The route to the first port answers 502 while nothing listens
// there, and keeps the container the app ran as before Keelson (compose, on that very port) serving until the first
// deployment adopts it: declaring the app must not open a gap.
func TestCaddyRoutesAnUndeployedHostPortAppToItsFirstPort(t *testing.T) {
	h := newHostApp(t)
	if err := h.d.Reconcile(context.Background()); err != nil {
		t.Fatal(err)
	}
	got := h.px.last()
	if len(got) != 1 || got[0].App != "web" || got[0].Upstream != "127.0.0.1:"+strconv.Itoa(h.ports[0]) {
		t.Fatalf("an app with host ports and no container has a route to its first port: %+v", got)
	}
}

// agent.db deleted, recreated empty or restored from an older copy while the site runs: the serving container must not be
// removed as an orphan, and the proxy must route to it again.
func TestRecoverAdoptsTheServingContainerWhenTheStateIsLost(t *testing.T) {
	h := newProxiedHarness(t)
	servingName := "web-aaaaaaaaaaaaaaaa"
	h.eng.put(servingName, repo+":v7", true)
	h.eng.label(servingName, "web")
	h.eng.ctrs[servingName].ports = []docker.Port{{PrivatePort: 3000, PublicPort: 40123, Type: "tcp"}}

	if err := h.d.Recover(context.Background()); err != nil {
		t.Fatal(err)
	}
	if h.eng.container(servingName) == nil {
		t.Fatal("the container that serves was removed as an orphan")
	}
	st := h.state()
	if st.Container != servingName || st.HostPort != 40123 || st.Ref != repo+":v7" {
		t.Errorf("the serving container must be adopted: %+v", st)
	}
	if got := h.upstream(); got != "127.0.0.1:40123" {
		t.Errorf("the proxy must route to the adopted container, got %q", got)
	}
}

// The same when a copy older than the last deployment is restored: app_state names a container that is gone.
func TestRecoverAdoptsTheServingContainerWhenTheStateIsStale(t *testing.T) {
	h := newProxiedHarness(t)
	h.deploy("v1")
	serving := h.state()
	stale := store.AppState{App: "web", Container: "web-0000000000000000", HostPort: 40999, Ref: repo + ":v0"}
	if err := h.st.SetAppState(context.Background(), stale, time.Now()); err != nil {
		t.Fatal(err)
	}

	if err := h.d.Recover(context.Background()); err != nil {
		t.Fatal(err)
	}
	if h.eng.container(serving.Container) == nil {
		t.Fatal("the container that serves was removed as an orphan")
	}
	if got := h.state(); got.Container != serving.Container || got.Ref != repo+":v1" {
		t.Errorf("the stale state must be replaced by the serving container: %+v", got)
	}
}

// With a lost state and several containers, the newest running one is adopted, another running one is never deleted by
// guesswork, and a stopped one is cleaned up.
func TestRecoverWithALostStateNeverDeletesARunningContainer(t *testing.T) {
	h := newProxiedHarness(t)
	for name, image := range map[string]string{"web-1111111111111111": repo + ":old", "web-2222222222222222": repo + ":new", "web-3333333333333333": repo + ":dead"} {
		h.eng.put(name, image, name != "web-3333333333333333")
		h.eng.label(name, "web")
		h.eng.ctrs[name].ports = []docker.Port{{PrivatePort: 3000, PublicPort: 41000, Type: "tcp"}}
	}
	h.eng.started["web-1111111111111111"] = time.Now().Add(-2 * time.Hour)
	h.eng.started["web-2222222222222222"] = time.Now().Add(-time.Hour)

	if err := h.d.Recover(context.Background()); err != nil {
		t.Fatal(err)
	}
	if got := h.state().Container; got != "web-2222222222222222" {
		t.Errorf("the newest running container must be adopted, got %s", got)
	}
	if h.eng.container("web-1111111111111111") == nil {
		t.Error("another running container must be left alone")
	}
	if h.eng.container("web-3333333333333333") != nil {
		t.Error("a stopped orphan is removed")
	}
}

// A first deployment that died before the switch leaves a deployment row and a container but no state: that container
// never served, and it is an orphan to remove (the previous version, if any, kept serving).
func TestRecoverStillRemovesTheContainerOfACrashedFirstDeployment(t *testing.T) {
	h := newProxiedHarness(t)
	h.eng.put("web-deadbeefdeadbeef", repo+":v1", true)
	h.eng.label("web-deadbeefdeadbeef", "web")
	h.eng.ctrs["web-deadbeefdeadbeef"].ports = []docker.Port{{PrivatePort: 3000, PublicPort: 40500, Type: "tcp"}}
	crashed := store.Deployment{ID: "deadbeefdeadbeef", App: "web", Ref: repo + ":v1", Trigger: "api", StartedAt: time.Now()}
	if err := h.st.CreateDeployment(context.Background(), crashed); err != nil {
		t.Fatal(err)
	}

	if err := h.d.Recover(context.Background()); err != nil {
		t.Fatal(err)
	}
	if h.eng.container("web-deadbeefdeadbeef") != nil {
		t.Error("the container of a deployment that never switched must be removed")
	}
	if _, err := h.st.AppState(context.Background(), "web"); !errors.Is(err, store.ErrNotFound) {
		t.Errorf("nothing served, so no state: %v", err)
	}
}
