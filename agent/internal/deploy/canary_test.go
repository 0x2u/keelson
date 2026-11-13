package deploy

import (
	"context"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/0x2u/keelson/agent/internal/config"
	"github.com/0x2u/keelson/agent/internal/proxy"
	"github.com/0x2u/keelson/agent/internal/store"
)

// newCanaryApp is a soak app that gives each new version 10% then 50% of the visitors, watching it 60ms at each step.
func newCanaryApp(t *testing.T, mutate ...func(*config.App)) *hostApp {
	t.Helper()
	return newSoakApp(t, append([]func(*config.App){func(a *config.App) {
		a.Canary = &config.Canary{Steps: []int{10, 50}, Hold: config.D(60 * time.Millisecond)}
	}}, mutate...)...)
}

// shares is what the proxy was told about example.com, call after call: the percentage of visitors the new version got
// ("10", "50"), or "all" for a route that sends everything to one upstream.
func (h *hostApp) shares() []string {
	h.px.mu.Lock()
	defer h.px.mu.Unlock()
	var out []string
	for _, call := range h.px.calls {
		for _, r := range call {
			if len(r.Hosts) == 0 || r.Hosts[0] != "example.com" {
				continue
			}
			s := "all"
			if r.Canary != nil {
				s = strconv.Itoa(r.Canary.Percent)
			}
			if len(out) == 0 || out[len(out)-1] != s {
				out = append(out, s)
			}
		}
	}
	return out
}

// afterShare runs fn the first time the proxy is told to send percent of the visitors to the new version.
func (h *hostApp) afterShare(percent int, fn func()) {
	done := false
	h.px.mu.Lock()
	h.px.onApply = func(routes []proxy.Route) {
		for _, r := range routes {
			if r.Canary != nil && r.Canary.Percent == percent && !done {
				done = true
				fn()
			}
		}
	}
	h.px.mu.Unlock()
}

func TestACanaryRaisesTheShareStepByStepAndOnlyThenSwitchesEverything(t *testing.T) {
	h := newCanaryApp(t)
	if dep := h.deploy("v1"); dep.Status != store.StatusSucceeded {
		t.Fatalf("%s: %s", dep.Status, dep.Error)
	}
	old := h.state()
	before := len(h.shares())

	dep := h.deploy("v2")
	if dep.Status != store.StatusSucceeded {
		t.Fatalf("%s: %s", dep.Status, dep.Error)
	}
	if got, want := strings.Join(h.shares()[before:], " "), "10 50 all"; got != want {
		t.Errorf("the proxy must be given 10%%, then 50%%, then everything: %q, want %q", got, want)
	}
	if got := h.upstream2(); got != "127.0.0.1:"+strconv.Itoa(h.ports[1]) {
		t.Errorf("after the last step the new version serves alone, the route is %q", got)
	}
	if got := h.state(); got.Ref != repo+":v2" || got.Container == old.Container {
		t.Errorf("app_state must name the new version: %+v", got)
	}
	if h.eng.container(old.Container) != nil {
		t.Error("the previous container must be gone once the new version took everything and held")
	}
	if got, want := pipeline(dep), "switch:done canary:done soak:done live:done"; !strings.HasSuffix(got, want) {
		t.Errorf("the canary is a phase between the switch and the soak: %s, want it to end with %s", got, want)
	}
	mustHave(t, "canary phase", inPhase(t, h.st, dep.ID, store.PhaseCanary),
		"canary 10%: 10% of the visitors go to the new version", "canary 10%: the new version held", "canary 50%: the new version held", "takes all the traffic", "traffic now goes to the new version")
	if got := inPhase(t, h.st, dep.ID, store.PhaseSoak); !strings.Contains(got, "watching the new version") || strings.Contains(got, "canary") {
		t.Errorf("the soak that follows is the soak, not another step: %q", got)
	}
}

