package deploy

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/0x2u/keelson/agent/internal/config"
	"github.com/0x2u/keelson/agent/internal/docker"
	"github.com/0x2u/keelson/agent/internal/notify"
	"github.com/0x2u/keelson/agent/internal/store"
)

// pipeline is the phases of a deployment as one line: "release:done switch:failed".
func pipeline(dep store.Deployment) string {
	var out []string
	for _, p := range dep.Phases {
		out = append(out, p.Name+":"+p.Status)
	}
	return strings.Join(out, " ")
}

// inPhase is the messages of the events a deployment wrote while the phase ran, one per line.
func inPhase(t *testing.T, st *store.Store, id, phase string) string {
	t.Helper()
	evs, err := st.Events(context.Background(), id, 0)
	if err != nil {
		t.Fatal(err)
	}
	var out []string
	for _, e := range evs {
		if e.Phase == phase {
			out = append(out, e.Message)
		}
	}
	return strings.Join(out, "\n")
}

func mustHave(t *testing.T, what, in string, wants ...string) {
	t.Helper()
	for _, w := range wants {
		if !strings.Contains(in, w) {
			t.Errorf("%s must hold %q, it holds:\n%s", what, w, in)
		}
	}
}

func mustNotHave(t *testing.T, what, in string, nots ...string) {
	t.Helper()
	for _, n := range nots {
		if strings.Contains(in, n) {
			t.Errorf("%s must not hold %q, it holds:\n%s", what, n, in)
		}
	}
}

// Every phase starts where the one before it ended, and none ends before it started.
func checkPhaseTimes(t *testing.T, dep store.Deployment) {
	t.Helper()
	for i, p := range dep.Phases {
		if p.Status == store.PhaseRunning {
			if p.FinishedAt != nil {
				t.Errorf("a running phase has no end: %+v", p)
			}
			continue
		}
		if p.FinishedAt == nil || p.FinishedAt.Before(p.StartedAt) {
			t.Errorf("phase %s: a finished phase ends after it started: %+v", p.Name, p)
		}
		if i > 0 && p.StartedAt.Before(dep.Phases[i-1].StartedAt) {
			t.Errorf("phase %s starts before the one before it: %+v", p.Name, dep.Phases)
		}
	}
}

func TestPlainInPlaceDeployHasReleaseSwitchAndLiveButNoSoak(t *testing.T) {
	h := newHarness(t)
	dep := h.deploy("v1")
	if got := pipeline(dep); got != "release:done switch:done live:done" {
		t.Fatalf("phases %q", got)
	}
	checkPhaseTimes(t, dep)
	if dep.ServingRef != repo+":v1" {
		t.Errorf("a success serves its own image, got %q", dep.ServingRef)
	}
	mustHave(t, "release", inPhase(t, h.st, dep.ID, store.PhaseRelease), "deploying "+repo+":v1", "pulling")
	mustHave(t, "switch", inPhase(t, h.st, dep.ID, store.PhaseSwitch), "waiting for web to become healthy", "web is healthy")

	second := h.deploy("v2")
	mustHave(t, "switch", inPhase(t, h.st, second.ID, store.PhaseSwitch), "stopping web (running "+repo+":v1)")
	if second.ServingRef != repo+":v2" || second.PreviousRef != repo+":v1" {
		t.Errorf("serving %q previous %q", second.ServingRef, second.PreviousRef)
	}
	// The finishing line is outside every phase: the pipeline is over.
	if got := inPhase(t, h.st, second.ID, ""); !strings.Contains(got, "deployment succeeded") {
		t.Errorf("the last line belongs to no phase: %q", got)
	}
}

