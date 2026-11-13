package api

import (
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/0x2u/keelson/agent/internal/store"
)

// delivered records a finished deployment of app, and a commit time when committed is not zero.
func delivered(t *testing.T, st *store.Store, app string, started, finished time.Time, status string, committed time.Time) {
	t.Helper()
	d := store.Deployment{ID: store.NewID(), App: app, Ref: "o/" + app + ":v", Trigger: "api", StartedAt: started}
	if !committed.IsZero() {
		d.CommittedAt = &committed
	}
	if err := st.CreateDeployment(t.Context(), d); err != nil {
		t.Fatal(err)
	}
	if err := st.Finish(t.Context(), d.ID, status, "", "o/"+app+":v", finished); err != nil {
		t.Fatal(err)
	}
}

type deliveryBody struct {
	Range       string `json:"range"`
	Days        float64
	Deployments struct {
		Total          int
		Succeeded      int
		Failed         int
		RolledBack     int `json:"rolled_back"`
		RollbackFailed int `json:"rollback_failed"`
	}
	PerDay             float64  `json:"per_day"`
	ChangeFailureRatio *float64 `json:"change_failure_ratio"`
	Restore            struct {
		Incidents     int
		MedianSeconds *float64 `json:"median_seconds"`
	}
	LeadTime struct {
		Deployments   int
		MedianSeconds *float64 `json:"median_seconds"`
	} `json:"lead_time"`
	Apps []struct {
		App         string `json:"app"`
		Deployments struct{ Total int }
	} `json:"apps"`
}

func TestDeliveryRouteAnswersTheNumbersOfTheWindow(t *testing.T) {
	st := openStore(t)
	if resp := do(t, "GET", monitoringServer(t, st, &DeployOptions{})+"/v1/delivery", testToken); resp.StatusCode != http.StatusNotFound {
		t.Errorf("without the service the route is a 404 the dashboard can tell apart: %d", resp.StatusCode)
	}

	url := monitoringServer(t, st, &DeployOptions{Delivery: st})
	if resp := do(t, "GET", url+"/v1/delivery", ""); resp.StatusCode != http.StatusUnauthorized {
		t.Errorf("a token is required: %d", resp.StatusCode)
	}
	for _, bad := range []string{"1h", "90d", "banana"} {
		if resp := do(t, "GET", url+"/v1/delivery?range="+bad, testToken); resp.StatusCode != http.StatusBadRequest {
			t.Errorf("%q: got %d, want 400", bad, resp.StatusCode)
		}
	}

	now := time.Now()
	delivered(t, st, "web", now.Add(-3*time.Hour), now.Add(-3*time.Hour+time.Minute), store.StatusSucceeded, now.Add(-5*time.Hour))
	delivered(t, st, "web", now.Add(-2*time.Hour), now.Add(-2*time.Hour+time.Minute), store.StatusRolledBack, time.Time{})
	if err := st.RecordAppState(t.Context(), "web", false, now.Add(-10*time.Hour)); err != nil {
		t.Fatal(err)
	}
	if err := st.RecordAppState(t.Context(), "web", true, now.Add(-4*time.Hour)); err != nil {
		t.Fatal(err)
	}
	if err := st.RecordAppState(t.Context(), "web", false, now.Add(-3*time.Hour)); err != nil {
		t.Fatal(err)
	}

	var out deliveryBody
	resp := do(t, "GET", url+"/v1/delivery?range=24h", testToken)
	if resp.StatusCode != 200 || json.NewDecoder(resp.Body).Decode(&out) != nil {
		t.Fatalf("status %d", resp.StatusCode)
	}
	if out.Range != "24h" || out.Days != 1 {
		t.Fatalf("the window is what was asked for: %+v", out)
	}
	if out.Deployments.Total != 2 || out.Deployments.Succeeded != 1 || out.Deployments.RolledBack != 1 {
		t.Errorf("outcomes: %+v", out.Deployments)
	}
	if out.PerDay != 1 || out.ChangeFailureRatio == nil || *out.ChangeFailureRatio != 0.5 {
		t.Errorf("one success a day, half of them failed: %v %v", out.PerDay, out.ChangeFailureRatio)
	}
	if out.Restore.Incidents != 1 || out.Restore.MedianSeconds == nil || *out.Restore.MedianSeconds != 3600 {
		t.Errorf("one outage of an hour: %+v", out.Restore)
	}
	if out.LeadTime.Deployments != 1 || out.LeadTime.MedianSeconds == nil || *out.LeadTime.MedianSeconds != 2*3600+60 {
		t.Errorf("the one deployment that knows its commit: %+v", out.LeadTime)
	}
	if len(out.Apps) != 1 || out.Apps[0].App != "web" || out.Apps[0].Deployments.Total != 2 {
		t.Errorf("the apps of the server are listed too: %+v", out.Apps)
	}

	var one deliveryBody
	resp = do(t, "GET", url+"/v1/delivery?range=24h&app=api", testToken)
	if resp.StatusCode != 200 || json.NewDecoder(resp.Body).Decode(&one) != nil {
		t.Fatalf("status %d", resp.StatusCode)
	}
	if one.Deployments.Total != 0 || one.Apps != nil {
		t.Errorf("one app's own numbers, without the per-app list: %+v", one)
	}
}

func TestTheScrapeCarriesTheDeliveryNumbers(t *testing.T) {
	st := openStore(t)
	now := time.Now()
	delivered(t, st, "web", now.Add(-3*time.Hour), now.Add(-3*time.Hour+time.Minute), store.StatusSucceeded, now.Add(-4*time.Hour))
	delivered(t, st, "web", now.Add(-2*time.Hour), now.Add(-2*time.Hour+time.Minute), store.StatusFailed, time.Time{})

	resp := do(t, "GET", monitoringServer(t, st, &DeployOptions{Delivery: st})+"/metrics", testToken)
	if resp.StatusCode != 200 {
		t.Fatalf("status %d", resp.StatusCode)
	}
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatal(err)
	}
	text := string(body)
	for _, want := range []string{
		`keelson_delivery_deployments{window="30d",status="succeeded"} 1`,
		`keelson_delivery_deployments{window="30d",status="failed"} 1`,
		`keelson_delivery_change_failure_ratio{window="30d"} 0.5`,
		`keelson_delivery_lead_time_deployments{window="30d"} 1`,
		`keelson_delivery_lead_time_seconds{window="30d",quantile="0.5"} 3660`,
		`keelson_collector_success{collector="delivery"} 1`,
	} {
		if !strings.Contains(text, want) {
			t.Errorf("the scrape must hold %q:\n%s", want, text)
		}
	}
}
