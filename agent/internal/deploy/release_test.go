package deploy

import (
	"context"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/0x2u/keelson/agent/internal/config"
	"github.com/0x2u/keelson/agent/internal/docker"
	"github.com/0x2u/keelson/agent/internal/store"
)

func withRelease(steps ...config.ReleaseStep) func(*config.App) {
	return func(a *config.App) {
		a.Env = map[string]string{"DATABASE_URL": "postgres://db"}
		a.Volumes = []string{"/srv/web/logs:/app/logs"}
		a.Network = "host"
		a.Release = &config.Release{Steps: steps}
		for i := range a.Release.Steps {
			if a.Release.Steps[i].Timeout == nil {
				a.Release.Steps[i].Timeout = config.D(time.Minute)
			}
		}
	}
}

// cmd is a container action running the command.
func cmd(c ...string) config.Action {
	return config.Action{Container: &config.ContainerAction{Command: c}}
}

var migrate = config.ReleaseStep{Name: "migrate", Action: config.Action{Container: &config.ContainerAction{Command: []string{"pnpm", "exec", "prisma", "migrate", "deploy"}}}}

func (h *harness) events(depID string) string {
	h.t.Helper()
	evs, err := h.st.Events(context.Background(), depID, 0)
	if err != nil {
		h.t.Fatal(err)
	}
	var b strings.Builder
	for _, e := range evs {
		fmt.Fprintf(&b, "%s %s\n", e.Level, e.Message)
	}
	return b.String()
}

func indexOfOp(ops []string, prefix string) int {
	for i, op := range ops {
		if strings.HasPrefix(op, prefix) {
			return i
		}
	}
	return -1
}

func TestContainerStepRunsBetweenThePullAndTheSwapWithTheAppsEnvironment(t *testing.T) {
	h := newHarness(t, withRelease(migrate))
	var seen docker.ContainerSpec
	h.eng.release = func(s docker.ContainerSpec) relOutcome {
		seen = s
		return relOutcome{lines: []string{"applying migration 20260101", "done"}}
	}
	h.deploy("v1")
	h.eng.mu.Lock()
	h.eng.ops = nil
	h.eng.mu.Unlock()

	dep := h.deploy("v2")
	if dep.Status != store.StatusSucceeded {
		t.Fatalf("got %s: %s", dep.Status, dep.Error)
	}

	ops := h.eng.opsList()
	order := []string{"pull ", "create web-release-", "start web-release-", "wait web-release-", "remove web-release-", "stop web", "create web "}
	last := -1
	for _, prefix := range order {
		i := indexOfOp(ops, prefix)
		if i <= last {
			t.Fatalf("%q out of order (index %d, previous %d) in %v", prefix, i, last, ops)
		}
		last = i
	}

	if seen.Image != repo+":v2" || strings.Join(seen.Cmd, " ") != "pnpm exec prisma migrate deploy" {
		t.Errorf("the step runs the new image with its own command: %+v", seen)
	}
	if seen.NetworkMode != "host" || len(seen.Binds) != 1 || seen.RestartPolicy != "no" || len(seen.Ports) != 0 {
		t.Errorf("same network and volumes as the app, no restart, no published ports: %+v", seen)
	}
	if got := strings.Join(seen.Env, ","); got != "DATABASE_URL=postgres://db" {
		t.Errorf("the app's environment must reach the step, got %s", got)
	}
	if seen.Labels["keelson.release"] != "true" || seen.Labels["keelson.app"] != "web" {
		t.Errorf("release containers are labelled so leftovers can be found: %v", seen.Labels)
	}
	ev := h.events(dep.ID)
	if !strings.Contains(ev, "[migrate] applying migration 20260101") || !strings.Contains(ev, `release step "migrate": done`) {
		t.Errorf("the step's output must reach the deployment log:\n%s", ev)
	}
}

