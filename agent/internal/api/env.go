package api

import (
	"errors"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/0x2u/keelson/agent/internal/appenv"
	"github.com/0x2u/keelson/agent/internal/config"
)

// EnvService is the variables set through the API, as the routes see them. Values go in and never come out.
type EnvService interface {
	List(app, scope string) (appenv.Listing, error)
	Apply(app string, ch appenv.Change) (appenv.Result, error)
	Clear(app, scope string) ([]string, error)
	// The build variables a build for another server uses, kept under the app name whether or not the app is in the
	// apps file (see appenv.BuildVars).
	ListBuildVars(app string) (appenv.BuildVarsListing, error)
	ApplyBuildVars(app string, ch appenv.BuildVarsChange) (appenv.BuildVarsResult, error)
	ClearBuildVars(app string) ([]string, error)
}

// maxEnvBody bounds the body of a change to the variables: a scope may hold 256 KiB, and JSON quoting can multiply
// that by six for control characters. Every other signed request is held to maxSignedBody.
const maxEnvBody = 2 << 20

// isEnvChange reports whether r is PUT /v1/apps/{app}/env or PUT /v1/build-vars/{app}, whose bodies may exceed
// maxSignedBody.
func isEnvChange(r *http.Request) bool {
	if r.Method != http.MethodPut {
		return false
	}
	if app, ok := strings.CutPrefix(r.URL.Path, "/v1/build-vars/"); ok {
		return app != "" && !strings.Contains(app, "/")
	}
	rest, ok := strings.CutPrefix(r.URL.Path, "/v1/apps/")
	if !ok {
		return false
	}
	app, tail, ok := strings.Cut(rest, "/")
	return ok && app != "" && tail == "env"
}

func (s *server) envRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /v1/apps/{app}/env", s.listEnv)
	mux.HandleFunc("PUT /v1/apps/{app}/env", s.putEnv)
	mux.HandleFunc("DELETE /v1/apps/{app}/env", s.deleteEnv)
	mux.HandleFunc("GET /v1/build-vars/{app}", s.listBuildVars)
	mux.HandleFunc("PUT /v1/build-vars/{app}", s.putBuildVars)
	mux.HandleFunc("DELETE /v1/build-vars/{app}", s.deleteBuildVars)
}

// buildVarsApp reads the app name of a build-vars route; an invalid one is answered 400 and never copied anywhere.
func buildVarsApp(w http.ResponseWriter, r *http.Request) (string, bool) {
	app := r.PathValue("app")
	if !config.ValidName(app) {
		writeError(w, http.StatusBadRequest, "invalid app name")
		return "", false
	}
	return app, true
}

