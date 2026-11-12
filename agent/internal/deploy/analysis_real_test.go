package deploy

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/0x2u/keelson/agent/internal/config"
	"github.com/0x2u/keelson/agent/internal/docker"
	"github.com/0x2u/keelson/agent/internal/store"
)

// TestRealMetricGateAgainstPrometheus deploys a blue/green app on a real Docker engine whose new version is judged by a real
// Prometheus: the image serves fine (every page answers 200, the soak's pages are happy) but the metric the new version
// exports is bad, and only the gate sees it. It needs Docker, the images nginx:alpine and prom/prometheus, and only runs
// when KEELSON_DOCKER_TEST is set.
func TestRealMetricGateAgainstPrometheus(t *testing.T) {
	if os.Getenv("KEELSON_DOCKER_TEST") == "" {
		t.Skip("set KEELSON_DOCKER_TEST=1 to run against a real Docker engine")
	}
	sfx := fmt.Sprintf("%d-%d", os.Getpid(), time.Now().UnixNano()%1e6)

	// What the app exports: a ratio the test turns bad before the second deployment.
	var ratio atomic.Value
	ratio.Store("0.001")
	exporter := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprintf(w, "# TYPE demo_error_ratio gauge\ndemo_error_ratio %s\n", ratio.Load())
	}))
	l, err := net.Listen("tcp", "0.0.0.0:0")
	if err != nil {
		t.Fatal(err)
	}
	exporter.Listener = l
	exporter.Start()
	t.Cleanup(exporter.Close)
	exporterPort := l.Addr().(*net.TCPAddr).Port

	// A real Prometheus scraping it every second.
	dir := t.TempDir()
	if err := os.Chmod(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	conf := fmt.Sprintf("global: {scrape_interval: 1s}\nscrape_configs:\n  - job_name: demo\n    static_configs: [{targets: ['host.docker.internal:%d']}]\n", exporterPort)
	if err := os.WriteFile(filepath.Join(dir, "prometheus.yml"), []byte(conf), 0o644); err != nil {
		t.Fatal(err)
	}
	promPort := freePort(t)
	prom := "kv-prom-" + sfx
	if out, err := exec.Command("docker", "run", "-d", "--name", prom, "--add-host", "host.docker.internal:host-gateway",
		"-p", fmt.Sprintf("127.0.0.1:%d:9090", promPort), "-v", dir+":/etc/prometheus:ro", "prom/prometheus").CombinedOutput(); err != nil {
		t.Fatalf("docker run prometheus: %v: %s", err, out)
	}
	t.Cleanup(func() { exec.Command("docker", "rm", "-f", prom).Run() })
	address := fmt.Sprintf("http://127.0.0.1:%d", promPort)
	waitFor(t, 60*time.Second, "Prometheus to have scraped the exporter", func() bool {
		v, err := (&Deployer{prom: &http.Client{}}).queryPrometheus(context.Background(), address, "demo_error_ratio")
		return err == nil && len(v) == 1
	})

	// The app: two tags of nginx, behind a proxy stand-in, with the gate in its soak.
	repo := "keelson-local/gate-" + sfx
	for _, tag := range []string{"v1", "v2"} {
		if out, err := exec.Command("docker", "tag", "nginx:alpine", repo+":"+tag).CombinedOutput(); err != nil {
			t.Fatalf("docker tag: %v: %s", err, out)
		}
	}
	name := "gate-web-" + sfx
	t.Cleanup(func() {
		// blue/green containers carry a suffix of their own: remove everything that starts with the app's name
		if ids, _ := exec.Command("docker", "ps", "-aq", "--filter", "name="+name).Output(); len(ids) > 0 {
			exec.Command("docker", append([]string{"rm", "-f"}, strings.Fields(string(ids))...)...).Run()
		}
		exec.Command("docker", "rmi", repo+":v1", repo+":v2").Run()
	})
	cfg, issues := config.Parse([]byte(fmt.Sprintf(`proxy: {}
apps:
  - name: %s
    image: %s
    domains: [gate.example.com]
    port: 80
    health_path: /
    stop_timeout: 2s
    stable_after: 1s
    drain: 0s
    soak: 8s
    analysis:
      address: %s
      metrics:
        - name: error-ratio
          query: max(demo_error_ratio)
          max: 0.05
          interval: 2s
          failure_limit: 2
          no_data: fail
`, name, repo, address)))
	if cfg == nil {
		t.Fatalf("%+v", issues)
	}
	st, err := store.Open(filepath.Join(t.TempDir(), "agent.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	for _, tag := range []string{"v1", "v2"} {
		if err := st.RecordImport(context.Background(), name, repo+":"+tag, time.Now()); err != nil {
			t.Fatal(err)
		}
	}
	d := New(docker.NewAdmin("/var/run/docker.sock"), st, cfg, &fakeProxy{}, slog.New(slog.NewTextHandler(io.Discard, nil)))
	d.PollEvery = 200 * time.Millisecond

	run := func(tag string) (store.Deployment, string) {
		t.Helper()
		id, done, err := d.Start(context.Background(), name, Target{Tag: tag}, "api")
		if err != nil {
			t.Fatalf("Start(%s): %v", tag, err)
		}
		select {
		case <-done:
		case <-time.After(3 * time.Minute):
			t.Fatalf("deployment of %s did not end", tag)
		}
		dep, err := st.Deployment(context.Background(), id)
		if err != nil {
			t.Fatal(err)
		}
		evs, _ := st.Events(context.Background(), id, 0)
		var log strings.Builder
		for _, e := range evs {
			fmt.Fprintf(&log, "%s %s\n", e.Level, e.Message)
		}
		return dep, log.String()
	}

	dep, events := run("v1")
	if dep.Status != store.StatusSucceeded {
		t.Fatalf("a version whose metric holds goes live: %s: %s\n%s", dep.Status, dep.Error, events)
	}
	if !strings.Contains(events, "metric error-ratio: 0.001, within at most 0.05") {
		t.Errorf("the gate must have judged the first version:\n%s", events)
	}
	serving, _ := st.AppState(context.Background(), name)

	ratio.Store("0.4")
	time.Sleep(3 * time.Second) // a scrape or two, so that Prometheus has the bad value
	dep, events = run("v2")
	if dep.Status != store.StatusRolledBack || !strings.Contains(dep.Error, "metric error-ratio: 0.4, above the maximum 0.05") {
		t.Fatalf("a metric out of bounds rolls the deployment back: %s: %s\n%s", dep.Status, dep.Error, events)
	}
	if got, _ := st.AppState(context.Background(), name); got.Container != serving.Container || got.Ref != serving.Ref {
		t.Errorf("the previous version must serve again: %+v, was %+v", got, serving)
	}
}

func freePort(t *testing.T) int {
	t.Helper()
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()
	return l.Addr().(*net.TCPAddr).Port
}

func waitFor(t *testing.T, limit time.Duration, what string, ok func() bool) {
	t.Helper()
	for deadline := time.Now().Add(limit); time.Now().Before(deadline); time.Sleep(500 * time.Millisecond) {
		if ok() {
			return
		}
	}
	t.Fatalf("timed out waiting for %s", what)
}
