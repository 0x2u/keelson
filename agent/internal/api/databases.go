package api

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"time"

	"github.com/0x2u/keelson/agent/internal/config"
	"github.com/0x2u/keelson/agent/internal/confmgr"
	"github.com/0x2u/keelson/agent/internal/databases"
	"github.com/0x2u/keelson/agent/internal/store"
)

// DatabasesService is the database service as the API sees it.
type DatabasesService interface {
	Databases(ctx context.Context) ([]databases.View, error)
	Live(ctx context.Context, name string) (databases.Live, error)
	Backups(ctx context.Context, name string) ([]databases.Backup, error)
	Restore(ctx context.Context, req databases.RestoreRequest) (databases.RestoreStarted, error)
	Restores(ctx context.Context, name string, limit int) ([]store.JobRun, error)
	// VerifyKey tries an age identity on a backup (the newest scheduled one when backup is empty).
	VerifyKey(ctx context.Context, name, identity, backup string) (databases.KeyCheck, error)
	// StartRestoreTest restores a backup into a scratch database in the background and compares row counts with the live one.
	StartRestoreTest(ctx context.Context, req databases.RestoreTestRequest) (store.RestoreTest, error)
	RestoreTests(ctx context.Context, name string, limit int) ([]store.RestoreTest, error)
}

func (s *server) databaseRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /v1/databases", s.listDatabases)
	mux.HandleFunc("GET /v1/databases/{name}/live", s.databaseLive)
	mux.HandleFunc("GET /v1/databases/{name}/backups", s.databaseBackups)
	mux.HandleFunc("GET /v1/databases/{name}/restores", s.databaseRestores)
	mux.HandleFunc("POST /v1/databases/{name}/restore", s.restoreDatabase)
	mux.HandleFunc("POST /v1/databases/{name}/verify-key", s.verifyKey)
	mux.HandleFunc("POST /v1/databases/{name}/restore-test", s.restoreTest)
	mux.HandleFunc("GET /v1/databases/{name}/restore-tests", s.databaseRestoreTests)
}

func (s *server) listDatabases(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), requestTimeout)
	defer cancel()
	list, err := s.deploy.Databases.Databases(ctx)
	if err != nil {
		s.failDatabase(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, list)
}