func (s *server) listBuildVars(w http.ResponseWriter, r *http.Request) {
	app, ok := buildVarsApp(w, r)
	if !ok {
		return
	}
	l, err := s.deploy.Env.ListBuildVars(app)
	if err != nil {
		s.failEnv(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, l)
}

func (s *server) putBuildVars(w http.ResponseWriter, r *http.Request) {
	app, ok := buildVarsApp(w, r)
	if !ok {
		return
	}
	var ch appenv.BuildVarsChange
	if err := decode(r, &ch); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	// The names of the keys, never a value; a key that is not a valid name is counted, not copied.
	noteAudit(r, envDetail(app, appenv.Change{Scope: appenv.ScopeBuild, Set: ch.Set, Unset: ch.Remove}))
	if len(ch.Set) == 0 {
		noteAuditAction(r, "build_vars.remove")
	}
	res, err := s.deploy.Env.ApplyBuildVars(app, ch)
	if err != nil {
		s.failEnv(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, res)
}

func (s *server) deleteBuildVars(w http.ResponseWriter, r *http.Request) {
	app, ok := buildVarsApp(w, r)
	if !ok {
		return
	}
	removed, err := s.deploy.Env.ClearBuildVars(app)
	if err != nil {
		s.failEnv(w, r, err)
		return
	}
	noteAudit(r, envDetail(app, appenv.Change{Scope: appenv.ScopeBuild, Unset: removed}))
	writeJSON(w, http.StatusOK, map[string]any{"removed": removed})
}

// scopeParam reads ?scope=, "app" when absent.
func scopeParam(r *http.Request) string {
	if v := r.URL.Query().Get("scope"); v != "" {
		return v
	}
	return appenv.ScopeApp
}

func (s *server) listEnv(w http.ResponseWriter, r *http.Request) {
	l, err := s.deploy.Env.List(r.PathValue("app"), scopeParam(r))
	if err != nil {
		s.failEnv(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, l)
}

func (s *server) putEnv(w http.ResponseWriter, r *http.Request) {
	var ch appenv.Change
	if err := decode(r, &ch); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if ch.Scope == "" {
		ch.Scope = appenv.ScopeApp
	}
	// The names of the keys, never a value; a key that is not a valid name is counted, not copied.
	noteAudit(r, envDetail(r.PathValue("app"), ch))
	if len(ch.Set) > 0 || ch.Build != nil {
		noteAuditAction(r, "env.set")
	} else {
		noteAuditAction(r, "env.unset")
	}
	res, err := s.deploy.Env.Apply(r.PathValue("app"), ch)
	if err != nil {
		s.failEnv(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, res)
}

func (s *server) deleteEnv(w http.ResponseWriter, r *http.Request) {
	scope := scopeParam(r)
	removed, err := s.deploy.Env.Clear(r.PathValue("app"), scope)
	if err != nil {
		s.failEnv(w, r, err)
		return
	}
	noteAudit(r, envDetail(r.PathValue("app"), appenv.Change{Scope: scope, Unset: removed}))
	writeJSON(w, http.StatusOK, map[string]any{"scope": scope, "removed": removed})
}

func (s *server) failEnv(w http.ResponseWriter, r *http.Request, err error) {
	var invalid *appenv.InvalidError
	var unknown *appenv.UnknownAppError
	switch {
	case errors.As(err, &invalid):
		issues := make([]appenv.Issue, len(invalid.Issues))
		for i, is := range invalid.Issues {
			issues[i] = appenv.Issue{Key: echoKey(is.Key), Message: is.Message}
		}
		writeJSON(w, http.StatusBadRequest, map[string]any{
			"error": "invalid", "message": "the change was refused and nothing was written", "issues": issues,
		})
	case errors.Is(err, appenv.ErrBadScope):
		writeError(w, http.StatusBadRequest, err.Error())
	case errors.As(err, &unknown):
		body := map[string]any{"error": "not found"}
		if len(unknown.Orphans) > 0 {
			// The app left the apps file but its stored variables did not: DELETE removes them.
			body["orphan_scopes"] = unknown.Orphans
		}
		writeJSON(w, http.StatusNotFound, body)
	default:
		s.log.Error("environment request failed", "path", r.URL.Path, "err", err)
		writeError(w, http.StatusInternalServerError, "internal error")
	}
}

// echoKey shortens a key name the sender made up before it goes back in an answer.
func echoKey(k string) string {
	const max = 64
	if utf8.RuneCountInString(k) <= max {
		return k
	}
	return string([]rune(k)[:max]) + "…"
}

// maxAuditKeys bounds the names listed in one audit entry.
const maxAuditKeys = 30

// envDetail describes a change for the audit log: the app, the scope and the key names, nothing else. A key that is
// not a valid name is counted rather than copied: it may be anything the sender typed.
func envDetail(app string, ch appenv.Change) string {
	var b strings.Builder
	b.WriteString(app + " scope=" + ch.Scope)
	invalid := 0
	list := func(label string, keys []string) {
		var valid []string
		for _, k := range keys {
			if appenv.ValidKey(k) {
				valid = append(valid, k)
			} else {
				invalid++
			}
		}
		if len(valid) == 0 {
			return
		}
		sort.Strings(valid)
		more := 0
		if len(valid) > maxAuditKeys {
			more, valid = len(valid)-maxAuditKeys, valid[:maxAuditKeys]
		}
		b.WriteString(" " + label + "=" + strings.Join(valid, ","))
		if more > 0 {
			b.WriteString(",+" + strconv.Itoa(more))
		}
	}
	set := make([]string, 0, len(ch.Set))
	for k := range ch.Set {
		set = append(set, k)
	}
	list("set", set)
	list("unset", ch.Unset)
	list("build", ch.Build)
	if invalid > 0 {
		b.WriteString(" invalid=" + strconv.Itoa(invalid))
	}
	return b.String()
}