func TestFailingStepAbortsBeforeAnythingServingIsTouched(t *testing.T) {
	h := newHarness(t, withRelease(migrate))
	h.deploy("v1")
	h.eng.release = func(docker.ContainerSpec) relOutcome {
		return relOutcome{exit: 1, lines: []string{"P3009 migration failed"}}
	}
	h.eng.mu.Lock()
	h.eng.ops = nil
	h.eng.mu.Unlock()

	dep := h.deploy("v2")
	if dep.Status != store.StatusFailed || !strings.Contains(dep.Error, `release step "migrate" failed: exit code 1`) {
		t.Fatalf("got %s: %q", dep.Status, dep.Error)
	}
	ev := h.events(dep.ID)
	if strings.Count(ev, "P3009 migration failed") != 1 || strings.Contains(ev, "output ") || strings.Contains(ev, "last output of") {
		t.Errorf("the failed step's output is in the log once, as the step wrote it, not again as container output:\n%s", ev)
	}
	h.mustImage("web", repo+":v1")
	for _, op := range h.eng.opsList() {
		if strings.HasPrefix(op, "stop ") || strings.HasPrefix(op, "rename ") || op == "create web "+repo+":v2" {
			t.Errorf("the running version must not be touched: %q", op)
		}
	}
	if got := h.eng.snapshot(); len(got) != 1 {
		t.Errorf("the release container must be removed even on failure: %v", got)
	}
	if !strings.Contains(h.events(dep.ID), "[migrate] P3009 migration failed") {
		t.Error("the reason must be in the log")
	}
}

func TestStepsRunInOrderAndTheFirstFailureStopsTheRest(t *testing.T) {
	h := newHarness(t, withRelease(
		config.ReleaseStep{Name: "one", Action: cmd("one")},
		config.ReleaseStep{Name: "two", Action: cmd("two")},
		config.ReleaseStep{Name: "three", Action: cmd("three")},
	))
	var ran []string
	h.eng.release = func(s docker.ContainerSpec) relOutcome {
		ran = append(ran, s.Cmd[0])
		if s.Cmd[0] == "two" {
			return relOutcome{exit: 2}
		}
		return relOutcome{}
	}
	dep := h.deploy("v1")
	if dep.Status != store.StatusFailed || strings.Join(ran, ",") != "one,two" {
		t.Errorf("got %s, ran %v", dep.Status, ran)
	}
}

func TestContinueOnFailureWarnsAndGoesOn(t *testing.T) {
	step := config.ReleaseStep{Name: "backup", Action: cmd("backup"), ContinueOnFailure: true}
	h := newHarness(t, withRelease(step, migrate))
	h.eng.release = func(s docker.ContainerSpec) relOutcome {
		if s.Cmd[0] == "backup" {
			return relOutcome{exit: 1}
		}
		return relOutcome{}
	}
	dep := h.deploy("v1")
	if dep.Status != store.StatusSucceeded {
		t.Fatalf("a tolerated failure must not stop the deployment: %s: %s", dep.Status, dep.Error)
	}
	if ev := h.events(dep.ID); !strings.Contains(ev, `warn release step "backup" failed, continuing`) {
		t.Errorf("the tolerated failure must stay visible:\n%s", ev)
	}
}

func TestHostStepsRunOnTheHostWithoutShellAndWithoutTheAgentsSecrets(t *testing.T) {
	t.Setenv("KEELSON_TOKEN", "do-not-leak")
	t.Setenv("KEELSON_DEPLOY_SECRET", "do-not-leak-either")
	t.Setenv("HARMLESS", "visible")
	h := newHarness(t, withRelease(config.ReleaseStep{
		Name:   "backup",
		Action: config.Action{Host: []string{"sh", "-c", `echo "app=$KEELSON_APP trigger=$KEELSON_TRIGGER ref=$KEELSON_REF harmless=$HARMLESS"; echo "token=[$KEELSON_TOKEN$KEELSON_DEPLOY_SECRET]"; echo oops >&2`}},
	}))
	dep := h.deploy("v1")
	if dep.Status != store.StatusSucceeded {
		t.Fatalf("got %s: %s", dep.Status, dep.Error)
	}
	ev := h.events(dep.ID)
	for _, want := range []string{"[backup] app=web trigger=api ref=" + repo + ":v1 harmless=visible", "[backup] token=[]", "[backup] oops"} {
		if !strings.Contains(ev, want) {
			t.Errorf("missing %q in:\n%s", want, ev)
		}
	}
	if strings.Contains(ev, "do-not-leak") {
		t.Error("the agent's own secrets must not be passed to scripts")
	}
	if indexOfOp(h.eng.opsList(), "create web-release") != -1 {
		t.Error("a host step must not create a container")
	}
}

