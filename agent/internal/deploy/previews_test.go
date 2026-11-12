package deploy

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/0x2u/keelson/agent/internal/config"
	"github.com/0x2u/keelson/agent/internal/confmgr"
	"github.com/0x2u/keelson/agent/internal/docker"
	"github.com/0x2u/keelson/agent/internal/notify"
	"github.com/0x2u/keelson/agent/internal/store"
)

// previewConfig is a proxied parent app with production secrets, volumes and a release step, and its previews template.
func previewConfig(envFile, previews string) string {
	return `
proxy: {}
apps:
  - name: web
    project: shop
    image: ghcr.io/o/web
    port: 3000
    domains: [web.example.com]
    env_file: ` + envFile + `
    env: {STRIPE_KEY: sk_live}
    volumes: ["/srv/web:/data"]
    stop_timeout: 1s
    health_timeout: 1s
    stable_after: 20ms
    drain: 0s
    soak: 0s
    release:
      steps:
        - {name: migrate, container: {command: [migrate]}}
` + previews
}

const defaultPreviews = "    previews: {domain: 'pr-{pr}-web.example.com', ttl: 1h, max: 2, env: {NODE_ENV: preview}}\n"

type previewHarness struct {
	*harness
	envFile string
	offset  atomic.Int64 // added to the deployer's clock
	emits   *emitRecorder
}

type emitRecorder struct {
	mu     sync.Mutex
	events []notify.Event
}

func (e *emitRecorder) Emit(ev notify.Event) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.events = append(e.events, ev)
}

func (e *emitRecorder) apps() []string {
	e.mu.Lock()
	defer e.mu.Unlock()
	var out []string
	for _, ev := range e.events {
		out = append(out, ev.App)
	}
	return out
}

func parseConfig(t *testing.T, doc string) *config.Config {
	t.Helper()
	c, issues := config.Parse([]byte(doc))
	if c == nil {
		t.Fatalf("config: %+v", issues)
	}
	return c
}

