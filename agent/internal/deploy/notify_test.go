package deploy

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"

	"github.com/0x2u/keelson/agent/internal/notify"
	"github.com/0x2u/keelson/agent/internal/store"
)

type captured struct {
	mu     sync.Mutex
	events []notify.Event
}

func (c *captured) Emit(e notify.Event) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.events = append(c.events, e)
}

func (c *captured) all() []notify.Event {
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([]notify.Event(nil), c.events...)
}

func (h *harness) capture() *captured {
	c := &captured{}
	h.d.SetEmitter(c)
	return c
}

func TestEveryDeploymentEndIsReportedWithItsRecord(t *testing.T) {
	h := newHarness(t)
	c := h.capture()

	ok := h.deploy("v1")
	h.eng.behavior[repo+":v2"] = "unhealthy"
	rolled := h.deploy("v2")
	h.eng.pullErr = errors.New("manifest unknown")
	failed := h.deploy("nope")
	h.eng.pullErr = nil
	h.eng.behavior[repo+":v3"] = "crash"
	h.eng.behavior[repo+":v1"] = "crash" // the restored version fails too
	broken := h.deploy("v3")

	want := []struct{ typ, severity, id string }{
		{"deployment.succeeded", notify.SeverityInfo, ok.ID},
		{"deployment.rolled_back", notify.SeverityWarning, rolled.ID},
		{"deployment.failed", notify.SeverityWarning, failed.ID},
		{"deployment.rollback_failed", notify.SeverityCritical, broken.ID},
	}
	got := c.all()
	if len(got) != len(want) {
		t.Fatalf("want %d events, got %d: %+v", len(want), len(got), got)
	}
	for i, w := range want {
		e := got[i]
		if e.Type != w.typ || e.Severity != w.severity || e.DeploymentID != w.id || e.App != "web" || !strings.HasPrefix(e.Ref, repo+":") {
			t.Errorf("event %d: %+v, want %+v", i, e, w)
		}
	}
	if !strings.Contains(got[1].Message, "unhealthy") || !strings.Contains(got[1].Message, "v1 is serving again") {
		t.Errorf("a rollback must say what happened and what serves: %q", got[1].Message)
	}
	if !strings.Contains(got[2].Message, "manifest unknown") || !strings.Contains(got[2].Message, "v1 is still serving") {
		t.Errorf("a failure carries its cause and says what still serves: %q", got[2].Message)
	}
	if !strings.Contains(got[3].Message, "may be down") {
		t.Errorf("a failed rollback is an emergency: %q", got[3].Message)
	}
	if !strings.HasPrefix(got[0].Message, "Took ") {
		t.Errorf("a success says how long it took: %q", got[0].Message)
	}
	for i, title := range []string{"web deployed v1", "web: deploy rolled back", "web: deploy failed", "web: deploy failed and the previous version could not be restored"} {
		if got[i].Title != title {
			t.Errorf("event %d: title %q, want %q", i, got[i].Title, title)
		}
	}
}

func TestAnInterruptedDeploymentIsReportedWhenRecovered(t *testing.T) {
	h := newHarness(t)
	h.eng.put("web", repo+":v1", true)
	c := h.capture()
	crashed := store.Deployment{ID: "dead", App: "web", Ref: repo + ":v2", Trigger: "api", StartedAt: h.d.now()}
	if err := h.st.CreateDeployment(context.Background(), crashed); err != nil {
		t.Fatal(err)
	}
	if err := h.d.Recover(context.Background()); err != nil {
		t.Fatal(err)
	}
	got := c.all()
	if len(got) != 1 || got[0].Type != "deployment.failed" || !strings.Contains(got[0].Message, "interrupted") {
		t.Errorf("got %+v", got)
	}
}

func TestObserveReportsStateAndMarksAppsBeingDeployed(t *testing.T) {
	h := newHarness(t)
	ctx := context.Background()

	states, err := h.d.Observe(ctx)
	if err != nil || len(states) != 1 || states[0].Present || states[0].Busy {
		t.Fatalf("an undeployed app is absent: %+v, %v", states, err)
	}

	h.deploy("v1")
	states, _ = h.d.Observe(ctx)
	if !states[0].Present || !states[0].Running || states[0].Health != "healthy" || states[0].Busy {
		t.Errorf("a deployed app is running and healthy: %+v", states[0])
	}

	h.eng.mu.Lock()
	h.eng.ctrs["web"].running = false
	h.eng.ctrs["web"].exitCode = 137
	h.eng.mu.Unlock()
	states, _ = h.d.Observe(ctx)
	if states[0].Running || states[0].ExitCode != 137 {
		t.Errorf("a stopped container is reported as such: %+v", states[0])
	}

	// While a deployment pulls, builds or runs release steps the live container is still serving: it is watched, not
	// marked busy (a crash of the app during a nine-minute build must still alert). It is busy only while it is being
	// replaced: from BeginSwap to EndSwap, and never beyond the deployment, whatever a path forgot to close.
	h.eng.pullGate = make(chan struct{})
	_, done, err := h.d.Start(ctx, "web", Target{Tag: "v2"}, "api")
	if err != nil {
		t.Fatal(err)
	}
	states, _ = h.d.Observe(ctx)
	if states[0].Busy {
		t.Error("an app whose deployment is only pulling is not being replaced: it must still be judged")
	}
	h.d.BeginSwap("web")
	states, _ = h.d.Observe(ctx)
	if !states[0].Busy {
		t.Error("an app being replaced must be marked busy")
	}
	h.d.BeginSwap("web") // windows nest
	h.d.EndSwap("web")
	states, _ = h.d.Observe(ctx)
	if !states[0].Busy {
		t.Error("one window is still open")
	}
	close(h.eng.pullGate)
	<-done
	states, _ = h.d.Observe(ctx)
	if states[0].Busy {
		t.Error("a window nobody closed ends with the deployment: the app must never be muted for good")
	}
}

func TestObserveFollowsTheServingContainerOfBlueGreenApps(t *testing.T) {
	h := newProxiedHarness(t)
	h.deploy("v1")
	states, err := h.d.Observe(context.Background())
	if err != nil || !states[0].Present || !states[0].Running {
		t.Errorf("got %+v, %v", states, err)
	}
}
