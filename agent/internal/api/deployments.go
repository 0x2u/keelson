package api

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"time"

	"github.com/0x2u/keelson/agent/internal/build"
	"github.com/0x2u/keelson/agent/internal/deploy"
	"github.com/0x2u/keelson/agent/internal/docker"
	"github.com/0x2u/keelson/agent/internal/jobs"
	"github.com/0x2u/keelson/agent/internal/store"
)

const eventPollEvery = 500 * time.Millisecond

// Deployments is the deployment engine as the API sees it.
type Deployments interface {
	Start(ctx context.Context, app string, target deploy.Target, trigger string) (string, <-chan struct{}, error)
	Rollback(ctx context.Context, app string) (string, <-chan struct{}, error)
	// StartBuild builds the app's image from a source archive and deploys it as one deployment.
	StartBuild(ctx context.Context, app, sha string, src build.Source) (string, <-chan struct{}, error)
	Apps(ctx context.Context) ([]deploy.AppStatus, error)
	// Proxy describes the reverse proxy; nil when none is configured.
	Proxy(ctx context.Context) (*deploy.ProxyView, error)
	Deployment(ctx context.Context, id string) (store.Deployment, error)
	Deployments(ctx context.Context, app string, limit int) ([]store.Deployment, error)
	Events(ctx context.Context, id string, after int64) ([]store.Event, error)
	// StartContainer and RestartContainer act on a container of an app, by name.
	StartContainer(ctx context.Context, name string) error
	RestartContainer(ctx context.Context, name string) error
}

// DeployOptions enables the deployment routes.
type DeployOptions struct {
	Deployments Deployments
	// Secret keys the HMAC signature required on every POST. It is distinct
	// from the read token: reading the API does not allow deploying.
	Secret  string
	Replays Replays
	// Jobs enables the job routes; nil leaves them out.
	Jobs JobsService
	// Databases enables the database routes; nil leaves them out.
	Databases DatabasesService
	// Previews enables the preview environment routes; nil leaves them out.
	Previews PreviewsService
	// Config enables the configuration routes; nil leaves them out.
	Config ConfigService
	// Audit records signed requests and serves the log; nil turns both off.
	Audit AuditLog
	// History serves the recorded container stats; nil leaves the route out.
	History HistoryService
	// HostHistory serves the recorded load, memory and disk of the machine; nil leaves GET /v1/stats/host out.
	HostHistory HostHistoryService
	// Availability serves the recorded uptime of the apps; nil leaves GET /v1/apps/{app}/availability out.
	Availability AvailabilityService
	// Env enables the routes of the variables set through the API; nil leaves them out.
	Env EnvService
	// Postgres enables the routes of the managed PostgreSQL; nil leaves them out.
	Postgres PostgresService
	// Images enables the routes that export and import an app's image; nil leaves them out. StagingDir is where an
	// imported archive waits, checked, before it is loaded.
	Images     ImageService
	StagingDir string
	// Alerts serves the history of the notifications and sends the test message; nil leaves both routes out.
	Alerts AlertHistory
	// Proofs serves what the agent has seen proven (a key that opens a backup, a restore, a delivered test); nil leaves the
	// route out.
	Proofs ProofLog
	// Builds enables POST /v1/builds (a build another server asks for, held to build_limits) and the "build" section of
	// GET /v1/system; nil leaves both out.
	Builds BuildService
}

func (s *server) deployRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /v1/apps", s.listApps)
	mux.HandleFunc("GET /v1/proxy", s.getProxy)
	mux.HandleFunc("GET /v1/deployments", s.listDeployments)
	mux.HandleFunc("GET /v1/deployments/{id}", s.getDeployment)
	mux.HandleFunc("GET /v1/deployments/{id}/events", s.deploymentEvents)
	mux.HandleFunc("POST /v1/apps/{app}/deploy", s.startDeploy)
	mux.HandleFunc("POST /v1/apps/{app}/rollback", s.startRollback)
	mux.HandleFunc("POST /v1/apps/{app}/build", s.startBuild)
	mux.HandleFunc("POST /v1/containers/{name}/start", s.startContainer)
	mux.HandleFunc("POST /v1/containers/{name}/restart", s.restartContainer)
	if s.deploy.Jobs != nil {
		mux.HandleFunc("GET /v1/jobs", s.listJobs)
		mux.HandleFunc("GET /v1/jobs/{name}/runs", s.jobRuns)
		mux.HandleFunc("POST /v1/jobs/{name}/run", s.runJob)
	}
	if s.deploy.Databases != nil {
		s.databaseRoutes(mux)
	}
	if s.deploy.Previews != nil {
		s.previewRoutes(mux)
	}
	if s.deploy.Config != nil {
		s.configRoutes(mux)
	}
	if s.deploy.Audit != nil {
		mux.HandleFunc("GET /v1/audit", s.listAudit)
	}
	if s.deploy.Alerts != nil {
		mux.HandleFunc("GET /v1/notifications/history", s.listAlerts)
		mux.HandleFunc("POST /v1/notifications/test", s.testNotifications)
	}
	if s.deploy.Proofs != nil {
		mux.HandleFunc("GET /v1/proofs", s.listProofs)
	}
	if s.deploy.Env != nil {
		s.envRoutes(mux)
	}
	if s.deploy.Builds != nil {
		mux.HandleFunc("POST /v1/builds", s.startRequestedBuild)
	}
	if s.deploy.Postgres != nil {
		s.postgresRoutes(mux)
	}
	if s.deploy.History != nil {
		mux.HandleFunc("GET /v1/stats/history", s.statsHistory)
	}
	if s.deploy.HostHistory != nil {
		mux.HandleFunc("GET /v1/stats/host", s.hostHistory)
	}
	if s.deploy.Availability != nil {
		mux.HandleFunc("GET /v1/apps/{app}/availability", s.appAvailability)
	}
	if s.deploy.Images != nil {
		s.imageRoutes(mux)
	}
}

