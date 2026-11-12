package api

import (
	"context"
	"errors"
	"io/fs"
	"net/http"
	"time"

	"github.com/0x2u/keelson/agent/internal/config"
	"github.com/0x2u/keelson/agent/internal/confmgr"
	"github.com/0x2u/keelson/agent/internal/postgres"
)

// PostgresService is the managed PostgreSQL as the API sees it.
type PostgresService interface {
	Status(ctx context.Context) (postgres.Status, error)
	CreateDatabase(ctx context.Context, req postgres.CreateRequest) (postgres.Result, error)
	DropDatabase(ctx context.Context, req postgres.DropRequest) error
	RotatePassword(ctx context.Context, name, actor string) (postgres.Result, error)
}

func (s *server) postgresRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /v1/postgres", s.postgresStatus)
	mux.HandleFunc("POST /v1/postgres/databases", s.createPostgresDatabase)
	mux.HandleFunc("DELETE /v1/postgres/databases/{name}", s.dropPostgresDatabase)
	mux.HandleFunc("POST /v1/postgres/databases/{name}/password", s.rotatePostgresPassword)
}

func (s *server) postgresStatus(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()
	st, err := s.deploy.Postgres.Status(ctx)
	if err != nil {
		s.failPostgres(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, st)
}

func (s *server) createPostgresDatabase(w http.ResponseWriter, r *http.Request) {
	var req postgres.CreateRequest
	if err := decode(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	req.Actor = cleanActor(r.Header.Get(HeaderActor))
	noteAudit(r, postgresDetail(req.Name, req.App, req.EnvKey))
	res, err := s.deploy.Postgres.CreateDatabase(r.Context(), req)
	if err != nil {
		s.failPostgres(w, r, err)
		return
	}
	// What the request was about, as the agent resolved it: the answer is the first place the defaults show.
	noteAudit(r, postgresDetail(res.Database.Name, res.Database.App, res.EnvKey))
	writeJSON(w, http.StatusOK, res)
}

func (s *server) dropPostgresDatabase(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Confirm string `json:"confirm"`
	}
	if err := decode(r, &body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	name := r.PathValue("name")
	noteAudit(r, postgresDetail(name, "", ""))
	err := s.deploy.Postgres.DropDatabase(r.Context(), postgres.DropRequest{Name: name, Confirm: body.Confirm, Actor: cleanActor(r.Header.Get(HeaderActor))})
	if err != nil {
		s.failPostgres(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"name": name, "dropped": true})
}

func (s *server) rotatePostgresPassword(w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("name")
	noteAudit(r, postgresDetail(name, "", ""))
	res, err := s.deploy.Postgres.RotatePassword(r.Context(), name, cleanActor(r.Header.Get(HeaderActor)))
	if err != nil {
		s.failPostgres(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, res)
}

// postgresDetail is the audit line of a request: names only, each written only if it is well formed, so an entry can
// neither grow with the request nor carry a line break. No password, URL or key is ever part of a request or of the
// audit log.
func postgresDetail(name, app, envKey string) string {
	const invalid = "(invalid)"
	clean := func(v string, ok func(string) bool) string {
		if v == "" || ok(v) {
			return v
		}
		return invalid
	}
	out := clean(name, config.ValidName)
	if app != "" {
		out += " app=" + clean(app, config.ValidName)
	}
	if envKey != "" {
		out += " env_key=" + clean(envKey, config.ValidEnvKey)
	}
	if out == "" {
		return invalid
	}
	return out
}

// failPostgres answers a failed request. The text of an engine or server failure is the agent's log's: the answer says
// what kind of failure it was.
func (s *server) failPostgres(w http.ResponseWriter, r *http.Request, err error) {
	var (
		bad      *postgres.RequestError
		conflict *postgres.ConflictError
		inst     *postgres.InstanceError
		server   *postgres.ServerError
		invalid  *confmgr.InvalidError
		stale    *confmgr.ConflictError
		ack      *confmgr.NeedsAckError
		busy     *confmgr.BusyError
	)
	switch {
	case errors.As(err, &bad):
		writeError(w, http.StatusBadRequest, bad.Msg)
	case errors.Is(err, postgres.ErrUnknownDatabase):
		writeError(w, http.StatusNotFound, "no such managed database")
	case errors.Is(err, postgres.ErrUnknownApp):
		writeError(w, http.StatusNotFound, "no such app")
	case errors.As(err, &conflict):
		writeError(w, http.StatusConflict, conflict.Msg)
	case errors.Is(err, postgres.ErrBusy):
		writeError(w, http.StatusConflict, err.Error())
	case errors.Is(err, postgres.ErrShuttingDown):
		writeError(w, http.StatusServiceUnavailable, "the agent is shutting down")
	case errors.Is(err, postgres.ErrForeign), errors.Is(err, postgres.ErrPasswordLost):
		s.log.Error("managed PostgreSQL request failed", "path", r.URL.Path, "err", err)
		writeError(w, http.StatusConflict, err.Error())
	case errors.As(err, &inst):
		s.log.Error("managed PostgreSQL request failed", "path", r.URL.Path, "err", err)
		writeError(w, http.StatusBadGateway, "the managed PostgreSQL could not be brought up: "+inst.Msg)
	case errors.As(err, &server):
		s.log.Error("managed PostgreSQL request failed", "path", r.URL.Path, "err", err)
		writeError(w, http.StatusBadGateway, "the PostgreSQL server refused a command: see the agent log")
	case errors.As(err, &invalid), errors.As(err, &stale), errors.As(err, &ack), errors.As(err, &busy), errors.Is(err, fs.ErrPermission):
		// The apps file refused the entry, or could not be written.
		s.configFailure(w, r, err)
	default:
		s.log.Error("managed PostgreSQL request failed", "path", r.URL.Path, "err", err)
		writeError(w, http.StatusInternalServerError, "internal error")
	}
}
