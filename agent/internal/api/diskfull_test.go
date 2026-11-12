package api

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"
)

type failingReplays struct{ err error }

func (f failingReplays) RecordRequest(context.Context, string, time.Time, time.Time) (bool, error) {
	return false, f.err
}

// The replay table is written before a signed action runs: on a full disk every deploy, rollback and config edit would answer
// "internal error" exactly when the operator needs to know what is wrong.
func TestASignedRequestOnAFullDiskSaysSoInsteadOfInternalError(t *testing.T) {
	for name, tc := range map[string]struct {
		err  error
		code int
		text string
	}{
		"sqlite full": {errors.New("SQLITE_FULL: database or disk is full (13)"), http.StatusInsufficientStorage, "disk is full"},
		"no space":    {errors.New("write /var/lib/keelson/agent.db-wal: no space left on device"), http.StatusInsufficientStorage, "disk is full"},
		"other":       {errors.New("database is locked"), http.StatusInternalServerError, "internal error"},
	} {
		t.Run(name, func(t *testing.T) {
			h, err := New(&fakeDocker{}, Options{Token: testToken, Version: "test", Logger: slog.New(slog.NewTextHandler(io.Discard, nil)),
				Deploy: &DeployOptions{Deployments: &fakeDeployments{}, Secret: testSecret, Replays: failingReplays{tc.err}}})
			if err != nil {
				t.Fatal(err)
			}
			srv := httptest.NewServer(h)
			defer srv.Close()
			path, body, now := "/v1/apps/web/rollback", "", time.Now()
			req, _ := http.NewRequest("POST", srv.URL+path, strings.NewReader(body))
			req.Header.Set(HeaderTimestamp, strconv.FormatInt(now.Unix(), 10))
			req.Header.Set(HeaderSignature, Sign(testSecret, now.Unix(), "POST", path, []byte(body)))
			resp, err := http.DefaultClient.Do(req)
			if err != nil {
				t.Fatal(err)
			}
			defer resp.Body.Close()
			got, _ := io.ReadAll(resp.Body)
			if resp.StatusCode != tc.code || !strings.Contains(string(got), tc.text) {
				t.Errorf("%d %s", resp.StatusCode, got)
			}
		})
	}
}
