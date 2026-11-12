package appenv

import (
	"errors"
	"fmt"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/0x2u/keelson/agent/internal/config"
)

// Limits of a scope.
const (
	MaxKeyLength  = 128
	MaxValueBytes = 32 << 10
	MaxScopeBytes = 256 << 10 // the keys and values of a scope together
	MaxKeys       = 200
)

var keyPattern = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]{0,127}$`)

// ValidKey reports whether s may be the name of a variable.
func ValidKey(s string) bool { return keyPattern.MatchString(s) }

// Reserved names: the container runtime sets them, or the agent owns them.
var reserved = map[string]string{
	"PATH":     "set by the image and the container runtime",
	"HOME":     "set by the image and the container runtime",
	"HOSTNAME": "set by the container runtime",
}

// ReservedReason says why key cannot be set for app, or "" when it can. PORT (or the app's port_env) belongs to the
// agent when it decides the port: a published container port (port:) or the alternating ports of host_ports.
func ReservedReason(a config.App, key string) string {
	if r, ok := reserved[key]; ok {
		return r
	}
	if strings.HasPrefix(key, "KEELSON_") {
		return "the KEELSON_ prefix is reserved for the agent"
	}
	if a.ContainerPort > 0 || len(a.HostPorts) > 0 {
		if key == "PORT" {
			return "the agent controls the port of an app with port or host_ports"
		}
		if len(a.HostPorts) > 0 && key == a.PortEnv {
			return "the agent sets it (port_env) to the port the new version listens on"
		}
	}
	return ""
}

// Change is the body of PUT /v1/apps/{app}/env.
type Change struct {
	// Scope is "app" (the default) or "preview".
	Scope string `json:"scope"`
	// Set creates or replaces variables.
	Set map[string]string `json:"set"`
	// Build, when present (even empty), is the exact list of keys that are also passed as build arguments once the
	// change is applied: a key not in it loses the flag. Absent, flags are left alone (a new key has none).
	Build []string `json:"build"`
	// Unset removes variables; one that is not stored is ignored.
	Unset []string `json:"unset"`
}

// Result is what a Change did. Keys only: no value ever leaves the agent.
type Result struct {
	Scope   string   `json:"scope"`
	Changed []string `json:"changed"`
	Removed []string `json:"removed"`
}

// Issue is one reason a change is refused. Key is empty for a problem of the scope as a whole.
type Issue struct {
	Key     string `json:"key"`
	Message string `json:"message"`
}

// InvalidError is a refused change: every problem is listed, nothing was written.
type InvalidError struct{ Issues []Issue }

func (e *InvalidError) Error() string {
	return fmt.Sprintf("invalid environment change: %d problem(s)", len(e.Issues))
}

// Errors of the service.
var (
	ErrBadScope = errors.New("scope must be app or preview")
)

// UnknownAppError is returned for an app that is not in the apps file. Orphans lists the scopes the store still
// keeps for it (an app removed from the file keeps its variables: re-adding it brings them back).
type UnknownAppError struct{ Orphans []string }

func (e *UnknownAppError) Error() string { return "unknown app" }

// Var is a stored variable as the API lists it: never the value.
type Var struct {
	Key       string `json:"key"`
	UpdatedAt string `json:"updated_at"`
	Build     bool   `json:"build"`
	// Shadows says the stored value overrides one the apps file defines ("env_file" or "env"); null otherwise.
	Shadows *string `json:"shadows"`
}

// Listing is the answer of GET /v1/apps/{app}/env.
type Listing struct {
	Scope string `json:"scope"`
	Vars  []Var  `json:"vars"`
	// LastChanged is when the scope last changed (RFC 3339), null if it never did.
	LastChanged *string `json:"last_changed"`
}

// Service applies the rules of the stored variables to the apps of a configuration.
type Service struct {
	Store *Store
	// Config returns the current apps file.
	Config func() *config.Config
	// Now defaults to time.Now.
	Now func() time.Time
}

func (s *Service) now() time.Time {
	if s.Now != nil {
		return s.Now()
	}
	return time.Now()
}

func (s *Service) app(name string) (config.App, error) {
	if config.ValidName(name) {
		if a, ok := s.Config().App(name); ok {
			return a, nil
		}
		orphans, _ := s.Store.Scopes(name)
		return config.App{}, &UnknownAppError{Orphans: orphans}
	}
	return config.App{}, &UnknownAppError{}
}

func rfc3339(t time.Time) string { return t.UTC().Format(time.RFC3339) }

// List describes the stored variables of an app's scope.
func (s *Service) List(app, scope string) (Listing, error) {
	if !ValidScope(scope) {
		return Listing{}, ErrBadScope
	}
	a, err := s.app(app)
	if err != nil {
		return Listing{}, err
	}
	sc, err := s.Store.Read(a.Name, scope)
	if err != nil {
		return Listing{}, err
	}
	fromFile, fromEnv := s.declared(a, scope)
	out := Listing{Scope: scope, Vars: []Var{}}
	for _, k := range sc.Keys() {
		e := sc.Entries[k]
		v := Var{Key: k, UpdatedAt: rfc3339(e.UpdatedAt), Build: e.Build}
		switch {
		case fromEnv[k]:
			v.Shadows = new("env")
		case fromFile[k]:
			v.Shadows = new("env_file")
		}
		out.Vars = append(out.Vars, v)
	}
	if !sc.Changed.IsZero() {
		out.LastChanged = new(rfc3339(sc.Changed))
	}
	return out, nil
}

// declared returns the keys the apps file defines for the scope: in the env_file and in env. Of an app, its own; of
// a preview scope, the template's (the parent's are never inherited). A missing or unreadable env_file declares
// nothing here: the deployment reports it.
func (s *Service) declared(a config.App, scope string) (fromFile, fromEnv map[string]bool) {
	fromFile, fromEnv = map[string]bool{}, map[string]bool{}
	envFile, env := a.EnvFile, a.Env
	if scope == ScopePreview {
		t, ok := s.Config().Previews(a.Name)
		if !ok {
			return
		}
		envFile, env = t.EnvFile, t.Env
	}
	if envFile != "" {
		if pairs, err := config.ReadEnvFile(envFile); err == nil {
			for _, kv := range pairs {
				fromFile[kv[0]] = true
			}
		}
	}
	for k := range env {
		fromEnv[k] = true
	}
	return
}

// Apply validates and applies a change atomically: every problem is returned at once, and nothing is written unless
// there is none.
func (s *Service) Apply(app string, ch Change) (Result, error) {
	if ch.Scope == "" {
		ch.Scope = ScopeApp
	}
	if !ValidScope(ch.Scope) {
		return Result{}, ErrBadScope
	}
	a, err := s.app(app)
	if err != nil {
		return Result{}, err
	}
	now := s.now().UTC().Truncate(time.Second)
	res := Result{Scope: ch.Scope, Changed: []string{}, Removed: []string{}}
	err = s.Store.Update(a.Name, ch.Scope, now, func(sc *Scope) (bool, error) {
		if issues := check(a, ch, *sc, s.neverBuild(a, ch.Scope)); len(issues) > 0 {
			return false, &InvalidError{Issues: issues}
		}
		res.Changed, res.Removed = edit(sc, ch, now)
		return len(res.Changed) > 0 || len(res.Removed) > 0, nil
	})
	return res, err
}

// edit applies a change that check accepted to the scope, and returns the keys it changed and removed, sorted.
func edit(sc *Scope, ch Change, now time.Time) (changed, removed []string) {
	changed, removed = []string{}, []string{}
	touched := map[string]bool{}
	for _, k := range ch.Unset {
		if _, ok := sc.Entries[k]; ok {
			delete(sc.Entries, k)
			removed = append(removed, k)
		}
	}
	for k, v := range ch.Set {
		e, ok := sc.Entries[k]
		if !ok || e.Value != v {
			e.Value, e.UpdatedAt = v, now
			sc.Entries[k] = e
			touched[k] = true
		}
	}
	if ch.Build != nil {
		want := map[string]bool{}
		for _, k := range ch.Build {
			want[k] = true
		}
		for k, e := range sc.Entries {
			if e.Build != want[k] {
				e.Build, e.UpdatedAt = want[k], now
				sc.Entries[k] = e
				touched[k] = true
			}
		}
	}
	for k := range touched {
		changed = append(changed, k)
	}
	sort.Strings(changed)
	sort.Strings(removed)
	return changed, removed
}

// check lists everything wrong with a change to the scope as it is now.
func check(a config.App, ch Change, cur Scope, neverBuild map[string]bool) []Issue {
	var issues []Issue
	add := func(key, format string, args ...any) {
		issues = append(issues, Issue{Key: key, Message: fmt.Sprintf(format, args...)})
	}

	unset := map[string]bool{}
	for _, k := range ch.Unset {
		if !ValidKey(k) {
			add(k, "not a valid variable name (letters, digits and underscores, not starting with a digit, up to %d characters)", MaxKeyLength)
		}
		unset[k] = true
	}
	next := map[string]int{} // the keys after the change, with the size of their value
	for k, e := range cur.Entries {
		if !unset[k] {
			next[k] = len(e.Value)
		}
	}
	for k, v := range ch.Set {
		switch {
		case !ValidKey(k):
			add(k, "not a valid variable name (letters, digits and underscores, not starting with a digit, up to %d characters)", MaxKeyLength)
			continue
		case unset[k]:
			add(k, "is both set and unset")
			continue
		}
		if why := ReservedReason(a, k); why != "" {
			add(k, "is reserved: %s", why)
		}
		if len(v) > MaxValueBytes {
			add(k, "value is longer than %d KiB", MaxValueBytes>>10)
		}
		if strings.IndexByte(v, 0) >= 0 {
			add(k, "value contains a NUL character")
		}
		next[k] = len(v)
	}
	for _, k := range ch.Build {
		if _, ok := next[k]; !ok && ValidKey(k) {
			add(k, "is listed in build but is not set")
		} else if !ValidKey(k) {
			add(k, "not a valid variable name")
		} else if neverBuild[k] {
			add(k, "holds the URL of a managed database and is never a build argument: the image's history would keep its password")
		}
	}
	total := 0
	for k, n := range next {
		total += len(k) + n
	}
	if len(next) > MaxKeys {
		add("", "a scope holds at most %d variables (this change would leave %d)", MaxKeys, len(next))
	}
	if total > MaxScopeBytes {
		add("", "a scope holds at most %d KiB of names and values (this change would leave %d KiB)", MaxScopeBytes>>10, (total+1023)>>10)
	}
	sort.SliceStable(issues, func(i, j int) bool { return issues[i].Key < issues[j].Key })
	return issues
}

// Clear removes every variable of a scope and returns their keys. For an app of the file it keeps an empty scope
// stamped now (so the app reads as changed since its running version); for an app that is no longer in the file
// (orphaned variables) it deletes the file.
func (s *Service) Clear(app, scope string) ([]string, error) {
	if !ValidScope(scope) {
		return nil, ErrBadScope
	}
	a, err := s.app(app)
	var unknown *UnknownAppError
	if errors.As(err, &unknown) {
		for _, o := range unknown.Orphans {
			if o == scope {
				sc, rerr := s.Store.Read(app, scope)
				if _, err := s.Store.Remove(app, scope); err != nil {
					return nil, err
				}
				if rerr != nil {
					return []string{}, nil // an unreadable file is removed all the same
				}
				return keysOrEmpty(sc), nil
			}
		}
		return nil, err
	}
	if err != nil {
		return nil, err
	}
	var removed []string
	err = s.Store.Update(a.Name, scope, s.now(), func(sc *Scope) (bool, error) {
		if len(sc.Entries) == 0 {
			return false, nil
		}
		removed = sc.Keys()
		sc.Entries = map[string]Entry{}
		return true, nil
	})
	if removed == nil {
		removed = []string{}
	}
	return removed, err
}

func keysOrEmpty(sc Scope) []string {
	if k := sc.Keys(); k != nil {
		return k
	}
	return []string{}
}

// ChangedAt is when the app's stored variables last changed, in any scope (RFC 3339), or "" when they never did.
func (s *Service) ChangedAt(app string) string {
	var latest time.Time
	for _, scope := range []string{ScopeApp, ScopePreview} {
		if t, err := s.Store.Changed(app, scope); err == nil && t.After(latest) {
			latest = t
		}
	}
	if latest.IsZero() {
		return ""
	}
	return rfc3339(latest)
}

// scopeOf says which stored scope applies to the app that is about to run: the app's own, or for an instance of a
// preview the preview scope of its parent.
func scopeOf(a config.App) (app, scope string) {
	if a.Parent != "" {
		return a.Parent, ScopePreview
	}
	return a.Name, ScopeApp
}

// Effective returns the environment of the container to create: the apps file's (env_file, then env), then the stored
// variables, which win. The read of the scope is one consistent snapshot, so a change made meanwhile applies to the
// next deployment as a whole. ignored lists the stored keys left out because the agent owns them for this app now
// (the app got a port after the key was stored). A nil Service gives the apps file's environment alone.
func (s *Service) Effective(a config.App) (env, ignored []string, err error) {
	base, err := a.Environment()
	if err != nil {
		return nil, nil, err
	}
	if s == nil {
		return base, nil, nil
	}
	owner, scope := scopeOf(a)
	sc, err := s.Store.Read(owner, scope)
	if err != nil {
		return nil, nil, fmt.Errorf("read the stored variables (%s): %w", scope, err)
	}
	index := make(map[string]int, len(base))
	for i, kv := range base {
		k, _, _ := strings.Cut(kv, "=")
		index[k] = i
	}
	for _, k := range sc.Keys() {
		if ReservedReason(a, k) != "" {
			ignored = append(ignored, k)
			continue
		}
		kv := k + "=" + sc.Entries[k].Value
		if i, ok := index[k]; ok {
			base[i] = kv
		} else {
			index[k] = len(base)
			base = append(base, kv)
		}
	}
	return base, ignored, nil
}

// neverBuild is the set of variables of the scope that must not be passed as build arguments: the ones that hold the
// URL of a managed database, whose password a build argument would leave in the image's history. Only the app's own
// scope has any: a preview never gets a database.
func (s *Service) neverBuild(a config.App, scope string) map[string]bool {
	if s == nil || s.Config == nil || scope != ScopeApp {
		return nil
	}
	cfg := s.Config()
	if cfg == nil {
		return nil
	}
	keys := cfg.ManagedDatabaseKeys(a.Name)
	if len(keys) == 0 {
		return nil
	}
	out := make(map[string]bool, len(keys))
	for _, k := range keys {
		out[k] = true
	}
	return out
}

// BuildArgs returns the stored variables flagged as build arguments, for a build of the app (or of an instance of a
// preview: its parent's preview scope). A nil Service has none. Values are not secret once they are build arguments:
// the engine records them in the image's history.
//
// The variables that hold the URL of a managed database are never passed because they are flagged: whatever flagged them
// (a request made before the database existed, a hand edit) is ignored. They are passed only when the app's build block
// says `database: true`, the operator's explicit choice for a build that queries its database to build; the build then
// gets that URL as an argument whether it was flagged or not. Only the app's own scope has a database: a preview never does.
func (s *Service) BuildArgs(a config.App) (map[string]string, error) {
	if s == nil {
		return nil, nil
	}
	owner, scope := scopeOf(a)
	sc, err := s.Store.Read(owner, scope)
	if err != nil {
		return nil, fmt.Errorf("read the stored variables (%s): %w", scope, err)
	}
	never := s.neverBuild(a, scope) // flagged before the database existed, or by hand in the file: still never an argument
	var withDatabase map[string]bool
	if a.Build != nil && a.Build.Database && scope == ScopeApp {
		withDatabase, never = never, nil
	}
	var out map[string]string
	for k, e := range sc.Entries {
		if (e.Build || withDatabase[k]) && !never[k] {
			if out == nil {
				out = map[string]string{}
			}
			out[k] = e.Value
		}
	}
	return out, nil
}