func TestEachStepOfACanaryGivesVisitorsItsOwnCookieKey(t *testing.T) {
	h := newCanaryApp(t)
	h.deploy("v1")
	dep := h.deploy("v2")

	keys := map[string]bool{}
	h.px.mu.Lock()
	for _, call := range h.px.calls {
		for _, r := range call {
			if r.Canary != nil {
				keys[r.Canary.Key] = true
			}
		}
	}
	h.px.mu.Unlock()
	want := map[string]bool{dep.ID + "-10": true, dep.ID + "-50": true}
	if len(keys) != 2 || !keys[dep.ID+"-10"] || !keys[dep.ID+"-50"] {
		t.Errorf("a step is a new draw of the visitors, and a cookie of an earlier rollout must never match: keys %v, want %v", keys, want)
	}
}

func TestTheFirstDeploymentOfACanaryAppHasNobodyToShareWith(t *testing.T) {
	h := newCanaryApp(t)
	dep := h.deploy("v1")
	if dep.Status != store.StatusSucceeded {
		t.Fatalf("%s: %s", dep.Status, dep.Error)
	}
	if got := strings.Join(h.shares(), " "); got != "all" {
		t.Errorf("with nothing serving there is nothing to share: %q", got)
	}
	if strings.Contains(pipeline(dep), "canary") {
		t.Errorf("no canary phase when there was no canary: %s", pipeline(dep))
	}
	mustHave(t, "events", h.events(dep.ID), "the canary is skipped")
}

func TestAStepThatFailsSendsEveryVisitorBackAndTheNewVersionNeverTakesAll(t *testing.T) {
	h := newCanaryApp(t)
	h.deploy("v1")
	serving := h.state()
	before := len(h.shares())
	h.afterShare(50, func() { h.status[1].Store(500) })

	dep := h.deploy("v2")
	if dep.Status != store.StatusRolledBack {
		t.Fatalf("a version that breaks at 50%% is rolled back: %s: %s", dep.Status, dep.Error)
	}
	for _, want := range []string{"the canary failed", "canary 50%", "answered 500"} {
		if !strings.Contains(dep.Error, want) {
			t.Errorf("the error must say %q: %s", want, dep.Error)
		}
	}
	if got, want := strings.Join(h.shares()[before:], " "), "10 50 all"; got != want {
		t.Errorf("shares %q, want %q (the last one is the way back to the version that served)", got, want)
	}
	if got := h.upstream2(); got != "127.0.0.1:"+strconv.Itoa(h.ports[0]) {
		t.Errorf("every visitor must be on the previous version, the route is %q", got)
	}
	if got := h.state(); got.Container != serving.Container || got.Ref != serving.Ref {
		t.Errorf("app_state must still name the previous version: %+v, was %+v", got, serving)
	}
	for name := range h.eng.snapshot() {
		if name != serving.Container {
			t.Errorf("the new container must be removed, found %s", name)
		}
	}
	if got := pipeline(dep); !strings.HasSuffix(got, "switch:done canary:failed") {
		t.Errorf("the pipeline must stop at the canary: %s", got)
	}
	if strings.Contains(pipeline(dep), "soak") {
		t.Errorf("a canary that failed never reached the soak: %s", pipeline(dep))
	}
	mustHave(t, "canary phase", inPhase(t, h.st, dep.ID, store.PhaseCanary), "the canary failed", "every visitor is on the previous version again")
	if dep.ServingRef != repo+":v1" {
		t.Errorf("what serves after the failure is the previous version: %q", dep.ServingRef)
	}
}

