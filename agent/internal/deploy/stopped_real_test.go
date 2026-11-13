package deploy

import (
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/0x2u/keelson/agent/internal/config"
	"github.com/0x2u/keelson/agent/internal/confmgr"
	"github.com/0x2u/keelson/agent/internal/docker"
	"github.com/0x2u/keelson/agent/internal/proxy"
	"github.com/0x2u/keelson/agent/internal/store"
)

// TestRealStoppedAppOnARealEngineAndARealCaddy stops an app the way the dashboard does (the apps file gets enabled: false
// through the configuration manager, whose reload reaches the deployer) and starts it again (the key goes, then the
// container is started as the API does). It checks, against a real Docker engine and a real Caddy with the reconciler
// running every second, that the container stops by itself and is kept, that the host answers 503 (and that Caddy
// reads back what the agent pushed: no drift), that a deployment is refused with the exported error, that nothing starts
// the container by itself when the app is enabled again, and that the host serves again once the container is started. It
// needs Docker, the images nginx:alpine and caddy:2-alpine and free ports 80, 443 and 2019, and only runs when
// KEELSON_DOCKER_TEST and KEELSON_CADDY_TEST are set.
func TestRealStoppedAppOnARealEngineAndARealCaddy(t *testing.T) {
	if os.Getenv("KEELSON_DOCKER_TEST") == "" || os.Getenv("KEELSON_CADDY_TEST") == "" {
		t.Skip("set KEELSON_DOCKER_TEST=1 and KEELSON_CADDY_TEST=1 to run against a real Docker engine and a real Caddy")
	}
	sfx := fmt.Sprintf("%d-%d", os.Getpid(), time.Now().UnixNano()%1e6)
	dk := func(args ...string) string {
		t.Helper()
		out, err := exec.Command("docker", args...).CombinedOutput()
		if err != nil {
			t.Fatalf("docker %s: %v: %s", strings.Join(args, " "), err, out)
		}
		return strings.TrimSpace(string(out))
	}

	caddy := "kv-stopped-caddy-" + sfx
	dk("run", "-d", "--name", caddy, "--network", "host", "caddy:2-alpine")
	t.Cleanup(func() { exec.Command("docker", "rm", "-f", caddy).Run() })
	waitFor(t, 30*time.Second, "the Caddy admin API", func() bool {
		resp, err := http.Get(config.DefaultProxyAdmin + "/config/")
		if err == nil {
			resp.Body.Close()
		}
		return err == nil
	})

	repo := "keelson-local/stopped-" + sfx
	name := "stopped-web-" + sfx
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "index.html"), []byte("v1"), 0o644); err != nil {
		t.Fatal(err)
	}
	id := dk("create", "nginx:alpine")
	dk("cp", filepath.Join(dir, "index.html"), id+":/usr/share/nginx/html/index.html")
	dk("commit", id, repo+":v1")
	dk("rm", id)
	t.Cleanup(func() {
		if ids, _ := exec.Command("docker", "ps", "-aq", "--filter", "name="+name).Output(); len(ids) > 0 {
			exec.Command("docker", append([]string{"rm", "-f"}, strings.Fields(string(ids))...)...).Run()
		}
		exec.Command("docker", "rmi", repo+":v1", repo+":v2").Run()
	})

	const host = "stopped.kv-test.test"
	apps := fmt.Sprintf(`proxy: {tls: internal}
apps:
  - name: %s
    image: %s
    domains: [%s]
    port: 80
    health_path: /
    stop_timeout: 2s
    stable_after: 1s
    drain: 0s
    soak: 0s
`, name, repo, host)
	appsFile := filepath.Join(t.TempDir(), "apps.yaml")
	if err := os.WriteFile(appsFile, []byte(apps), 0o600); err != nil {
		t.Fatal(err)
	}
	cfg, err := config.Load(appsFile)
	if err != nil {
		t.Fatal(err)
	}
	st, err := store.Open(filepath.Join(t.TempDir(), "agent.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	d := New(docker.NewAdmin("/var/run/docker.sock"), st, cfg, proxy.New(*cfg.Proxy), log)
	d.PollEvery = 200 * time.Millisecond
	mgr, err := confmgr.New(appsFile, st, cfg, log, d)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go d.RunReconciler(ctx, time.Second)

	// What the host answers, through Caddy on :443.
	client := &http.Client{Timeout: 5 * time.Second, Transport: &http.Transport{
		DisableKeepAlives: true,
		DialContext: func(ctx context.Context, network, _ string) (net.Conn, error) {
			return (&net.Dialer{}).DialContext(ctx, network, "127.0.0.1:443")
		},
		TLSClientConfig: &tls.Config{InsecureSkipVerify: true},
	}}
	ask := func() (int, string) {
		resp, err := client.Get("https://" + host + "/")
		if err != nil {
			return 0, err.Error()
		}
		defer resp.Body.Close()
		b, _ := io.ReadAll(resp.Body)
		return resp.StatusCode, strings.TrimSpace(string(b))
	}
	answers := func(status int, body string) func() bool {
		return func() bool { s, b := ask(); return s == status && b == body }
	}
	running := func(container string) bool {
		out, err := exec.Command("docker", "inspect", "-f", "{{.State.Running}}", container).Output()
		return err == nil && strings.TrimSpace(string(out)) == "true"
	}
	// edit applies a change of the apps file the way the config API does: through the manager, whose reload reaches the
	// deployer.
	edit := func(content string) {
		t.Helper()
		doc, err := mgr.Document()
		if err != nil {
			t.Fatal(err)
		}
		if _, err := mgr.Save([]byte(content), doc.Hash, false, confmgr.Meta{Source: "test", Actor: "test"}); err != nil {
			t.Fatalf("save the apps file: %v", err)
		}
	}

	if err := st.RecordImport(ctx, name, repo+":v1", time.Now()); err != nil {
		t.Fatal(err)
	}
	depID, done, err := d.Start(ctx, name, Target{Tag: "v1"}, "api")
	if err != nil {
		t.Fatal(err)
	}
	<-done
	if dep, _ := st.Deployment(ctx, depID); dep.Status != store.StatusSucceeded {
		t.Fatalf("v1: %s: %s", dep.Status, dep.Error)
	}
	state, err := st.AppState(ctx, name)
	if err != nil {
		t.Fatal(err)
	}
	container := state.Container
	waitFor(t, 60*time.Second, "Caddy to serve v1 (its certificate takes a moment)", answers(200, "v1"))

	// Stop it, through the file.
	edit(strings.Replace(apps, "    port: 80\n", "    enabled: false\n    port: 80\n", 1))
	waitFor(t, 30*time.Second, "the container to be stopped by the agent", func() bool { return !running(container) })
	waitFor(t, 30*time.Second, "the host to answer 503", answers(503, "This app is stopped."))
	dk("inspect", container) // stopped, not removed
	for range 4 {            // the reconciler keeps running: the answer is stable, and Caddy reads back what was pushed
		time.Sleep(time.Second)
		if s, b := ask(); s != 503 || b != "This app is stopped." {
			t.Fatalf("a stopped app keeps answering 503: %d %q", s, b)
		}
	}
	d.proxyMu.Lock()
	drifted := d.proxyDrifted(ctx, d.applied)
	d.proxyMu.Unlock()
	if drifted {
		t.Error("Caddy must read back the stopped route the agent pushed: no drift")
	}

	// A deployment is refused, with the exported error, and creates nothing.
	_, _, err = d.Start(ctx, name, Target{Tag: "v2"}, "api")
	var stopped *StoppedError
	if !errors.As(err, &stopped) || err.Error() != "app "+name+" is stopped (enabled: false): start it first" {
		t.Fatalf("a deployment of a stopped app is refused: %v", err)
	}
	if deps, _ := st.ListDeployments(ctx, name, 10); len(deps) != 1 {
		t.Errorf("a refused deployment leaves no record: %d", len(deps))
	}

	// Something starts the container behind the agent's back: it is stopped again.
	dk("start", container)
	waitFor(t, 30*time.Second, "the container started by hand to be stopped again", func() bool { return !running(container) })

	// Enabled again: the agent starts nothing by itself.
	edit(apps)
	time.Sleep(4 * time.Second)
	if running(container) {
		t.Fatal("the agent must not start an app by itself")
	}
	// The dashboard starts the container as the API does.
	if err := d.StartContainer(ctx, container); err != nil {
		t.Fatal(err)
	}
	waitFor(t, 30*time.Second, "the host to serve v1 again", answers(200, "v1"))
	time.Sleep(3 * time.Second) // and the reconciler leaves it so
	if s, b := ask(); s != 200 || b != "v1" || !running(container) {
		t.Errorf("an enabled app stays up: %d %q running=%v", s, b, running(container))
	}
}
