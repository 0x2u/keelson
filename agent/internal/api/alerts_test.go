package api

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"
	"time"

	"github.com/0x2u/keelson/agent/internal/config"
	"github.com/0x2u/keelson/agent/internal/notify"
	"github.com/0x2u/keelson/agent/internal/store"
)

func TestTheNotificationHistoryIsServedNewestFirstWithItsDeliveryAndOnlyToTheToken(t *testing.T) {
	st, err := store.Open(filepath.Join(t.TempDir(), "a.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	ledger := notify.OpenLedger("", slog.New(slog.NewTextHandler(io.Discard, nil)))
	ledger.Add(notify.Record{Event: notify.Event{Type: config.EventJobFailed, Job: "backup", Time: time.Unix(1, 0)}, Status: notify.StatusDelivered})
	ledger.Add(notify.Record{Event: notify.Event{Type: config.EventAppDown, App: "web", Time: time.Unix(2, 0)}, Status: notify.StatusFailed, FailedChannels: []string{"telegram"}})
	h, err := New(&fakeDocker{}, Options{Token: testToken, Version: "test", Logger: slog.New(slog.NewTextHandler(io.Discard, nil)),
		Deploy: &DeployOptions{Deployments: &fakeDeployments{}, Secret: testSecret, Replays: st, Alerts: alertsOf{ledger}}})
	if err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(h)
	defer srv.Close()

	if do(t, "GET", srv.URL+"/v1/notifications/history", "").StatusCode != http.StatusUnauthorized {
		t.Error("the history needs the read token")
	}
	var got []notify.Record
	resp := do(t, "GET", srv.URL+"/v1/notifications/history", testToken)
	json.NewDecoder(resp.Body).Decode(&got)
	if len(got) != 2 || got[0].Type != config.EventAppDown || got[0].Status != notify.StatusFailed || got[0].FailedChannels[0] != "telegram" || got[1].Job != "backup" {
		t.Errorf("%+v", got)
	}
	if n := len(func() []notify.Record {
		var one []notify.Record
		json.NewDecoder(do(t, "GET", srv.URL+"/v1/notifications/history?limit=1", testToken).Body).Decode(&one)
		return one
	}()); n != 1 {
		t.Errorf("limit: %d", n)
	}
	for _, bad := range []string{"0", "201", "x"} {
		if c := do(t, "GET", srv.URL+"/v1/notifications/history?limit="+bad, testToken).StatusCode; c != http.StatusBadRequest {
			t.Errorf("limit=%s: %d", bad, c)
		}
	}
}

type alertsOf struct{ l *notify.Ledger }

func (a alertsOf) Events(limit int) []notify.Record { return a.l.Events(limit) }

func (a alertsOf) Test(context.Context) ([]notify.ChannelResult, error) { return nil, nil }
