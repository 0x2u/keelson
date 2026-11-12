package appenv

import (
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

const buildVarSecret = "postgres://u:Bu1ld-V4r-0001@127.0.0.1:5432/site"

func TestBuildVarsOfANameThatIsNoAppAreStoredListedWithoutValuesAndAllArguments(t *testing.T) {
	r := newRig(t)
	r.svc.Now = func() time.Time { return t0 }
	res, err := r.svc.ApplyBuildVars("not-an-app", BuildVarsChange{Set: map[string]string{"DATABASE_URL": buildVarSecret, "A": "1"}})
	if err != nil || !reflect.DeepEqual(res, BuildVarsResult{Changed: []string{"A", "DATABASE_URL"}, Removed: []string{}}) {
		t.Fatalf("%+v %v", res, err)
	}
	l, err := r.svc.ListBuildVars("not-an-app")
	if err != nil || len(l.Names) != 2 || l.Names[0].Name != "A" || l.Names[1].Name != "DATABASE_URL" || l.Names[1].ChangedAt != t0.UTC().Format(time.RFC3339) {
		t.Fatalf("%+v %v", l, err)
	}
	if strings.Contains(strings.Join([]string{l.Names[0].Name, l.Names[0].ChangedAt, l.Names[1].Name, l.Names[1].ChangedAt}, " "), "Bu1ld") {
		t.Error("a value is in the listing")
	}
	args, err := r.svc.BuildVars("not-an-app")
	if err != nil || !reflect.DeepEqual(args, map[string]string{"A": "1", "DATABASE_URL": buildVarSecret}) {
		t.Errorf("%v %v", args, err)
	}
	if none, err := r.svc.BuildVars("nothing-here"); err != nil || none != nil {
		t.Errorf("%v %v", none, err)
	}

	// The same file mode as the other variables, and a file of its own beside them.
	p := filepath.Join(r.svc.Store.Dir(), "not-an-app.build.env")
	fi, err := os.Stat(p)
	if err != nil || fi.Mode().Perm() != 0o600 {
		t.Fatalf("%v %v", fi, err)
	}
	sc, _ := r.svc.Store.Read("not-an-app", ScopeBuild)
	for k, e := range sc.Entries {
		if !e.Build {
			t.Errorf("%s must be flagged for build", k)
		}
	}

	// A change that removes one and replaces one; an unchanged value is no change.
	res, err = r.svc.ApplyBuildVars("not-an-app", BuildVarsChange{Set: map[string]string{"DATABASE_URL": buildVarSecret, "A": "2"}, Remove: []string{"GONE"}})
	if err != nil || !reflect.DeepEqual(res.Changed, []string{"A"}) || len(res.Removed) != 0 {
		t.Errorf("%+v %v", res, err)
	}
	res, _ = r.svc.ApplyBuildVars("not-an-app", BuildVarsChange{Remove: []string{"A"}})
	if !reflect.DeepEqual(res.Removed, []string{"A"}) || len(res.Changed) != 0 {
		t.Errorf("%+v", res)
	}
	removed, err := r.svc.ClearBuildVars("not-an-app")
	if err != nil || !reflect.DeepEqual(removed, []string{"DATABASE_URL"}) {
		t.Errorf("%v %v", removed, err)
	}
	if _, err := os.Stat(p); !os.IsNotExist(err) {
		t.Error("the file must be gone")
	}
	if removed, err := r.svc.ClearBuildVars("not-an-app"); err != nil || removed == nil || len(removed) != 0 {
		t.Errorf("clearing nothing: %v %v", removed, err)
	}
}

func TestBuildVarsAreAScopeOfTheirOwnAndNeverTouchTheAppsVariables(t *testing.T) {
	r := newRig(t)
	r.apply("web", Change{Set: map[string]string{"OWN": "own-value", "API_URL": "https://own"}, Build: []string{"API_URL"}})
	if _, err := r.svc.ApplyBuildVars("web", BuildVarsChange{Set: map[string]string{"API_URL": "https://builder", "ONLY_BUILDER": "b-value"}}); err != nil {
		t.Fatal(err)
	}
	l, _ := r.svc.List("web", ScopeApp)
	if len(l.Vars) != 2 || l.Vars[0].Key != "API_URL" || l.Vars[1].Key != "OWN" {
		t.Errorf("the app's own scope: %+v", l)
	}
	if args, _ := r.svc.BuildArgs(r.app("web")); !reflect.DeepEqual(args, map[string]string{"API_URL": "https://own"}) {
		t.Errorf("the app's own build uses its own scope: %v", args)
	}
	if env, _, _ := r.svc.Effective(r.app("web")); strings.Contains(strings.Join(env, ","), "builder") {
		t.Errorf("a deployment never sees the build variables: %v", env)
	}
	if scopes, _ := r.svc.Store.Scopes("web"); !reflect.DeepEqual(scopes, []string{ScopeApp}) {
		t.Errorf("build variables are not a scope of the app: %v", scopes)
	}
	if _, err := r.svc.List("web", ScopeBuild); !errors.Is(err, ErrBadScope) {
		t.Errorf("the variables API has no build scope: %v", err)
	}
	// Clearing them leaves the app's alone.
	if _, err := r.svc.ClearBuildVars("web"); err != nil {
		t.Fatal(err)
	}
	if l, _ := r.svc.List("web", ScopeApp); len(l.Vars) != 2 {
		t.Errorf("%+v", l)
	}
}

func TestBuildVarsFollowTheRulesOfEveryScopeAndAnInvalidNameWritesNothing(t *testing.T) {
	r := newRig(t)
	long := strings.Repeat("V", MaxValueBytes+1)
	_, err := r.svc.ApplyBuildVars("site", BuildVarsChange{
		Set:    map[string]string{"PATH": "x", "1bad": "y", "KEELSON_X": "z", "BIG": long, "NUL": "a\x00b", "BOTH": "1", "OK": "1"},
		Remove: []string{"BOTH", "also bad"},
	})
	var inv *InvalidError
	if !errors.As(err, &inv) {
		t.Fatalf("%v", err)
	}
	bad := map[string]bool{}
	for _, is := range inv.Issues {
		bad[is.Key] = true
	}
	for _, k := range []string{"PATH", "1bad", "KEELSON_X", "BIG", "NUL", "BOTH", "also bad"} {
		if !bad[k] {
			t.Errorf("%q must be refused: %+v", k, inv.Issues)
		}
	}
	if bad["OK"] {
		t.Error("OK is fine")
	}
	if l, _ := r.svc.ListBuildVars("site"); len(l.Names) != 0 {
		t.Errorf("nothing may be written: %+v", l)
	}
	if _, err := os.Stat(filepath.Join(r.svc.Store.Dir(), "site.build.env")); !os.IsNotExist(err) {
		t.Error("no file may exist")
	}

	many := map[string]string{}
	for i := 0; i <= MaxKeys; i++ {
		many["K"+strings.Repeat("0", 3)+string(rune('a'+i%26))+string(rune('a'+i/26))] = "1"
	}
	if _, err := r.svc.ApplyBuildVars("site", BuildVarsChange{Set: many}); !errors.As(err, &inv) {
		t.Errorf("the scope is limited like any other: %v", err)
	}

	for _, name := range []string{"../x", "a/b", "", "UPPER", "a.b", "x\x00y", ".."} {
		if _, err := r.svc.ApplyBuildVars(name, BuildVarsChange{Set: map[string]string{"A": "1"}}); !errors.Is(err, ErrBadName) {
			t.Errorf("ApplyBuildVars(%q): %v", name, err)
		}
		if _, err := r.svc.ListBuildVars(name); !errors.Is(err, ErrBadName) {
			t.Errorf("ListBuildVars(%q): %v", name, err)
		}
		if _, err := r.svc.ClearBuildVars(name); !errors.Is(err, ErrBadName) {
			t.Errorf("ClearBuildVars(%q): %v", name, err)
		}
	}
}

func TestANilServiceHasNoBuildVars(t *testing.T) {
	var s *Service
	if v, err := s.BuildVars("site"); v != nil || err != nil {
		t.Errorf("%v %v", v, err)
	}
}