func TestProxiedDeployWithoutASoakSkipsIt(t *testing.T) {
	h := newProxiedHarness(t)
	h.deploy("v1")
	dep := h.deploy("v2")
	if got := pipeline(dep); got != "release:done switch:done soak:skipped live:done" {
		t.Fatalf("phases %q", got)
	}
	checkPhaseTimes(t, dep)
	if dep.ServingRef != repo+":v2" {
		t.Errorf("serving %q", dep.ServingRef)
	}
	mustHave(t, "switch", inPhase(t, h.st, dep.ID, store.PhaseSwitch), "switching traffic to", "traffic now goes to the new version")
	mustHave(t, "live", inPhase(t, h.st, dep.ID, store.PhaseLive), "stopping previous container")
	if got := inPhase(t, h.st, dep.ID, store.PhaseSoak); got != "" {
		t.Errorf("a skipped phase has no log: %q", got)
	}
}

func TestProxiedDeployWithASoakWatchesBeforeItStopsThePreviousVersion(t *testing.T) {
	h := newSoakApp(t)
	h.deploy("v1")
	dep := h.deploy("v2")
	if got := pipeline(dep); got != "release:done switch:done soak:done live:done" {
		t.Fatalf("phases %q", got)
	}
	checkPhaseTimes(t, dep)
	soak := dep.Phases[2]
	if soak.FinishedAt.Sub(soak.StartedAt) < 100*time.Millisecond {
		t.Errorf("the soak lasts as long as the watch: %+v", soak)
	}
	mustHave(t, "soak", inPhase(t, h.st, dep.ID, store.PhaseSoak), "watching the new version", "held for the full")
	live := inPhase(t, h.st, dep.ID, store.PhaseLive)
	mustHave(t, "live", live, "stopping previous container")
	mustNotHave(t, "live", live, "watching")
}

func TestAHealthGateThatFailsBeforeTheSwitchLeavesWhatServedServing(t *testing.T) {
	h := newProxiedHarness(t)
	h.deploy("v1")
	h.eng.behavior[repo+":v2"] = "unhealthy"
	dep := h.deploy("v2")
	if dep.Status != store.StatusFailed {
		t.Fatalf("%s: %s", dep.Status, dep.Error)
	}
	if got := pipeline(dep); got != "release:done switch:failed" {
		t.Fatalf("phases %q", got)
	}
	if dep.ServingRef != repo+":v1" {
		t.Errorf("production is untouched: v1 still serves, got %q", dep.ServingRef)
	}
	mustHave(t, "switch", inPhase(t, h.st, dep.ID, store.PhaseSwitch), "new container failed", "the previous version ("+repo+":v1) is still serving")
}

func TestAnInPlaceSwapThatFailsIsRestoredInsideTheSwitchPhase(t *testing.T) {
	h := newHarness(t)
	h.deploy("v1")
	h.eng.behavior[repo+":v2"] = "unhealthy"
	dep := h.deploy("v2")
	if dep.Status != store.StatusRolledBack {
		t.Fatalf("%s: %s", dep.Status, dep.Error)
	}
	if got := pipeline(dep); got != "release:done switch:failed" {
		t.Fatalf("phases %q", got)
	}
	if dep.ServingRef != repo+":v1" {
		t.Errorf("the previous version serves again, got %q", dep.ServingRef)
	}
	mustHave(t, "switch", inPhase(t, h.st, dep.ID, store.PhaseSwitch), "new container failed", "restoring previous container", "previous version restored and healthy")
}

func TestASoakFailureSwitchesBackAndIsRecordedInTheSoakPhase(t *testing.T) {
	h := newSoakApp(t)
	h.deploy("v1")
	h.afterSwitchTo(h.ports[1], func() { h.status[1].Store(500) })

	dep := h.deploy("v2")
	if dep.Status != store.StatusRolledBack {
		t.Fatalf("%s: %s", dep.Status, dep.Error)
	}
	if got := pipeline(dep); got != "release:done switch:done soak:failed" {
		t.Fatalf("a failed soak ends the pipeline: %q", got)
	}
	if dep.ServingRef != repo+":v1" {
		t.Errorf("traffic went back to v1, got %q", dep.ServingRef)
	}
	mustHave(t, "soak", inPhase(t, h.st, dep.ID, store.PhaseSoak), "failed during the soak", "switching traffic back", "traffic goes to the previous version again")
}

