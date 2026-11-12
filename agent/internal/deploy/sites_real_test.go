package deploy

import (
	"context"
	"crypto/tls"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/0x2u/keelson/agent/internal/config"
	"github.com/0x2u/keelson/agent/internal/proxy"
)

// TestRealCaddyRestartIsRestoredByTheReconciler kills a real Caddy and checks that the reconciler brings back
// the sites within one run, with no app at all. It needs Docker, caddy:2-alpine and free ports 80, 443 and 2019, and
// only runs when KEELSON_CADDY_TEST is set.
func TestRealCaddyRestartIsRestoredByTheReconciler(t *testing.T) {
	if os.Getenv("KEELSON_CADDY_TEST") == "" {
		t.Skip("set KEELSON_CADDY_TEST=1 to run against a real Caddy container")
	}
	root := t.TempDir()
	if err := os.Chmod(root, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "index.html"), []byte("static home"), 0o644); err != nil {
		t.Fatal(err)
	}
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { io.WriteString(w, "upstream") }))
	defer up.Close()

	name := fmt.Sprintf("kv-caddy-reconcile-%d", os.Getpid())
	if out, err := exec.Command("docker", "run", "-d", "--name", name, "--network", "host", "-v", root+":"+root+":ro", "caddy:2-alpine").CombinedOutput(); err != nil {
		t.Fatalf("docker run: %v: %s", err, out)
	}
	defer exec.Command("docker", "rm", "-f", name).Run()
	waitAdmin := func() {
		for i := 0; i < 100; i++ {
			if resp, err := http.Get(config.DefaultProxyAdmin + "/config/"); err == nil {
				resp.Body.Close()
				return
			}
			time.Sleep(200 * time.Millisecond)
		}
		t.Fatal("admin API did not come up")
	}
	waitAdmin()

	h := newHarness(t)
	h.d.cfg.Store(&config.Config{Proxy: &config.Proxy{}})
	settings := config.Proxy{Type: config.ProxyCaddy, TLS: "internal", Sites: []config.Site{
		{Hosts: []string{"static.kv-reconcile.test"}, Root: root, Index: "index.html", TryFiles: config.DefaultTryFiles},
		{Hosts: []string{"app.kv-reconcile.test"}, Upstream: strings.TrimPrefix(up.URL, "http://")},
	}}
	cfg := *h.d.config()
	cfg.Proxy = &settings
	h.d.cfg.Store(&cfg)
	h.d.pxMu.Lock()
	h.d.proxy = proxy.New(settings)
	h.d.pxMu.Unlock()

	client := &http.Client{Timeout: 5 * time.Second, Transport: &http.Transport{
		DialContext: func(ctx context.Context, n, _ string) (net.Conn, error) {
			return (&net.Dialer{}).DialContext(ctx, n, "127.0.0.1:443")
		},
		TLSClientConfig: &tls.Config{InsecureSkipVerify: true},
	}}
	get := func(host string) (string, error) {
		var last error
		for i := 0; i < 20; i++ {
			resp, err := client.Get("https://" + host + "/")
			if err == nil {
				defer resp.Body.Close()
				b, _ := io.ReadAll(resp.Body)
				return string(b), nil
			}
			last = err
			time.Sleep(250 * time.Millisecond)
		}
		return "", last
	}

	if err := h.d.Reconcile(context.Background()); err != nil {
		t.Fatal(err)
	}
	if body, err := get("static.kv-reconcile.test"); err != nil || body != "static home" {
		t.Fatalf("static site after the first reconcile: %q %v", body, err)
	}
	if body, err := get("app.kv-reconcile.test"); err != nil || body != "upstream" {
		t.Fatalf("upstream site after the first reconcile: %q %v", body, err)
	}

	if out, err := exec.Command("docker", "restart", "-t", "0", name).CombinedOutput(); err != nil {
		t.Fatalf("docker restart: %v: %s", err, out)
	}
	waitAdmin()
	if _, err := client.Get("https://static.kv-reconcile.test/"); err == nil {
		t.Fatal("a restarted Caddy has an empty configuration and must not serve the site")
	}

	if err := h.d.Reconcile(context.Background()); err != nil {
		t.Fatal(err)
	}
	if body, err := get("static.kv-reconcile.test"); err != nil || body != "static home" {
		t.Errorf("static site after the restart and one reconcile: %q %v", body, err)
	}
	if body, err := get("app.kv-reconcile.test"); err != nil || body != "upstream" {
		t.Errorf("upstream site after the restart and one reconcile: %q %v", body, err)
	}
}