// JobsService is the job scheduler as the API sees it.
type JobsService interface {
	Jobs(ctx context.Context) ([]jobs.Status, error)
	Runs(ctx context.Context, name string, limit int) ([]store.JobRun, error)
	Trigger(name string) (string, <-chan struct{}, error)
}

func (s *server) listJobs(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), requestTimeout)
	defer cancel()
	list, err := s.deploy.Jobs.Jobs(ctx)
	if err != nil {
		s.failDeploy(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, list)
}

func (s *server) jobRuns(w http.ResponseWriter, r *http.Request) {
	limit := 20
	if v := r.URL.Query().Get("limit"); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || n < 1 || n > 100 {
			writeError(w, http.StatusBadRequest, "limit must be between 1 and 100")
			return
		}
		limit = n
	}
	ctx, cancel := context.WithTimeout(r.Context(), requestTimeout)
	defer cancel()
	runs, err := s.deploy.Jobs.Runs(ctx, r.PathValue("name"), limit)
	if err != nil {
		s.failDeploy(w, r, err)
		return
	}
	if runs == nil {
		runs = []store.JobRun{}
	}
	writeJSON(w, http.StatusOK, runs)
}

func (s *server) runJob(w http.ResponseWriter, r *http.Request) {
	id, _, err := s.deploy.Jobs.Trigger(r.PathValue("name"))
	if err != nil {
		s.failDeploy(w, r, err)
		return
	}
	writeJSON(w, http.StatusAccepted, map[string]string{"run_id": id})
}

func (s *server) failDeploy(w http.ResponseWriter, r *http.Request, err error) {
	switch {
	case errors.Is(err, deploy.ErrUnknownApp), errors.Is(err, store.ErrNotFound):
		writeError(w, http.StatusNotFound, "not found")
	case errors.Is(err, deploy.ErrInvalidTarget):
		writeError(w, http.StatusBadRequest, "body must contain exactly one of a valid tag or a sha256 digest")
	case errors.Is(err, deploy.ErrBusy):
		writeError(w, http.StatusConflict, "a deployment is already running for this app")
	case errors.Is(err, deploy.ErrNoRollbackTarget):
		writeError(w, http.StatusConflict, "no previous successful deployment to roll back to")
	case errors.Is(err, jobs.ErrUnknownJob):
		writeError(w, http.StatusNotFound, "not found")
	case errors.Is(err, jobs.ErrBusy):
		writeError(w, http.StatusConflict, "the job is already running")
	default:
		s.log.Error("deployment request failed", "path", r.URL.Path, "err", err)
		writeError(w, http.StatusInternalServerError, "internal error")
	}
}

func (s *server) listApps(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), requestTimeout)
	defer cancel()
	apps, err := s.deploy.Deployments.Apps(ctx)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, apps)
}

func (s *server) listDeployments(w http.ResponseWriter, r *http.Request) {
	limit := 20
	if v := r.URL.Query().Get("limit"); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || n < 1 || n > 100 {
			writeError(w, http.StatusBadRequest, "limit must be between 1 and 100")
			return
		}
		limit = n
	}
	ctx, cancel := context.WithTimeout(r.Context(), requestTimeout)
	defer cancel()
	list, err := s.deploy.Deployments.Deployments(ctx, r.URL.Query().Get("app"), limit)
	if err != nil {
		s.failDeploy(w, r, err)
		return
	}
	if list == nil {
		list = []store.Deployment{}
	}
	writeJSON(w, http.StatusOK, list)
}

func (s *server) getDeployment(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), requestTimeout)
	defer cancel()
	d, err := s.deploy.Deployments.Deployment(ctx, r.PathValue("id"))
	if err != nil {
		s.failDeploy(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, d)
}