func TestASoakFailureWithNothingBeforeItLeavesNothingKnownToServe(t *testing.T) {
	h := newSoakApp(t)
	h.afterSwitchTo(h.ports[0], func() { h.status[0].Store(500) })
	dep := h.deploy("v1")
	if dep.Status != store.StatusFailed {
		t.Fatalf("%s: %s", dep.Status, dep.Error)
	}
	if got := pipeline(dep); got != "release:done switch:done soak:failed" {
		t.Fatalf("phases %q", got)
	}
	if dep.ServingRef != "" {
		t.Errorf("nothing was serving before and the new version failed: %q", dep.ServingRef)
	}
}

func TestAFailedReleaseStepStopsThePipelineThereAndNothingIsTouched(t *testing.T) {
	h := newHarness(t, withRelease(migrate))
	h.deploy("v1")
	h.eng.release = func(docker.ContainerSpec) relOutcome { return relOutcome{exit: 1, lines: []string{"P3009"}} }
	dep := h.deploy("v2")
	if dep.Status != store.StatusFailed {
		t.Fatalf("%s: %s", dep.Status, dep.Error)
	}
	if got := pipeline(dep); got != "release:failed" {
		t.Fatalf("phases %q", got)
	}
	if dep.ServingRef != repo+":v1" {
		t.Errorf("v1 was never touched and still serves, got %q", dep.ServingRef)
	}
	mustHave(t, "release", inPhase(t, h.st, dep.ID, store.PhaseRelease), "release step \"migrate\" failed", "P3009")
}

func TestAFailedPullIsAFailedReleasePhase(t *testing.T) {
	h := newProxiedHarness(t)
	h.deploy("v1")
	h.eng.pullErr = errors.New("manifest unknown")
	dep := h.deploy("nope")
	if got := pipeline(dep); got != "release:failed" || dep.ServingRef != repo+":v1" {
		t.Errorf("phases %q serving %q", got, dep.ServingRef)
	}
}

func TestAFirstDeploymentThatFailsBeforeAnythingServedHasNoServingImage(t *testing.T) {
	h := newHarness(t)
	h.eng.pullErr = errors.New("manifest unknown")
	dep := h.deploy("nope")
	if dep.ServingRef != "" || pipeline(dep) != "release:failed" {
		t.Errorf("phases %q serving %q", pipeline(dep), dep.ServingRef)
	}
	h.eng.pullErr = nil
	h.eng.behavior[repo+":v1"] = "crash"
	dep = h.deploy("v1")
	if dep.Status != store.StatusFailed || dep.ServingRef != "" || pipeline(dep) != "release:done switch:failed" {
		t.Errorf("a first deployment that crashes leaves nothing serving: %s phases %q serving %q", dep.Status, pipeline(dep), dep.ServingRef)
	}
}

func TestAFailedRestoreLeavesNothingKnownToServe(t *testing.T) {
	h := newHarness(t)
	h.deploy("v1")
	h.eng.behavior[repo+":v2"] = "crash"
	h.eng.behavior[repo+":v1"] = "crash"
	dep := h.deploy("v2")
	if dep.Status != store.StatusRollbackFailed || dep.ServingRef != "" || pipeline(dep) != "release:done switch:failed" {
		t.Errorf("%s phases %q serving %q", dep.Status, pipeline(dep), dep.ServingRef)
	}
	if dep.PreviousRef != repo+":v1" {
		t.Errorf("the previous ref is still recorded: %q", dep.PreviousRef)
	}
}

func rollback(t *testing.T, h *harness) store.Deployment {
	t.Helper()
	id, done, err := h.d.Rollback(context.Background(), "web")
	if err != nil {
		t.Fatal(err)
	}
	<-done
	dep, err := h.st.Deployment(context.Background(), id)
	if err != nil {
		t.Fatal(err)
	}
	return dep
}

