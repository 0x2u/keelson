package deploy

import (
	"context"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/0x2u/keelson/agent/internal/docker"
	"github.com/0x2u/keelson/agent/internal/store"
)

// outputEvents returns the messages of the events of level "output".
func (h *harness) outputEvents(depID string) []string {
	h.t.Helper()
	evs, err := h.st.Events(context.Background(), depID, 0)
	if err != nil {
		h.t.Fatal(err)
	}
	var out []string
	for _, e := range evs {
		if e.Level == OutputLevel {
			out = append(out, e.Message)
		}
	}
	return out
}

func TestCrashedNewContainerOutputIsKeptBeforeItIsRemoved(t *testing.T) {
	cases := []struct {
		name string
		prep func(*harness)
		want string // status
	}{
		{"first deploy", func(h *harness) {}, store.StatusFailed},
		{"with a previous version", func(h *harness) { h.deploy("v1") }, store.StatusRolledBack},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			h := newHarness(t)
			c.prep(h)
			h.eng.behavior[repo+":v2"] = "crash"
			h.eng.output = map[string][]string{repo + ":v2": {"booting", "Error: DATABASE_URL is required"}}

			dep := h.deploy("v2")
			if dep.Status != c.want {
				t.Fatalf("got %s: %s", dep.Status, dep.Error)
			}
			got := h.outputEvents(dep.ID)
			if len(got) != 2 || got[0] != "booting" || got[1] != "Error: DATABASE_URL is required" {
				t.Fatalf("output events: %q\n%s", got, h.events(dep.ID))
			}
			// The logs are read while the container still exists, and it is removed afterwards.
			ops := h.eng.opsList()
			if indexOfOp(ops, "remove web") < 0 {
				t.Errorf("the failed container must be removed: %v", ops)
			}
			if h.eng.logTails[0] != "200" {
				t.Errorf("the log read is bounded by the engine: tail %q", h.eng.logTails[0])
			}
		})
	}
}

func TestOutputOfAProxiedFailureIsKept(t *testing.T) {
	for _, mode := range []string{"crash", "unhealthy"} {
		t.Run(mode, func(t *testing.T) {
			h := newProxiedHarness(t)
			h.deploy("v1")
			h.eng.behavior[repo+":v2"] = mode
			h.eng.output = map[string][]string{repo + ":v2": {"listening on :3000", "panic: boom"}}

			dep := h.deploy("v2")
			if dep.Status != store.StatusFailed {
				t.Fatalf("got %s", dep.Status)
			}
			if got := h.outputEvents(dep.ID); len(got) != 2 || got[1] != "panic: boom" {
				t.Fatalf("output events: %q", got)
			}
			if h.eng.container("web-"+dep.ID) != nil {
				t.Error("the failed container must be removed")
			}
		})
	}
}

func TestOutputOfARestoredPreviousVersionThatFailsIsKept(t *testing.T) {
	h := newHarness(t)
	h.deploy("v1")
	h.eng.behavior[repo+":v2"] = "crash"
	h.eng.behavior[repo+":v1"] = "crash"
	h.eng.output = map[string][]string{repo + ":v2": {"new broke"}, repo + ":v1": {"old broke too"}}

	dep := h.deploy("v2")
	if dep.Status != store.StatusRollbackFailed {
		t.Fatalf("got %s", dep.Status)
	}
	got := h.outputEvents(dep.ID)
	if len(got) != 2 || got[0] != "new broke" || got[1] != "old broke too" {
		t.Fatalf("both outputs are kept: %q", got)
	}
}

func TestASuccessfulDeployRecordsNoOutput(t *testing.T) {
	h := newHarness(t)
	h.eng.output = map[string][]string{repo + ":v1": {"hello"}}
	dep := h.deploy("v1")
	if got := h.outputEvents(dep.ID); len(got) != 0 {
		t.Errorf("only failures record output: %q", got)
	}
}

func TestSilentFailedContainerIsSaidSo(t *testing.T) {
	h := newHarness(t)
	h.eng.behavior[repo+":v1"] = "crash"
	dep := h.deploy("v1")
	if ev := h.events(dep.ID); !strings.Contains(ev, "printed no output") || len(h.outputEvents(dep.ID)) != 0 {
		t.Errorf("a silent container must be said to be silent:\n%s", ev)
	}
}

