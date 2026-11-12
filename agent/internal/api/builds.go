package api

import (
	"context"
	"errors"
	"net/http"

	"github.com/0x2u/keelson/agent/internal/build"
	"github.com/0x2u/keelson/agent/internal/config"
	"github.com/0x2u/keelson/agent/internal/deploy"
)

// BuildService builds images for other servers (POST /v1/builds) under this server's build_limits.
type BuildService interface {
	StartBuildRequest(ctx context.Context, req deploy.BuildRequest) (string, <-chan struct{}, error)
	BuildCeilings() config.BuildCeilings
}

// requestedBuild is the body of POST /v1/builds: a build that is not of an app of this server. build is the build block
// in the shape of the configuration API (without only and database); the result is "<image>:<sha>", built here, never
// pushed.
type requestedBuild struct {
	App        string        `json:"app"`
	Image      string        `json:"image"`
	SHA        string        `json:"sha"`
	Source     *build.Source `json:"source"`
	Build      *config.Build `json:"build"`
	Port       int           `json:"port"`
	HealthPath string        `json:"health_path"`
}

// startRequestedBuild builds an image another server will run. The answer only says the deployment was accepted; its
// progress and outcome are read from GET /v1/deployments/{id}. As for POST /v1/apps/{app}/build, the source token is
// read from the signed body, held in memory for the download and never put anywhere else.
func (s *server) startRequestedBuild(w http.ResponseWriter, r *http.Request) {
	var req requestedBuild
	if err := decode(r, &req); err != nil || req.Source == nil || req.Build == nil {
		s.failBuild(w, r, errRequestedBuildBody)
		return
	}
	if build.ValidSHA(req.SHA) {
		noteAudit(r, req.App+" sha="+req.SHA)
	}
	id, _, err := s.deploy.Builds.StartBuildRequest(r.Context(), deploy.BuildRequest{
		App: req.App, Image: req.Image, SHA: req.SHA, Source: *req.Source, Build: req.Build, Port: req.Port, HealthPath: req.HealthPath,
	})
	if err != nil {
		s.failBuild(w, r, err)
		return
	}
	writeJSON(w, http.StatusAccepted, map[string]string{"deployment_id": id})
}

var errRequestedBuildBody = errors.New(`body must be {"app": ..., "image": ..., "sha": <40 hex>, "source": {"url": ..., "token": ...}, "build": {...}, "port": <optional>, "health_path": <optional>}`)

// buildRequest is the body of POST /v1/apps/{app}/build.
type buildRequest struct {
	SHA    string        `json:"sha"`
	Source *build.Source `json:"source"`
	// Deploy must be true or absent: a build exists to be deployed (the history of successful deployments is what a
	// rollback chooses from, so an image nobody deployed must not be recorded as one).
	Deploy *bool `json:"deploy"`
}

// startBuild builds the app's image from a source archive the dashboard points at, and deploys it. The answer only says
// the deployment was accepted; its progress and outcome are read from GET /v1/deployments/{id}.
//
// The source token is read from the signed body, handed to the deployer and never put anywhere else: not the audit
// entry (which names the app and the commit), not a log line, not an error.
func (s *server) startBuild(w http.ResponseWriter, r *http.Request) {
	var req buildRequest
	if err := decode(r, &req); err != nil || req.Source == nil {
		s.failBuild(w, r, errBuildBody)
		return
	}
	if req.Deploy != nil && !*req.Deploy {
		s.failBuild(w, r, errBuildNoDeploy)
		return
	}
	app := r.PathValue("app")
	if build.ValidSHA(req.SHA) {
		noteAudit(r, app+" sha="+req.SHA)
	}
	id, _, err := s.deploy.Deployments.StartBuild(r.Context(), app, req.SHA, *req.Source)
	if err != nil {
		s.failBuild(w, r, err)
		return
	}
	writeJSON(w, http.StatusAccepted, map[string]string{"deployment_id": id})
}

var (
	errBuildBody     = errors.New("body must be {\"sha\": <40 hex>, \"source\": {\"url\": ..., \"token\": ...}, \"deploy\": true}")
	errBuildNoDeploy = errors.New("deploy must be true: a build is always deployed")
)

// failBuild answers the errors of a build request. Messages never include anything of the request's source.
func (s *server) failBuild(w http.ResponseWriter, r *http.Request, err error) {
	var refused *config.BuildRequestError
	switch {
	case errors.Is(err, deploy.ErrUnknownApp), errors.Is(err, deploy.ErrNoPreview):
		writeError(w, http.StatusNotFound, "not found")
	case errors.Is(err, errBuildBody), errors.Is(err, errBuildNoDeploy), errors.Is(err, errRequestedBuildBody):
		writeError(w, http.StatusBadRequest, err.Error())
	case errors.As(err, &refused):
		writeError(w, http.StatusBadRequest, err.Error())
	case errors.Is(err, deploy.ErrBuildNameTaken):
		writeError(w, http.StatusConflict, err.Error())
	case errors.Is(err, deploy.ErrNoBuild):
		writeError(w, http.StatusBadRequest, "the app has no build block: add build: to it in the agent's apps file to build on this server")
	case errors.Is(err, build.ErrBadSHA), errors.Is(err, build.ErrSourceHost), errors.Is(err, build.ErrSourceToken):
		writeError(w, http.StatusBadRequest, err.Error())
	case errors.Is(err, deploy.ErrBuildBusy):
		writeError(w, http.StatusConflict, "another build is running on this agent")
	case errors.Is(err, deploy.ErrBusy):
		writeError(w, http.StatusConflict, "a deployment is already running for this app")
	case errors.Is(err, deploy.ErrShuttingDown):
		writeError(w, http.StatusServiceUnavailable, "the agent is shutting down")
	default:
		s.log.Error("build request failed", "path", r.URL.Path, "err", err)
		writeError(w, http.StatusInternalServerError, "internal error")
	}
}