func TestARollbackSkipsTheReleaseUnlessTheAppAsksForIt(t *testing.T) {
	h := newHarness(t)
	h.deploy("v1")
	h.deploy("v2")
	dep := rollback(t, h)
	if dep.Status != store.StatusSucceeded {
		t.Fatalf("%s: %s", dep.Status, dep.Error)
	}
	if got := pipeline(dep); got != "release:skipped switch:done live:done" {
		t.Fatalf("phases %q", got)
	}
	if dep.ServingRef != repo+":v1" || dep.PreviousRef != repo+":v2" {
		t.Errorf("serving %q previous %q", dep.ServingRef, dep.PreviousRef)
	}

	steps := withRelease(migrate)
	on := newHarness(t, steps, func(a *config.App) { a.Release.OnRollback = true })
	on.deploy("v1")
	on.deploy("v2")
	if got := pipeline(rollback(t, on)); got != "release:done switch:done live:done" {
		t.Errorf("a rollback that runs the steps has a release phase: %q", got)
	}

	skip := newHarness(t, steps)
	skip.deploy("v1")
	skip.deploy("v2")
	if got := pipeline(rollback(t, skip)); got != "release:skipped switch:done live:done" {
		t.Errorf("an app with steps skips them on a rollback by default: %q", got)
	}
}

func TestABuildedDeploymentStartsWithSourceAndBuild(t *testing.T) {
	h := newBuildHarness(t)
	h.b.lines = []string{"Step 1/3 : FROM scratch"}
	dep, err := h.startBuild("web", 1)
	if err != nil {
		t.Fatal(err)
	}
	if got := pipeline(dep); got != "source:done build:done release:done switch:done live:done" {
		t.Fatalf("phases %q", got)
	}
	checkPhaseTimes(t, dep)
	ref := repo + ":" + sha(1)
	source := inPhase(t, h.st, dep.ID, store.PhaseSource)
	mustHave(t, "source", source, "downloading source from api.github.com")
	mustNotHave(t, "source", source, "building")
	build := inPhase(t, h.st, dep.ID, store.PhaseBuild)
	mustHave(t, "build", build, "building "+ref, "Step 1/3 : FROM scratch", "built "+ref)
	mustHave(t, "release", inPhase(t, h.st, dep.ID, store.PhaseRelease), "deploying "+ref+" to web", "not pulled")
	if dep.ServingRef != ref {
		t.Errorf("serving %q", dep.ServingRef)
	}
}

func TestAFailedBuildAndAFailedDownloadAreEachTheirOwnPhase(t *testing.T) {
	h := newBuildHarness(t)
	if dep, err := h.startBuild("web", 1); err != nil || dep.Status != store.StatusSucceeded {
		t.Fatalf("%+v, %v", dep, err)
	}
	h.b.mu.Lock()
	h.b.err = errors.New("build failed: RUN false")
	h.b.mu.Unlock()
	dep, err := h.startBuild("web", 2)
	if err != nil {
		t.Fatal(err)
	}
	if got := pipeline(dep); got != "source:done build:failed" {
		t.Fatalf("phases %q", got)
	}
	if dep.ServingRef != repo+":"+sha(1) {
		t.Errorf("the build never touched what serves: %q", dep.ServingRef)
	}

	h.b.mu.Lock()
	h.b.err, h.b.sourceErr = nil, errors.New("source host answered 404")
	h.b.mu.Unlock()
	dep, err = h.startBuild("web", 3)
	if err != nil {
		t.Fatal(err)
	}
	if got := pipeline(dep); got != "source:failed" {
		t.Fatalf("phases %q", got)
	}
}

func TestABuildForAnotherServerHasNoSwitchAndNothingServesFromIt(t *testing.T) {
	h := newBuildHarness(t)
	dep, err := h.startRequested(requestedBuild(1, &config.Build{}))
	if err != nil {
		t.Fatal(err)
	}
	if dep.Status != store.StatusSucceeded || pipeline(dep) != "source:done build:done" || dep.ServingRef != "" {
		t.Errorf("%s phases %q serving %q", dep.Status, pipeline(dep), dep.ServingRef)
	}
}

func recovered(t *testing.T, h *harness, id string) store.Deployment {
	t.Helper()
	if err := h.d.Recover(context.Background()); err != nil {
		t.Fatal(err)
	}
	dep, err := h.st.Deployment(context.Background(), id)
	if err != nil {
		t.Fatal(err)
	}
	return dep
}

