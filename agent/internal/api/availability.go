package api

import (
	"context"
	"net/http"
	"time"

	"github.com/0x2u/keelson/agent/internal/store"
)

// AvailabilityService is the record of when apps were down.
type AvailabilityService interface {
	AppAvailability(ctx context.Context, app string, from, to time.Time) (store.Availability, error)
}

// availabilityRanges are what GET /v1/apps/{app}/availability accepts; the record is kept for the longest.
var availabilityRanges = map[string]time.Duration{
	"24h": 24 * time.Hour,
	"7d":  7 * 24 * time.Hour,
	"30d": store.AvailabilityRetention,
}

type availabilityAnswer struct {
	App   string `json:"app"`
	Range string `json:"range"`
	store.Availability
}

// appAvailability answers GET /v1/apps/{app}/availability?range=24h|7d|30d: how much of the range the app was up, over the
// part of it the agent has watched, and the incidents. An app that has not been judged yet has no uptime (null) rather than
// being an error: it may simply not be deployed.
func (s *server) appAvailability(w http.ResponseWriter, r *http.Request) {
	app := r.PathValue("app")
	name := r.URL.Query().Get("range")
	if name == "" {
		name = "24h"
	}
	span, ok := availabilityRanges[name]
	if !ok {
		writeError(w, http.StatusBadRequest, "range must be 24h, 7d or 30d")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), requestTimeout)
	defer cancel()
	now := s.now()
	a, err := s.deploy.Availability.AppAvailability(ctx, app, now.Add(-span), now)
	if err != nil {
		s.failDeploy(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, availabilityAnswer{App: app, Range: name, Availability: a})
}
