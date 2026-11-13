package api

import (
	"context"
	"net/http"
	"time"

	"github.com/0x2u/keelson/agent/internal/store"
)

// DeliveryService computes the delivery performance of this server over a window.
type DeliveryService interface {
	Delivery(ctx context.Context, app string, from, to time.Time) (store.Delivery, error)
}

// deliveryRanges are the windows GET /v1/delivery accepts. 30 days is the longest: the outage record stops there.
var deliveryRanges = map[string]time.Duration{
	"24h": 24 * time.Hour,
	"7d":  7 * 24 * time.Hour,
	"30d": store.MaxDeliveryWindow,
}

type deliveryAnswer struct {
	Range string `json:"range"`
	store.Delivery
	// Apps are the same numbers per app; absent when the request named one app.
	Apps []store.Delivery `json:"apps,omitempty"`
}

// delivery answers GET /v1/delivery?range=24h|7d|30d&app=<name>: how often this server deployed, how often a deployment
// did not leave the new version serving, how long its apps took to serve again after an outage, and, over the
// deployments that carry the time of their commit, how long a change took to reach production.
func (s *server) delivery(w http.ResponseWriter, r *http.Request) {
	name := r.URL.Query().Get("range")
	if name == "" {
		name = "30d"
	}
	span, ok := deliveryRanges[name]
	if !ok {
		writeError(w, http.StatusBadRequest, "range must be 24h, 7d or 30d")
		return
	}
	app := r.URL.Query().Get("app")
	ctx, cancel := context.WithTimeout(r.Context(), requestTimeout)
	defer cancel()
	now := s.now()
	from := now.Add(-span)
	all, err := s.deploy.Delivery.Delivery(ctx, app, from, now)
	if err != nil {
		s.failDeploy(w, r, err)
		return
	}
	answer := deliveryAnswer{Range: name, Delivery: all}
	if app == "" {
		apps, err := s.deploy.Deployments.Apps(ctx)
		if err != nil {
			s.failDeploy(w, r, err)
			return
		}
		for _, a := range apps {
			one, err := s.deploy.Delivery.Delivery(ctx, a.Name, from, now)
			if err != nil {
				s.failDeploy(w, r, err)
				return
			}
			answer.Apps = append(answer.Apps, one)
		}
	}
	writeJSON(w, http.StatusOK, answer)
}
