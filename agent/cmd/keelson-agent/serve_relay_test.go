package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/0x2u/keelson/agent/internal/install"
)

// serveFiles makes the token and relay files `serve --relay-file` reads, pointing at a dashboard.
func serveFiles(t *testing.T, dashboard string) (token, relayFile string) {
	t.Helper()
	dir := t.TempDir()
	token = filepath.Join(dir, "token")
	relayFile = filepath.Join(dir, "relay.json")
	if err := os.WriteFile(token, []byte("a-token-of-at-least-32-characters-long\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(relayFile, machine{Dashboard: dashboard, Credential: "cred", ServerID: "srv-1", Name: "vps"}.relayJSON(), 0o600); err != nil {
		t.Fatal(err)
	}
	return token, relayFile
}

func TestServeRefusesToHaveNeitherAListenerNorARelay(t *testing.T) {
	token, relayFile := serveFiles(t, "http://127.0.0.1:1")
	for name, tc := range map[string]struct {
		args []string
		want string
	}{
		"no listener, no relay":    {[]string{"--listen=", "--token-file", token}, "--relay-file"},
		"TLS needs a listener":     {[]string{"--listen=", "--relay-file", relayFile, "--token-file", token, "--tls-cert", "a", "--tls-key", "b"}, "listener"},
		"a relay file that is not": {[]string{"--listen=", "--relay-file", filepath.Join(t.TempDir(), "missing.json"), "--token-file", token}, "--relay-file"},
	} {
		t.Run(name, func(t *testing.T) {
			err := serve(context.Background(), tc.args)
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Errorf("got %v, want a refusal that mentions %q", err, tc.want)
			}
		})
	}

	bad := filepath.Join(t.TempDir(), "relay.json")
	os.WriteFile(bad, []byte(`{"dashboard":"https://x"}`), 0o600)
	err := serve(context.Background(), []string{"--listen=", "--relay-file", bad, "--token-file", token})
	if err == nil || !strings.Contains(err.Error(), "not a relay file") || !strings.Contains(err.Error(), bad) {
		t.Errorf("a relay file without a credential must be named: %v", err)
	}
}

// relayDashboard is a dashboard's relay API with one request to send down the stream and a place to collect the answer.
type relayDashboard struct {
	*httptest.Server
	mu       sync.Mutex
	status   map[string]int // request id -> answer status
	answered chan string
	revoke   bool
}

func newRelayDashboard(t *testing.T, requests map[string]string) *relayDashboard {
	d := &relayDashboard{status: map[string]int{}, answered: make(chan string, 8)}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/relay/connect", func(w http.ResponseWriter, r *http.Request) {
		if d.revoke {
			http.Error(w, "unknown", http.StatusUnauthorized)
			return
		}
		w.Header().Set("Content-Type", "application/x-ndjson")
		fmt.Fprintln(w, `{"type":"hello"}`)
		for id, path := range requests {
			line, _ := json.Marshal(map[string]any{"type": "request", "id": id, "method": "GET", "path": path, "headers": map[string]string{}})
			fmt.Fprintf(w, "%s\n", line)
		}
		w.(http.Flusher).Flush()
		<-r.Context().Done()
	})
	mux.HandleFunc("POST /api/relay/response/{id}", func(w http.ResponseWriter, r *http.Request) {
		if s := r.Header.Get("X-Relay-Status"); s != "" {
			n, _ := strconv.Atoi(s)
			d.mu.Lock()
			d.status[r.PathValue("id")] = n
			d.mu.Unlock()
		}
		if r.Header.Get("X-Relay-End") != "" {
			d.answered <- r.PathValue("id")
		}
	})
	d.Server = httptest.NewServer(mux)
	t.Cleanup(d.Close)
	return d
}

// A server installed with `install --connect` runs `serve --relay-file F --listen=`: the dashboard's requests are
// answered by the same handler a listener would use (here the token check answers one, the health route the other), and
// the process stops cleanly when told to.
func TestServeAnswersTheDashboardOverTheRelayWithoutAListener(t *testing.T) {
	d := newRelayDashboard(t, map[string]string{"a1": "/v1/health", "b2": "/v1/containers"})
	token, relayFile := serveFiles(t, d.URL)

	ctx, stop := context.WithCancel(context.Background())
	defer stop()
	done := make(chan error, 1)
	go func() {
		done <- serve(ctx, []string{"--listen=", "--relay-file", relayFile, "--token-file", token, "--docker-socket", filepath.Join(t.TempDir(), "no.sock")})
	}()

	for range 2 {
		select {
		case <-d.answered:
		case err := <-done:
			t.Fatalf("serve ended early: %v", err)
		case <-time.After(10 * time.Second):
			t.Fatal("the dashboard got no answer over the relay")
		}
	}
	d.mu.Lock()
	secret, health := d.status["b2"], d.status["a1"]
	d.mu.Unlock()
	if secret != http.StatusUnauthorized {
		t.Errorf("a request without the token must be refused by the agent's own authentication, got %d", secret)
	}
	if health != http.StatusOK && health != http.StatusServiceUnavailable {
		t.Errorf("health is answered (503 when Docker is down), got %d", health)
	}

	stop()
	select {
	case err := <-done:
		if err != nil {
			t.Errorf("a shutdown is not an error: %v", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("serve did not stop")
	}
}

// A dashboard that forgot this server would refuse it again at every restart: the process exits with the status the unit
// does not restart on, and says what to do.
func TestServeStopsForGoodWhenTheDashboardDoesNotKnowTheServer(t *testing.T) {
	d := newRelayDashboard(t, nil)
	d.revoke = true
	token, relayFile := serveFiles(t, d.URL)

	err := serve(context.Background(), []string{"--listen=", "--relay-file", relayFile, "--token-file", token, "--docker-socket", filepath.Join(t.TempDir(), "no.sock")})
	var exit *exitError
	if !errors.As(err, &exit) || exit.code != install.ExitStopRestarting || !strings.Contains(err.Error(), "uninstall") {
		t.Fatalf("got %v", err)
	}
}
