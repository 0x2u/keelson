package appenv

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/0x2u/keelson/agent/internal/config"
)

type rig struct {
	t   *testing.T
	svc *Service
	now time.Time
	dir string
}

// newRig has an app "web" (port, env_file, env and a previews template with its own env_file and env), an app "worker"
// on host_ports, and a bare app "plain".
func newRig(t *testing.T) *rig {
	t.Helper()
	dir := t.TempDir()
	web := filepath.Join(dir, "web.env")
	if err := os.WriteFile(web, []byte("FROM_FILE=file\nBOTH=file\nDATABASE_URL=postgres://production\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	prev := filepath.Join(dir, "preview.env")
	if err := os.WriteFile(prev, []byte("PREVIEW_FILE=file\nBOTH=file\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	doc := `
proxy: {}
apps:
  - name: web
    image: ghcr.io/o/web
    port: 3000
    domains: [web.example.com]
    env_file: ` + web + `
    env: {FROM_ENV: env, BOTH: env}
  - name: worker
    image: ghcr.io/o/worker
    network: host
    host_ports: [4000, 4001]
    domains: [worker.example.com]
    port_env: LISTEN_PORT
  - name: plain
    image: ghcr.io/o/plain
previews:
  - {app: web, domain: 'pr-{pr}-web.example.com', env_file: ` + prev + `, env: {PREVIEW_ENV: env, BOTH: env}}
`
	cfg, issues := config.Parse([]byte(doc))
	if cfg == nil {
		t.Fatalf("%+v", issues)
	}
	r := &rig{t: t, now: t0, dir: dir}
	st, err := Open(filepath.Join(dir, "envstore"))
	if err != nil {
		t.Fatal(err)
	}
	r.svc = &Service{Store: st, Config: func() *config.Config { return cfg }, Now: func() time.Time { return r.now }}
	return r
}

func (r *rig) apply(app string, ch Change) Result {
	r.t.Helper()
	res, err := r.svc.Apply(app, ch)
	if err != nil {
		r.t.Fatalf("Apply(%s, %+v): %v", app, ch, err)
	}
	return res
}

func (r *rig) invalid(app string, ch Change) []Issue {
	r.t.Helper()
	_, err := r.svc.Apply(app, ch)
	var inv *InvalidError
	if !errors.As(err, &inv) {
		r.t.Fatalf("Apply(%s, %+v) = %v, want an InvalidError", app, ch, err)
	}
	return inv.Issues
}

func (r *rig) app(name string) config.App {
	a, ok := r.svc.Config().App(name)
	if !ok {
		r.t.Fatal(name)
	}
	return a
}

func issueKeys(is []Issue) []string {
	var out []string
	for _, i := range is {
		out = append(out, i.Key)
	}
	return out
}

func TestSetReportsWhatChangedAndAnUnchangedValueIsNotAChange(t *testing.T) {
	r := newRig(t)
	res := r.apply("web", Change{Set: map[string]string{"B": "1", "A": "2"}})
	if res.Scope != ScopeApp || !reflect.DeepEqual(res.Changed, []string{"A", "B"}) || len(res.Removed) != 0 || res.Removed == nil {
		t.Fatalf("%+v", res)
	}
	l, _ := r.svc.List("web", ScopeApp)
	if l.LastChanged == nil || *l.LastChanged != "2026-10-23T10:00:00Z" {
		t.Fatalf("%+v", l)
	}

	r.now = t0.Add(time.Hour)
	res = r.apply("web", Change{Set: map[string]string{"A": "2", "B": "new"}, Unset: []string{"NOPE"}})
	if !reflect.DeepEqual(res.Changed, []string{"B"}) || len(res.Removed) != 0 {
		t.Fatalf("only B changed, and unsetting what is not there is not a removal: %+v", res)
	}
	l, _ = r.svc.List("web", ScopeApp)
	at := map[string]string{}
	for _, v := range l.Vars {
		at[v.Key] = v.UpdatedAt
	}
	if at["A"] != "2026-10-23T10:00:00Z" || at["B"] != "2026-10-23T11:00:00Z" || *l.LastChanged != "2026-10-23T11:00:00Z" {
		t.Errorf("updated_at per key: %v, last changed %s", at, *l.LastChanged)
	}

	// A request that changes nothing does not move the scope's time.
	r.now = t0.Add(2 * time.Hour)
	res = r.apply("web", Change{Set: map[string]string{"A": "2"}})
	if len(res.Changed) != 0 {
		t.Errorf("%+v", res)
	}
	if l, _ := r.svc.List("web", ScopeApp); *l.LastChanged != "2026-10-23T11:00:00Z" {
		t.Errorf("last changed moved: %s", *l.LastChanged)
	}
}

func TestUnsetRemovesAndAnEmptyScopeIsListedAsSuch(t *testing.T) {
	r := newRig(t)
	r.apply("web", Change{Set: map[string]string{"OLD": "1", "KEEP": "2"}})
	r.now = t0.Add(time.Minute)
	res := r.apply("web", Change{Unset: []string{"OLD", "KEEP"}})
	if !reflect.DeepEqual(res.Removed, []string{"KEEP", "OLD"}) || len(res.Changed) != 0 {
		t.Fatalf("%+v", res)
	}
	l, err := r.svc.List("web", ScopeApp)
	if err != nil || l.Vars == nil || len(l.Vars) != 0 || *l.LastChanged != "2026-10-23T10:01:00Z" {
		t.Errorf("%+v %v", l, err)
	}
}

func TestListNeverCarriesAValueAndReportsWhatIsShadowed(t *testing.T) {
	r := newRig(t)
	const secret = "s3cr3t-value-0001"
	r.apply("web", Change{Set: map[string]string{
		"DATABASE_URL": secret, "FROM_ENV": secret, "BOTH": secret, "NEW_ONE": secret,
	}})
	l, err := r.svc.List("web", ScopeApp)
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]string{}
	for _, v := range l.Vars {
		s := "null"
		if v.Shadows != nil {
			s = *v.Shadows
		}
		got[v.Key] = s
	}
	// env wins over env_file in the file's own environment, so it is the value the stored one replaces.
	want := map[string]string{"DATABASE_URL": "env_file", "FROM_ENV": "env", "BOTH": "env", "NEW_ONE": "null"}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("shadows: %v, want %v", got, want)
	}
	if b := fmt.Sprintf("%+v", l); strings.Contains(b, secret) {
		t.Errorf("the listing holds a value: %s", b)
	}

	// The preview scope shadows the template's variables, not the app's.
	r.apply("web", Change{Scope: ScopePreview, Set: map[string]string{"PREVIEW_FILE": "x", "PREVIEW_ENV": "x", "FROM_ENV": "x"}})
	l, _ = r.svc.List("web", ScopePreview)
	got = map[string]string{}
	for _, v := range l.Vars {
		s := "null"
		if v.Shadows != nil {
			s = *v.Shadows
		}
		got[v.Key] = s
	}
	want = map[string]string{"PREVIEW_FILE": "env_file", "PREVIEW_ENV": "env", "FROM_ENV": "null"}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("preview shadows: %v, want %v", got, want)
	}
}

func TestValidationListsEveryProblemAndWritesNothing(t *testing.T) {
	r := newRig(t)
	r.apply("web", Change{Set: map[string]string{"KEEP": "1"}})
	r.now = t0.Add(time.Hour)
	issues := r.invalid("web", Change{
		Set: map[string]string{
			"1BAD": "x", "with space": "x", "a-b": "x", strings.Repeat("K", 129): "x", "": "x",
			"PATH": "x", "HOME": "x", "HOSTNAME": "x", "KEELSON_TOKEN": "x", "KEELSON_": "x", "PORT": "x",
			"HUGE": strings.Repeat("v", MaxValueBytes+1), "NUL": "a\x00b", "GOOD": "ok",
		},
		Unset: []string{"bad key", "GOOD"},
		Build: []string{"MISSING"},
	})
	byKey := map[string]string{}
	for _, i := range issues {
		byKey[i.Key] += i.Message + "|"
	}
	for _, k := range []string{"1BAD", "with space", "a-b", strings.Repeat("K", 129), "", "PATH", "HOME", "HOSTNAME", "KEELSON_TOKEN", "KEELSON_", "PORT", "HUGE", "NUL", "bad key", "GOOD", "MISSING"} {
		if byKey[k] == "" {
			t.Errorf("no issue for %q (issues: %v)", k, byKey)
		}
	}
	if !strings.Contains(byKey["PORT"], "port") || !strings.Contains(byKey["HUGE"], "32 KiB") || !strings.Contains(byKey["NUL"], "NUL") {
		t.Errorf("messages: %v", byKey)
	}
	if byKey["KEEP"] != "" {
		t.Error("a valid stored key must not be blamed")
	}
	// All or nothing: the one valid key was not written, and the scope did not move.
	l, _ := r.svc.List("web", ScopeApp)
	if len(l.Vars) != 1 || l.Vars[0].Key != "KEEP" || *l.LastChanged != "2026-10-23T10:00:00Z" {
		t.Errorf("a refused change left a trace: %+v", l)
	}
}

func TestPortIsReservedOnlyWhereTheAgentControlsIt(t *testing.T) {
	r := newRig(t)
	if is := r.invalid("web", Change{Set: map[string]string{"PORT": "1"}}); issueKeys(is)[0] != "PORT" {
		t.Errorf("%v", is)
	}
	if is := r.invalid("web", Change{Scope: ScopePreview, Set: map[string]string{"PORT": "1"}}); len(is) != 1 {
		t.Errorf("a preview instance runs on its parent's port: %v", is)
	}
	// host_ports: the app's port_env is the agent's, PORT is then free.
	if is := r.invalid("worker", Change{Set: map[string]string{"LISTEN_PORT": "1"}}); issueKeys(is)[0] != "LISTEN_PORT" {
		t.Errorf("%v", is)
	}
	r.apply("plain", Change{Set: map[string]string{"PORT": "8080", "LISTEN_PORT": "1"}})
}

func TestScopeLimits(t *testing.T) {
	r := newRig(t)
	many := map[string]string{}
	for i := 0; i <= MaxKeys; i++ {
		many[fmt.Sprintf("K%03d", i)] = "v"
	}
	if is := r.invalid("plain", Change{Set: many}); len(is) != 1 || is[0].Key != "" || !strings.Contains(is[0].Message, "200") {
		t.Errorf("%v", is)
	}
	delete(many, "K000")
	r.apply("plain", Change{Set: many}) // exactly 200
	if is := r.invalid("plain", Change{Set: map[string]string{"ONE_MORE": "v"}}); len(is) != 1 || is[0].Key != "" {
		t.Errorf("the 201st key: %v", is)
	}
	if res := r.apply("plain", Change{Set: map[string]string{"ONE_MORE": "v"}, Unset: []string{"K001"}}); len(res.Changed) != 1 {
		t.Errorf("replacing within the limit: %+v", res)
	}

	big := map[string]string{}
	for i := 0; i < 9; i++ { // 9 x 32 KiB > 256 KiB
		big[fmt.Sprintf("BIG%d", i)] = strings.Repeat("x", MaxValueBytes)
	}
	if is := r.invalid("worker", Change{Set: big}); len(is) != 1 || is[0].Key != "" || !strings.Contains(is[0].Message, "256 KiB") {
		t.Errorf("%v", is)
	}
	delete(big, "BIG8")
	for k := range big {
		big[k] = big[k][:MaxValueBytes-8] // 8 values of just under 32 KiB, names included: just fits
	}
	r.apply("worker", Change{Set: big})
}

func TestBuildFlagSemantics(t *testing.T) {
	r := newRig(t)
	flags := func() map[string]bool {
		l, _ := r.svc.List("web", ScopeApp)
		m := map[string]bool{}
		for _, v := range l.Vars {
			m[v.Key] = v.Build
		}
		return m
	}
	r.apply("web", Change{Set: map[string]string{"A": "1", "B": "2", "C": "3"}, Build: []string{"A", "B"}})
	if !reflect.DeepEqual(flags(), map[string]bool{"A": true, "B": true, "C": false}) {
		t.Fatalf("%v", flags())
	}
	// Absent: flags are left alone, a new key has none.
	r.now = t0.Add(time.Minute)
	res := r.apply("web", Change{Set: map[string]string{"A": "changed", "D": "4"}})
	if !reflect.DeepEqual(res.Changed, []string{"A", "D"}) || !reflect.DeepEqual(flags(), map[string]bool{"A": true, "B": true, "C": false, "D": false}) {
		t.Fatalf("%+v %v", res, flags())
	}
	// Present: the exact list. B loses the flag, C (stored, not in set) gains it, without any value being sent.
	r.now = t0.Add(2 * time.Minute)
	res = r.apply("web", Change{Build: []string{"A", "C"}})
	if !reflect.DeepEqual(res.Changed, []string{"B", "C"}) || !reflect.DeepEqual(flags(), map[string]bool{"A": true, "B": false, "C": true, "D": false}) {
		t.Fatalf("%+v %v", res, flags())
	}
	// An empty list clears every flag.
	r.apply("web", Change{Build: []string{}})
	if f := flags(); f["A"] || f["C"] {
		t.Errorf("%v", f)
	}
	// A key must exist to be a build argument; one being removed cannot be listed.
	if is := r.invalid("web", Change{Unset: []string{"A"}, Build: []string{"A"}}); issueKeys(is)[0] != "A" {
		t.Errorf("%v", is)
	}
	if is := r.invalid("web", Change{Set: map[string]string{"A": "x"}, Unset: []string{"A"}}); issueKeys(is)[0] != "A" {
		t.Errorf("set and unset together: %v", is)
	}
	// BuildArgs gives the values of the flagged ones.
	r.apply("web", Change{Build: []string{"B", "D"}})
	args, err := r.svc.BuildArgs(r.app("web"))
	if err != nil || !reflect.DeepEqual(args, map[string]string{"B": "2", "D": "4"}) {
		t.Errorf("%v %v", args, err)
	}
	if args, _ := r.svc.BuildArgs(r.app("plain")); len(args) != 0 {
		t.Errorf("%v", args)
	}
}

func TestEffectiveEnvironmentPrecedenceAndOrder(t *testing.T) {
	r := newRig(t)
	r.apply("web", Change{Set: map[string]string{"BOTH": "managed", "DATABASE_URL": "postgres://managed", "Z_NEW": "z", "A_NEW": "a"}})
	env, ignored, err := r.svc.Effective(r.app("web"))
	if err != nil || len(ignored) != 0 {
		t.Fatal(err, ignored)
	}
	// env_file (file order), env (sorted) replacing in place, then the stored keys that are new, sorted.
	want := []string{"FROM_FILE=file", "BOTH=managed", "DATABASE_URL=postgres://managed", "FROM_ENV=env", "A_NEW=a", "Z_NEW=z"}
	if !reflect.DeepEqual(env, want) {
		t.Errorf("got  %v\nwant %v", env, want)
	}
	// Without any stored variable the environment is the file's, unchanged.
	env, _, _ = r.svc.Effective(r.app("plain"))
	base, _ := r.app("plain").Environment()
	if !reflect.DeepEqual(env, base) {
		t.Errorf("%v %v", env, base)
	}
	// No store at all is the file's too.
	var none *Service
	if env, _, err := none.Effective(r.app("web")); err != nil || !strings.Contains(strings.Join(env, ","), "BOTH=env") {
		t.Errorf("%v %v", env, err)
	}
}

func TestAPreviewInstanceGetsOnlyThePreviewScopeOnTopOfItsTemplate(t *testing.T) {
	r := newRig(t)
	r.apply("web", Change{Set: map[string]string{"APP_ONLY": "1", "BOTH": "app-scope"}})
	r.apply("web", Change{Scope: ScopePreview, Set: map[string]string{"PREVIEW_ONLY": "1", "BOTH": "preview-scope"}})

	tpl, _ := r.svc.Config().Previews("web")
	inst := tpl.Instance(r.app("web"), 12)
	env, _, err := r.svc.Effective(inst)
	if err != nil {
		t.Fatal(err)
	}
	joined := strings.Join(env, "\n")
	for _, want := range []string{"PREVIEW_FILE=file", "PREVIEW_ENV=env", "PREVIEW_ONLY=1", "BOTH=preview-scope"} {
		if !strings.Contains(joined, want) {
			t.Errorf("missing %q in\n%s", want, joined)
		}
	}
	// Nothing of the parent's: neither its file, its env, nor its app scope.
	for _, bad := range []string{"APP_ONLY", "app-scope", "FROM_FILE", "FROM_ENV", "DATABASE_URL", "postgres://production"} {
		if strings.Contains(joined, bad) {
			t.Errorf("%q reached the preview:\n%s", bad, joined)
		}
	}
	// ... and the app does not get the preview scope.
	env, _, _ = r.svc.Effective(r.app("web"))
	if j := strings.Join(env, "\n"); strings.Contains(j, "PREVIEW_ONLY") || !strings.Contains(j, "BOTH=app-scope") {
		t.Errorf("%s", j)
	}
	// Build arguments follow the same split.
	r.apply("web", Change{Build: []string{"APP_ONLY"}})
	r.apply("web", Change{Scope: ScopePreview, Build: []string{"PREVIEW_ONLY"}})
	if a, _ := r.svc.BuildArgs(inst); !reflect.DeepEqual(a, map[string]string{"PREVIEW_ONLY": "1"}) {
		t.Errorf("instance build args: %v", a)
	}
	if a, _ := r.svc.BuildArgs(r.app("web")); !reflect.DeepEqual(a, map[string]string{"APP_ONLY": "1"}) {
		t.Errorf("app build args: %v", a)
	}
}

func TestAStoredKeyTheAgentNowOwnsIsLeftOutAndReported(t *testing.T) {
	r := newRig(t)
	r.apply("plain", Change{Set: map[string]string{"PORT": "9999", "OK": "1"}})
	cfg := r.svc.Config()
	ported := cfg.Apps[2]
	ported.ContainerPort = 3000 // the operator gave the app a port after PORT was stored
	env, ignored, err := r.svc.Effective(ported)
	if err != nil || !reflect.DeepEqual(ignored, []string{"PORT"}) || strings.Contains(strings.Join(env, ","), "PORT=") {
		t.Errorf("%v %v %v", env, ignored, err)
	}
}

func TestAnUnreadableStoreFailsTheEnvironmentInsteadOfDeployingWithoutIt(t *testing.T) {
	r := newRig(t)
	if err := os.WriteFile(filepath.Join(r.svc.Store.Dir(), "web.app.env"), []byte(config.ManagedEnvHeader+"\nX=oops\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, _, err := r.svc.Effective(r.app("web")); err == nil {
		t.Error("a corrupt scope must stop the deployment")
	}
}

func TestChangedAtIsTheLatestOverBothScopesAndCountsRemovals(t *testing.T) {
	r := newRig(t)
	if r.svc.ChangedAt("web") != "" {
		t.Error("nothing stored yet")
	}
	r.apply("web", Change{Set: map[string]string{"A": "1"}})
	if got := r.svc.ChangedAt("web"); got != "2026-10-23T10:00:00Z" {
		t.Errorf("%s", got)
	}
	r.now = t0.Add(time.Hour)
	r.apply("web", Change{Scope: ScopePreview, Set: map[string]string{"A": "1"}})
	if got := r.svc.ChangedAt("web"); got != "2026-10-23T11:00:00Z" {
		t.Errorf("%s", got)
	}
	r.now = t0.Add(2 * time.Hour)
	r.apply("web", Change{Unset: []string{"A"}})
	if got := r.svc.ChangedAt("web"); got != "2026-10-23T12:00:00Z" {
		t.Errorf("removing a variable is a change: %s", got)
	}
	if r.svc.ChangedAt("plain") != "" || r.svc.ChangedAt("../x") != "" {
		t.Error("other apps are untouched")
	}
}

func TestClearEmptiesTheScopeAndKeepsItStamped(t *testing.T) {
	r := newRig(t)
	r.apply("web", Change{Set: map[string]string{"A": "1", "B": "2"}})
	r.apply("web", Change{Scope: ScopePreview, Set: map[string]string{"P": "1"}})
	r.now = t0.Add(time.Hour)
	removed, err := r.svc.Clear("web", ScopeApp)
	if err != nil || !reflect.DeepEqual(removed, []string{"A", "B"}) {
		t.Fatalf("%v %v", removed, err)
	}
	l, _ := r.svc.List("web", ScopeApp)
	if len(l.Vars) != 0 || *l.LastChanged != "2026-10-23T11:00:00Z" {
		t.Errorf("%+v", l)
	}
	if l, _ := r.svc.List("web", ScopePreview); len(l.Vars) != 1 {
		t.Error("the other scope must stay")
	}
	// Clearing an empty (or never written) scope is not a change.
	r.now = t0.Add(2 * time.Hour)
	if removed, err := r.svc.Clear("web", ScopeApp); err != nil || removed == nil || len(removed) != 0 {
		t.Errorf("%v %v", removed, err)
	}
	if got := r.svc.ChangedAt("web"); got != "2026-10-23T11:00:00Z" {
		t.Errorf("%s", got)
	}
	if _, err := r.svc.Clear("web", "nope"); !errors.Is(err, ErrBadScope) {
		t.Errorf("%v", err)
	}
}

func TestAppsOutsideTheFileAreUnknownButTheirStoredVariablesAreReportedAndRemovable(t *testing.T) {
	r := newRig(t)
	// An app that was in the file when its variables were stored.
	put(t, r.svc.Store, "gone", ScopeApp, t0, map[string]string{"SECRET": "s3cr3t-value-0002"})
	put(t, r.svc.Store, "gone", ScopePreview, t0, map[string]string{"X": "1"})

	var unknown *UnknownAppError
	if _, err := r.svc.List("gone", ScopeApp); !errors.As(err, &unknown) || !reflect.DeepEqual(unknown.Orphans, []string{ScopeApp, ScopePreview}) {
		t.Fatalf("%v", err)
	}
	if _, err := r.svc.Apply("gone", Change{Set: map[string]string{"A": "1"}}); !errors.As(err, &unknown) {
		t.Errorf("a change for an app that is not in the file: %v", err)
	}
	if _, err := r.svc.List("never-existed", ScopeApp); !errors.As(err, &unknown) || len(unknown.Orphans) != 0 {
		t.Errorf("%v", err)
	}
	if _, err := r.svc.List("../etc", ScopeApp); !errors.As(err, &unknown) {
		t.Errorf("%v", err)
	}

	removed, err := r.svc.Clear("gone", ScopeApp)
	if err != nil || !reflect.DeepEqual(removed, []string{"SECRET"}) {
		t.Fatalf("%v %v", removed, err)
	}
	if _, err := os.Stat(filepath.Join(r.svc.Store.Dir(), "gone.app.env")); !os.IsNotExist(err) {
		t.Error("the orphaned file must be deleted")
	}
	if _, err := r.svc.Clear("gone", ScopeApp); !errors.As(err, &unknown) {
		t.Errorf("nothing left to delete: %v", err)
	}
	if _, err := r.svc.Clear("gone", ScopePreview); err != nil {
		t.Errorf("the other scope is still there: %v", err)
	}
	// An app that comes back finds its variables again.
	put(t, r.svc.Store, "plain", ScopeApp, t0, map[string]string{"BACK": "1"})
	if l, err := r.svc.List("plain", ScopeApp); err != nil || len(l.Vars) != 1 {
		t.Errorf("%+v %v", l, err)
	}
}

func TestBadScopeIsRefused(t *testing.T) {
	r := newRig(t)
	if _, err := r.svc.List("web", "prod"); !errors.Is(err, ErrBadScope) {
		t.Errorf("%v", err)
	}
	if _, err := r.svc.Apply("web", Change{Scope: "../x"}); !errors.Is(err, ErrBadScope) {
		t.Errorf("%v", err)
	}
	if res := r.apply("web", Change{}); res.Scope != ScopeApp {
		t.Errorf("the scope defaults to app: %+v", res)
	}
}

const managedDoc = `
apps:
  - name: shop
    image: ghcr.io/o/shop
  - name: other
    image: ghcr.io/o/other
databases:
  - name: shopdb
    managed: true
    app: shop
    env_key: DATABASE_URL
    engine: postgres
    host: keelson-postgres
    port: 5432
    database: shopdb
    user: shopdb
    password_file: /var/lib/keelson/postgres/roles/shopdb.pw
    network: keelson
`

func managedService(t *testing.T, doc string) (*Service, *config.Config) {
	t.Helper()
	cfg, issues := config.Parse([]byte(doc))
	if cfg == nil {
		t.Fatalf("%+v", issues)
	}
	st, err := Open(filepath.Join(t.TempDir(), "envstore"))
	if err != nil {
		t.Fatal(err)
	}
	return &Service{Store: st, Config: func() *config.Config { return cfg }, Now: func() time.Time { return t0 }}, cfg
}

// A build argument is recorded in the image's history, so the URL of a managed database (its password is in it) is
// never one: refused when asked, and left out of a build when it was flagged before the database existed.
func TestTheURLOfAManagedDatabaseIsNeverABuildArgument(t *testing.T) {
	svc, _ := managedService(t, managedDoc)
	issues := func(app string, ch Change) []Issue {
		_, err := svc.Apply(app, ch)
		var inv *InvalidError
		if !errors.As(err, &inv) {
			return nil
		}
		return inv.Issues
	}
	got := issues("shop", Change{Set: map[string]string{"DATABASE_URL": "postgresql://u:p@h/d", "NEXT_PUBLIC_X": "1"}, Build: []string{"DATABASE_URL", "NEXT_PUBLIC_X"}})
	if len(got) != 1 || got[0].Key != "DATABASE_URL" || !strings.Contains(got[0].Message, "managed database") {
		t.Fatalf("issues: %+v", got)
	}
	// Nothing was written by the refused change, and an ordinary variable may still be a build argument.
	if l, _ := svc.List("shop", ScopeApp); len(l.Vars) != 0 {
		t.Errorf("a refused change wrote %+v", l.Vars)
	}
	if _, err := svc.Apply("shop", Change{Set: map[string]string{"DATABASE_URL": "postgresql://u:p@h/d", "NEXT_PUBLIC_X": "1"}, Build: []string{"NEXT_PUBLIC_X"}}); err != nil {
		t.Fatalf("a database URL that is not a build argument is fine: %v", err)
	}
	// Another app's DATABASE_URL is its own business: it has no managed database.
	if _, err := svc.Apply("other", Change{Set: map[string]string{"DATABASE_URL": "x"}, Build: []string{"DATABASE_URL"}}); err != nil {
		t.Errorf("another app: %v", err)
	}
}

func TestAKeyFlaggedBeforeTheDatabaseExistedIsLeftOutOfTheBuild(t *testing.T) {
	svc, _ := managedService(t, strings.Split(managedDoc, "databases:")[0])
	if _, err := svc.Apply("shop", Change{Set: map[string]string{"DATABASE_URL": "postgresql://u:secret@h/d", "PUBLIC_Y": "2"}, Build: []string{"DATABASE_URL", "PUBLIC_Y"}}); err != nil {
		t.Fatal(err)
	}
	app := func(c *config.Config) config.App { a, _ := c.App("shop"); return a }
	before, _ := svc.BuildArgs(app(svc.Config()))
	if len(before) != 2 {
		t.Fatalf("with no managed database both are arguments: %v", before)
	}
	withDB, cfg := managedService(t, managedDoc)
	withDB.Store = svc.Store
	args, err := withDB.BuildArgs(app(cfg))
	if err != nil || len(args) != 1 || args["PUBLIC_Y"] != "2" || strings.Contains(fmt.Sprint(args), "secret") {
		t.Errorf("build arguments once the database exists: %v (%v)", args, err)
	}
}

// `database: true` in the build block is the operator's explicit choice to give a build the managed database's URL (a build
// that queries its database to build): it is passed flagged or not, and only when the option is on.
func TestBuildDatabaseHandsTheManagedURLToTheBuild(t *testing.T) {
	svc, cfg := managedService(t, managedDoc)
	if _, err := svc.Apply("shop", Change{Set: map[string]string{"DATABASE_URL": "postgresql://u:secret@h/d", "PUBLIC_Y": "2", "UNRELATED": "3"}, Build: []string{"PUBLIC_Y"}}); err != nil {
		t.Fatal(err)
	}
	app, _ := cfg.App("shop")
	app.Build = &config.Build{}
	off, err := svc.BuildArgs(app)
	if err != nil || !reflect.DeepEqual(off, map[string]string{"PUBLIC_Y": "2"}) {
		t.Fatalf("without the option only the flagged variable is an argument: %v (%v)", off, err)
	}
	app.Build = &config.Build{Database: true}
	on, err := svc.BuildArgs(app)
	if err != nil || !reflect.DeepEqual(on, map[string]string{"DATABASE_URL": "postgresql://u:secret@h/d", "PUBLIC_Y": "2"}) {
		t.Fatalf("with the option the database URL joins the flagged one, and nothing else unflagged does: %v (%v)", on, err)
	}
}
