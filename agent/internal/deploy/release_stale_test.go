package deploy

import (
	"context"
	"testing"
	"time"

	"github.com/0x2u/keelson/agent/internal/config"
	"github.com/0x2u/keelson/agent/internal/docker"
)

// exitGate is an engine whose containers, once listed in gates, keep running until their channel is closed: Wait blocks
// like the engine's does, and returns when the container "exits" or the caller stops waiting.
type exitGate struct {
	*fakeEngine
	gates map[string]chan struct{}
}

func (g *exitGate) Wait(ctx context.Context, name string) (int, error) {
	gate, ok := g.gates[name]
	if !ok {
		return g.fakeEngine.Wait(ctx, name)
	}
	select {
	case <-gate:
		g.mu.Lock()
		if c, ok := g.ctrs[name]; ok {
			c.running = false
		}
		g.mu.Unlock()
		return 0, nil
	case <-ctx.Done():
		return 0, ctx.Err()
	}
}

const staleRelease = "web-release-deadbeefdeadbeef-1"

// staleHarness has one release container left over by a dead agent, running or not, carrying the timeout label a step
// records ("" for one without), and an engine that keeps it running until the returned channel is closed.
func staleHarness(t *testing.T, running bool, timeout string) (*harness, *exitGate, chan struct{}) {
	t.Helper()
	h := newHarness(t, withRelease(migrate))
	h.eng.put(staleRelease, repo+":v2", running)
	h.eng.label(staleRelease, "web")
	h.eng.mu.Lock()
	h.eng.ctrs[staleRelease].labels[releaseLabel] = "true"
	h.eng.started[staleRelease] = time.Now()
	if timeout != "" {
		h.eng.ctrs[staleRelease].labels[releaseTimeoutLabel] = timeout
	}
	h.eng.mu.Unlock()
	exit := make(chan struct{})
	g := &exitGate{fakeEngine: h.eng, gates: map[string]chan struct{}{staleRelease: exit}}
	h.d.eng = g
	return h, g, exit
}

func waitClosed(t *testing.T, ch <-chan struct{}, what string) {
	t.Helper()
	select {
	case <-ch:
	case <-time.After(5 * time.Second):
		t.Fatalf("timed out: %s", what)
	}
}

func TestRecoverLeavesARunningReleaseContainerAndRemovesItOnceItExits(t *testing.T) {
	h, _, exit := staleHarness(t, true, "10m0s")
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	if err := h.d.Recover(ctx); err != nil {
		t.Fatal(err)
	}
	// Give a (wrong) immediate removal the time to show.
	time.Sleep(50 * time.Millisecond)
	if c := h.eng.container(staleRelease); c == nil || !c.running {
		t.Fatal("a release step still running must not be cut by the agent's start")
	}

	close(exit)
	deadline := time.Now().Add(5 * time.Second)
	for h.eng.container(staleRelease) != nil {
		if time.Now().After(deadline) {
			t.Fatal("the container must be removed once it has exited")
		}
		time.Sleep(10 * time.Millisecond)
	}
	h.eng.mu.Lock()
	defer h.eng.mu.Unlock()
	if len(h.eng.volumesRemoved) != 1 || h.eng.volumesRemoved[0] != staleRelease {
		t.Errorf("it goes with its anonymous volumes, like any throwaway: %v", h.eng.volumesRemoved)
	}
}

func TestRecoverRemovesAnExitedReleaseContainerAtOnce(t *testing.T) {
	h, _, _ := staleHarness(t, false, "10m0s")
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	done, err := h.d.sweepStaleReleases(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if h.eng.container(staleRelease) != nil {
		t.Error("an exited release container is removed before the sweep returns")
	}
	waitClosed(t, done, "no watcher is needed for an exited container")
}

func TestARunningReleaseContainerPastItsTimeoutIsForceRemoved(t *testing.T) {
	// The step's time runs out while the container never exits: it is removed anyway, running.
	h, _, _ := staleHarness(t, true, "50ms")
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	done, err := h.d.sweepStaleReleases(ctx)
	if err != nil {
		t.Fatal(err)
	}
	waitClosed(t, done, "the watcher ends once the timeout has removed the container")
	if h.eng.container(staleRelease) != nil {
		t.Error("a container still running after its step timeout must be force-removed")
	}
}

func TestTheTimeoutCountsFromWhenTheContainerStarted(t *testing.T) {
	h, _, _ := staleHarness(t, true, "10m0s")
	h.eng.mu.Lock()
	h.eng.started[staleRelease] = time.Now().Add(-time.Hour) // well past a 10 minute step
	h.eng.mu.Unlock()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	done, err := h.d.sweepStaleReleases(ctx)
	if err != nil {
		t.Fatal(err)
	}
	waitClosed(t, done, "an overdue container is removed without waiting")
	if h.eng.container(staleRelease) != nil {
		t.Error("the time the agent was down counts against the step's timeout")
	}
}

func TestTheWatcherEndsWithTheAgentAndRemovesNothing(t *testing.T) {
	h, _, _ := staleHarness(t, true, "10m0s")
	ctx, cancel := context.WithCancel(context.Background())

	done, err := h.d.sweepStaleReleases(ctx)
	if err != nil {
		t.Fatal(err)
	}
	cancel()
	waitClosed(t, done, "the watcher must stop when the agent shuts down")
	if c := h.eng.container(staleRelease); c == nil || !c.running {
		t.Error("shutting down must leave the step running: the next start decides")
	}
}

func TestStepTimeoutOf(t *testing.T) {
	for label, want := range map[string]time.Duration{
		"10m0s":     10 * time.Minute,
		"":          config.MaxReleaseTimeout, // a container of an older agent has no record
		"garbage":   config.MaxReleaseTimeout,
		"-1m0s":     config.MaxReleaseTimeout,
		"1000h0m0s": config.MaxReleaseTimeout, // beyond what a step may ask for
	} {
		if got := stepTimeoutOf(map[string]string{releaseTimeoutLabel: label}); got != want {
			t.Errorf("label %q: got %s, want %s", label, got, want)
		}
	}
}

func TestReleaseContainersRecordTheirStepTimeout(t *testing.T) {
	h := newHarness(t, withRelease(config.ReleaseStep{Name: "migrate", Action: cmd("migrate"), Timeout: config.D(3 * time.Minute)}))
	var seen docker.ContainerSpec
	h.eng.release = func(s docker.ContainerSpec) relOutcome { seen = s; return relOutcome{} }
	h.deploy("v1")
	if got := seen.Labels[releaseTimeoutLabel]; got != "3m0s" {
		t.Errorf("timeout label = %q", got)
	}
}