func TestOutputIsBoundedToTheEnd(t *testing.T) {
	h := newHarness(t)
	h.eng.behavior[repo+":v1"] = "crash"
	var lines []string
	for i := 0; i < 500; i++ {
		lines = append(lines, fmt.Sprintf("line %03d", i))
	}
	lines = append(lines, strings.Repeat("x", 10_000))
	h.eng.output = map[string][]string{repo + ":v1": lines}

	dep := h.deploy("v1")
	got := h.outputEvents(dep.ID)
	if len(got) != maxOutputLines {
		t.Fatalf("%d lines kept, want %d", len(got), maxOutputLines)
	}
	if got[len(got)-2] != "line 499" {
		t.Errorf("the end of the output is kept, got %q", got[len(got)-2])
	}
	if last := got[len(got)-1]; len(last) > maxOutputLine+len("…") || !strings.HasSuffix(last, "…") {
		t.Errorf("a long line is cut: %d bytes", len(last))
	}
	if !strings.Contains(h.events(dep.ID), "older lines are not kept") {
		t.Error("the cut must be told")
	}
}

func TestOutputByteCapKeepsTheEnd(t *testing.T) {
	line := strings.Repeat("y", 1000)
	var lines []string
	for i := 0; i < 100; i++ {
		lines = append(lines, fmt.Sprintf("%02d %s", i, line))
	}
	kept, cut := boundOutput(lines)
	total := 0
	for _, l := range kept {
		total += len(l) + 1
	}
	if !cut || total > maxOutputBytes || len(kept) == 0 || !strings.HasPrefix(kept[len(kept)-1], "99 ") {
		t.Fatalf("cut=%v total=%d kept=%d", cut, total, len(kept))
	}
	if len(kept) < 30 { // 32 KiB holds 32 lines of 1 KiB
		t.Errorf("too much dropped: %d lines", len(kept))
	}
}

func TestLogsThatHangDoNotHoldTheDeployment(t *testing.T) {
	h := newHarness(t)
	h.eng.behavior[repo+":v1"] = "crash"
	h.eng.logsHang = true
	defer func(old time.Duration) { outputTimeout = old }(outputTimeout)
	outputTimeout = 100 * time.Millisecond

	start := time.Now()
	dep := h.deploy("v1")
	if dep.Status != store.StatusFailed {
		t.Fatalf("got %s", dep.Status)
	}
	if time.Since(start) > 5*time.Second {
		t.Error("reading the logs must be bounded")
	}
	if h.eng.container("web") != nil {
		t.Error("the container must be removed even when its logs hang")
	}
	if !strings.Contains(h.events(dep.ID), "could not read the output") {
		t.Errorf("the failure to read must be told:\n%s", h.events(dep.ID))
	}
}

func TestUnreadableLogsStillRemoveTheContainer(t *testing.T) {
	h := newProxiedHarness(t)
	h.eng.behavior[repo+":v1"] = "crash"
	h.eng.logsErr = fmt.Errorf("engine hiccup")
	dep := h.deploy("v1")
	if dep.Status != store.StatusFailed || h.eng.container("web-"+dep.ID) != nil {
		t.Fatalf("got %s; container %v", dep.Status, h.eng.container("web-"+dep.ID))
	}
	if !strings.Contains(h.events(dep.ID), "warn could not read the output of web-"+dep.ID+": engine hiccup") {
		t.Errorf("events:\n%s", h.events(dep.ID))
	}
}

func TestAnAppsContainersAreRemovedKeepingTheirVolumes(t *testing.T) {
	h := newHarness(t)
	h.eng.behavior[repo+":v2"] = "crash"
	h.deploy("v1")
	h.deploy("v2")
	h.eng.mu.Lock()
	removed := append([]string(nil), h.eng.volumesRemoved...)
	h.eng.mu.Unlock()
	if len(removed) != 0 {
		t.Errorf("an app's container keeps its volumes: %v", removed)
	}
}

func TestReleaseAndLeftoverThrowawaysAreRemovedWithTheirVolumes(t *testing.T) {
	h := newHarness(t, withRelease(migrate))
	h.eng.release = func(docker.ContainerSpec) relOutcome { return relOutcome{lines: []string{"ok"}} }
	h.deploy("v1")
	h.eng.put("web-release-deadbeefdeadbeef-1", repo+":v1", false)
	h.eng.label("web-release-deadbeefdeadbeef-1", "web")
	h.eng.ctrs["web-release-deadbeefdeadbeef-1"].labels["keelson.release"] = "true"

	if err := h.d.Recover(context.Background()); err != nil {
		t.Fatal(err)
	}
	h.eng.mu.Lock()
	defer h.eng.mu.Unlock()
	var ran, left bool
	for _, n := range h.eng.volumesRemoved {
		switch {
		case n == "web-release-deadbeefdeadbeef-1":
			left = true
		case strings.HasPrefix(n, "web-release-"):
			ran = true
		case n == "web":
			t.Error("an app's container never loses its volumes")
		}
	}
	if !ran || !left {
		t.Errorf("the release container of the run (%v) and the leftover (%v) go with their anonymous volumes: %v", ran, left, h.eng.volumesRemoved)
	}
}
