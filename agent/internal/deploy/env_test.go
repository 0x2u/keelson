package deploy

import (
	"bytes"
	"context"
	"encoding/json"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/0x2u/keelson/agent/internal/appenv"
	"github.com/0x2u/keelson/agent/internal/config"
	"github.com/0x2u/keelson/agent/internal/docker"
	"github.com/0x2u/keelson/agent/internal/store"
)

// A value that must be found nowhere but in the container's environment and the 0600 file.
const (
	secretValue = "pa55-w0rd-Zq81-managed"
	otherSecret = "Other-Secret-7731-xyz"
)

// envHarness is a harness whose app has an env_file and env and whose deployer has a variable store.
func newEnvHarness(t *testing.T, mutate ...func(*config.App)) (*harness, *appenv.Service) {
	t.Helper()
	envFile := filepath.Join(t.TempDir(), "web.env")
	if err := os.WriteFile(envFile, []byte("FROM_FILE=file\nBOTH=file\nDATABASE_URL=postgres://production\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	h := newHarness(t, append([]func(*config.App){func(a *config.App) {
		a.EnvFile = envFile
		a.Env = map[string]string{"FROM_ENV": "env", "BOTH": "env"}
	}}, mutate...)...)
	return h, attachStore(t, h.d)
}

func attachStore(t *testing.T, d *Deployer) *appenv.Service {
	t.Helper()
	st, err := appenv.Open(filepath.Join(t.TempDir(), "env"))
	if err != nil {
		t.Fatal(err)
	}
	d.SetEnvStore(st)
	return d.Env()
}

func mustApply(t *testing.T, svc *appenv.Service, app string, ch appenv.Change) {
	t.Helper()
	if _, err := svc.Apply(app, ch); err != nil {
		t.Fatal(err)
	}
}

func (h *harness) runningEnv() []string {
	h.t.Helper()
	c := h.eng.container("web")
	if st, err := h.st.AppState(context.Background(), "web"); c == nil && err == nil {
		c = h.eng.container(st.Container) // a blue/green app runs under a name of its own
	}
	if c == nil {
		h.t.Fatal("web is not running")
	}
	return c.env
}

func TestStoredVariablesOverrideTheAppsFileAtEveryDeploy(t *testing.T) {
	h, svc := newEnvHarness(t)
	if dep := h.deploy("v1"); dep.Status != store.StatusSucceeded {
		t.Fatalf("%+v", dep)
	}
	if got := strings.Join(h.runningEnv(), ","); got != "FROM_FILE=file,BOTH=env,DATABASE_URL=postgres://production,FROM_ENV=env" {
		t.Fatalf("without stored variables the environment is the file's: %s", got)
	}

	mustApply(t, svc, "web", appenv.Change{Set: map[string]string{"DATABASE_URL": secretValue, "BOTH": "managed", "NEW": "n"}})
	// A change does nothing to the running container: it needs a redeploy ...
	if got := strings.Join(h.runningEnv(), ","); strings.Contains(got, "managed") {
		t.Errorf("a running container's environment cannot change: %s", got)
	}
	// ... and the redeploy has the stored values, which win over env_file and env.
	if dep := h.deploy("v2"); dep.Status != store.StatusSucceeded {
		t.Fatalf("%+v", dep)
	}
	want := "FROM_FILE=file,BOTH=managed,DATABASE_URL=" + secretValue + ",FROM_ENV=env,NEW=n"
	if got := strings.Join(h.runningEnv(), ","); got != want {
		t.Errorf("got  %s\nwant %s", got, want)
	}

	mustApply(t, svc, "web", appenv.Change{Unset: []string{"BOTH", "DATABASE_URL"}})
	h.deploy("v3")
	if got := strings.Join(h.runningEnv(), ","); got != "FROM_FILE=file,BOTH=env,DATABASE_URL=postgres://production,FROM_ENV=env,NEW=n" {
		t.Errorf("removing a stored variable gives the file's back: %s", got)
	}
}

// specEngine records the specs of the containers created, even those removed afterwards.
type specEngine struct {
	*fakeEngine
	mu    sync.Mutex
	specs []docker.ContainerSpec
}

func (e *specEngine) Create(ctx context.Context, s docker.ContainerSpec) (string, error) {
	e.mu.Lock()
	e.specs = append(e.specs, s)
	e.mu.Unlock()
	return e.fakeEngine.Create(ctx, s)
}

func (e *specEngine) spec(label string) (docker.ContainerSpec, bool) {
	e.mu.Lock()
	defer e.mu.Unlock()
	for _, s := range e.specs {
		if s.Labels[label] == "true" {
			return s, true
		}
	}
	return docker.ContainerSpec{}, false
}