func TestHostStepFailureAndArgumentsAreNotInterpretedByAShell(t *testing.T) {
	h := newHarness(t, withRelease(config.ReleaseStep{Name: "backup", Action: config.Action{Host: []string{"sh", "-c", "echo disk full; exit 3"}}}))
	dep := h.deploy("v1")
	if dep.Status != store.StatusFailed || !strings.Contains(dep.Error, `release step "backup" failed`) || !strings.Contains(dep.Error, "exit status 3") {
		t.Errorf("got %s: %q", dep.Status, dep.Error)
	}

	h = newHarness(t, withRelease(config.ReleaseStep{Name: "echo", Action: config.Action{Host: []string{"echo", "$(touch /tmp/keelson-release-injected)"}}}))
	h.deploy("v1")
	if !strings.Contains(h.events(h.lastDeployment().ID), "$(touch") {
		t.Error("the argument must reach the program verbatim")
	}
}

func (h *harness) lastDeployment() store.Deployment {
	h.t.Helper()
	list, err := h.st.ListDeployments(context.Background(), "web", 1)
	if err != nil || len(list) == 0 {
		h.t.Fatalf("no deployment: %v", err)
	}
	return list[0]
}

func TestStepsTimeOut(t *testing.T) {
	slow := migrate
	slow.Timeout = config.D(80 * time.Millisecond)
	h := newHarness(t, withRelease(slow))
	h.eng.release = func(docker.ContainerSpec) relOutcome { return relOutcome{hang: true} }
	started := time.Now()
	dep := h.deploy("v1")
	if dep.Status != store.StatusFailed || !strings.Contains(dep.Error, "timed out after 80ms") {
		t.Fatalf("got %s: %q", dep.Status, dep.Error)
	}
	if time.Since(started) > 3*time.Second {
		t.Error("the timeout must end the step promptly")
	}
	if got := h.eng.snapshot(); len(got) != 0 {
		t.Errorf("a timed-out release container must be removed: %v", got)
	}

	hostSlow := config.ReleaseStep{Name: "stuck", Action: config.Action{Host: []string{"sleep", "30"}}, Timeout: config.D(150 * time.Millisecond)}
	h = newHarness(t, withRelease(hostSlow))
	started = time.Now()
	dep = h.deploy("v1")
	if dep.Status != store.StatusFailed || !strings.Contains(dep.Error, "timed out") || time.Since(started) > 5*time.Second {
		t.Errorf("host step: %s %q after %s", dep.Status, dep.Error, time.Since(started))
	}
}

func TestRollbacksSkipReleaseStepsUnlessAsked(t *testing.T) {
	for _, onRollback := range []bool{false, true} {
		h := newHarness(t, withRelease(migrate))
		h.eng.release = func(docker.ContainerSpec) relOutcome { return relOutcome{} }
		h.app.Release = nil
		h.d.config().Apps[0].Release.OnRollback = onRollback

		h.deploy("v1")
		h.deploy("v2")
		h.eng.mu.Lock()
		h.eng.ops = nil
		h.eng.mu.Unlock()

		id, done, err := h.d.Rollback(context.Background(), "web")
		if err != nil {
			t.Fatal(err)
		}
		<-done
		ran := indexOfOp(h.eng.opsList(), "create web-release") != -1
		if ran != onRollback {
			t.Errorf("on_rollback=%v: release ran=%v", onRollback, ran)
		}
		if !onRollback && !strings.Contains(h.events(id), "release steps are skipped for a rollback") {
			t.Error("the skip must be visible in the log")
		}
	}
}

