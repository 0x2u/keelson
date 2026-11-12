package appenv

import (
	"time"

	"github.com/0x2u/keelson/agent/internal/config"
)

// The build variables of an app name: what a build this server runs for another server (POST /v1/builds) is given as
// build arguments. They are kept under the name the request carries, whether or not an app of that name is in this
// server's apps file (a server that only builds for others has none), and are a scope of their own: an app of the same
// name keeps its own variables, which these never touch. Every one is a build argument; values go in and never come out.

// BuildVarsChange is the body of PUT /v1/build-vars/{app}. The rules are those of any scope (see check).
type BuildVarsChange struct {
	// Set creates or replaces variables.
	Set map[string]string `json:"set"`
	// Remove deletes variables; one that is not stored is ignored.
	Remove []string `json:"remove"`
}

// BuildVarsResult is what a BuildVarsChange did. Names only.
type BuildVarsResult struct {
	Changed []string `json:"changed"`
	Removed []string `json:"removed"`
}

// BuildVarName is a stored build variable as the API lists it: never the value.
type BuildVarName struct {
	Name      string `json:"name"`
	ChangedAt string `json:"changed_at"`
}

// BuildVarsListing is the answer of GET /v1/build-vars/{app}.
type BuildVarsListing struct {
	Names []BuildVarName `json:"names"`
}

// ListBuildVars describes the build variables stored for an app name.
func (s *Service) ListBuildVars(app string) (BuildVarsListing, error) {
	sc, err := s.Store.Read(app, ScopeBuild)
	if err != nil {
		return BuildVarsListing{}, err
	}
	out := BuildVarsListing{Names: []BuildVarName{}}
	for _, k := range sc.Keys() {
		out.Names = append(out.Names, BuildVarName{Name: k, ChangedAt: rfc3339(sc.Entries[k].UpdatedAt)})
	}
	return out, nil
}

// ApplyBuildVars validates and applies a change atomically, like Apply: every problem is returned at once, and nothing
// is written unless there is none.
func (s *Service) ApplyBuildVars(app string, ch BuildVarsChange) (BuildVarsResult, error) {
	now := s.now().UTC().Truncate(time.Second)
	res := BuildVarsResult{Changed: []string{}, Removed: []string{}}
	err := s.Store.Update(app, ScopeBuild, now, func(sc *Scope) (bool, error) {
		change := Change{Scope: ScopeBuild, Set: ch.Set, Unset: ch.Remove}
		if issues := check(config.App{}, change, *sc, nil); len(issues) > 0 {
			return false, &InvalidError{Issues: issues}
		}
		// Every variable of the scope is a build argument: flag the keys that exist once the change is applied.
		removing := make(map[string]bool, len(ch.Remove))
		for _, k := range ch.Remove {
			removing[k] = true
		}
		change.Build = []string{}
		for k := range sc.Entries {
			if !removing[k] {
				change.Build = append(change.Build, k)
			}
		}
		for k := range ch.Set {
			change.Build = append(change.Build, k)
		}
		res.Changed, res.Removed = edit(sc, change, now)
		return len(res.Changed) > 0 || len(res.Removed) > 0, nil
	})
	return res, err
}

// ClearBuildVars removes every build variable stored for an app name and returns their names. A file that cannot be
// read is removed all the same.
func (s *Service) ClearBuildVars(app string) ([]string, error) {
	sc, _ := s.Store.Read(app, ScopeBuild)
	if _, err := s.Store.Remove(app, ScopeBuild); err != nil {
		return nil, err
	}
	return keysOrEmpty(sc), nil
}

// BuildVars returns the build variables stored for an app name, nil when there are none. A nil Service has none.
func (s *Service) BuildVars(app string) (map[string]string, error) {
	if s == nil {
		return nil, nil
	}
	sc, err := s.Store.Read(app, ScopeBuild)
	if err != nil {
		return nil, err
	}
	if len(sc.Entries) == 0 {
		return nil, nil
	}
	out := make(map[string]string, len(sc.Entries))
	for k, e := range sc.Entries {
		out[k] = e.Value
	}
	return out, nil
}