func TestReleaseStepsOneOffJobsAndBearerSecretsSeeTheStoredVariables(t *testing.T) {
	h, svc := newEnvHarness(t, func(a *config.App) {
		a.Release = &config.Release{Steps: []config.ReleaseStep{{Name: "migrate", Action: cmd("migrate"), Timeout: config.D(time.Minute)}}}
	})
	eng := &specEngine{fakeEngine: h.eng}
	h.d.eng = eng
	mustApply(t, svc, "web", appenv.Change{Set: map[string]string{"DATABASE_URL": secretValue, "CRON_SECRET": otherSecret}})

	if dep := h.deploy("v1"); dep.Status != store.StatusSucceeded {
		t.Fatalf("%+v %s", dep, h.events(dep.ID))
	}
	rel, ok := eng.spec("keelson.release")
	if !ok || !hasEnv(rel.Env, "DATABASE_URL="+secretValue) {
		t.Errorf("the release step must run with the stored variables: %+v", rel.Env)
	}
	// The release container and the app got the same snapshot.
	if !equal(rel.Env, h.runningEnv()) {
		t.Errorf("release %v\napp     %v", rel.Env, h.runningEnv())
	}

	if err := h.d.RunOneOff(context.Background(), "web", []string{"true"}, func(string) {}); err != nil {
		t.Fatal(err)
	}
	job, ok := eng.spec("keelson.job")
	if !ok || !hasEnv(job.Env, "DATABASE_URL="+secretValue) || !hasEnv(job.Env, "BOTH=env") {
		t.Errorf("a one-off job runs with the stored variables too: %+v", job.Env)
	}

	// A job's bearer secret read from the app's environment follows a rotation without any redeploy.
	if v, err := h.d.EnvVar("web", "CRON_SECRET"); err != nil || v != otherSecret {
		t.Errorf("%q %v", v, err)
	}
	mustApply(t, svc, "web", appenv.Change{Set: map[string]string{"CRON_SECRET": "rotated-secret-0001"}})
	if v, _ := h.d.EnvVar("web", "CRON_SECRET"); v != "rotated-secret-0001" {
		t.Errorf("%q", v)
	}
	if v, err := h.d.EnvVar("web", "FROM_ENV"); err != nil || v != "env" {
		t.Errorf("a variable of the file: %q %v", v, err)
	}
	if _, err := h.d.EnvVar("web", "ABSENT"); err == nil {
		t.Error("an absent variable is an error")
	}
}

func hasEnv(env []string, kv string) bool {
	for _, e := range env {
		if e == kv {
			return true
		}
	}
	return false
}

func equal(a, b []string) bool { return strings.Join(a, "\x00") == strings.Join(b, "\x00") }

// A change made while a deployment is under way cannot corrupt it: the deployment read one snapshot before it started
// to pull, and the next deployment gets the new one.
func TestAChangeDuringADeploymentDoesNotReachIt(t *testing.T) {
	h, svc := newEnvHarness(t)
	mustApply(t, svc, "web", appenv.Change{Set: map[string]string{"GEN": "one", "ALSO": "one"}})
	h.eng.pullGate = make(chan struct{})
	id, done, err := h.d.Start(context.Background(), "web", Target{Tag: "v1"}, "api")
	if err != nil {
		t.Fatal(err)
	}
	waitForOp(t, h.eng, "pull ")
	mustApply(t, svc, "web", appenv.Change{Set: map[string]string{"GEN": "two", "ALSO": "two"}})
	close(h.eng.pullGate)
	<-done
	if dep, _ := h.st.Deployment(context.Background(), id); dep.Status != store.StatusSucceeded {
		t.Fatalf("%+v", dep)
	}
	env := strings.Join(h.runningEnv(), ",")
	if !strings.Contains(env, "GEN=one") || !strings.Contains(env, "ALSO=one") {
		t.Errorf("the deployment must run with the snapshot it started with, whole: %s", env)
	}
	h.deploy("v2")
	if env := strings.Join(h.runningEnv(), ","); !strings.Contains(env, "GEN=two") || !strings.Contains(env, "ALSO=two") {
		t.Errorf("the next deployment gets the change: %s", env)
	}
}