func TestStepWithItsOwnImageFollowsTheAppsTag(t *testing.T) {
	step := migrate
	step.Container.Image = "ghcr.io/o/web-migrate"
	h := newHarness(t, withRelease(step))
	var image string
	h.eng.release = func(s docker.ContainerSpec) relOutcome { image = s.Image; return relOutcome{} }

	if dep := h.deploy("v7"); dep.Status != store.StatusSucceeded {
		t.Fatalf("got %s: %s", dep.Status, dep.Error)
	}
	if image != "ghcr.io/o/web-migrate:v7" {
		t.Errorf("the migrator must come at the app's tag, got %s", image)
	}
	if indexOfOp(h.eng.opsList(), "pull ghcr.io/o/web-migrate v7") == -1 {
		t.Errorf("the step's image must be pulled: %v", h.eng.opsList())
	}

	// A digest names one image: it cannot say which migrator goes with it.
	digest := "sha256:" + strings.Repeat("a", 64)
	id, done, err := h.d.Start(context.Background(), "web", Target{Digest: digest}, "api")
	if err != nil {
		t.Fatal(err)
	}
	<-done
	dep, _ := h.st.Deployment(context.Background(), id)
	if dep.Status != store.StatusFailed || !strings.Contains(dep.Error, "digest") {
		t.Errorf("got %s: %q", dep.Status, dep.Error)
	}
}

func TestReleaseRunsBeforeTheNewBlueGreenContainerExists(t *testing.T) {
	h := newHarness(t, func(a *config.App) {
		a.Domains = []string{"example.com"}
		a.Port, a.ContainerPort = config.PortSpec{Container: 3000}, 3000
		a.Release = &config.Release{Steps: []config.ReleaseStep{{Name: "migrate", Action: cmd("migrate"), Timeout: config.D(time.Minute)}}}
	})
	h.deploy("v1")
	h.eng.release = func(docker.ContainerSpec) relOutcome { return relOutcome{exit: 1} }
	before := h.state()
	routes := h.px.count()

	dep := h.deploy("v2")
	if dep.Status != store.StatusFailed || h.state() != before || h.px.count() != routes {
		t.Fatalf("a failed release must leave a blue/green app and its proxy alone: %s", dep.Status)
	}
	if h.eng.container("web-"+dep.ID) != nil {
		t.Error("the new container must never have been created")
	}
}

func TestStepOutputIsCapped(t *testing.T) {
	h := newHarness(t, withRelease(migrate))
	h.eng.release = func(docker.ContainerSpec) relOutcome {
		lines := make([]string, maxStepLines+100)
		for i := range lines {
			lines[i] = fmt.Sprintf("line %d", i)
		}
		return relOutcome{lines: lines}
	}
	dep := h.deploy("v1")
	ev := h.events(dep.ID)
	if n := strings.Count(ev, "[migrate] line "); n != maxStepLines {
		t.Errorf("want %d recorded lines, got %d", maxStepLines, n)
	}
	if !strings.Contains(ev, "further output is not recorded") {
		t.Error("the cut must be announced")
	}
}

func TestRecoverRemovesLeftoverReleaseContainers(t *testing.T) {
	h := newHarness(t, withRelease(migrate))
	h.eng.put("web-release-deadbeefdeadbeef-1", repo+":v2", false)
	h.eng.label("web-release-deadbeefdeadbeef-1", "web")
	h.eng.ctrs["web-release-deadbeefdeadbeef-1"].labels["keelson.release"] = "true"
	h.eng.put("web", repo+":v1", true) // the real app is not a release container
	h.eng.label("web", "web")

	if err := h.d.Recover(context.Background()); err != nil {
		t.Fatal(err)
	}
	if h.eng.container("web-release-deadbeefdeadbeef-1") != nil {
		t.Error("a leftover release container must be removed")
	}
	if h.eng.container("web") == nil {
		t.Error("the app itself must never be removed")
	}
}

// fakeBackuper records the databases it is asked to back up, in order with the engine's operations.
type fakeBackuper struct {
	h     *harness
	names []string
	lines []string
	err   error
	block chan struct{}
}