// databaseLive and databaseBackups reach out to something that may be down (the server, the destination): their
// failures are 502 with the reason, which is what the operator needs to fix it.
func (s *server) databaseLive(w http.ResponseWriter, r *http.Request) {
	live, err := s.deploy.Databases.Live(r.Context(), r.PathValue("name"))
	if err != nil {
		s.failRemote(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, live)
}

func (s *server) databaseBackups(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()
	list, err := s.deploy.Databases.Backups(ctx, r.PathValue("name"))
	if err != nil {
		s.failRemote(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, list)
}

func (s *server) databaseRestores(w http.ResponseWriter, r *http.Request) {
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
	runs, err := s.deploy.Databases.Restores(ctx, r.PathValue("name"), limit)
	if err != nil {
		s.failDatabase(w, r, err)
		return
	}
	if runs == nil {
		runs = []store.JobRun{}
	}
	writeJSON(w, http.StatusOK, runs)
}

func (s *server) restoreDatabase(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Backup    string `json:"backup"`
		Identity  string `json:"identity"`
		Target    string `json:"target"`
		Overwrite bool   `json:"overwrite"`
		Confirm   string `json:"confirm"`
	}
	if err := decode(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	name := r.PathValue("name")
	// The audit entry says what was asked, never the key, and only what passed validation: a refused request
	// leaves "(invalid)" where its value was, not text of the caller's choosing.
	noteAudit(r, restoreDetail(name, req.Backup, req.Target, req.Overwrite))
	started, err := s.deploy.Databases.Restore(r.Context(), databases.RestoreRequest{
		Database: name, Backup: req.Backup, Identity: req.Identity, Target: req.Target, Overwrite: req.Overwrite, Confirm: req.Confirm,
	})
	if err != nil {
		s.failDatabase(w, r, err)
		return
	}
	noteAudit(r, restoreDetail(name, req.Backup, started.Target, req.Overwrite))
	writeJSON(w, http.StatusAccepted, map[string]string{"run_id": started.RunID})
}

// restoreDetail is the audit line of a restore. Each value is written only if it is well formed (a database name,
// the key of a backup of that database, a plain identifier as target); anything else is "(invalid)", so an audit
// entry can neither grow with the request nor carry line breaks or control characters.
func restoreDetail(database, backup, target string, overwrite bool) string {
	const invalid = "(invalid)"
	if !config.ValidName(database) {
		database = invalid
	}
	if _, ok := databases.ParseKey(database, backup); !ok {
		backup = invalid
	}
	if target != "" && !databases.ValidTarget(target) && target != database {
		target = invalid
	}
	return fmt.Sprintf("%s backup=%s target=%s overwrite=%t", database, backup, target, overwrite)
}

// backupDetail is the audit line of a request about one backup (a key check, a restore test): the database and the key of
// the backup, each written only if well formed. It never carries the identity.
func backupDetail(database, backup string) string {
	const invalid = "(invalid)"
	if !config.ValidName(database) {
		database = invalid
	}
	if backup == "" {
		backup = "(none)"
	} else if _, ok := databases.ParseKey(database, backup); !ok {
		backup = invalid
	}
	return fmt.Sprintf("%s backup=%s", database, backup)
}

// keyAnswer is what POST /v1/databases/{name}/verify-key answers: the backup is told only when the key opened it.
type keyAnswer struct {
	OK         bool       `json:"ok"`
	Reason     string     `json:"reason,omitempty"`
	Backup     string     `json:"backup,omitempty"`
	BackupTime *time.Time `json:"backup_time,omitempty"`
}

// verifyKey proves that an age identity opens a backup. The identity is in the request body and nowhere else: it is not
// in the audit entry, the log or the answer.
func (s *server) verifyKey(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Identity string `json:"identity"`
		Backup   string `json:"backup"`
	}
	if err := decode(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	name := r.PathValue("name")
	noteAudit(r, backupDetail(name, req.Backup))
	ctx, cancel := context.WithTimeout(r.Context(), time.Minute)
	defer cancel()
	res, err := s.deploy.Databases.VerifyKey(ctx, name, req.Identity, req.Backup)
	if err != nil {
		s.failDatabase(w, r, err)
		return
	}
	noteAudit(r, backupDetail(name, res.Backup))
	if !res.OK {
		writeJSON(w, http.StatusOK, keyAnswer{Reason: res.Reason})
		return
	}
	writeJSON(w, http.StatusOK, keyAnswer{OK: true, Backup: res.Backup, BackupTime: &res.BackupTime})
}

// restoreTest starts a restore of a backup into a scratch database; the result is read from restore-tests.
func (s *server) restoreTest(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Identity string `json:"identity"`
		Backup   string `json:"backup"`
	}
	if err := decode(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	name := r.PathValue("name")
	noteAudit(r, backupDetail(name, req.Backup))
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()
	started, err := s.deploy.Databases.StartRestoreTest(ctx, databases.RestoreTestRequest{Database: name, Backup: req.Backup, Identity: req.Identity})
	if err != nil {
		if errors.Is(err, databases.ErrDestination) || errors.Is(err, databases.ErrSecret) {
			s.failRemote(w, r, err)
		} else {
			s.failDatabase(w, r, err)
		}
		return
	}
	noteAudit(r, backupDetail(name, started.Backup))
	writeJSON(w, http.StatusAccepted, map[string]string{"test_id": started.ID})
}

func (s *server) databaseRestoreTests(w http.ResponseWriter, r *http.Request) {
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
	tests, err := s.deploy.Databases.RestoreTests(ctx, r.PathValue("name"), limit)
	if err != nil {
		s.failDatabase(w, r, err)
		return
	}
	if tests == nil {
		tests = []store.RestoreTest{}
	}
	writeJSON(w, http.StatusOK, tests)
}

func (s *server) failDatabase(w http.ResponseWriter, r *http.Request, err error) {
	var bad *databases.RequestError
	switch {
	case errors.Is(err, databases.ErrUnknownDatabase):
		writeError(w, http.StatusNotFound, "not found")
	case errors.As(err, &bad):
		writeError(w, http.StatusBadRequest, bad.Msg)
	case errors.Is(err, databases.ErrRestoreBusy):
		writeError(w, http.StatusConflict, "a restore is already running for this database")
	case errors.Is(err, databases.ErrTestBusy):
		writeError(w, http.StatusConflict, "a restore test is already running for this database")
	case errors.Is(err, databases.ErrBackupBusy):
		writeError(w, http.StatusConflict, "a backup is running for this database: wait for it to end")
	case errors.Is(err, databases.ErrShuttingDown):
		writeError(w, http.StatusServiceUnavailable, "the agent is shutting down")
	default:
		s.log.Error("database request failed", "path", r.URL.Path, "err", err)
		writeError(w, http.StatusInternalServerError, "internal error")
	}
}

// failRemote answers a request that reached out to the server or the destination and failed. The answer is a stable
// sentence for the kind of failure: the error itself names paths of secret files, hosts and whatever the remote
// side printed, and stays in the agent's log, where the operator reads it.
func (s *server) failRemote(w http.ResponseWriter, r *http.Request, err error) {
	if errors.Is(err, databases.ErrUnknownDatabase) {
		s.failDatabase(w, r, err)
		return
	}
	s.log.Warn("database request failed", "path", r.URL.Path, "err", err)
	msg := "the request could not be completed: see the agent log"
	switch {
	case errors.Is(err, databases.ErrSecret):
		msg = "a secret file of this database could not be read: see the agent log"
	case errors.Is(err, databases.ErrDestination):
		msg = "the backup destination could not be read: see the agent log"
	case errors.Is(err, databases.ErrServer):
		msg = "the database server could not be queried: see the agent log"
	}
	writeError(w, http.StatusBadGateway, msg)
}

func (s *server) putDatabase(w http.ResponseWriter, r *http.Request) {
	var req struct {
		changeRequest
		Database map[string]any `json:"database"`
	}
	if err := decode(r, &req); err != nil || req.Database == nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	name := r.PathValue("name")
	out, err := confmgr.EditBundle(s.deploy.Config, req.BaseHash, req.Force, req.meta(r), func(b *config.Bundle) ([]config.Issue, error) {
		return b.SetDatabase(name, req.Database)
	})
	s.configResult(w, r, out, err)
}

func (s *server) deleteDatabase(w http.ResponseWriter, r *http.Request) {
	var req changeRequest
	if err := decode(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	name := r.PathValue("name")
	out, err := confmgr.EditBundle(s.deploy.Config, req.BaseHash, req.Force, req.meta(r), func(b *config.Bundle) ([]config.Issue, error) {
		return nil, b.DeleteDatabase(name)
	})
	s.configResult(w, r, out, err)
}
