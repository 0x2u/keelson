package api

import (
	"context"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/0x2u/keelson/agent/internal/build"
	"github.com/0x2u/keelson/agent/internal/config"
	"github.com/0x2u/keelson/agent/internal/confmgr"
	"github.com/0x2u/keelson/agent/internal/deploy"
)

// PreviewsService is the preview environments as the API sees them.
type PreviewsService interface {
	Previews(ctx context.Context) ([]deploy.PreviewStatus, error)
	StartPreview(ctx context.Context, app string, pr int, target deploy.Target) (deploy.PreviewStarted, <-chan struct{}, error)
	// StartPreviewBuild builds the instance's image from a source archive, then deploys it.
	StartPreviewBuild(ctx context.Context, app string, pr int, sha string, src build.Source) (deploy.PreviewStarted, <-chan struct{}, error)
	RemovePreview(ctx context.Context, app string, pr int) error
}

func (s *server) previewRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /v1/previews", s.listPreviews)
	mux.HandleFunc("PUT /v1/previews/{app}/{pr}", s.putPreview)
	mux.HandleFunc("DELETE /v1/previews/{app}/{pr}", s.deletePreview)
}

func (s *server) listPreviews(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), requestTimeout)
	defer cancel()
	list, err := s.deploy.Previews.Previews(ctx)
	if err != nil {
		s.failPreview(w, r, err)
		return
	}
	if list == nil {
		list = []deploy.PreviewStatus{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"previews": list})
}

// previewNumber reads the {pr} of the path: a positive integer written without sign or leading zeros.
func previewNumber(r *http.Request) (int, bool) {
	raw := r.PathValue("pr")
	n, err := strconv.Atoi(raw)
	if err != nil || strconv.Itoa(n) != raw || !config.ValidPreviewNumber(n) {
		return 0, false
	}
	return n, true
}

// previewWriteTimeout bounds a creation or a removal, which may stop containers: a dropped connection must not cut one
// short half way, so they do not follow the request's context.
const previewWriteTimeout = 2 * time.Minute

func (s *server) putPreview(w http.ResponseWriter, r *http.Request) {
	pr, ok := previewNumber(r)
	if !ok {
		s.failPreview(w, r, deploy.ErrInvalidPR)
		return
	}
	var req struct {
		Tag    string        `json:"tag"`
		SHA    string        `json:"sha"`
		Source *build.Source `json:"source"`
	}
	if err := decode(r, &req); err != nil {
		s.failPreview(w, r, deploy.ErrInvalidTarget)
		return
	}
	// Exactly one of a tag (CI built the image) or a sha with a source (this agent builds it).
	building := req.SHA != "" || req.Source != nil
	if building && (req.Tag != "" || req.SHA == "" || req.Source == nil) || !building && req.Tag == "" {
		s.failPreview(w, r, deploy.ErrInvalidTarget)
		return
	}
	app := r.PathValue("app")
	if config.ValidName(app) {
		noteAudit(r, config.PreviewName(app, pr))
	}
	ctx, cancel := context.WithTimeout(context.WithoutCancel(r.Context()), previewWriteTimeout)
	defer cancel()
	var (
		started deploy.PreviewStarted
		err     error
	)
	if building {
		started, _, err = s.deploy.Previews.StartPreviewBuild(ctx, app, pr, req.SHA, *req.Source)
	} else {
		started, _, err = s.deploy.Previews.StartPreview(ctx, app, pr, deploy.Target{Tag: req.Tag})
	}
	if err != nil {
		s.failPreview(w, r, err)
		return
	}
	// Everything here passed validation: a tag or sha has plain characters and the names are the agent's own. The
	// source (its token above all) is never recorded.
	detail := started.Name + " tag=" + req.Tag
	if building {
		detail = started.Name + " sha=" + req.SHA
	}
	if len(started.Evicted) > 0 {
		detail += " evicted=" + strings.Join(started.Evicted, ",")
	}
	noteAudit(r, detail)
	evicted := started.Evicted
	if evicted == nil {
		evicted = []string{}
	}
	writeJSON(w, http.StatusAccepted, map[string]any{
		"deployment_id": started.DeploymentID, "name": started.Name, "url": started.URL, "evicted": evicted,
	})
}

func (s *server) deletePreview(w http.ResponseWriter, r *http.Request) {
	pr, ok := previewNumber(r)
	if !ok {
		s.failPreview(w, r, deploy.ErrInvalidPR)
		return
	}
	app := r.PathValue("app")
	if config.ValidName(app) {
		noteAudit(r, config.PreviewName(app, pr))
	}
	ctx, cancel := context.WithTimeout(context.WithoutCancel(r.Context()), previewWriteTimeout)
	defer cancel()
	if err := s.deploy.Previews.RemovePreview(ctx, app, pr); err != nil {
		s.failPreview(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *server) failPreview(w http.ResponseWriter, r *http.Request, err error) {
	switch {
	case errors.Is(err, deploy.ErrNoPreview):
		writeError(w, http.StatusNotFound, "no previews template for this app")
	case errors.Is(err, deploy.ErrInvalidPR):
		writeError(w, http.StatusBadRequest, "the pull request number must be a positive integer up to 999999")
	case errors.Is(err, deploy.ErrInvalidTarget):
		writeError(w, http.StatusBadRequest, "body must contain exactly a valid tag, or a sha with a source")
	case errors.Is(err, deploy.ErrNoBuild):
		writeError(w, http.StatusBadRequest, "the app has no build block: add build: to it in the agent's apps file to build on this server")
	case errors.Is(err, build.ErrBadSHA), errors.Is(err, build.ErrSourceHost), errors.Is(err, build.ErrSourceToken):
		writeError(w, http.StatusBadRequest, err.Error())
	case errors.Is(err, deploy.ErrBuildBusy):
		writeError(w, http.StatusConflict, "another build is running on this agent")
	case errors.Is(err, deploy.ErrBusy):
		writeError(w, http.StatusConflict, "a deployment is already running for this preview")
	case errors.Is(err, deploy.ErrShuttingDown):
		writeError(w, http.StatusServiceUnavailable, "the agent is shutting down")
	default:
		s.log.Error("preview request failed", "path", r.URL.Path, "err", err)
		writeError(w, http.StatusInternalServerError, "internal error")
	}
}

func (s *server) putPreviewTemplate(w http.ResponseWriter, r *http.Request) {
	var req struct {
		changeRequest
		Preview map[string]any `json:"preview"`
	}
	if err := decode(r, &req); err != nil || req.Preview == nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	app := r.PathValue("app")
	out, err := confmgr.EditBundle(s.deploy.Config, req.BaseHash, req.Force, req.meta(r), func(b *config.Bundle) ([]config.Issue, error) {
		return b.SetPreview(app, req.Preview)
	})
	s.configResult(w, r, out, err)
}

func (s *server) deletePreviewTemplate(w http.ResponseWriter, r *http.Request) {
	var req changeRequest
	if err := decode(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	app := r.PathValue("app")
	out, err := confmgr.EditBundle(s.deploy.Config, req.BaseHash, req.Force, req.meta(r), func(b *config.Bundle) ([]config.Issue, error) {
		return nil, b.DeletePreview(app)
	})
	s.configResult(w, r, out, err)
}