func newPreviewHarness(t *testing.T, previews string) *previewHarness {
	t.Helper()
	st, err := store.Open(filepath.Join(t.TempDir(), "agent.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	envFile := filepath.Join(t.TempDir(), "production.env")
	if err := os.WriteFile(envFile, []byte("DATABASE_URL=postgres://production\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	eng := newFakeEngine()
	px := &fakeProxy{}
	d := New(eng, st, parseConfig(t, previewConfig(envFile, previews)), px, slog.New(slog.NewTextHandler(io.Discard, nil)))
	d.PollEvery = 5 * time.Millisecond
	h := &previewHarness{harness: &harness{t: t, eng: eng, st: st, d: d, px: px}, envFile: envFile, emits: &emitRecorder{}}
	d.now = func() time.Time { return time.Now().Add(time.Duration(h.offset.Load())) }
	d.SetEmitter(h.emits)
	return h
}

// withoutTemplates is the configuration with the parent app and no previews section.
func (h *previewHarness) withoutTemplates() *config.Config {
	return parseConfig(h.t, previewConfig(h.envFile, ""))
}

func (h *previewHarness) advance(by time.Duration) { h.offset.Add(int64(by)) }

// reload applies a new configuration the way the manager does.
func (h *previewHarness) reload(previews string) error {
	h.t.Helper()
	apply, err := h.d.Prepare(h.d.config(), parseConfig(h.t, previewConfig(h.envFile, previews)))
	if err != nil {
		return err
	}
	apply()
	return nil
}

func sha(n int) string { return fmt.Sprintf("%040x", n) }

// preview deploys pull request pr at commit n and waits for the deployment.
func (h *previewHarness) preview(pr, n int) (PreviewStarted, store.Deployment) {
	h.t.Helper()
	started, done, err := h.d.StartPreview(context.Background(), "web", pr, Target{Tag: sha(n)})
	if err != nil {
		h.t.Fatalf("StartPreview(%d): %v", pr, err)
	}
	<-done
	dep, err := h.st.Deployment(context.Background(), started.DeploymentID)
	if err != nil {
		h.t.Fatal(err)
	}
	return started, dep
}

func (h *previewHarness) routeApps() []string {
	var out []string
	for _, r := range h.px.last() {
		out = append(out, r.App)
	}
	return out
}

func (h *previewHarness) rows() map[string]store.Preview {
	h.t.Helper()
	rows, err := h.st.Previews(context.Background())
	if err != nil {
		h.t.Fatal(err)
	}
	out := map[string]store.Preview{}
	for _, r := range rows {
		out[r.Name] = r
	}
	return out
}

func (h *previewHarness) audits() []string {
	h.t.Helper()
	list, err := h.st.Audit(context.Background(), 50, 0)
	if err != nil {
		h.t.Fatal(err)
	}
	var out []string
	for _, e := range list {
		out = append(out, e.Action+": "+e.Detail)
	}
	return out
}

func (h *previewHarness) containersOf(name string) []string {
	var out []string
	for c := range h.eng.snapshot() {
		if c == name || strings.HasPrefix(c, name+"-") {
			out = append(out, c)
		}
	}
	return out
}

func TestPreviewIsDeployedBlueGreenFromTheTemplateAndInheritsNothingFromProduction(t *testing.T) {
	h := newPreviewHarness(t, defaultPreviews)

	started, dep := h.preview(12, 1)
	if dep.Status != store.StatusSucceeded || dep.Trigger != "preview" || dep.App != "web-pr-12" || dep.Ref != repo+":"+sha(1) {
		t.Fatalf("deployment: %+v", dep)
	}
	if started.Name != "web-pr-12" || started.URL != "https://pr-12-web.example.com" || len(started.Evicted) != 0 {
		t.Fatalf("started: %+v", started)
	}

	st, err := h.st.AppState(context.Background(), "web-pr-12")
	if err != nil || st.Container != "web-pr-12-"+dep.ID || st.HostPort == 0 || st.Ref != dep.Ref {
		t.Fatalf("state: %+v %v", st, err)
	}
	c := h.eng.container(st.Container)
	if c == nil || !c.running || c.image != dep.Ref || c.labels["keelson.app"] != "web-pr-12" {
		t.Fatalf("container: %+v", c)
	}
	if len(c.spec.Binds) != 0 || len(c.spec.Ports) != 1 || c.spec.Ports[0].HostIP != "127.0.0.1" {
		t.Errorf("no volumes are inherited and the port is published on loopback: %+v", c.spec)
	}
	if strings.Join(c.env, ",") != "NODE_ENV=preview" { // not DATABASE_URL (env_file) nor STRIPE_KEY (env) of the parent
		t.Errorf("the environment is the template's own, never production's: %v", c.env)
	}
	routes := h.px.last()
	if len(routes) != 1 || routes[0].App != "web-pr-12" || len(routes[0].Hosts) != 1 || routes[0].Hosts[0] != "pr-12-web.example.com" ||
		routes[0].Upstream != fmt.Sprintf("127.0.0.1:%d", st.HostPort) {
		t.Errorf("routes: %+v", routes)
	}
	events, _ := h.st.Events(context.Background(), dep.ID, 0)
	for _, e := range events {
		if strings.Contains(e.Message, "release step") {
			t.Errorf("release steps are not inherited: %s", e.Message)
		}
	}
	for _, op := range h.eng.opsList() {
		if strings.HasPrefix(op, "wait") {
			t.Errorf("no release container may run: %s", op)
		}
	}

	list, err := h.d.Previews(context.Background())
	if err != nil || len(list) != 1 {
		t.Fatalf("%+v %v", list, err)
	}
	p := list[0]
	if p.Name != "web-pr-12" || p.App != "web" || p.PR != 12 || p.Domain != "pr-12-web.example.com" || p.URL != "https://pr-12-web.example.com" ||
		p.Ref != dep.Ref || p.Status != PreviewRunning || p.DeploymentID != dep.ID || !p.ExpiresAt.After(p.CreatedAt.Add(59*time.Minute)) {
		t.Errorf("listing: %+v", p)
	}

	// Previews are not apps of the file: the listing of apps does not change.
	apps, err := h.d.Apps(context.Background())
	if err != nil || len(apps) != 1 || apps[0].Name != "web" || apps[0].Container != nil {
		t.Errorf("Apps must stay config-only: %+v %v", apps, err)
	}
	if _, _, err := h.d.Start(context.Background(), "web-pr-12", Target{Tag: "x"}, "api"); !errors.Is(err, ErrUnknownApp) {
		t.Errorf("an instance is not deployed through the apps routes: %v", err)
	}

	// A deployment of a preview is not a notification: only the parent's are.
	if got := h.emits.apps(); len(got) != 0 {
		t.Errorf("previews must not notify: %v", got)
	}
	if dep := h.deploy("v1"); dep.Status != store.StatusSucceeded {
		t.Fatalf("parent deploy: %+v", dep)
	}
	if got := h.emits.apps(); len(got) != 1 || got[0] != "web" {
		t.Errorf("the parent still notifies: %v", got)
	}
}

func TestPUTCreatesThenRedeploysTheSameInstance(t *testing.T) {
	h := newPreviewHarness(t, defaultPreviews)
	h.eng.images = []docker.Image{tagged("i1", sha(1)), tagged("i2", sha(2)), tagged("p", "v9")}

	_, first := h.preview(7, 1)
	before := h.rows()["web-pr-7"]
	h.advance(10 * time.Minute)
	started, second := h.preview(7, 2)

	if started.Name != "web-pr-7" || len(started.Evicted) != 0 {
		t.Fatalf("%+v", started)
	}
	if second.Status != store.StatusSucceeded || second.PreviousRef != first.Ref {
		t.Fatalf("a redeploy replaces the serving version: %+v", second)
	}
	rows := h.rows()
	if len(rows) != 1 {
		t.Fatalf("one instance, not two: %+v", rows)
	}
	after := rows["web-pr-7"]
	if !after.CreatedAt.Equal(before.CreatedAt) || after.Ref != repo+":"+sha(2) || after.DeploymentID != second.ID {
		t.Errorf("before %+v after %+v", before, after)
	}
	if !after.ExpiresAt.After(before.ExpiresAt.Add(9 * time.Minute)) {
		t.Errorf("the TTL runs from the last deployment: %v then %v", before.ExpiresAt, after.ExpiresAt)
	}
	st, _ := h.st.AppState(context.Background(), "web-pr-7")
	if st.Container != "web-pr-7-"+second.ID || st.Ref != second.Ref {
		t.Errorf("state: %+v", st)
	}
	if got := h.containersOf("web-pr-7"); len(got) != 1 || got[0] != st.Container {
		t.Errorf("the previous version's container is gone: %v", got)
	}
	// The superseded commit's image goes; the parent's own versions and the new one stay.
	if got := h.removed(); len(got) != 1 || got[0] != repo+":"+sha(1) {
		t.Errorf("removed images: %v", got)
	}
}

func TestPreviewValidation(t *testing.T) {
	h := newPreviewHarness(t, defaultPreviews)
	ctx := context.Background()
	cases := []struct {
		app    string
		pr     int
		target Target
		want   error
	}{
		{"web", 0, Target{Tag: sha(1)}, ErrInvalidPR},
		{"web", -3, Target{Tag: sha(1)}, ErrInvalidPR},
		{"web", 1000000, Target{Tag: sha(1)}, ErrInvalidPR},
		{"nope", 1, Target{Tag: sha(1)}, ErrNoPreview},
		{"web", 1, Target{}, ErrInvalidTarget},
		{"web", 1, Target{Tag: "bad tag"}, ErrInvalidTarget},
		{"web", 1, Target{Tag: "a", Digest: "sha256:" + strings.Repeat("a", 64)}, ErrInvalidTarget},
	}
	for _, tc := range cases {
		if _, _, err := h.d.StartPreview(ctx, tc.app, tc.pr, tc.target); !errors.Is(err, tc.want) {
			t.Errorf("%s #%d %+v: got %v, want %v", tc.app, tc.pr, tc.target, err, tc.want)
		}
	}
	if err := h.d.RemovePreview(ctx, "web", 0); !errors.Is(err, ErrInvalidPR) {
		t.Errorf("remove: %v", err)
	}
	if len(h.rows()) != 0 || len(h.eng.opsList()) != 0 {
		t.Error("a refused request must change nothing")
	}
}

func TestBeyondMaxTheLeastRecentlyDeployedInstanceIsRemovedCompletelyWithItsRoute(t *testing.T) {
	h := newPreviewHarness(t, defaultPreviews) // max 2
	ctx := context.Background()

	h.preview(5, 1)
	h.advance(time.Minute)
	h.preview(3, 2)
	h.advance(time.Minute)
	h.preview(5, 3) // redeployed last of the first two, though created first
	h.advance(time.Minute)
	oldContainer := h.containersOf("web-pr-3")
	if len(oldContainer) != 1 {
		t.Fatalf("%v", oldContainer)
	}
	victim, _ := h.st.AppState(ctx, "web-pr-3")

	started, dep := h.preview(9, 4)
	if dep.Status != store.StatusSucceeded || len(started.Evicted) != 1 || started.Evicted[0] != "web-pr-3" {
		t.Fatalf("started %+v, deployment %+v", started, dep)
	}
	rows := h.rows()
	if len(rows) != 2 || rows["web-pr-5"].Name == "" || rows["web-pr-9"].Name == "" {
		t.Fatalf("rows: %+v", rows)
	}
	if got := h.containersOf("web-pr-3"); len(got) != 0 {
		t.Errorf("containers of the evicted instance remain: %v", got)
	}
	if _, err := h.st.AppState(ctx, "web-pr-3"); !errors.Is(err, store.ErrNotFound) {
		t.Errorf("app_state must go: %v", err)
	}
	if got := h.routeApps(); strings.Join(got, ",") != "web-pr-5,web-pr-9" {
		t.Errorf("the evicted route is gone: %v", got)
	}
	for _, r := range h.px.last() {
		if strings.HasSuffix(r.Upstream, fmt.Sprint(victim.HostPort)) && r.App != "web-pr-9" && r.App != "web-pr-5" {
			t.Errorf("route to the evicted container: %+v", r)
		}
	}
	if len(h.audits()) != 1 || !strings.HasPrefix(h.audits()[0], "preview.evict: web-pr-3") {
		t.Errorf("audit: %v", h.audits())
	}
	// Its image went with it; the other instances' commits stay.
	if got := h.removed(); !contains(got, repo+":"+sha(2)) || contains(got, repo+":"+sha(3)) || contains(got, repo+":"+sha(4)) {
		t.Errorf("removed images: %v", got)
	}

	// Redeploying an existing instance never evicts anything.
	started, _ = h.preview(5, 5)
	if len(started.Evicted) != 0 || len(h.rows()) != 2 {
		t.Errorf("%+v", started)
	}
}

func contains(list []string, s string) bool {
	for _, x := range list {
		if x == s {
			return true
		}
	}
	return false
}

func TestEvictionSkipsABusyInstanceAndRefusesWhenNoRoomCanBeMade(t *testing.T) {
	h := newPreviewHarness(t, "    previews: {domain: 'pr-{pr}-web.example.com', max: 1}\n")
	h.preview(1, 1)

	h.eng.mu.Lock()
	h.eng.pullGate = make(chan struct{})
	h.eng.mu.Unlock()
	_, done, err := h.d.StartPreview(context.Background(), "web", 1, Target{Tag: sha(2)}) // redeploy in flight
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := h.d.StartPreview(context.Background(), "web", 2, Target{Tag: sha(3)}); !errors.Is(err, ErrBusy) {
		t.Fatalf("the only instance is busy: %v", err)
	}
	if _, ok := h.rows()["web-pr-2"]; ok {
		t.Error("a refused creation leaves no row")
	}
	h.eng.mu.Lock()
	close(h.eng.pullGate)
	h.eng.pullGate = nil
	h.eng.mu.Unlock()
	<-done
	if _, _, err := h.d.StartPreview(context.Background(), "web", 2, Target{Tag: sha(3)}); err != nil {
		t.Fatal(err)
	}
	h.d.Wait(5 * time.Second)
	if rows := h.rows(); len(rows) != 1 || rows["web-pr-2"].Name == "" {
		t.Errorf("%+v", rows)
	}
}

func TestDeleteRemovesContainersRouteRowAndImagesAndIsIdempotent(t *testing.T) {
	h := newPreviewHarness(t, defaultPreviews)
	ctx := context.Background()
	h.preview(4, 1)
	h.preview(8, 2)
	// A deployment cut short left a container behind.
	h.eng.put("web-pr-4-0123456789abcdef", repo+":x", false)
	h.eng.label("web-pr-4-0123456789abcdef", "web-pr-4")

	if err := h.d.RemovePreview(ctx, "web", 4); err != nil {
		t.Fatal(err)
	}
	if got := h.containersOf("web-pr-4"); len(got) != 0 {
		t.Errorf("containers left: %v", got)
	}
	if got := h.containersOf("web-pr-8"); len(got) != 1 {
		t.Errorf("the other instance is untouched: %v", got)
	}
	if _, err := h.st.AppState(ctx, "web-pr-4"); !errors.Is(err, store.ErrNotFound) {
		t.Errorf("app_state: %v", err)
	}
	if got := h.routeApps(); strings.Join(got, ",") != "web-pr-8" {
		t.Errorf("routes: %v", got)
	}
	if _, ok := h.rows()["web-pr-4"]; ok {
		t.Error("the row must go")
	}
	if got := h.removed(); len(got) != 1 || got[0] != repo+":"+sha(1) {
		t.Errorf("only the instance's own image goes: %v", got)
	}

	ops := len(h.eng.opsList())
	calls := h.px.count()
	if err := h.d.RemovePreview(ctx, "web", 4); err != nil {
		t.Fatalf("deleting again is fine: %v", err)
	}
	if err := h.d.RemovePreview(ctx, "nope", 99); err != nil {
		t.Fatalf("an instance that never existed is fine: %v", err)
	}
	if len(h.eng.opsList()) != ops || h.px.count() != calls {
		t.Error("deleting what is not there must touch nothing")
	}
}

func TestDeleteNeverTouchesAContainerOfARealAppThatLooksLikeAnInstance(t *testing.T) {
	h := newPreviewHarness(t, defaultPreviews)
	h.eng.put("web-pr-3", repo+":real", true)
	h.eng.label("web-pr-3", "web-pr-3")
	if err := h.d.RemovePreview(context.Background(), "web", 3); err != nil {
		t.Fatal(err)
	}
	if h.eng.container("web-pr-3") == nil {
		t.Error("without an instance row there is nothing the agent created: leave the container")
	}
}

func TestRemovalRefusesWhileTheInstanceIsDeployingAndTheSweeperWaits(t *testing.T) {
	h := newPreviewHarness(t, defaultPreviews)
	h.preview(1, 1)

	h.eng.mu.Lock()
	h.eng.pullGate = make(chan struct{})
	h.eng.mu.Unlock()
	_, done, err := h.d.StartPreview(context.Background(), "web", 1, Target{Tag: sha(2)})
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := h.d.StartPreview(context.Background(), "web", 1, Target{Tag: sha(3)}); !errors.Is(err, ErrBusy) {
		t.Errorf("a second deployment of the instance: %v", err)
	}
	if err := h.d.RemovePreview(context.Background(), "web", 1); !errors.Is(err, ErrBusy) {
		t.Errorf("removal while deploying: %v", err)
	}
	h.advance(2 * time.Hour) // expired, but busy
	h.d.SweepPreviews(context.Background())
	if _, ok := h.rows()["web-pr-1"]; !ok {
		t.Error("the sweeper must not remove an instance that is being deployed")
	}
	h.eng.mu.Lock()
	close(h.eng.pullGate)
	h.eng.pullGate = nil
	h.eng.mu.Unlock()
	<-done
	h.d.SweepPreviews(context.Background())
	if _, ok := h.rows()["web-pr-1"]; ok {
		t.Error("the next sweep removes it")
	}
}

func TestSweeperRemovesExpiredInstancesAndARedeploymentExtendsTheTTL(t *testing.T) {
	h := newPreviewHarness(t, "    previews: {domain: 'pr-{pr}-web.example.com', ttl: 1h, max: 5}\n")
	ctx := context.Background()
	h.preview(1, 1)
	h.advance(30 * time.Minute)
	h.preview(2, 2)
	h.advance(25 * time.Minute)
	h.preview(1, 3) // pr 1 deployed again: its hour starts over
	h.advance(10 * time.Minute)
	h.preview(3, 4)

	h.d.SweepPreviews(ctx)
	if len(h.rows()) != 3 {
		t.Fatalf("nothing is expired yet: %+v", h.rows())
	}
	h.advance(25 * time.Minute) // now 90 minutes in: pr 2 is expired; pr 1 (redeployed at 55) and pr 3 (65) are not
	h.d.SweepPreviews(ctx)
	rows := h.rows()
	if _, ok := rows["web-pr-2"]; ok || len(rows) != 2 {
		t.Fatalf("pr 2 expired: %+v", rows)
	}
	if got := h.containersOf("web-pr-2"); len(got) != 0 {
		t.Errorf("containers left: %v", got)
	}
	if got := h.routeApps(); strings.Join(got, ",") != "web-pr-1,web-pr-3" {
		t.Errorf("routes: %v", got)
	}
	if a := h.audits(); len(a) != 1 || !strings.HasPrefix(a[0], "preview.expire: web-pr-2: expired") {
		t.Errorf("audit: %v", a)
	}

	h.advance(26 * time.Minute) // now 116 minutes in: pr 1 (redeployed at 55, so it expires at 115) is over; pr 3 (expires at 125) is not
	h.d.SweepPreviews(ctx)
	if rows := h.rows(); len(rows) != 1 || rows["web-pr-3"].Name == "" {
		t.Errorf("pr 1 expired, pr 3 has time left: %+v", rows)
	}
}

func TestSweeperEnforcesALoweredMaxAndRemovesInstancesOfARemovedTemplate(t *testing.T) {
	h := newPreviewHarness(t, "    previews: {domain: 'pr-{pr}-web.example.com', max: 5}\n")
	ctx := context.Background()
	for pr := 1; pr <= 3; pr++ {
		h.preview(pr, pr)
		h.advance(time.Minute)
	}
	if err := h.reload("    previews: {domain: 'pr-{pr}-web.example.com', max: 1}\n"); err != nil {
		t.Fatal(err)
	}
	h.d.SweepPreviews(ctx)
	if rows := h.rows(); len(rows) != 1 || rows["web-pr-3"].Name == "" {
		t.Fatalf("the newest stays: %+v", rows)
	}
	if got := h.routeApps(); strings.Join(got, ",") != "web-pr-3" {
		t.Errorf("routes: %v", got)
	}

	// The template goes: the instance is dropped from the routes at once (the reconciler) and removed by the sweeper.
	if err := h.reload("    previews: {domain: 'other-{pr}-web.example.com'}\n"); err != nil {
		t.Fatal(err)
	}
	if err := h.d.Reconcile(ctx); err != nil {
		t.Fatal(err)
	}
	if got := h.routeApps(); len(got) != 1 {
		t.Fatalf("a changed pattern moves the route with the template: %v", got)
	}
	if h.px.last()[0].Hosts[0] != "other-3-web.example.com" {
		t.Errorf("routes: %+v", h.px.last())
	}
	next := h.withoutTemplates()
	apply, err := h.d.Prepare(h.d.config(), next)
	if err != nil {
		t.Fatal(err)
	}
	apply()
	if err := h.d.Reconcile(ctx); err != nil {
		t.Fatal(err)
	}
	if got := h.routeApps(); len(got) != 0 {
		t.Errorf("an instance without a template has no route: %v", got)
	}
	h.d.SweepPreviews(ctx)
	if len(h.rows()) != 0 || len(h.containersOf("web-pr-3")) != 0 {
		t.Errorf("instances of a removed template are removed: %+v %v", h.rows(), h.containersOf("web-pr-3"))
	}
	if a := h.audits(); len(a) == 0 || !strings.HasPrefix(a[0], "preview.remove: web-pr-3: its previews template was removed") {
		t.Errorf("audit: %v", a)
	}
}

func TestReloadIsRefusedWhileAnInstanceOfARemovedTemplateDeploys(t *testing.T) {
	h := newPreviewHarness(t, defaultPreviews)
	h.eng.mu.Lock()
	h.eng.pullGate = make(chan struct{})
	h.eng.mu.Unlock()
	_, done, err := h.d.StartPreview(context.Background(), "web", 1, Target{Tag: sha(1)})
	if err != nil {
		t.Fatal(err)
	}

	// Changing the template is fine: the instance keeps deploying.
	if err := h.reload("    previews: {domain: 'pr-{pr}-web.example.com', max: 4}\n"); err != nil {
		t.Fatalf("a changed template must not be refused: %v", err)
	}
	next := h.withoutTemplates()
	_, err = h.d.Prepare(h.d.config(), next)
	var busy *confmgr.BusyError
	if !errors.As(err, &busy) || !strings.Contains(busy.Reason, "web-pr-1") {
		t.Fatalf("removing the template of a deploying instance is busy: %v", err)
	}
	h.eng.mu.Lock()
	close(h.eng.pullGate)
	h.eng.mu.Unlock()
	<-done
	if _, err := h.d.Prepare(h.d.config(), next); err != nil {
		t.Errorf("once it is done: %v", err)
	}
}

func TestReconcileKeepsPreviewRoutesAndFollowsTheirPort(t *testing.T) {
	h := newPreviewHarness(t, defaultPreviews)
	ctx := context.Background()
	h.deploy("v1")
	h.preview(12, 1)
	if got := h.routeApps(); strings.Join(got, ",") != "web,web-pr-12" {
		t.Fatalf("routes: %v", got)
	}

	calls := h.px.count()
	if err := h.d.Reconcile(ctx); err != nil {
		t.Fatal(err)
	}
	if h.px.count() != calls {
		t.Error("nothing changed: nothing is pushed")
	}

	// Docker hands the restarted preview container another host port.
	st, _ := h.st.AppState(ctx, "web-pr-12")
	h.eng.mu.Lock()
	h.eng.ctrs[st.Container].ports[0].PublicPort = 49999
	h.eng.mu.Unlock()
	if err := h.d.Reconcile(ctx); err != nil {
		t.Fatal(err)
	}
	var got string
	for _, r := range h.px.last() {
		if r.App == "web-pr-12" {
			got = r.Upstream
		}
	}
	if got != "127.0.0.1:49999" {
		t.Errorf("the preview route follows its container: %q (%v)", got, h.routeApps())
	}
	if after, _ := h.st.AppState(ctx, "web-pr-12"); after.HostPort != 49999 {
		t.Errorf("state: %+v", after)
	}

	// The container disappears: its route goes, the parent's stays.
	h.eng.mu.Lock()
	delete(h.eng.ctrs, st.Container)
	h.eng.mu.Unlock()
	if err := h.d.Reconcile(ctx); err != nil {
		t.Fatal(err)
	}
	if got := h.routeApps(); strings.Join(got, ",") != "web" {
		t.Errorf("routes: %v", got)
	}
}

func TestRecoverAdoptsPreviewsAndLeavesOrphansOfEachAppToItsOwnRule(t *testing.T) {
	h := newPreviewHarness(t, defaultPreviews)
	ctx := context.Background()
	h.deploy("v1")
	_, pdep := h.preview(12, 1)
	serving, _ := h.st.AppState(ctx, "web-pr-12")
	parent, _ := h.st.AppState(ctx, "web")

	// A preview deployment that created its container and died before the switch, and one of the parent.
	h.eng.put("web-pr-12-deadbeefdeadbeef", repo+":"+sha(2), true)
	h.eng.label("web-pr-12-deadbeefdeadbeef", "web-pr-12")
	h.eng.put("web-cafecafecafecafe", repo+":v2", true)
	h.eng.label("web-cafecafecafecafe", "web")
	if err := h.st.CreateDeployment(ctx, store.Deployment{ID: "deadbeefdeadbeef", App: "web-pr-12", Ref: repo + ":" + sha(2), Trigger: "preview", StartedAt: time.Now()}); err != nil {
		t.Fatal(err)
	}

	if err := h.d.Recover(ctx); err != nil {
		t.Fatal(err)
	}
	dep, _ := h.st.Deployment(ctx, "deadbeefdeadbeef")
	if dep.Status != store.StatusFailed || !strings.Contains(dep.Error, "interrupted: agent restarted") || strings.Contains(dep.Error, "no longer configured") {
		t.Errorf("an interrupted preview deployment is resolved like any other: %s %q", dep.Status, dep.Error)
	}
	if h.eng.container("web-pr-12-deadbeefdeadbeef") != nil || h.eng.container("web-cafecafecafecafe") != nil {
		t.Error("orphans of both are removed")
	}
	h.mustImage(serving.Container, pdep.Ref)
	h.mustImage(parent.Container, repo+":v1")
	if got := h.routeApps(); strings.Join(got, ",") != "web,web-pr-12" {
		t.Errorf("routes: %v", got)
	}
}

func TestPreviewRefsAreNeverTheParentsToPruneAndTheParentsAreNeverThePreviews(t *testing.T) {
	h := newPreviewHarness(t, defaultPreviews)
	h.d.config().Apps[0].KeepImages = ptr(1)
	h.deploy("v1")
	h.preview(1, 1)
	h.eng.images = []docker.Image{tagged("a0", "v0"), tagged("a1", "v1"), tagged("p1", sha(1))}

	// The parent deploys v2 and keeps one version: v1 and v0 go, but not the preview's commit.
	if dep := h.deploy("v2"); dep.Status != store.StatusSucceeded {
		t.Fatal(dep)
	}
	got := h.removed()
	if !contains(got, repo+":v0") || !contains(got, repo+":v1") || contains(got, repo+":"+sha(1)) {
		t.Errorf("parent prune removed %v", got)
	}

	// The preview moves to a new commit: its old image goes, the parent's v2 and the new commit stay.
	h.eng.removedImages = nil
	h.eng.images = []docker.Image{tagged("a2", "v2"), tagged("p1", sha(1)), tagged("p2", sha(2))}
	h.preview(1, 2)
	if got := h.removed(); len(got) != 1 || got[0] != repo+":"+sha(1) {
		t.Errorf("preview prune removed %v", got)
	}

	// A commit the parent also runs (a merged pull request) is the parent's: removing the instance leaves it.
	h.d.config().Apps[0].KeepImages = ptr(3)
	h.preview(2, 3)
	if dep := h.deploy(sha(3)); dep.Status != store.StatusSucceeded {
		t.Fatal(dep)
	}
	h.eng.removedImages = nil
	if err := h.d.RemovePreview(context.Background(), "web", 2); err != nil {
		t.Fatal(err)
	}
	if got := h.removed(); contains(got, repo+":"+sha(3)) {
		t.Errorf("a version the parent keeps must stay: %v", got)
	}
}

func TestAFailedFirstDeploymentRemovesTheInstanceButKeepsTheDeploymentRecord(t *testing.T) {
	h := newPreviewHarness(t, defaultPreviews)
	h.eng.behavior[repo+":"+sha(1)] = "unhealthy"
	started, dep := h.preview(5, 1)
	if dep.Status != store.StatusFailed || dep.ID != started.DeploymentID {
		t.Fatalf("the deployment stays readable by id: %+v", dep)
	}
	if len(h.rows()) != 0 {
		t.Errorf("an instance that never served must not linger: %+v", h.rows())
	}
	list, _ := h.d.Previews(context.Background())
	if len(list) != 0 {
		t.Errorf("not listed: %+v", list)
	}
	if got := h.containersOf("web-pr-5"); len(got) != 0 {
		t.Errorf("leftover containers: %v", got)
	}
	if _, err := h.st.AppState(context.Background(), "web-pr-5"); !errors.Is(err, store.ErrNotFound) {
		t.Errorf("app_state: %v", err)
	}
	if got := h.routeApps(); len(got) != 0 {
		t.Errorf("a preview that never came up has no route: %v", got)
	}
	if got := h.emits.apps(); len(got) != 0 {
		t.Errorf("no notification for a preview: %v", got)
	}
	// Deleting what is already gone is fine, and it does not count against max.
	if err := h.d.RemovePreview(context.Background(), "web", 5); err != nil {
		t.Fatal(err)
	}
	h.preview(6, 2)
	h.preview(7, 3)
	if started, _ := h.preview(8, 4); len(started.Evicted) != 1 {
		t.Errorf("max 2 counts only instances that exist: %+v", started)
	}
}

func TestAFailedRedeployKeepsTheServingInstance(t *testing.T) {
	h := newPreviewHarness(t, defaultPreviews)
	h.preview(5, 1)
	h.eng.behavior[repo+":"+sha(2)] = "unhealthy"
	_, dep := h.preview(5, 2)
	if dep.Status == store.StatusSucceeded {
		t.Fatalf("%+v", dep)
	}
	rows := h.rows()
	if _, ok := rows["web-pr-5"]; !ok || len(rows) != 1 {
		t.Fatalf("the row stays: %+v", rows)
	}
	if st, err := h.st.AppState(context.Background(), "web-pr-5"); err != nil || st.Ref != repo+":"+sha(1) {
		t.Errorf("the old version keeps serving: %+v %v", st, err)
	}
	if got := h.routeApps(); len(got) != 1 || got[0] != "web-pr-5" {
		t.Errorf("routes: %v", got)
	}
	list, _ := h.d.Previews(context.Background())
	if len(list) != 1 || list[0].Status != PreviewFailed {
		t.Errorf("%+v", list)
	}
}

func TestEvictionTakesFailedInstancesFirstThenTheLeastRecentlyDeployed(t *testing.T) {
	h := newPreviewHarness(t, "    previews: {domain: 'pr-{pr}-web.example.com', max: 3}\n")
	h.preview(1, 1)
	h.advance(time.Minute)
	h.preview(2, 2)
	h.advance(time.Minute)
	h.preview(3, 3)
	h.advance(time.Minute)
	h.eng.behavior[repo+":"+sha(5)] = "unhealthy"
	h.preview(3, 5) // failed redeploy of the newest instance: it still serves, but is "failed"
	h.advance(time.Minute)
	h.preview(1, 6) // pr 1 is the oldest by creation, the most recently deployed now
	h.advance(time.Minute)

	started, _ := h.preview(4, 7)
	if len(started.Evicted) != 1 || started.Evicted[0] != "web-pr-3" {
		t.Fatalf("a failed instance goes first: %+v", started)
	}
	h.advance(time.Minute)
	started, _ = h.preview(5, 8)
	if len(started.Evicted) != 1 || started.Evicted[0] != "web-pr-2" {
		t.Fatalf("then the least recently deployed, not the oldest created (pr 1): %+v", started)
	}
}

func TestProxyViewShowsServingPreviewRoutes(t *testing.T) {
	h := newPreviewHarness(t, defaultPreviews)
	h.preview(5, 1)
	view, err := h.d.Proxy(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	var found *RouteView
	for i, r := range view.Routes {
		if r.App == "web-pr-5" {
			found = &view.Routes[i]
		}
	}
	if found == nil || found.Domains[0] != "pr-5-web.example.com" || !found.Running {
		t.Errorf("%+v", view)
	}
}

func TestPreviewsAreRefusedOnceShuttingDown(t *testing.T) {
	h := newPreviewHarness(t, defaultPreviews)
	h.preview(1, 1)
	h.d.BeginShutdown()
	if _, _, err := h.d.StartPreview(context.Background(), "web", 2, Target{Tag: sha(2)}); !errors.Is(err, ErrShuttingDown) {
		t.Errorf("start: %v", err)
	}
	if err := h.d.RemovePreview(context.Background(), "web", 1); !errors.Is(err, ErrShuttingDown) {
		t.Errorf("remove: %v", err)
	}
	h.advance(2 * time.Hour)
	h.d.SweepPreviews(context.Background())
	if len(h.rows()) != 1 {
		t.Error("the sweeper stands still while shutting down")
	}
}

func TestSweeperLoopStopsWithItsContextAndSweepsOnTheTicker(t *testing.T) {
	h := newPreviewHarness(t, defaultPreviews)
	h.preview(1, 1)
	h.advance(2 * time.Hour)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { h.d.RunPreviewSweeper(ctx, 10*time.Millisecond); close(done) }()
	deadline := time.Now().Add(5 * time.Second)
	for len(h.rows()) != 0 && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if len(h.rows()) != 0 {
		t.Error("the loop removes expired instances")
	}
	cancel()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("the loop must end with its context")
	}
}
