package api

import (
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"
	"time"

	"github.com/0x2u/keelson/agent/internal/store"
)

func monitoringServer(t *testing.T, st *store.Store, o *DeployOptions) string {
	t.Helper()
	o.Deployments, o.Secret, o.Replays = &fakeDeployments{}, testSecret, st
	h, err := New(&fakeDocker{}, Options{Token: testToken, Logger: slog.New(slog.NewTextHandler(io.Discard, nil)), Deploy: o})
	if err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(h)
	t.Cleanup(srv.Close)
	return srv.URL
}

func openStore(t *testing.T) *store.Store {
	t.Helper()
	st, err := store.Open(filepath.Join(t.TempDir(), "a.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	return st
}

func TestHostHistoryRouteIsAbsentWithoutARecorderAndValidatesTheRange(t *testing.T) {
	st := openStore(t)
	if resp := do(t, "GET", monitoringServer(t, st, &DeployOptions{})+"/v1/stats/host", testToken); resp.StatusCode != http.StatusNotFound {
		t.Errorf("without a recorder the route is a 404 the dashboard can tell apart: %d", resp.StatusCode)
	}

	url := monitoringServer(t, st, &DeployOptions{HostHistory: st})
	if resp := do(t, "GET", url+"/v1/stats/host", ""); resp.StatusCode != http.StatusUnauthorized {
		t.Errorf("a token is required: %d", resp.StatusCode)
	}
	for _, bad := range []string{"banana", "30s", "48h"} {
		if resp := do(t, "GET", url+"/v1/stats/host?range="+bad, testToken); resp.StatusCode != http.StatusBadRequest {
			t.Errorf("%q: got %d, want 400", bad, resp.StatusCode)
		}
	}

	type answer struct {
		CPUs        int   `json:"cpus"`
		StepSeconds int64 `json:"step_seconds"`
		Points      []store.HostPoint
	}
	var out answer
	resp := do(t, "GET", url+"/v1/stats/host?range=1h", testToken)
	if resp.StatusCode != 200 || json.NewDecoder(resp.Body).Decode(&out) != nil || out.Points == nil || len(out.Points) != 0 || out.CPUs < 1 || out.StepSeconds != 30 {
		t.Fatalf("no sample yet is an empty list, not null: %d %+v", resp.StatusCode, out)
	}

	load := 2.5
	if err := st.AddHostSample(t.Context(), store.HostSample{Time: time.Now().Add(-time.Minute), Load: &load, MemTotal: 100, MemAvailable: 25}); err != nil {
		t.Fatal(err)
	}
	resp = do(t, "GET", url+"/v1/stats/host?range=24h", testToken)
	out = answer{}
	if resp.StatusCode != 200 || json.NewDecoder(resp.Body).Decode(&out) != nil || out.StepSeconds != 360 || len(out.Points) != 1 {
		t.Fatalf("24h is averaged into 6 minute points: %d %+v", resp.StatusCode, out)
	}
	if p := out.Points[0]; *p.Load != 2.5 || *p.MemPercent != 75 || p.DiskPct != nil {
		t.Errorf("unexpected point %+v", p)
	}
}

func TestAvailabilityRouteAnswersFromTheRecordAndValidatesTheRange(t *testing.T) {
	st := openStore(t)
	if resp := do(t, "GET", monitoringServer(t, st, &DeployOptions{})+"/v1/apps/web/availability", testToken); resp.StatusCode != http.StatusNotFound {
		t.Errorf("without a record the route is a 404: %d", resp.StatusCode)
	}

	url := monitoringServer(t, st, &DeployOptions{Availability: st})
	if resp := do(t, "GET", url+"/v1/apps/web/availability", ""); resp.StatusCode != http.StatusUnauthorized {
		t.Errorf("a token is required: %d", resp.StatusCode)
	}
	for _, bad := range []string{"1h", "90d", "banana"} {
		if resp := do(t, "GET", url+"/v1/apps/web/availability?range="+bad, testToken); resp.StatusCode != http.StatusBadRequest {
			t.Errorf("%q: got %d, want 400", bad, resp.StatusCode)
		}
	}

	type answer struct {
		App           string `json:"app"`
		Range         string `json:"range"`
		Since         *time.Time
		UptimePercent *float64 `json:"uptime_percent"`
		Incidents     []struct {
			Start           time.Time
			End             *time.Time
			DurationSeconds int64 `json:"duration_seconds"`
		}
	}
	var out answer
	resp := do(t, "GET", url+"/v1/apps/web/availability", testToken)
	if resp.StatusCode != 200 || json.NewDecoder(resp.Body).Decode(&out) != nil || out.App != "web" || out.Range != "24h" || out.Since != nil || out.UptimePercent != nil || out.Incidents == nil {
		t.Fatalf("an app not judged yet has no uptime and an empty list: %d %+v", resp.StatusCode, out)
	}

	now := time.Now()
	for _, r := range []struct {
		down bool
		ago  time.Duration
	}{{false, 10 * time.Hour}, {true, 5 * time.Hour}, {false, 4 * time.Hour}} {
		if err := st.RecordAppState(t.Context(), "web", r.down, now.Add(-r.ago)); err != nil {
			t.Fatal(err)
		}
	}
	out = answer{}
	resp = do(t, "GET", url+"/v1/apps/web/availability?range=7d", testToken)
	if resp.StatusCode != 200 || json.NewDecoder(resp.Body).Decode(&out) != nil || out.Range != "7d" {
		t.Fatalf("%d %+v", resp.StatusCode, out)
	}
	if out.Since == nil || time.Since(*out.Since) < 10*time.Hour-time.Minute || time.Since(*out.Since) > 10*time.Hour+time.Minute {
		t.Errorf("the record started 10 h ago, not 7 days ago: %v", out.Since)
	}
	if out.UptimePercent == nil || *out.UptimePercent < 89.9 || *out.UptimePercent > 90.1 {
		t.Errorf("1 h down in 10 h: %v", out.UptimePercent)
	}
	if len(out.Incidents) != 1 || out.Incidents[0].End == nil || out.Incidents[0].DurationSeconds != 3600 {
		t.Errorf("one closed incident: %+v", out.Incidents)
	}
}