func waitForOp(t *testing.T, eng *fakeEngine, prefix string) {
	t.Helper()
	for i := 0; i < 400; i++ {
		if indexOfOp(eng.opsList(), prefix) >= 0 {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("no %q operation: %v", prefix, eng.opsList())
}

func TestAnUnreadableStoreFailsTheDeploymentBeforeTouchingTheRunningContainer(t *testing.T) {
	h, svc := newEnvHarness(t)
	h.deploy("v1")
	mustApply(t, svc, "web", appenv.Change{Set: map[string]string{"A": "1"}})
	if err := os.WriteFile(filepath.Join(svc.Store.Dir(), "web.app.env"), []byte(config.ManagedEnvHeader+"\nA=unquoted-"+secretValue+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	dep := h.deploy("v2")
	if dep.Status != store.StatusFailed || !strings.Contains(dep.Error, "stored variables") || strings.Contains(dep.Error, secretValue) {
		t.Fatalf("%+v", dep)
	}
	h.mustImage("web", repo+":v1")
	for _, op := range h.eng.opsList() {
		if strings.HasPrefix(op, "pull "+repo+" v2") {
			t.Errorf("nothing may happen before the environment is known: %s", op)
		}
	}
}

func TestAStoredKeyTheAgentOwnsIsLeftOutAndTheDeploymentLogSaysSoByName(t *testing.T) {
	h, svc := newEnvHarness(t)
	mustApply(t, svc, "web", appenv.Change{Set: map[string]string{"PORT": secretValue, "KEPT": "1"}})
	// The operator then gives the app a port: PORT is the agent's from now on.
	app := h.app
	app.Port, app.ContainerPort = config.PortSpec{Container: 3000}, 3000
	h.d.cfg.Store(&config.Config{Apps: []config.App{app}, Proxy: &config.Proxy{}})
	dep := h.deploy("v1")
	if dep.Status != store.StatusSucceeded {
		t.Fatalf("%+v\n%s", dep, h.events(dep.ID))
	}
	env := strings.Join(h.runningEnv(), ",")
	if strings.Contains(env, "PORT=") || !strings.Contains(env, "KEPT=1") {
		t.Errorf("%s", env)
	}
	if ev := h.events(dep.ID); !strings.Contains(ev, "PORT") || strings.Contains(ev, secretValue) {
		t.Errorf("%s", ev)
	}
}

func TestAppsListingReportsWhenTheVariablesLastChanged(t *testing.T) {
	h, svc := newEnvHarness(t)
	apps, err := h.d.Apps(context.Background())
	if err != nil || len(apps) != 1 || apps[0].EnvChangedAt != "" {
		t.Fatalf("%+v %v", apps, err)
	}
	svc.Now = func() time.Time { return time.Date(2026, 10, 23, 10, 0, 0, 0, time.UTC) }
	mustApply(t, svc, "web", appenv.Change{Set: map[string]string{"A": "1"}})
	apps, _ = h.d.Apps(context.Background())
	if apps[0].EnvChangedAt != "2026-10-23T10:00:00Z" {
		t.Errorf("%q", apps[0].EnvChangedAt)
	}
	// The listing is otherwise unchanged: no variable appears in it.
	if b, _ := jsonOf(apps); strings.Contains(b, "FROM_FILE") || strings.Contains(b, "A=1") {
		t.Errorf("%s", b)
	}
	// Without a store (a deployer made for tests, or read-only use) the field is empty.
	bare := newHarness(t)
	if apps, _ := bare.d.Apps(context.Background()); apps[0].EnvChangedAt != "" {
		t.Errorf("%q", apps[0].EnvChangedAt)
	}
}

func TestPreviewInstancesGetOnlyThePreviewScopeOfTheirParent(t *testing.T) {
	h := newPreviewHarness(t, defaultPreviews)
	svc := attachStore(t, h.d)
	mustApply(t, svc, "web", appenv.Change{Set: map[string]string{"PROD_ONLY": otherSecret, "DATABASE_URL": "postgres://managed-prod"}})
	mustApply(t, svc, "web", appenv.Change{Scope: appenv.ScopePreview, Set: map[string]string{"PREVIEW_DB": "postgres://scratch", "NODE_ENV": "staging"}})

	_, dep := h.preview(12, 1)
	if dep.Status != store.StatusSucceeded {
		t.Fatalf("%+v %s", dep, h.events(dep.ID))
	}
	c := h.instance("web-pr-12")
	// The template's NODE_ENV is overridden by the stored preview value; nothing of the parent's app scope, env_file or env.
	if got := strings.Join(c.env, ","); got != "NODE_ENV=staging,PREVIEW_DB=postgres://scratch" {
		t.Errorf("preview environment: %s", got)
	}
	// The parent, redeployed, gets its own scope and nothing of the preview's.
	if dep := h.deploy("v1"); dep.Status != store.StatusSucceeded {
		t.Fatalf("%+v", dep)
	}
	env := strings.Join(h.runningEnv(), ",")
	if !strings.Contains(env, "PROD_ONLY="+otherSecret) || !strings.Contains(env, "DATABASE_URL=postgres://managed-prod") || strings.Contains(env, "PREVIEW_DB") {
		t.Errorf("parent environment: %s", env)
	}
}

func TestBuildsPassTheFlaggedVariablesAsArgumentsUnderTheFilesOwn(t *testing.T) {
	h := newBuildHarness(t)
	svc := attachStore(t, h.d)
	mustApply(t, svc, "web", appenv.Change{Set: map[string]string{
		"NEXT_PUBLIC_API": "https://api.example.com", "A": "from-store", "RUNTIME_ONLY": secretValue,
	}, Build: []string{"NEXT_PUBLIC_API", "A"}})

	dep, err := h.startBuild("web", 1)
	if err != nil || dep.Status != store.StatusSucceeded {
		t.Fatalf("%+v %v", dep, err)
	}
	reqs := h.b.requests()
	if len(reqs) != 1 {
		t.Fatalf("%d builds", len(reqs))
	}
	// The store's flagged keys, and only those, go in Args; the block's own args stay in the block (A: b), where the
	// builder lets them win.
	if got := reqs[0].Args; len(got) != 2 || got["NEXT_PUBLIC_API"] != "https://api.example.com" || got["A"] != "from-store" {
		t.Errorf("args: %v", got)
	}
	if reqs[0].Config.Args["A"] != "b" || len(reqs[0].Config.Args) != 1 {
		t.Errorf("the file's args must be untouched: %v", reqs[0].Config.Args)
	}
	// The unflagged variable is runtime only, and the deployed container has all of them.
	if _, ok := reqs[0].Args["RUNTIME_ONLY"]; ok {
		t.Error("an unflagged variable must not be a build argument")
	}
	if !hasEnv(h.eng.container("web").env, "RUNTIME_ONLY="+secretValue) {
		t.Error("the container must still have it")
	}
	if events := strings.Join(h.events(dep.ID), "\n"); strings.Contains(events, secretValue) || strings.Contains(events, "api.example.com") {
		t.Errorf("events:\n%s", events)
	}
}

func TestAPreviewBuildUsesThePreviewScopesBuildArguments(t *testing.T) {
	h, b, _ := newBuildPreviewHarness(t, defaultPreviews)
	svc := attachStore(t, h.d)
	mustApply(t, svc, "web", appenv.Change{Set: map[string]string{"API_URL": "https://prod"}, Build: []string{"API_URL"}})
	mustApply(t, svc, "web", appenv.Change{Scope: appenv.ScopePreview, Set: map[string]string{"API_URL": "https://preview"}, Build: []string{"API_URL"}})
	if _, dep, err := h.previewBuild(12, 1); err != nil || dep.Status != store.StatusSucceeded {
		t.Fatalf("%v %+v", err, dep)
	}
	reqs := b.requests()
	if len(reqs) != 1 || reqs[0].Args["API_URL"] != "https://preview" || len(reqs[0].Args) != 1 {
		t.Errorf("%+v", reqs)
	}
}

// Whatever the agent writes (its log, the deployment's events and record, the audit log, the database) has no value.
func TestNoValueIsLoggedOrRecordedByADeployment(t *testing.T) {
	h := newBuildHarness(t)
	var logs syncBuffer
	h.d.log = slog.New(slog.NewTextHandler(&logs, &slog.HandlerOptions{Level: slog.LevelDebug}))
	svc := attachStore(t, h.d)
	mustApply(t, svc, "web", appenv.Change{Set: map[string]string{"TOKEN": secretValue, "OTHER": otherSecret}, Build: []string{"OTHER"}})

	dep, err := h.startBuild("web", 1)
	if err != nil || dep.Status != store.StatusSucceeded {
		t.Fatalf("%+v %v", dep, err)
	}
	dep2 := h.deploy("v2")
	_ = dep2
	if strings.Contains(logs.String(), secretValue) || strings.Contains(logs.String(), otherSecret) {
		t.Errorf("a value is in the agent's log:\n%s", logs.String())
	}
	all, _ := h.st.ListDeployments(context.Background(), "", 100)
	for _, d := range all {
		for _, e := range h.events(d.ID) {
			if strings.Contains(e, secretValue) || strings.Contains(e, otherSecret) {
				t.Errorf("a value is in an event: %s", e)
			}
		}
		if strings.Contains(d.Error+d.Ref, secretValue) {
			t.Errorf("%+v", d)
		}
	}
	// The only copy at rest is the 0600 file.
	raw, _ := os.ReadFile(filepath.Join(svc.Store.Dir(), "web.app.env"))
	if !bytes.Contains(raw, []byte(secretValue)) {
		t.Error("the file must hold the value")
	}
}

func jsonOf(v any) (string, error) {
	b, err := json.Marshal(v)
	return string(b), err
}
