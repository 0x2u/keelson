package api

import (
	"context"
	"net"
	"net/http"
	"strconv"
	"strings"

	"github.com/0x2u/keelson/agent/internal/store"
)

// AuditLog stores and lists the requests the agent acted on.
type AuditLog interface {
	AddAudit(ctx context.Context, e store.AuditEntry) error
	Audit(ctx context.Context, limit int, before int64) ([]store.AuditEntry, error)
}

// HeaderActor names who sent a signed request ("dashboard", "ci"). It is not signed: it labels the audit log,
// it does not authenticate anyone (only holders of the deploy secret can send a signed request at all).
const HeaderActor = "X-Keelson-Actor"

// auditActions names the routes worth recording. A route that is absent, or maps to "", is not recorded:
// validating a document happens at every pause in typing and would drown the log.
var auditActions = map[string]string{
	"POST /v1/apps/{app}/deploy":                  "deploy",
	"POST /v1/apps/{app}/rollback":                "rollback",
	"POST /v1/apps/{app}/build":                   "build",
	"POST /v1/builds":                             "build",
	"POST /v1/apps/{app}/image/export":            "image.export",
	"POST /v1/images/export":                      "image.export",
	"PUT /v1/apps/{app}/image/{tag}":              "image.import",
	"POST /v1/containers/{name}/start":            "container.start",
	"POST /v1/containers/{name}/restart":          "container.restart",
	"POST /v1/jobs/{name}/run":                    "job.run",
	"PUT /v1/config":                              "config.update",
	"POST /v1/config/versions/{id}/restore":       "config.restore",
	"PUT /v1/config/apps/{name}":                  "app.save",
	"DELETE /v1/config/apps/{name}":               "app.delete",
	"PUT /v1/config/jobs/{name}":                  "job.save",
	"DELETE /v1/config/jobs/{name}":               "job.delete",
	"PUT /v1/config/notifications":                "notifications.save",
	"PUT /v1/config/databases/{name}":             "database.save",
	"DELETE /v1/config/databases/{name}":          "database.delete",
	"POST /v1/databases/{name}/restore":           "database.restore",
	"POST /v1/databases/{name}/verify-key":        "database.verify_key",
	"POST /v1/databases/{name}/restore-test":      "database.restore_test",
	"POST /v1/notifications/test":                 "notifications.test",
	"PUT /v1/previews/{app}/{pr}":                 "preview.deploy",
	"DELETE /v1/previews/{app}/{pr}":              "preview.remove",
	"PUT /v1/config/previews/{app}":               "preview.save",
	"DELETE /v1/config/previews/{app}":            "preview.delete",
	"PUT /v1/projects/{name}/config":              "project.save",
	"DELETE /v1/projects/{name}/config":           "project.delete",
	"POST /v1/projects/{name}/split":              "project.split",
	"PUT /v1/apps/{app}/env":                      "env.set", // env.unset when the request only removes keys
	"DELETE /v1/apps/{app}/env":                   "env.delete",
	"PUT /v1/build-vars/{app}":                    "build_vars.set", // build_vars.remove when the request only removes names
	"DELETE /v1/build-vars/{app}":                 "build_vars.remove",
	"POST /v1/postgres/databases":                 "postgres.create",
	"DELETE /v1/postgres/databases/{name}":        "postgres.drop",
	"POST /v1/postgres/databases/{name}/password": "postgres.password",
}

type auditNoteKey struct{}

// auditNote lets a handler add what it did to the entry of its own request.
type auditNote struct{ detail, action string }

// noteAudit sets the detail of the audit entry of the current request.
func noteAudit(r *http.Request, detail string) {
	if n, ok := r.Context().Value(auditNoteKey{}).(*auditNote); ok {
		n.detail = detail
	}
}

// noteAuditAction replaces the action the route is recorded as, for a route whose requests do different things.
func noteAuditAction(r *http.Request, action string) {
	if n, ok := r.Context().Value(auditNoteKey{}).(*auditNote); ok {
		n.action = action
	}
}

// The status a handler wrote is read from the request log's statusRecorder (server.go), which wraps every response;
// it stays 0 when a handler writes a body without choosing a status, which means 200.
// serveAudited runs an authenticated request and records it afterwards, with the status it got.
func (s *server) serveAudited(w http.ResponseWriter, r *http.Request, next http.Handler) {
	if s.deploy.Audit == nil {
		next.ServeHTTP(w, r)
		return
	}
	note := &auditNote{}
	r = r.WithContext(context.WithValue(r.Context(), auditNoteKey{}, note))
	rec := &statusRecorder{ResponseWriter: w}
	next.ServeHTTP(rec, r)

	action := auditActions[r.Pattern]
	if action == "" {
		return
	}
	if note.action != "" {
		action = note.action
	}
	status := rec.status
	if status == 0 {
		status = http.StatusOK
	}
	detail := note.detail
	if detail == "" {
		detail = firstNonEmpty(r.PathValue("app"), r.PathValue("name"), r.PathValue("id"))
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		host = r.RemoteAddr
	}
	e := store.AuditEntry{
		At: s.now().UTC(), Actor: cleanActor(r.Header.Get(HeaderActor)), IP: host,
		Method: r.Method, Path: r.URL.Path, Action: action, Status: status, Detail: detail,
	}
	// The request has been answered: a failure to record it must not turn into an error for the caller.
	if err := s.deploy.Audit.AddAudit(context.WithoutCancel(r.Context()), e); err != nil {
		s.log.Error("record audit entry", "err", err)
	}
}

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if v != "" {
			return v
		}
	}
	return ""
}

// cleanActor keeps a short, printable label.
func cleanActor(s string) string {
	s = strings.Map(func(r rune) rune {
		if r < 0x20 || r == 0x7f {
			return -1
		}
		return r
	}, strings.TrimSpace(s))
	if len(s) > 40 {
		s = s[:40]
	}
	return s
}

func (s *server) listAudit(w http.ResponseWriter, r *http.Request) {
	limit := 50
	if v := r.URL.Query().Get("limit"); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || n < 1 || n > 200 {
			writeError(w, http.StatusBadRequest, "limit must be between 1 and 200")
			return
		}
		limit = n
	}
	var before int64
	if v := r.URL.Query().Get("before"); v != "" {
		n, err := strconv.ParseInt(v, 10, 64)
		if err != nil || n < 1 {
			writeError(w, http.StatusBadRequest, "before must be an entry id")
			return
		}
		before = n
	}
	ctx, cancel := context.WithTimeout(r.Context(), requestTimeout)
	defer cancel()
	entries, err := s.deploy.Audit.Audit(ctx, limit, before)
	if err != nil {
		s.log.Error("list audit", "err", err)
		writeError(w, http.StatusInternalServerError, "internal error")
		return
	}
	if entries == nil {
		entries = []store.AuditEntry{}
	}
	writeJSON(w, http.StatusOK, entries)
}