// crashedAt records a deployment that was running (the phases given, the last one still running) when the agent died.
func crashedAt(t *testing.T, h *harness, id, previous string, phases ...string) {
	t.Helper()
	ctx := context.Background()
	if err := h.st.CreateDeployment(ctx, store.Deployment{ID: id, App: "web", Ref: repo + ":v2", Trigger: "api", StartedAt: time.Now()}); err != nil {
		t.Fatal(err)
	}
	if previous != "" {
		if err := h.st.SetPreviousRef(ctx, id, previous); err != nil {
			t.Fatal(err)
		}
	}
	for _, p := range phases {
		if err := h.st.BeginPhase(ctx, id, p, time.Now()); err != nil {
			t.Fatal(err)
		}
	}
}

func TestAnInterruptedDeploymentFailsThePhaseItWasIn(t *testing.T) {
	// In the release: nothing was touched, what ran keeps serving.
	h := newHarness(t)
	h.eng.put("web", repo+":v1", true)
	crashedAt(t, h, "dead", "", store.PhaseRelease)
	dep := recovered(t, h, "dead")
	if dep.Status != store.StatusFailed || pipeline(dep) != "release:failed" || dep.ServingRef != repo+":v1" {
		t.Errorf("%s phases %q serving %q", dep.Status, pipeline(dep), dep.ServingRef)
	}
	if dep.Phases[0].FinishedAt == nil {
		t.Error("the interrupted phase ends when the restart was found out")
	}
	mustHave(t, "release", inPhase(t, h.st, "dead", store.PhaseRelease), "interrupted by an agent restart")

	// In the swap of an in-place app: the previous version is put back.
	h = newHarness(t)
	h.eng.put("web", repo+":v2", false)
	h.eng.put("web.prev", repo+":v1", false)
	crashedAt(t, h, "dead", repo+":v1", store.PhaseRelease, store.PhaseSwitch)
	dep = recovered(t, h, "dead")
	if dep.Status != store.StatusRolledBack || pipeline(dep) != "release:done switch:failed" || dep.ServingRef != repo+":v1" {
		t.Errorf("%s phases %q serving %q", dep.Status, pipeline(dep), dep.ServingRef)
	}
	mustHave(t, "switch", inPhase(t, h.st, "dead", store.PhaseSwitch), "restoring the previous version")
}

func TestAnInterruptedProxiedDeploymentIsJudgedByWhereTheTrafficWent(t *testing.T) {
	// Before the switch: failed, the previous version kept serving.
	h := newProxiedHarness(t)
	h.deploy("v1")
	crashedAt(t, h, "deadbeefdeadbeef", repo+":v1", store.PhaseRelease, store.PhaseSwitch)
	dep := recovered(t, h, "deadbeefdeadbeef")
	if dep.Status != store.StatusFailed || pipeline(dep) != "release:done switch:failed" || dep.ServingRef != repo+":v1" {
		t.Errorf("%s phases %q serving %q", dep.Status, pipeline(dep), dep.ServingRef)
	}

	// After the switch: a success whose soak was cut short.
	h = newProxiedHarness(t)
	h.deploy("v1")
	oldName := h.state().Container
	newName := "web-aaaaaaaaaaaaaaaa"
	h.eng.put(newName, repo+":v2", true)
	h.eng.label(newName, "web")
	h.eng.ctrs[newName].ports = h.eng.ctrs[oldName].ports
	if err := h.st.SetAppState(context.Background(), store.AppState{App: "web", Container: newName, HostPort: h.state().HostPort, Ref: repo + ":v2"}, time.Now()); err != nil {
		t.Fatal(err)
	}
	crashedAt(t, h, "aaaaaaaaaaaaaaaa", repo+":v1", store.PhaseRelease, store.PhaseSwitch, store.PhaseSoak)
	dep = recovered(t, h, "aaaaaaaaaaaaaaaa")
	if dep.Status != store.StatusSucceeded || pipeline(dep) != "release:done switch:done soak:done" || dep.ServingRef != repo+":v2" {
		t.Errorf("%s phases %q serving %q", dep.Status, pipeline(dep), dep.ServingRef)
	}
}

