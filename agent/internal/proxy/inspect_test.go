package proxy

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"github.com/0x2u/keelson/agent/internal/config"
)

var inspectRoutes = []Route{{App: "web", Hosts: []string{"example.com"}, Upstream: "127.0.0.1:3000"}}

func TestNginxInspectComparesTheFileOnDiskWithWhatWouldBeWritten(t *testing.T) {
	n, _, path := newNginx(t)
	ctx := context.Background()

	got := n.Inspect(ctx, inspectRoutes)
	if got.Type != "nginx" || got.Where != path || !strings.Contains(got.Generated, "upstream keelson_web {\n    server 127.0.0.1:3000;") {
		t.Fatalf("unexpected inspection: %+v", got)
	}
	if got.InSync == nil || *got.InSync || got.LiveError == "" {
		t.Errorf("a missing file is a difference, with the reason: %+v", got)
	}

	if err := os.MkdirAll(path[:strings.LastIndex(path, "/")], 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, RenderNginx(inspectRoutes), 0o644); err != nil {
		t.Fatal(err)
	}
	if got := n.Inspect(ctx, inspectRoutes); got.InSync == nil || !*got.InSync {
		t.Errorf("identical content must be in sync: %+v", got)
	}

	if err := os.WriteFile(path, []byte("# edited by hand\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if got := n.Inspect(ctx, inspectRoutes); got.InSync == nil || *got.InSync {
		t.Errorf("a hand-edited file must be reported as different: %+v", got)
	}
	if b, _ := os.ReadFile(path); string(b) != "# edited by hand\n" {
		t.Error("inspecting must never write")
	}
}

func TestCaddyInspectComparesTheServedRoutesWithTheGeneratedOnes(t *testing.T) {
	serving := caddyRoutes(config.Proxy{}, inspectRoutes)
	status := 200
	var path string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path = r.Method + " " + r.URL.Path
		w.WriteHeader(status)
		json.NewEncoder(w).Encode(map[string]any{"routes": serving})
	}))
	defer srv.Close()
	c := New(config.Proxy{Admin: srv.URL})

	got := c.Inspect(context.Background(), inspectRoutes)
	if got.Type != "caddy" || got.InSync == nil || !*got.InSync || !strings.Contains(got.Generated, `"dial": "127.0.0.1:3000"`) {
		t.Fatalf("unexpected inspection: %+v", got)
	}
	if path != "GET /config/apps/http/servers/keelson" {
		t.Errorf("inspection must only read the server: %q", path)
	}
	// What a handover loads: the very document Apply would post, listener included.
	var full struct {
		Apps struct {
			HTTP struct {
				Servers map[string]struct {
					Listen []string `json:"listen"`
					Routes []any    `json:"routes"`
				} `json:"servers"`
			} `json:"http"`
		} `json:"apps"`
	}
	if err := json.Unmarshal([]byte(got.Config), &full); err != nil || len(full.Apps.HTTP.Servers["keelson"].Listen) == 0 || len(full.Apps.HTTP.Servers["keelson"].Routes) != len(inspectRoutes) {
		t.Errorf("config must be the whole document Apply loads: %v %q", err, got.Config)
	}

	serving = caddyRoutes(config.Proxy{}, []Route{{App: "web", Hosts: []string{"example.com"}, Upstream: "127.0.0.1:3001"}})
	if got := c.Inspect(context.Background(), inspectRoutes); got.InSync == nil || *got.InSync {
		t.Errorf("another upstream must be reported as different: %+v", got)
	}

	status = 404 // Caddy has nothing of ours loaded
	serving = nil
	if got := c.Inspect(context.Background(), inspectRoutes); got.InSync == nil || *got.InSync {
		t.Errorf("an empty Caddy differs from routes that should be there: %+v", got)
	}
	if got := c.Inspect(context.Background(), nil); got.InSync == nil || !*got.InSync {
		t.Errorf("no routes and nothing loaded agree: %+v", got)
	}

	srv.Close()
	if got := c.Inspect(context.Background(), inspectRoutes); got.InSync != nil || got.LiveError == "" {
		t.Errorf("an unreachable admin API is unknown, not different: %+v", got)
	}
}
