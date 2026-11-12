package api

import (
	"bytes"
	"encoding/json"
	"errors"
	"io/fs"
	"net/http"
	"strconv"
	"time"

	"github.com/0x2u/keelson/agent/internal/config"
	"github.com/0x2u/keelson/agent/internal/confmgr"
	"github.com/0x2u/keelson/agent/internal/store"
)

// ConfigService is the configuration manager as the API sees it.
type ConfigService interface {
	Document() (confmgr.Document, error)
	Validate(content []byte) ([]config.Issue, error)
	Save(content []byte, baseHash string, force bool, meta confmgr.Meta) (confmgr.Outcome, error)
	Edit(baseHash string, force bool, meta confmgr.Meta, edit func(disk []byte) ([]byte, []config.Issue, error)) (confmgr.Outcome, error)
	RestoreVersion(id int64, baseHash string, force bool, actor string) (confmgr.Outcome, error)
	Versions(limit int) ([]store.ConfigVersion, error)
	Version(id int64) (store.ConfigVersion, string, error)
}

func (s *server) configRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /v1/config", s.getConfig)
	mux.HandleFunc("POST /v1/config/validate", s.validateConfig)
	mux.HandleFunc("PUT /v1/config", s.putConfig)
	mux.HandleFunc("PUT /v1/config/apps/{name}", s.putApp)
	mux.HandleFunc("DELETE /v1/config/apps/{name}", s.deleteApp)
	mux.HandleFunc("PUT /v1/config/jobs/{name}", s.putJob)
	mux.HandleFunc("DELETE /v1/config/jobs/{name}", s.deleteJob)
	mux.HandleFunc("PUT /v1/config/databases/{name}", s.putDatabase)
	mux.HandleFunc("DELETE /v1/config/databases/{name}", s.deleteDatabase)
	mux.HandleFunc("PUT /v1/config/previews/{app}", s.putPreviewTemplate)
	mux.HandleFunc("DELETE /v1/config/previews/{app}", s.deletePreviewTemplate)
	mux.HandleFunc("PUT /v1/config/notifications", s.putNotifications)
	mux.HandleFunc("GET /v1/config/versions", s.listConfigVersions)
	mux.HandleFunc("GET /v1/config/versions/{id}", s.getConfigVersion)
	mux.HandleFunc("POST /v1/config/versions/{id}/restore", s.restoreConfigVersion)
	if _, ok := s.deploy.Config.(ProjectsService); ok {
		mux.HandleFunc("GET /v1/projects", s.listProjects)
		mux.HandleFunc("GET /v1/projects/{name}/config", s.getProjectConfig)
		mux.HandleFunc("POST /v1/projects/{name}/config/validate", s.validateProjectConfig)
		mux.HandleFunc("PUT /v1/projects/{name}/config", s.putProjectConfig)
		mux.HandleFunc("DELETE /v1/projects/{name}/config", s.deleteProjectConfig)
		mux.HandleFunc("POST /v1/projects/{name}/split", s.splitProject)
	}
}

// ProjectsService is what the configuration manager offers for the project files; the routes of /v1/projects exist only
// when the configuration service has it.
type ProjectsService interface {
	Projects() ([]confmgr.ProjectInfo, error)
	ProjectDocument(name string) (confmgr.ProjectDocument, error)
	ValidateProject(name string, content []byte) ([]config.Issue, error)
	SaveProject(name string, content []byte, baseHash string, force bool, meta confmgr.Meta) (confmgr.Outcome, error)
	DeleteProject(name, baseHash string, force bool, meta confmgr.Meta) (confmgr.Outcome, error)
	SplitProject(name, baseHash string, force, dryRun bool, meta confmgr.Meta) (confmgr.Outcome, config.SplitPlan, error)
	VersionFiles(id int64) ([]confmgr.VersionFile, error)
}

// changeRequest is what every change carries besides its subject.
type changeRequest struct {
	BaseHash string `json:"base_hash"`
	Comment  string `json:"comment"`
	Force    bool   `json:"force"`
}