// What a notification says depends on the verb (a deploy or a roll back) and on how it ended, in the words of the
// product, and says what serves.
func TestNotificationsSayDeployAndRollBackAndWhatServes(t *testing.T) {
	const prev = repo + ":v1"
	cases := []struct {
		trigger, status string
		severity        string
		title           string
		message         []string
	}{
		{"api", store.StatusSucceeded, notify.SeverityInfo, "web deployed v2", []string{"Took "}},
		{"promotion", store.StatusSucceeded, notify.SeverityInfo, "web deployed v2", nil},
		{"rollback", store.StatusSucceeded, notify.SeverityInfo, "web rolled back to v2", []string{"Took "}},
		{"api", store.StatusFailed, notify.SeverityWarning, "web: deploy failed", []string{"v1 is still serving.", "boom"}},
		{"rollback", store.StatusFailed, notify.SeverityWarning, "web: rollback failed", []string{"v1 is still serving.", "boom"}},
		{"api", store.StatusRolledBack, notify.SeverityWarning, "web: deploy rolled back", []string{"v1 is serving again.", "boom"}},
		{"rollback", store.StatusRolledBack, notify.SeverityWarning, "web: rollback failed", []string{"v1 is serving again.", "boom"}},
		{"api", store.StatusRollbackFailed, notify.SeverityCritical, "web: deploy failed and the previous version could not be restored", []string{"The app may be down.", "boom"}},
		{"rollback", store.StatusRollbackFailed, notify.SeverityCritical, "web: rollback failed", []string{"The app may be down.", "boom"}},
	}
	for _, c := range cases {
		t.Run(c.trigger+"/"+c.status, func(t *testing.T) {
			h := newHarness(t)
			got := h.capture()
			ctx := context.Background()
			id := "dep-" + c.trigger + "-" + c.status
			if err := h.st.CreateDeployment(ctx, store.Deployment{ID: id, App: "web", Ref: repo + ":v2", Trigger: c.trigger, StartedAt: h.d.now().Add(-3 * time.Second)}); err != nil {
				t.Fatal(err)
			}
			h.st.SetPreviousRef(ctx, id, prev)
			h.d.phase(id, store.PhaseSwitch)
			var cause error
			if c.status != store.StatusSucceeded {
				cause = errors.New("boom")
			}
			h.d.finish(id, c.status, cause)

			evs := got.all()
			if len(evs) != 1 {
				t.Fatalf("one notification, got %+v", evs)
			}
			e := evs[0]
			if e.Title != c.title || e.Severity != c.severity || e.Type != "deployment."+c.status || e.Ref != repo+":v2" {
				t.Errorf("got %q (%s, %s), want %q (%s)", e.Title, e.Type, e.Severity, c.title, c.severity)
			}
			for _, m := range c.message {
				if !strings.Contains(e.Message, m) {
					t.Errorf("message %q must hold %q", e.Message, m)
				}
			}
			if strings.Contains(e.Title, "deployment") {
				t.Errorf("a deployment is never a noun in a title: %q", e.Title)
			}
		})
	}
}

func TestVersionOfNamesAnImageForAHuman(t *testing.T) {
	full := strings.Repeat("ab12", 10)
	digest := strings.Repeat("9f", 32)
	for ref, want := range map[string]string{
		"ghcr.io/o/web:v1.4.2":                  "v1.4.2",
		"ghcr.io/o/web:" + full:                 "ab12ab1",
		"localhost:5000/o/web:v3":               "v3",
		"ghcr.io/o/web@sha256:" + digest:        "sha256:9f9f9f9f9f9f",
		"ghcr.io/o/web:" + full[:39] + "-extra": full[:39] + "-extra",
		"nginx":                                 "nginx",
	} {
		if got := versionOf(ref); got != want {
			t.Errorf("versionOf(%q) = %q, want %q", ref, got, want)
		}
	}
}