func (f *fakeBackuper) BackupBeforeDeploy(ctx context.Context, name string, out func(string)) error {
	f.names = append(f.names, name)
	f.h.eng.mu.Lock()
	f.h.eng.ops = append(f.h.eng.ops, "backup "+name)
	f.h.eng.mu.Unlock()
	for _, l := range f.lines {
		out(l)
	}
	if f.block != nil {
		select {
		case <-f.block:
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	return f.err
}

func backupStep(database string) config.ReleaseStep {
	return config.ReleaseStep{Name: "backup", Backup: database}
}

func TestBackupStepRunsBeforeTheMigrationAndItsOutputIsInTheLog(t *testing.T) {
	h := newHarness(t, withRelease(backupStep("shop"), migrate))
	b := &fakeBackuper{h: h, lines: []string{"dumped 15 objects", "stored shop-20261028T160000Z.dump.age"}}
	h.d.SetBackuper(b)

	dep := h.deploy("v1")
	if dep.Status != store.StatusSucceeded {
		t.Fatalf("got %s: %s", dep.Status, dep.Error)
	}
	if len(b.names) != 1 || b.names[0] != "shop" {
		t.Fatalf("backed up %v", b.names)
	}
	ops := h.eng.opsList()
	if bk, mig := indexOfOp(ops, "backup shop"), indexOfOp(ops, "create web-release-"); bk < 0 || mig < 0 || bk > mig {
		t.Errorf("the backup must come before the migration container: %v", ops)
	}
	if ev := h.events(dep.ID); !strings.Contains(ev, "[backup] stored shop-20261028T160000Z.dump.age") {
		t.Errorf("the backup's output belongs in the deployment log:\n%s", ev)
	}
}

func TestFailingBackupStopsTheDeploymentBeforeTheMigrationAndTheSwitch(t *testing.T) {
	h := newHarness(t, withRelease(backupStep("shop"), migrate))
	b := &fakeBackuper{h: h}
	h.d.SetBackuper(b)
	h.deploy("v1")
	b.err = fmt.Errorf("pg_dump: connection refused")
	h.eng.mu.Lock()
	h.eng.ops = nil
	h.eng.mu.Unlock()

	dep := h.deploy("v2")
	if dep.Status != store.StatusFailed || !strings.Contains(dep.Error, `release step "backup" failed: pg_dump: connection refused`) {
		t.Fatalf("got %s: %q", dep.Status, dep.Error)
	}
	h.mustImage("web", repo+":v1")
	for _, op := range h.eng.opsList() {
		if strings.HasPrefix(op, "create web-release-") || strings.HasPrefix(op, "stop ") || op == "create web "+repo+":v2" {
			t.Errorf("without a backup the migration must not run and the running version must not be touched: %q", op)
		}
	}
}

func TestBackupStepWithoutADatabaseServiceFailsClearly(t *testing.T) {
	h := newHarness(t, withRelease(backupStep("shop"), migrate))
	dep := h.deploy("v1")
	if dep.Status != store.StatusFailed || !strings.Contains(dep.Error, "no database service") {
		t.Fatalf("got %s: %q", dep.Status, dep.Error)
	}
}

func TestBackupStepTimesOut(t *testing.T) {
	step := backupStep("shop")
	h := newHarness(t, withRelease(step, migrate), func(a *config.App) { a.Release.Steps[0].Timeout = config.D(50 * time.Millisecond) })
	h.d.SetBackuper(&fakeBackuper{h: h, block: make(chan struct{})})
	dep := h.deploy("v1")
	if dep.Status != store.StatusFailed || !strings.Contains(dep.Error, "timed out after 50ms") {
		t.Fatalf("got %s: %q", dep.Status, dep.Error)
	}
}

func TestRollbacksSkipTheBackupStepToo(t *testing.T) {
	h := newHarness(t, withRelease(backupStep("shop"), migrate))
	b := &fakeBackuper{h: h}
	h.d.SetBackuper(b)
	h.deploy("v1")
	h.deploy("v2")
	b.names = nil
	id, done, err := h.d.Rollback(context.Background(), "web")
	if err != nil {
		t.Fatal(err)
	}
	<-done
	if dep, _ := h.st.Deployment(context.Background(), id); dep.Status != store.StatusSucceeded || len(b.names) != 0 {
		t.Fatalf("a rollback must not run the backup step: %+v, backed up %v", dep, b.names)
	}
}