func (c changeRequest) meta(r *http.Request) confmgr.Meta {
	comment := c.Comment
	if len(comment) > 200 {
		comment = comment[:200]
	}
	return confmgr.Meta{Source: store.SourceAPI, Actor: cleanActor(r.Header.Get(HeaderActor)), Comment: comment}
}

// decode reads a JSON body strictly: an unknown field is a bug in the caller, not something to ignore.
func decode(r *http.Request, v any) error {
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	return dec.Decode(v)
}

func (s *server) getConfig(w http.ResponseWriter, r *http.Request) {
	doc, err := s.deploy.Config.Document()
	if err != nil {
		s.configFailure(w, r, err)
		return
	}
	out := map[string]any{
		"content":      doc.Content,
		"hash":         doc.Hash,
		"modified_at":  doc.ModifiedAt.Format(time.RFC3339),
		"model":        doc.Model,
		"applied_hash": doc.AppliedHash,
		"deprecations": nonNil(doc.Deprecations),
	}
	if len(doc.Files) > 0 {
		out["files"] = doc.Files
	}
	if doc.Error != "" {
		out["error"] = doc.Error
	}
	writeJSON(w, http.StatusOK, out)
}

func (s *server) validateConfig(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Content string `json:"content"`
	}
	if err := decode(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	issues, err := s.deploy.Config.Validate([]byte(req.Content))
	if err != nil {
		s.configFailure(w, r, err)
		return
	}
	ok := true
	for _, is := range issues {
		if is.Severity == config.SeverityError {
			ok = false
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": ok, "issues": nonNil(issues)})
}

func (s *server) putConfig(w http.ResponseWriter, r *http.Request) {
	var req struct {
		changeRequest
		Content string `json:"content"`
	}
	if err := decode(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	out, err := s.deploy.Config.Save([]byte(req.Content), req.BaseHash, req.Force, req.meta(r))
	s.configResult(w, r, out, err)
}

func (s *server) putApp(w http.ResponseWriter, r *http.Request) {
	var req struct {
		changeRequest
		App map[string]any `json:"app"`
	}
	if err := decode(r, &req); err != nil || req.App == nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	name := r.PathValue("name")
	out, err := confmgr.EditBundle(s.deploy.Config, req.BaseHash, req.Force, req.meta(r), func(b *config.Bundle) ([]config.Issue, error) {
		return b.SetApp(name, req.App)
	})
	s.configResult(w, r, out, err)
}

func (s *server) deleteApp(w http.ResponseWriter, r *http.Request) {
	var req changeRequest
	if err := decode(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	name := r.PathValue("name")
	out, err := confmgr.EditBundle(s.deploy.Config, req.BaseHash, req.Force, req.meta(r), func(b *config.Bundle) ([]config.Issue, error) {
		return nil, b.DeleteApp(name)
	})
	s.configResult(w, r, out, err)
}

func (s *server) putJob(w http.ResponseWriter, r *http.Request) {
	var req struct {
		changeRequest
		Job map[string]any `json:"job"`
	}
	if err := decode(r, &req); err != nil || req.Job == nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	name := r.PathValue("name")
	out, err := confmgr.EditBundle(s.deploy.Config, req.BaseHash, req.Force, req.meta(r), func(b *config.Bundle) ([]config.Issue, error) {
		return b.SetJob(name, req.Job)
	})
	s.configResult(w, r, out, err)
}

func (s *server) deleteJob(w http.ResponseWriter, r *http.Request) {
	var req changeRequest
	if err := decode(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	name := r.PathValue("name")
	out, err := confmgr.EditBundle(s.deploy.Config, req.BaseHash, req.Force, req.meta(r), func(b *config.Bundle) ([]config.Issue, error) {
		return nil, b.DeleteJob(name)
	})
	s.configResult(w, r, out, err)
}

func (s *server) putNotifications(w http.ResponseWriter, r *http.Request) {
	var req struct {
		changeRequest
		Notifications json.RawMessage `json:"notifications"`
	}
	if err := decode(r, &req); err != nil || len(req.Notifications) == 0 {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	var section map[string]any // stays nil for "null": the section is removed
	if !bytes.Equal(bytes.TrimSpace(req.Notifications), []byte("null")) {
		if err := json.Unmarshal(req.Notifications, &section); err != nil || section == nil {
			writeError(w, http.StatusBadRequest, "notifications must be an object or null")
			return
		}
	}
	out, err := s.deploy.Config.Edit(req.BaseHash, req.Force, req.meta(r), func(disk []byte) ([]byte, []config.Issue, error) {
		return config.SetNotifications(disk, section)
	})
	s.configResult(w, r, out, err)
}

func (s *server) listConfigVersions(w http.ResponseWriter, r *http.Request) {
	limit := 30
	if v := r.URL.Query().Get("limit"); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || n < 1 || n > 100 {
			writeError(w, http.StatusBadRequest, "limit must be between 1 and 100")
			return
		}
		limit = n
	}
	versions, err := s.deploy.Config.Versions(limit)
	if err != nil {
		s.configFailure(w, r, err)
		return
	}
	if versions == nil {
		versions = []store.ConfigVersion{}
	}
	writeJSON(w, http.StatusOK, versions)
}

func versionID(r *http.Request) (int64, bool) {
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	return id, err == nil && id > 0
}

func (s *server) getConfigVersion(w http.ResponseWriter, r *http.Request) {
	id, ok := versionID(r)
	if !ok {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	v, content, err := s.deploy.Config.Version(id)
	if err != nil {
		s.configFailure(w, r, err)
		return
	}
	var files []confmgr.VersionFile
	if ps, ok := s.deploy.Config.(ProjectsService); ok {
		if files, err = ps.VersionFiles(id); err != nil {
			s.configFailure(w, r, err)
			return
		}
	}
	writeJSON(w, http.StatusOK, struct {
		store.ConfigVersion
		Content string                `json:"content"`
		Files   []confmgr.VersionFile `json:"files,omitempty"`
	}{v, content, files})
}

func (s *server) restoreConfigVersion(w http.ResponseWriter, r *http.Request) {
	id, ok := versionID(r)
	if !ok {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	var req changeRequest
	if err := decode(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	out, err := s.deploy.Config.RestoreVersion(id, req.BaseHash, req.Force, cleanActor(r.Header.Get(HeaderActor)))
	s.configResult(w, r, out, err)
}

// configResult answers a change: 200 with the new hash, or the refusal with what the caller can do about it.
func (s *server) configResult(w http.ResponseWriter, r *http.Request, out confmgr.Outcome, err error) {
	if err != nil {
		s.configFailure(w, r, err)
		return
	}
	noteAudit(r, "hash "+short(out.Hash))
	writeJSON(w, http.StatusOK, map[string]any{"hash": out.Hash, "version": out.Version, "issues": nonNil(out.Issues)})
}

func (s *server) configFailure(w http.ResponseWriter, r *http.Request, err error) {
	var (
		invalid  *confmgr.InvalidError
		conflict *confmgr.ConflictError
		ack      *confmgr.NeedsAckError
		busy     *confmgr.BusyError
	)
	switch {
	case errors.As(err, &invalid):
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid", "issues": nonNil(invalid.Issues)})
	case errors.As(err, &conflict):
		writeJSON(w, http.StatusConflict, map[string]any{"error": "changed", "hash": conflict.Hash})
	case errors.As(err, &ack):
		writeJSON(w, http.StatusConflict, map[string]any{"error": "needs_acknowledgement", "issues": nonNil(ack.Issues)})
	case errors.As(err, &busy):
		writeJSON(w, http.StatusConflict, map[string]any{"error": "busy", "message": busy.Reason})
	case errors.Is(err, store.ErrNotFound):
		writeError(w, http.StatusNotFound, "not found")
	case errors.Is(err, fs.ErrPermission):
		s.log.Error("configuration request failed", "path", r.URL.Path, "err", err)
		writeError(w, http.StatusInternalServerError, "the agent cannot write its apps file: check the file's and its directory's permissions")
	default:
		s.log.Error("configuration request failed", "path", r.URL.Path, "err", err)
		writeError(w, http.StatusInternalServerError, "internal error")
	}
}

func nonNil(issues []config.Issue) []config.Issue {
	if issues == nil {
		return []config.Issue{}
	}
	return issues
}

func short(hash string) string {
	if len(hash) > 12 {
		return hash[:12]
	}
	return hash
}