func TestACanaryStepIsJudgedByItsMetrics(t *testing.T) {
	p := newFakeProm(t)
	h := newCanaryApp(t, func(a *config.App) {
		a.Canary.Hold = config.D(100 * time.Millisecond)
		a.Analysis = &config.Analysis{Address: p.srv.URL, Metrics: []config.Metric{{
			Name:         "error-rate",
			Query:        `rate(errors{app="{{app}}",container="{{container}}",version="{{version}}"}[1m])`,
			Max:          new(0.05),
			Interval:     config.D(20 * time.Millisecond),
			FailureLimit: new(3),
		}}}
	})
	if dep := h.deploy("v1"); dep.Status != store.StatusSucceeded {
		t.Fatalf("%s: %s", dep.Status, dep.Error)
	}
	serving := h.state()
	h.afterShare(10, func() { p.set("0.4") })

	dep := h.deploy("v2")
	if dep.Status != store.StatusRolledBack {
		t.Fatalf("a metric out of bounds during the first step rolls back: %s: %s", dep.Status, dep.Error)
	}
	for _, want := range []string{"canary 10%", "metric error-rate", "above the maximum 0.05"} {
		if !strings.Contains(dep.Error, want) {
			t.Errorf("the error must say %q: %s", want, dep.Error)
		}
	}
	if got := h.upstream2(); got != "127.0.0.1:"+strconv.Itoa(h.ports[0]) {
		t.Errorf("every visitor must be back on the previous version: %q", got)
	}
	if h.state().Container != serving.Container {
		t.Error("app_state must still name the previous version")
	}
	if last := p.asked(); len(last) == 0 || !strings.Contains(last[len(last)-1], `version="`+repo+`:v2"`) {
		t.Errorf("the metric asks about the new version, not about the one that serves: %v", last)
	}
}

func TestACanaryThatTheProxyRefusesChangesNothingAndRollsBack(t *testing.T) {
	h := newCanaryApp(t)
	h.deploy("v1")
	serving := h.state()
	h.px.mu.Lock()
	h.px.err = context.DeadlineExceeded
	h.px.mu.Unlock()

	dep := h.deploy("v2")
	if dep.Status != store.StatusRolledBack || !strings.Contains(dep.Error, "share the traffic") {
		t.Fatalf("%s: %s", dep.Status, dep.Error)
	}
	if got := h.state(); got.Container != serving.Container {
		t.Errorf("app_state must still name the previous version: %+v", got)
	}
	h.d.proxyMu.Lock()
	left := len(h.d.canaries)
	h.d.proxyMu.Unlock()
	if left != 0 {
		t.Errorf("a canary that never started must not be remembered: %d", left)
	}
}

func TestTheReconcilerKeepsTheShareOfACanaryUnderWay(t *testing.T) {
	h := newCanaryApp(t)
	h.deploy("v1")
	h.d.proxyMu.Lock()
	h.d.canaries = map[string]proxy.Canary{"web": {Upstream: "127.0.0.1:" + strconv.Itoa(h.ports[1]), Percent: 10, Key: "k"}}
	h.d.appliedSet = false
	h.d.proxyMu.Unlock()

	if err := h.d.Reconcile(context.Background()); err != nil {
		t.Fatal(err)
	}
	var got *proxy.Canary
	for _, r := range h.px.last() {
		if len(r.Hosts) > 0 && r.Hosts[0] == "example.com" {
			got = r.Canary
		}
	}
	if got == nil || got.Percent != 10 {
		t.Fatalf("the reconciler runs every few seconds: it must not put every visitor back on the previous version in the middle of a rollout: %+v", got)
	}

	// An agent that restarts has no canary in memory: what it applies is app_state alone.
	h.d.proxyMu.Lock()
	h.d.canaries, h.d.appliedSet = nil, false
	h.d.proxyMu.Unlock()
	if err := h.d.Reconcile(context.Background()); err != nil {
		t.Fatal(err)
	}
	for _, r := range h.px.last() {
		if r.Canary != nil {
			t.Errorf("after a restart the previous version serves alone: %+v", r.Canary)
		}
	}
}

func TestTheDeploymentBudgetHoldsTheStepsOfACanary(t *testing.T) {
	a := config.App{Soak: config.D(30 * time.Second)}
	without := soakBudget(a)
	a.Canary = &config.Canary{Steps: []int{10, 50, 90}, Hold: config.D(2 * time.Minute)}
	if got, min := soakBudget(a)-without, 6*time.Minute; got < min {
		t.Errorf("three steps of two minutes add %s to the budget, at least %s are needed", got, min)
	}
}
