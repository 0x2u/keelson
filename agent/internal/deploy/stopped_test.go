package deploy

import (
	"context"
	"errors"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/0x2u/keelson/agent/internal/config"
	"github.com/0x2u/keelson/agent/internal/notify"
	"github.com/0x2u/keelson/agent/internal/proxy"
)

// setEnabled puts the app of the harness in force as the file would say it: enabled: false, or the key removed.
func (h *harness) setEnabled(on bool) {
	h.t.Helper()
	cfg := *h.d.config()
	apps := append([]config.App(nil), cfg.Apps...)
	if on {
		apps[0].Enabled = nil
	} else {
		off := false
		apps[0].Enabled = &off
	}
	cfg.Apps = apps
	h.d.cfg.Store(&cfg)
}

func eventually(t *testing.T, what string, ok func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for !ok() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func stopOps(h *harness) []string {
	var out []string
	for _, op := range h.eng.opsList() {
		if strings.HasPrefix(op, "stop ") {
			out = append(out, op)
		}
	}
	return out
}

func TestEnforceStoppedStopsEveryRunningContainerOfAStoppedAppAndNothingElse(t *testing.T) {
	h := newProxiedHarness(t)
	h.deploy("v1")
	serving := h.state().Container
	// Something started an older container of the app behind the agent's back, and another app runs beside it.
	h.eng.put("web-0123456789abcdef", repo+":v0", true)
	h.eng.label("web-0123456789abcdef", "web")
	h.eng.put("other", "o/other:1", true)
	h.eng.label("other", "other")
	h.eng.clearOps()

	if err := h.d.EnforceStopped(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(stopOps(h)) != 0 {
		t.Fatalf("an enabled app is never stopped: %v", h.eng.opsList())
	}

	h.setEnabled(false)
	if err := h.d.EnforceStopped(context.Background()); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{serving, "web-0123456789abcdef"} {
		c := h.eng.container(name)
		if c == nil || c.running {
			t.Errorf("%s must be stopped, and kept (config, data and the way back are kept): %+v", name, c)
		}
	}
	if !h.eng.running("other") {
		t.Error("a container of another app must be left alone")
	}
	for _, op := range h.eng.opsList() {
		if strings.HasPrefix(op, "remove") || strings.HasPrefix(op, "start") {
			t.Errorf("stopping an app only stops: %q", op)
		}
	}
	if got := h.eng.stopTimeouts; len(got) != 2 || got[0] != 1 || got[1] != 1 {
		t.Errorf("the stop uses the stop_timeout of the app (1s in this harness): %v", got)
	}

	// Idempotent: nothing is running, so nothing is stopped again.
	h.eng.clearOps()
	if err := h.d.EnforceStopped(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(h.eng.opsList()) != 0 {
		t.Errorf("a second pass has nothing to do: %v", h.eng.opsList())
	}
}

// A deployment moves containers about, and a start of a container holds the app's lock too: the app is looked at again at
// the next tick, not fought with.
func TestEnforceStoppedLeavesAnAppUnderDeploymentAlone(t *testing.T) {
	h := newProxiedHarness(t)
	h.deploy("v1")
	h.setEnabled(false)
	h.eng.clearOps()

	if !h.d.reserve("web") {
		t.Fatal("the app should be free")
	}
	if err := h.d.EnforceStopped(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(stopOps(h)) != 0 {
		t.Fatalf("an app with a deployment under way must not be stopped from under it: %v", h.eng.opsList())
	}
	h.d.release("web")
	if err := h.d.EnforceStopped(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(stopOps(h)) != 1 {
		t.Errorf("once the deployment is over the app is stopped: %v", h.eng.opsList())
	}
}

func TestEverythingThatPutsANewVersionOnAStoppedAppIsRefused(t *testing.T) {
	h := newProxiedHarness(t)
	h.deploy("v1")
	h.deploy("v2") // something to roll back to
	h.setEnabled(false)
	ctx := context.Background()
	ops := len(h.eng.opsList())

	check := func(what string, err error) {
		t.Helper()
		var stopped *StoppedError
		if !errors.As(err, &stopped) || stopped.App != "web" {
			t.Fatalf("%s: want a *StoppedError for web, got %v", what, err)
		}
		if err.Error() != "app web is stopped (enabled: false): start it first" {
			t.Errorf("%s: the message is part of the API: %q", what, err)
		}
	}
	_, _, err := h.d.Start(ctx, "web", Target{Tag: "v3"}, "api")
	check("deploy", err)
	_, _, err = h.d.Rollback(ctx, "web")
	check("rollback", err)
	check("start a container", h.d.StartContainer(ctx, h.state().Container))
	check("restart a container", h.d.RestartContainer(ctx, h.state().Container))

	if got := h.eng.opsList(); len(got) != ops {
		t.Errorf("a refused request must not touch the engine: %v", got[ops:])
	}
	if deps, _ := h.st.ListDeployments(ctx, "web", 10); len(deps) != 2 {
		t.Errorf("a refused deployment leaves no record: %d deployments", len(deps))
	}
	if !h.d.reserve("web") {
		t.Error("a refusal must not keep the app's lock")
	}
	h.d.release("web")

	// Started again from the file, it deploys like any app.
	h.setEnabled(true)
	if dep := h.deploy("v3"); dep.Status != "succeeded" {
		t.Errorf("%s: %s", dep.Status, dep.Error)
	}
}

func TestAStoppedAppMakesNoPreview(t *testing.T) {
	h := newPreviewHarness(t, defaultPreviews)
	h.d.cfg.Store(parseConfig(t, strings.Replace(previewConfig(h.envFile, defaultPreviews), "    project: shop\n", "    project: shop\n    enabled: false\n", 1)))
	_, _, err := h.d.StartPreview(context.Background(), "web", 7, Target{Tag: "v1"})
	var stopped *StoppedError
	if !errors.As(err, &stopped) {
		t.Fatalf("a stopped parent makes no preview: %v", err)
	}
	if previews, _ := h.d.Previews(context.Background()); len(previews) != 0 {
		t.Errorf("no instance may exist: %+v", previews)
	}
}

func TestAStoppedProxiedAppGetsAStoppedRouteAndKeepsItWithoutChurn(t *testing.T) {
	h := newProxiedHarness(t)
	h.deploy("v1")
	ctx := context.Background()
	h.setEnabled(false)
	if err := h.d.EnforceStopped(ctx); err != nil {
		t.Fatal(err)
	}
	if err := h.d.Reconcile(ctx); err != nil {
		t.Fatal(err)
	}
	got := h.px.last()
	if len(got) != 1 || !got[0].Stopped || got[0].Down || got[0].Canary != nil || len(got[0].Hosts) != 2 || got[0].Hosts[1] != "www.example.com" {
		t.Fatalf("both domains of a stopped app answer 'stopped', not 502 for a container that is down on purpose: %+v", got)
	}
	if want := "127.0.0.1:" + strconv.Itoa(h.state().HostPort); got[0].Upstream != want {
		t.Errorf("nginx's upstream block keeps the address the app had: %q, want %q", got[0].Upstream, want)
	}

	n := h.px.count()
	if err := h.d.Reconcile(ctx); err != nil {
		t.Fatal(err)
	}
	if h.px.count() != n {
		t.Error("an unchanged stopped route must not be pushed again at every tick")
	}

	// Every other way the routes are built (the switch of a deployment, the removal of a preview) agrees.
	routes, err := h.d.routesFromState(ctx, nil)
	if err != nil || len(routes) != 1 || !routes[0].Stopped {
		t.Errorf("routesFromState: %+v %v", routes, err)
	}
}

// A stopped app that was never deployed, or whose container is gone, still answers: a host without a route would answer
// an empty 200 (Caddy), the very thing a stopped app must not do.
func TestAStoppedAppWithoutAContainerStillAnswers(t *testing.T) {
	h := newProxiedHarness(t)
	h.setEnabled(false)
	if err := h.d.Reconcile(context.Background()); err != nil {
		t.Fatal(err)
	}
	if got := h.px.last(); len(got) != 1 || !got[0].Stopped || got[0].Upstream != "" || got[0].Hosts[0] != "example.com" {
		t.Errorf("%+v", got)
	}
}

func TestAStoppedHostPortAppKeepsItsUpstreamForNginx(t *testing.T) {
	h := newHostApp(t)
	cfg := *h.d.config()
	cfg.Proxy = &config.Proxy{Type: config.ProxyNginx, UpstreamsFile: "/unused", Reload: []string{"true"}}
	h.d.cfg.Store(&cfg)
	h.deploy("v1")
	h.setEnabled(false)
	if err := h.d.Reconcile(context.Background()); err != nil {
		t.Fatal(err)
	}
	last := h.px.last()
	if len(last) != 1 || !last[0].Stopped || last[0].Upstream != "127.0.0.1:"+strconv.Itoa(h.ports[0]) {
		t.Fatalf("nginx needs the upstream its server block names: %+v", last)
	}
	if !strings.Contains(string(proxy.RenderNginx(last)), "server 127.0.0.1:"+strconv.Itoa(h.ports[0])+" down;") {
		t.Errorf("it is rendered down:\n%s", proxy.RenderNginx(last))
	}
}

// The whole way, as the dashboard drives it: the file changes (the reload path), the container stops by itself and the host
// answers 'stopped'; the file changes back, nothing starts by itself, the container is started as the API does, and the
// route is the app's again.
func TestStoppingAndStartingAnAppThroughTheFile(t *testing.T) {
	h := newProxiedHarness(t)
	h.deploy("v1")
	ctx := context.Background()
	container := h.state().Container
	old := h.d.config()
	h.eng.clearOps()

	off := false
	next := *old
	next.Apps = append([]config.App(nil), old.Apps...)
	next.Apps[0].Enabled = &off
	commit, err := h.d.Prepare(old, &next)
	if err != nil {
		t.Fatal(err)
	}
	commit()
	eventually(t, "the container of the stopped app to be stopped and its route to say so", func() bool {
		last := h.px.last()
		return !h.eng.running(container) && len(last) == 1 && last[0].Stopped
	})
	if h.eng.container(container) == nil {
		t.Fatal("stopping keeps the container")
	}

	// Enabled again: the agent starts nothing.
	commit, err = h.d.Prepare(&next, old)
	if err != nil {
		t.Fatal(err)
	}
	commit()
	eventually(t, "the proxy to follow the file", func() bool {
		last := h.px.last()
		return len(last) == 0 || !last[0].Stopped
	})
	if err := h.d.EnforceStopped(ctx); err != nil {
		t.Fatal(err)
	}
	if err := h.d.Reconcile(ctx); err != nil {
		t.Fatal(err)
	}
	if h.eng.running(container) {
		t.Fatal("the agent must not start an app by itself")
	}
	for _, op := range h.eng.opsList() {
		if op == "start "+container {
			t.Fatalf("the agent started the container by itself: %v", h.eng.opsList())
		}
	}

	if err := h.d.StartContainer(ctx, container); err != nil {
		t.Fatal(err)
	}
	if last := h.px.last(); len(last) != 1 || last[0].Stopped || last[0].Upstream != "127.0.0.1:"+strconv.Itoa(h.state().HostPort) {
		t.Errorf("a started app is routed again like any started container: %+v", last)
	}
}

// Prepare must not fire the background work for a reload that changes nothing about which apps are stopped.
func TestAReloadThatStopsNoAppDoesNotStopAnything(t *testing.T) {
	h := newProxiedHarness(t)
	h.deploy("v1")
	old := h.d.config()
	next := *old
	next.Apps = append([]config.App(nil), old.Apps...)
	next.Apps[0].Domains = []string{"example.com"}
	h.eng.clearOps()
	commit, err := h.d.Prepare(old, &next)
	if err != nil {
		t.Fatal(err)
	}
	commit()
	time.Sleep(50 * time.Millisecond)
	if ops := h.eng.opsList(); len(ops) != 0 {
		t.Errorf("%v", ops)
	}
}

// Whatever starts the container of a stopped app (a person with docker start, a restart policy after a reboot) is undone
// by the reconcile loop, within its period.
func TestTheReconcilerStopsAContainerStartedBehindItsBack(t *testing.T) {
	h := newProxiedHarness(t)
	h.deploy("v1")
	container := h.state().Container
	h.setEnabled(false)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go h.d.RunReconciler(ctx, 10*time.Millisecond)
	eventually(t, "the stop", func() bool { return !h.eng.running(container) })

	if err := h.eng.Start(ctx, container); err != nil { // docker start, by hand
		t.Fatal(err)
	}
	eventually(t, "the second stop", func() bool { return !h.eng.running(container) })
}

func TestObserveAndAppsSayAStoppedAppIsStopped(t *testing.T) {
	h := newProxiedHarness(t)
	h.deploy("v1")
	ctx := context.Background()
	h.setEnabled(false)
	h.eng.clearOps()

	states, err := h.d.Observe(ctx)
	if err != nil || len(states) != 1 || !states[0].Stopped {
		t.Fatalf("the watcher must be told: %+v %v", states, err)
	}
	var _ notify.Source = h.d
	apps, err := h.d.Apps(ctx)
	if err != nil || len(apps) != 1 || apps[0].Enabled || apps[0].Container == nil {
		t.Fatalf("a stopped app is listed as not enabled, with its container: %+v %v", apps, err)
	}
	h.setEnabled(true)
	if apps, _ = h.d.Apps(ctx); !apps[0].Enabled {
		t.Error("an app is enabled unless the file says otherwise")
	}
	if states, _ = h.d.Observe(ctx); states[0].Stopped {
		t.Error("the file does not stop it")
	}
}
