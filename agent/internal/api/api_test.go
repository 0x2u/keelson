package api

import (
	"bufio"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/0x2u/keelson/agent/internal/docker"
)

const testToken = "0123456789abcdef0123456789abcdef"

type fakeDocker struct {
	pingErr error
	logs    []docker.LogLine
	// block makes Logs/Stats wait for the request context, like a follow stream.
	block bool
	// infoErr and dfErr make the engine's /info and /system/df fail; dfCalls counts /system/df requests.
	infoErr, dfErr error
	dfCalls        int
}

func (f *fakeDocker) Ping(context.Context) error { return f.pingErr }
func (f *fakeDocker) ListContainers(_ context.Context, all bool) ([]docker.Container, error) {
	out := []docker.Container{{ID: "a", Name: "web", State: "running"}}
	if all {
		out = append(out, docker.Container{ID: "b", Name: "old", State: "exited"})
	}
	return out, nil
}
func (f *fakeDocker) Inspect(_ context.Context, id string) (*docker.Detail, error) {
	switch id {
	case "web":
		return &docker.Detail{ID: "a", Name: "web"}, nil
	case "bad id":
		return nil, docker.ErrInvalidID
	}
	return nil, &docker.Error{Status: 404, Message: "No such container"}
}
func (f *fakeDocker) Logs(ctx context.Context, _ string, _ docker.LogOptions, fn func(docker.LogLine) error) error {
	for _, l := range f.logs {
		if err := fn(l); err != nil {
			return err
		}
	}
	if f.block {
		<-ctx.Done()
		return ctx.Err()
	}
	return nil
}
func (f *fakeDocker) Stats(ctx context.Context, _ string, fn func(docker.Stats) error) error {
	for i := 1; i <= 3; i++ {
		if err := fn(docker.Stats{CPUPercent: float64(i)}); err != nil {
			if err == docker.ErrStop {
				return nil
			}
			return err
		}
	}
	return nil
}

func newServer(t *testing.T, f *fakeDocker, max int) *httptest.Server {
	t.Helper()
	h, err := New(f, Options{Token: testToken, Version: "test", MaxStreams: max,
		Logger: slog.New(slog.NewTextHandler(io.Discard, nil))})
	if err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(h)
	t.Cleanup(srv.Close)
	return srv
}

func do(t *testing.T, method, url, token string) *http.Response {
	t.Helper()
	req, _ := http.NewRequest(method, url, nil)
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { resp.Body.Close() })
	return resp
}

func TestNewRejectsShortToken(t *testing.T) {
	if _, err := New(&fakeDocker{}, Options{Token: "short"}); err == nil {
		t.Fatal("a short token must be rejected")
	}
}

func TestEverythingButHealthRequiresTheToken(t *testing.T) {
	srv := newServer(t, &fakeDocker{}, 0)

	for _, path := range []string{"/v1/info", "/v1/containers", "/v1/containers/web", "/v1/containers/web/logs", "/v1/containers/web/stats", "/v1/nope"} {
		for _, token := range []string{"", "wrong", testToken[:31], testToken + "x"} {
			if got := do(t, "GET", srv.URL+path, token).StatusCode; got != http.StatusUnauthorized {
				t.Errorf("GET %s with token %q: want 401, got %d", path, token, got)
			}
		}
		if got := do(t, "GET", srv.URL+path, testToken).StatusCode; got == http.StatusUnauthorized {
			t.Errorf("GET %s with the right token must not be 401", path)
		}
	}
	if got := do(t, "GET", srv.URL+"/v1/health", "").StatusCode; got != http.StatusOK {
		t.Errorf("health must be public, got %d", got)
	}
}

func TestMutatingMethodsAreNotRoutable(t *testing.T) {
	srv := newServer(t, &fakeDocker{}, 0)
	for _, m := range []string{"POST", "PUT", "PATCH", "DELETE"} {
		for _, path := range []string{"/v1/containers", "/v1/containers/web", "/v1/containers/web/logs"} {
			if got := do(t, m, srv.URL+path, testToken).StatusCode; got != http.StatusMethodNotAllowed {
				t.Errorf("%s %s: want 405, got %d", m, path, got)
			}
		}
	}
}

func TestHealthReflectsEngine(t *testing.T) {
	srv := newServer(t, &fakeDocker{pingErr: io.ErrClosedPipe}, 0)
	if got := do(t, "GET", srv.URL+"/v1/health", "").StatusCode; got != http.StatusServiceUnavailable {
		t.Errorf("want 503 when the engine is down, got %d", got)
	}
}

func TestListContainersAllParameter(t *testing.T) {
	srv := newServer(t, &fakeDocker{}, 0)
	count := func(q string) int {
		resp := do(t, "GET", srv.URL+"/v1/containers"+q, testToken)
		var l []docker.Container
		if err := json.NewDecoder(resp.Body).Decode(&l); err != nil {
			t.Fatal(err)
		}
		return len(l)
	}
	if count("") != 1 || count("?all=true") != 2 {
		t.Error("all parameter not honoured")
	}
	if got := do(t, "GET", srv.URL+"/v1/containers?all=maybe", testToken).StatusCode; got != 400 {
		t.Errorf("want 400 for a bad all, got %d", got)
	}
}

