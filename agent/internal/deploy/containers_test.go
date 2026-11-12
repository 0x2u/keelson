package deploy

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/0x2u/keelson/agent/internal/config"
	"github.com/0x2u/keelson/agent/internal/docker"
)

func (f *fakeEngine) running(name string) bool {
	c := f.container(name)
	return c != nil && c.running
}

func (f *fakeEngine) clearOps() {
	f.mu.Lock()
	f.ops, f.stopTimeouts = nil, nil
	f.mu.Unlock()
}

func TestStartContainerStartsAStoppedContainerOfAnApp(t *testing.T) {
	h := newHarness(t)
	h.deploy("v1")
	h.eng.mu.Lock()
	h.eng.ctrs["web"].running = false
	h.eng.mu.Unlock()
	h.eng.clearOps()

	if err := h.d.StartContainer(context.Background(), "web"); err != nil {
		t.Fatal(err)
	}
	if !h.eng.running("web") {
		t.Error("the container must be running")
	}
	if ops := h.eng.opsList(); len(ops) != 1 || ops[0] != "start web" {
		t.Errorf("a start only starts: %v", ops)
	}
}

func TestRestartContainerStopsWithTheStopTimeoutOfTheAppThenStarts(t *testing.T) {
	h := newHarness(t, func(a *config.App) { a.StopTimeout = config.D(7 * time.Second) })
	h.deploy("v1")
	h.eng.clearOps()

	if err := h.d.RestartContainer(context.Background(), "web"); err != nil {
		t.Fatal(err)
	}
	ops := h.eng.opsList()
	if len(ops) != 2 || ops[0] != "stop web" || ops[1] != "start web" {
		t.Fatalf("ops %v", ops)
	}
	if h.eng.stopTimeouts[0] != 7 {
		t.Errorf("stop timeout %d, want the app's 7", h.eng.stopTimeouts[0])
	}
	if !h.eng.running("web") {
		t.Error("the container must be running again")
	}
}

func TestContainerOfAnAppNoLongerConfiguredRestartsWithTheDefaultStopTimeout(t *testing.T) {
	h := newHarness(t)
	h.eng.put("old-1", "o/old:v1", true)
	h.eng.label("old-1", "old")
	if err := h.d.RestartContainer(context.Background(), "old-1"); err != nil {
		t.Fatal(err)
	}
	if h.eng.stopTimeouts[0] != int(config.DefaultStopTimeout.Seconds()) {
		t.Errorf("stop timeout %d", h.eng.stopTimeouts[0])
	}
}

func TestOnlyManagedContainersAreStartedOrRestarted(t *testing.T) {
	h := newHarness(t)
	h.eng.put("portainer", "portainer/portainer-ce", true) // no keelson.app label
	h.eng.clearOps()
	for name, act := range map[string]func(context.Context, string) error{"start": h.d.StartContainer, "restart": h.d.RestartContainer} {
		if err := act(context.Background(), "portainer"); !errors.Is(err, ErrNotManaged) {
			t.Errorf("%s of an unmanaged container: %v", name, err)
		}
		if err := act(context.Background(), "nothing"); !docker.IsNotFound(err) {
			t.Errorf("%s of an unknown container: %v", name, err)
		}
	}
	for _, op := range h.eng.opsList() {
		t.Errorf("an unmanaged or unknown container must not be touched: %q", op)
	}
}

func TestContainerOfAnAppWithADeploymentRunningIsBusy(t *testing.T) {
	h := newHarness(t)
	h.deploy("v1")
	h.eng.clearOps()
	if !h.d.reserve("web") {
		t.Fatal("reserve")
	}
	if err := h.d.RestartContainer(context.Background(), "web"); !errors.Is(err, ErrBusy) {
		t.Fatalf("got %v", err)
	}
	if len(h.eng.opsList()) != 0 {
		t.Errorf("nothing may move under a deployment: %v", h.eng.opsList())
	}
	h.d.release("web")
	if err := h.d.RestartContainer(context.Background(), "web"); err != nil {
		t.Errorf("the lock must be taken only while the action runs: %v", err)
	}
}

func TestRestartedBlueGreenContainerGetsItsRouteCorrectedAtOnce(t *testing.T) {
	h := newProxiedHarness(t)
	h.deploy("v1")
	st := h.state()
	h.eng.mu.Lock()
	h.eng.rePort = 41999 // the engine gives the restarted container another host port
	h.eng.mu.Unlock()

	if err := h.d.RestartContainer(context.Background(), st.Container); err != nil {
		t.Fatal(err)
	}
	if h.upstream() != "127.0.0.1:41999" || h.state().HostPort != 41999 {
		t.Errorf("route %q / state %d must follow the port the restart gave", h.upstream(), h.state().HostPort)
	}
}

func TestStartingAStoppedBlueGreenContainerBringsItsRouteBack(t *testing.T) {
	h := newProxiedHarness(t)
	h.deploy("v1")
	st := h.state()
	h.eng.mu.Lock()
	h.eng.ctrs[st.Container].running = false
	h.eng.mu.Unlock()
	if err := h.d.Reconcile(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(h.px.last()) != 0 {
		t.Fatalf("a stopped app has no route: %+v", h.px.last())
	}
	if err := h.d.StartContainer(context.Background(), st.Container); err != nil {
		t.Fatal(err)
	}
	if h.upstream() == "" {
		t.Error("a started app is routed again")
	}
}

// Even when the restart did not go through the agent (docker restart by hand, the engine's own restart policy), the
// reconcile loop corrects the route within its period.
func TestReconcilerCorrectsTheRouteOfAContainerRestartedBehindItsBack(t *testing.T) {
	h := newProxiedHarness(t)
	h.deploy("v1")
	st := h.state()
	h.eng.mu.Lock()
	h.eng.rePort = 42001
	h.eng.mu.Unlock()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go h.d.RunReconciler(ctx, 10*time.Millisecond)

	ctxb := context.Background()
	if err := h.eng.Stop(ctxb, st.Container, 1); err != nil {
		t.Fatal(err)
	}
	if err := h.eng.Start(ctxb, st.Container); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(5 * time.Second)
	for h.upstream() != "127.0.0.1:42001" {
		if time.Now().After(deadline) {
			t.Fatalf("route still %q after the reconcile period (state %+v)", h.upstream(), h.state())
		}
		time.Sleep(5 * time.Millisecond)
	}
}