// deploymentEvents streams a deployment's log, then "end" with the final
// status. It works for finished deployments too: the log is replayed.
func (s *server) deploymentEvents(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	ctx, cancel := context.WithTimeout(r.Context(), requestTimeout)
	_, err := s.deploy.Deployments.Deployment(ctx, id)
	cancel()
	if err != nil {
		s.failDeploy(w, r, err)
		return
	}
	release, ok := s.acquire(w)
	if !ok {
		return
	}
	defer release()

	sse := newSSE(w)
	defer sse.keepAlive(r.Context(), keepAliveEvery)()

	var after int64
	for {
		// Read the status before the events: a deployment seen as finished
		// has all of its events already written.
		dep, err := s.deploy.Deployments.Deployment(r.Context(), id)
		if err == nil {
			var events []store.Event
			if events, err = s.deploy.Deployments.Events(r.Context(), id, after); err == nil {
				for _, e := range events {
					if err = sse.send("event", e); err != nil {
						return
					}
					after = e.Seq
				}
				if dep.Status != store.StatusRunning {
					_ = sse.send("end", map[string]string{"status": dep.Status})
					return
				}
			}
		}
		if err != nil {
			if r.Context().Err() == nil {
				s.log.Error("deployment events failed", "id", id, "err", err)
				_ = sse.send("error", map[string]string{"error": "stream interrupted"})
			}
			return
		}
		select {
		case <-r.Context().Done():
			return
		case <-time.After(eventPollEvery):
		}
	}
}

type deployRequest struct {
	Tag    string `json:"tag"`
	Digest string `json:"digest"`
	// Trigger says why: "api" (the default), "promotion" (a version moved from another environment) or "transfer" (an
	// image built on another server and sent here). It is only recorded in the deployment's history; anything else is
	// refused.
	Trigger string `json:"trigger"`
}

func (s *server) startDeploy(w http.ResponseWriter, r *http.Request) {
	var req deployRequest
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	if err := dec.Decode(&req); err != nil {
		s.failDeploy(w, r, deploy.ErrInvalidTarget)
		return
	}
	trigger := req.Trigger
	switch trigger {
	case "":
		trigger = "api"
	case "api", "promotion", "transfer":
	default:
		s.failDeploy(w, r, deploy.ErrInvalidTarget)
		return
	}
	id, _, err := s.deploy.Deployments.Start(r.Context(), r.PathValue("app"), deploy.Target{Tag: req.Tag, Digest: req.Digest}, trigger)
	if err != nil {
		s.failDeploy(w, r, err)
		return
	}
	writeJSON(w, http.StatusAccepted, map[string]string{"deployment_id": id})
}

func (s *server) startRollback(w http.ResponseWriter, r *http.Request) {
	id, _, err := s.deploy.Deployments.Rollback(r.Context(), r.PathValue("app"))
	if err != nil {
		s.failDeploy(w, r, err)
		return
	}
	writeJSON(w, http.StatusAccepted, map[string]string{"deployment_id": id})
}

func (s *server) startContainer(w http.ResponseWriter, r *http.Request) {
	s.containerAction(w, r, s.deploy.Deployments.StartContainer)
}

func (s *server) restartContainer(w http.ResponseWriter, r *http.Request) {
	s.containerAction(w, r, s.deploy.Deployments.RestartContainer)
}

// containerAction runs a start or a restart and answers 204. Both end when the container is running again: the
// answer says the engine did it, not that the app is healthy.
func (s *server) containerAction(w http.ResponseWriter, r *http.Request, act func(context.Context, string) error) {
	err := act(r.Context(), r.PathValue("name"))
	switch {
	case err == nil:
		w.WriteHeader(http.StatusNoContent)
	case errors.Is(err, docker.ErrInvalidID):
		writeError(w, http.StatusBadRequest, "invalid container name")
	case docker.IsNotFound(err):
		writeError(w, http.StatusNotFound, "container not found")
	case errors.Is(err, deploy.ErrNotManaged):
		writeError(w, http.StatusConflict, "the container is not managed by keelson")
	case errors.Is(err, deploy.ErrBusy):
		writeError(w, http.StatusConflict, "a deployment is running for this app")
	default:
		s.log.Error("container action failed", "path", r.URL.Path, "err", err)
		writeError(w, http.StatusBadGateway, "docker engine error")
	}
}

func (s *server) getProxy(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), requestTimeout)
	defer cancel()
	view, err := s.deploy.Deployments.Proxy(ctx)
	if err != nil {
		s.failDeploy(w, r, err)
		return
	}
	if view == nil {
		writeError(w, http.StatusNotFound, "no reverse proxy is configured")
		return
	}
	writeJSON(w, http.StatusOK, view)
}
