package api

import (
	"context"
	"fmt"
	"net/http"
	"strconv"
	"time"

	"github.com/0x2u/keelson/agent/internal/notify"
	"github.com/0x2u/keelson/agent/internal/store"
)

// AlertHistory is the agent's memory of the notifications it raised, and the way to test the channels that deliver them.
type AlertHistory interface {
	Events(limit int) []notify.Record
	// Test sends a test message on every channel and reports each outcome; it records a proof when all of them got it.
	Test(ctx context.Context) ([]notify.ChannelResult, error)
}

// ProofLog lists the latest successful proof of each kind and subject.
type ProofLog interface {
	Proofs(ctx context.Context) ([]store.Proof, error)
}

// listAlerts serves GET /v1/notifications/history?limit=: the newest events first (at most 200 are kept), each with how its
// delivery ended. A channel that failed is named without the error (an error may quote a URL that carries a token).
func (s *server) listAlerts(w http.ResponseWriter, r *http.Request) {
	limit := notify.KeepHistory
	if v := r.URL.Query().Get("limit"); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || n < 1 || n > notify.KeepHistory {
			writeError(w, http.StatusBadRequest, "limit must be between 1 and "+strconv.Itoa(notify.KeepHistory))
			return
		}
		limit = n
	}
	events := s.deploy.Alerts.Events(limit)
	if events == nil {
		events = []notify.Record{}
	}
	writeJSON(w, http.StatusOK, events)
}

// testNotifications serves POST /v1/notifications/test: a test message on every channel at once, and how each one went. A
// channel that failed is told by the kind of failure, never by the error. No channel configured answers an empty list.
func (s *server) testNotifications(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()
	channels, err := s.deploy.Alerts.Test(ctx)
	if err != nil {
		s.log.Error("notification test failed", "err", err)
		writeError(w, http.StatusInternalServerError, "internal error")
		return
	}
	if channels == nil {
		channels = []notify.ChannelResult{}
	}
	failed := 0
	for _, c := range channels {
		if !c.OK {
			failed++
		}
	}
	noteAudit(r, fmt.Sprintf("%d channels, %d failed", len(channels), failed))
	writeJSON(w, http.StatusOK, map[string]any{"channels": channels})
}

// listProofs serves GET /v1/proofs: the latest successful proof per kind and subject.
func (s *server) listProofs(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), requestTimeout)
	defer cancel()
	proofs, err := s.deploy.Proofs.Proofs(ctx)
	if err != nil {
		s.log.Error("list proofs", "err", err)
		writeError(w, http.StatusInternalServerError, "internal error")
		return
	}
	writeJSON(w, http.StatusOK, proofs)
}
