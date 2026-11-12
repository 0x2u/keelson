package api

import (
	"net/http"
	"time"

	"github.com/0x2u/keelson/agent/internal/config"
	"github.com/0x2u/keelson/agent/internal/confmgr"
)

// projects is the configuration service's project files, which configRoutes only routes when it has them.
func (s *server) projects() ProjectsService {
	return s.deploy.Config.(ProjectsService)
}

func (s *server) listProjects(w http.ResponseWriter, r *http.Request) {
	list, err := s.projects().Projects()
	if err != nil {
		s.configFailure(w, r, err)
		return
	}
	if list == nil {
		list = []confmgr.ProjectInfo{}
	}
	writeJSON(w, http.StatusOK, list)
}

func (s *server) getProjectConfig(w http.ResponseWriter, r *http.Request) {
	doc, err := s.projects().ProjectDocument(r.PathValue("name"))
	if err != nil {
		s.configFailure(w, r, err)
		return
	}
	out := map[string]any{
		"project":      doc.Project,
		"path":         doc.Path,
		"content":      doc.Content,
		"hash":         doc.Hash,
		"applied_hash": doc.AppliedHash,
		"config_hash":  doc.ConfigHash,
		"modified_at":  doc.ModifiedAt.Format(time.RFC3339),
		"model":        doc.Model,
	}
	if doc.Error != "" {
		out["error"] = doc.Error
	}
	writeJSON(w, http.StatusOK, out)
}

func (s *server) validateProjectConfig(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Content string `json:"content"`
	}
	if err := decode(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	issues, err := s.projects().ValidateProject(r.PathValue("name"), []byte(req.Content))
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

// projectResult answers a change to a project's file: hash is the file's new hash (the next base_hash of that file; empty
// once it is deleted), config_hash the one of the whole configuration.
func (s *server) projectResult(w http.ResponseWriter, r *http.Request, out confmgr.Outcome, err error) {
	if err != nil {
		s.configFailure(w, r, err)
		return
	}
	noteAudit(r, r.PathValue("name")+" hash "+short(out.Hash))
	writeJSON(w, http.StatusOK, map[string]any{"hash": out.FileHash, "config_hash": out.Hash, "version": out.Version, "issues": nonNil(out.Issues)})
}

func (s *server) putProjectConfig(w http.ResponseWriter, r *http.Request) {
	var req struct {
		changeRequest
		Content string `json:"content"`
	}
	if err := decode(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	out, err := s.projects().SaveProject(r.PathValue("name"), []byte(req.Content), req.BaseHash, req.Force, req.meta(r))
	s.projectResult(w, r, out, err)
}

func (s *server) deleteProjectConfig(w http.ResponseWriter, r *http.Request) {
	var req changeRequest
	if err := decode(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	out, err := s.projects().DeleteProject(r.PathValue("name"), req.BaseHash, req.Force, req.meta(r))
	s.projectResult(w, r, out, err)
}

func (s *server) splitProject(w http.ResponseWriter, r *http.Request) {
	var req struct {
		changeRequest
		// DryRun answers with what would move and writes nothing.
		DryRun bool `json:"dry_run"`
	}
	if err := decode(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	out, plan, err := s.projects().SplitProject(r.PathValue("name"), req.BaseHash, req.Force, req.DryRun, req.meta(r))
	if err != nil {
		s.configFailure(w, r, err)
		return
	}
	if plan.Apps == nil {
		plan.Apps = []string{}
	}
	if plan.Jobs == nil {
		plan.Jobs = []string{}
	}
	if plan.Databases == nil {
		plan.Databases = []string{}
	}
	if plan.Previews == nil {
		plan.Previews = []string{}
	}
	if plan.Kept == nil {
		plan.Kept = []config.SplitKept{}
	}
	if req.DryRun {
		writeJSON(w, http.StatusOK, map[string]any{"dry_run": true, "hash": out.Hash, "plan": plan})
		return
	}
	noteAudit(r, r.PathValue("name")+" hash "+short(out.Hash))
	writeJSON(w, http.StatusOK, map[string]any{"dry_run": false, "hash": out.Hash, "file_hash": out.FileHash, "version": out.Version, "issues": nonNil(out.Issues), "plan": plan})
}