func TestContainerErrorsMapToStatus(t *testing.T) {
	srv := newServer(t, &fakeDocker{}, 0)
	cases := map[string]int{
		"/v1/containers/ghost":      404,
		"/v1/containers/ghost/logs": 404,
		"/v1/containers/bad%20id":   400,
	}
	for path, want := range cases {
		if got := do(t, "GET", srv.URL+path, testToken).StatusCode; got != want {
			t.Errorf("%s: want %d, got %d", path, want, got)
		}
	}
}

func TestLogsRejectsBadParameters(t *testing.T) {
	srv := newServer(t, &fakeDocker{}, 0)
	for _, q := range []string{"tail=abc", "tail=-1", "tail=1234567890", "follow=maybe", "since=yesterday", "since=-5m"} {
		if got := do(t, "GET", srv.URL+"/v1/containers/web/logs?"+q, testToken).StatusCode; got != 400 {
			t.Errorf("?%s: want 400, got %d", q, got)
		}
	}
}

func TestParseSince(t *testing.T) {
	now := time.Unix(1_000_000, 0)
	cases := map[string]string{
		"":                     "",
		"1700000000":           "1700000000",
		"10m":                  "999400",
		"1970-01-01T00:00:10Z": "10",
	}
	for in, want := range cases {
		got, err := parseSince(in, now)
		if err != nil || got != want {
			t.Errorf("parseSince(%q) = %q, %v; want %q", in, got, err, want)
		}
	}
	for _, bad := range []string{"soon", "-5m", "0s", "1.5.2"} {
		if _, err := parseSince(bad, now); err == nil {
			t.Errorf("parseSince(%q) must fail", bad)
		}
	}
}

// readEvents parses an SSE body into "event: payload" strings.
func readEvents(t *testing.T, body io.Reader) []string {
	t.Helper()
	var out []string
	sc := bufio.NewScanner(body)
	event := ""
	for sc.Scan() {
		switch line := sc.Text(); {
		case strings.HasPrefix(line, "event: "):
			event = strings.TrimPrefix(line, "event: ")
		case strings.HasPrefix(line, "data: "):
			out = append(out, event+": "+strings.TrimPrefix(line, "data: "))
		}
	}
	return out
}

func TestLogsStreamsEventsThenEnd(t *testing.T) {
	srv := newServer(t, &fakeDocker{logs: []docker.LogLine{
		{Stream: "stdout", Line: "hello"}, {Stream: "stderr", Line: "boom"},
	}}, 0)
	resp := do(t, "GET", srv.URL+"/v1/containers/web/logs", testToken)
	if ct := resp.Header.Get("Content-Type"); ct != "text/event-stream" {
		t.Fatalf("content type %q", ct)
	}
	ev := readEvents(t, resp.Body)
	if len(ev) != 3 || !strings.HasPrefix(ev[0], "log: ") || !strings.Contains(ev[0], `"line":"hello"`) ||
		!strings.Contains(ev[1], `"stream":"stderr"`) || ev[2] != "end: {}" {
		t.Errorf("unexpected events: %v", ev)
	}
}

func TestStatsSingleSampleUsesSecondSample(t *testing.T) {
	srv := newServer(t, &fakeDocker{}, 0)
	resp := do(t, "GET", srv.URL+"/v1/containers/web/stats?stream=false", testToken)
	var s docker.Stats
	if err := json.NewDecoder(resp.Body).Decode(&s); err != nil || s.CPUPercent != 2 {
		t.Errorf("want the second sample (cpu 2), got %+v, %v", s, err)
	}
}

func TestStreamLimitReturns429AndSlotIsReleased(t *testing.T) {
	srv := newServer(t, &fakeDocker{block: true}, 1)

	req, _ := http.NewRequest("GET", srv.URL+"/v1/containers/web/logs?follow=true", nil)
	req.Header.Set("Authorization", "Bearer "+testToken)
	ctx, cancel := context.WithCancel(context.Background())
	first, err := http.DefaultClient.Do(req.WithContext(ctx))
	if err != nil {
		t.Fatal(err)
	}
	defer first.Body.Close()

	if got := do(t, "GET", srv.URL+"/v1/containers/web/logs", testToken).StatusCode; got != http.StatusTooManyRequests {
		t.Errorf("want 429 while the only slot is taken, got %d", got)
	}

	cancel() // client disconnects: the slot must come back
	deadline := time.Now().Add(2 * time.Second)
	for {
		resp := do(t, "GET", srv.URL+"/v1/containers/web/stats?stream=false", testToken)
		if resp.StatusCode == http.StatusOK {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("slot not released after disconnect, last status %d", resp.StatusCode)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func (f *fakeDocker) Info(context.Context) (*docker.EngineInfo, error) {
	if f.infoErr != nil {
		return nil, f.infoErr
	}
	return &docker.EngineInfo{Version: "27.1.1", RootDir: "/var/lib/docker", OSType: "linux", Arch: "arm64"}, nil
}

func (f *fakeDocker) DiskUsage(context.Context) (*docker.DiskUsage, error) {
	f.dfCalls++
	if f.dfErr != nil {
		return nil, f.dfErr
	}
	var u docker.DiskUsage
	u.Images.Reclaimable = int64(f.dfCalls) // tells the answers apart
	return &u, nil
}
