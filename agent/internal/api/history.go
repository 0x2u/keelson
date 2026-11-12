package api

import (
	"context"
	"net/http"
	"runtime"
	"time"

	"github.com/0x2u/keelson/agent/internal/history"
	"github.com/0x2u/keelson/agent/internal/store"
)

// HistoryService is the record of container stats.
type HistoryService interface {
	StatsHistory(ctx context.Context, container string, since time.Time, step time.Duration) ([]store.StatPoint, error)
}

const (
	defaultHistoryRange = time.Hour
	// maxHistoryPoints is what a chart can show: longer ranges are averaged into buckets.
	maxHistoryPoints = 240
)

type historyAnswer struct {
	Container string `json:"container"`
	// StepSeconds is the width of a point; every point averages that much time.
	StepSeconds int64             `json:"step_seconds"`
	Points      []store.StatPoint `json:"points"`
}

// statsHistory answers GET /v1/stats/history?container=&range=: the recent CPU and memory of a container, or of the app
// it serves, so that the history survives deployments. An unknown container has no points rather than being an error: it
// may simply not have been sampled yet.
func (s *server) statsHistory(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	container := q.Get("container")
	if container == "" || len(container) > 200 {
		writeError(w, http.StatusBadRequest, "container is required")
		return
	}
	span, step, ok := historyWindow(w, q.Get("range"))
	if !ok {
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), requestTimeout)
	defer cancel()
	points, err := s.deploy.History.StatsHistory(ctx, container, s.now().Add(-span), step)
	if err != nil {
		s.failDeploy(w, r, err)
		return
	}
	if points == nil {
		points = []store.StatPoint{}
	}
	writeJSON(w, http.StatusOK, historyAnswer{Container: container, StepSeconds: int64(step / time.Second), Points: points})
}

// historyWindow reads the range of a history request: a duration between 1m and the retention, an hour by default. The
// width of a point is the range over maxHistoryPoints, never finer than the sampling interval. It answers 400 itself.
func historyWindow(w http.ResponseWriter, v string) (span, step time.Duration, ok bool) {
	span = defaultHistoryRange
	if v != "" {
		d, err := time.ParseDuration(v)
		if err != nil || d < time.Minute || d > history.Retention {
			writeError(w, http.StatusBadRequest, "range must be a duration between 1m and 24h, such as 6h")
			return 0, 0, false
		}
		span = d
	}
	step = span / maxHistoryPoints
	if step < history.Interval {
		step = history.Interval
	}
	return span, step.Round(time.Second), true
}

// HostHistoryService is the record of the host's load, memory and disk.
type HostHistoryService interface {
	HostHistory(ctx context.Context, since time.Time, step time.Duration) ([]store.HostPoint, error)
}

type hostHistoryAnswer struct {
	// CPUs is how many the host has: load is per run queue, so it reads against this.
	CPUs        int   `json:"cpus"`
	StepSeconds int64 `json:"step_seconds"`
	// Points carry the load average, and memory and disk used in percent; each with its peak inside the point.
	Points []store.HostPoint `json:"points"`
}

// hostHistory answers GET /v1/stats/host?range=: the recent load, memory and disk of the machine.
func (s *server) hostHistory(w http.ResponseWriter, r *http.Request) {
	span, step, ok := historyWindow(w, r.URL.Query().Get("range"))
	if !ok {
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), requestTimeout)
	defer cancel()
	points, err := s.deploy.HostHistory.HostHistory(ctx, s.now().Add(-span), step)
	if err != nil {
		s.failDeploy(w, r, err)
		return
	}
	if points == nil {
		points = []store.HostPoint{}
	}
	writeJSON(w, http.StatusOK, hostHistoryAnswer{CPUs: runtime.NumCPU(), StepSeconds: int64(step / time.Second), Points: points})
}
