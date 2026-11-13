package deploy

import (
	"context"
	"crypto/tls"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/cookiejar"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/0x2u/keelson/agent/internal/config"
	"github.com/0x2u/keelson/agent/internal/docker"
	"github.com/0x2u/keelson/agent/internal/proxy"
	"github.com/0x2u/keelson/agent/internal/store"
)

// sighting is one answer a visitor got.
type sighting struct {
	at      time.Time
	visitor int
	body    string
	status  int
	err     error
}

// crowd is browsers (each with its own cookies) that keep asking one host through a real Caddy, and remember what they were
// answered.
type crowd struct {
	mu   sync.Mutex
	seen []sighting
	stop chan struct{}
	wg   sync.WaitGroup
}

func startCrowd(n int, host string) *crowd {
	c := &crowd{stop: make(chan struct{})}
	for i := range n {
		jar, _ := cookiejar.New(nil)
		client := &http.Client{Jar: jar, Timeout: 5 * time.Second, Transport: &http.Transport{
			DialContext: func(ctx context.Context, network, _ string) (net.Conn, error) {
				return (&net.Dialer{}).DialContext(ctx, network, "127.0.0.1:443")
			},
			TLSClientConfig: &tls.Config{InsecureSkipVerify: true},
		}}
		c.wg.Add(1)
		go func() {
			defer c.wg.Done()
			for {
				select {
				case <-c.stop:
					return
				case <-time.After(150 * time.Millisecond):
				}
				s := sighting{at: time.Now(), visitor: i}
				resp, err := client.Get("https://" + host + "/")
				if err != nil {
					s.err = err
				} else {
					b, _ := io.ReadAll(resp.Body)
					resp.Body.Close()
					s.body, s.status = strings.TrimSpace(string(b)), resp.StatusCode
				}
				c.mu.Lock()
				c.seen = append(c.seen, s)
				c.mu.Unlock()
			}
		}()
	}
	return c
}

func (c *crowd) end() {
	close(c.stop)
	c.wg.Wait()
}

// between returns, for the visitors who asked from..to, how many were answered body at least once, and how many requests did
// not get a 200.
func (c *crowd) between(from, to time.Time, body string) (visitors, notOK int) {
	c.mu.Lock()
	defer c.mu.Unlock()
	got := map[int]bool{}
	for _, s := range c.seen {
		if s.at.Before(from) || s.at.After(to) {
			continue
		}
		if s.err != nil || s.status != 200 {
			notOK++
		} else if s.body == body {
			got[s.visitor] = true
		}
	}
	return len(got), notOK
}

// lastAnswers is what each visitor was last answered, among the n last requests it made.
func (c *crowd) lastAnswers(n int) map[string]int {
	c.mu.Lock()
	defer c.mu.Unlock()
	per := map[int][]sighting{}
	for _, s := range c.seen {
		per[s.visitor] = append(per[s.visitor], s)
	}
	out := map[string]int{}
	for _, list := range per {
		for _, s := range list[max(0, len(list)-n):] {
			out[fmt.Sprintf("%d %s", s.status, s.body)]++
		}
	}
	return out
}

// TestRealCanaryOnARealEngineAndARealCaddy deploys a version of nginx to 20% then 60% of the visitors of a site, with fifty
// browsers asking it all along, and then a version that breaks once it has its first visitors. It checks that the share of
// each step is the one asked, that no visitor is ever refused while the version is good, that the reconciler (running every
// second) leaves the share alone, and that the broken version is taken back by everyone. It needs Docker, the images
// nginx:alpine and caddy:2-alpine and free ports 80, 443 and 2019, and only runs when KEELSON_DOCKER_TEST and
// KEELSON_CADDY_TEST are set.
func TestRealCanaryOnARealEngineAndARealCaddy(t *testing.T) {
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

	caddy := "kv-canary-caddy-" + sfx
	dk("run", "-d", "--name", caddy, "--network", "host", "caddy:2-alpine")
	t.Cleanup(func() { exec.Command("docker", "rm", "-f", caddy).Run() })
	waitFor(t, 30*time.Second, "the Caddy admin API", func() bool {
		resp, err := http.Get(config.DefaultProxyAdmin + "/config/")
		if err == nil {
			resp.Body.Close()
		}
		return err == nil
	})

	// Three versions of the site, told apart by what the home page says.
	repo := "keelson-local/canary-" + sfx
	name := "canary-web-" + sfx
	// A version is built right before its deployment: the agent removes the images of its repository that were never
	// deployed once a deployment succeeds, as it should.
	buildVersion := func(v string) {
		dir := t.TempDir()
		if err := os.WriteFile(filepath.Join(dir, "index.html"), []byte(v), 0o644); err != nil {
			t.Fatal(err)
		}
		id := dk("create", "nginx:alpine")
		dk("cp", filepath.Join(dir, "index.html"), id+":/usr/share/nginx/html/index.html")
		dk("commit", id, repo+":"+v)
		dk("rm", id)
	}
	t.Cleanup(func() {
		if ids, _ := exec.Command("docker", "ps", "-aq", "--filter", "name="+name).Output(); len(ids) > 0 {
			exec.Command("docker", append([]string{"rm", "-f"}, strings.Fields(string(ids))...)...).Run()
		}
		exec.Command("docker", "rmi", repo+":v1", repo+":v2", repo+":v3").Run()
	})

	const host = "canary.kv-test.test"
	cfg, issues := config.Parse([]byte(fmt.Sprintf(`proxy: {tls: internal}
apps:
  - name: %s
    image: %s
    domains: [%s]
    port: 80
    health_path: /
    stop_timeout: 2s
    stable_after: 1s
    drain: 1s
    soak: 3s
    canary: {steps: [20, 60], hold: 10s}
`, name, repo, host)))
	if cfg == nil {
		t.Fatalf("%+v", issues)
	}
	st, err := store.Open(filepath.Join(t.TempDir(), "agent.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	d := New(docker.NewAdmin("/var/run/docker.sock"), st, cfg, proxy.New(*cfg.Proxy), slog.New(slog.NewTextHandler(io.Discard, nil)))
	d.PollEvery = 200 * time.Millisecond
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go d.RunReconciler(ctx, time.Second) // it runs all along: it must leave the share of a canary alone

	run := func(tag string, during func(id string)) (store.Deployment, []store.Event) {
		t.Helper()
		buildVersion(tag)
		if err := st.RecordImport(context.Background(), name, repo+":"+tag, time.Now()); err != nil {
			t.Fatal(err)
		}
		id, done, err := d.Start(context.Background(), name, Target{Tag: tag}, "api")
		if err != nil {
			t.Fatalf("Start(%s): %v", tag, err)
		}
		if during != nil {
			go during(id)
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
		return dep, evs
	}
	eventTime := func(evs []store.Event, prefix string) time.Time {
		for _, e := range evs {
			if strings.HasPrefix(e.Message, prefix) {
				return e.Time
			}
		}
		t.Fatalf("no event starts with %q", prefix)
		return time.Time{}
	}
	show := func(evs []store.Event) string {
		var b strings.Builder
		for _, e := range evs {
			fmt.Fprintf(&b, "%s %s\n", e.Level, e.Message)
		}
		return b.String()
	}

	// v1: nothing serves yet, so there is nobody to share with.
	dep, evs := run("v1", nil)
	if dep.Status != store.StatusSucceeded || !strings.Contains(show(evs), "the canary is skipped") {
		t.Fatalf("the first version goes live at once: %s: %s\n%s", dep.Status, dep.Error, show(evs))
	}
	waitFor(t, 60*time.Second, "Caddy to serve v1 (its certificate takes a moment)", func() bool {
		c := startCrowd(1, host)
		time.Sleep(600 * time.Millisecond)
		c.end()
		a := c.lastAnswers(1)
		return a["200 v1"] == 1
	})

	browsers := startCrowd(50, host)
	t.Cleanup(func() {
		select {
		case <-browsers.stop:
		default:
			browsers.end()
		}
	})
	time.Sleep(2 * time.Second)

	// v2: a good version, taken by 20% then 60% of fifty visitors, then by all of them.
	dep, evs = run("v2", nil)
	if dep.Status != store.StatusSucceeded {
		t.Fatalf("a good version goes through the canary: %s: %s\n%s", dep.Status, dep.Error, show(evs))
	}
	step1, step2, all := eventTime(evs, "canary 20%: 20% of the visitors"), eventTime(evs, "canary 60%: 60% of the visitors"), eventTime(evs, "the new version held at every step")
	settle := 1500 * time.Millisecond // the visitors who were on a cookie of the step before are drawn again at their next request
	n1, bad1 := browsers.between(step1.Add(settle), step2, "v2")
	n2, bad2 := browsers.between(step2.Add(settle), all, "v2")
	t.Logf("fifty visitors: %d reached v2 at 20%%, %d at 60%%", n1, n2)
	if n1 < 5 || n1 > 15 {
		t.Errorf("20%% of 50 visitors is 10, %d reached the new version", n1)
	}
	if n2 < 24 || n2 > 36 {
		t.Errorf("60%% of 50 visitors is 30, %d reached the new version", n2)
	}
	if _, notOK := browsers.between(step1.Add(-time.Second), time.Now(), "v2"); notOK != 0 || bad1+bad2 != 0 {
		t.Errorf("a good version never refuses a visitor, not during the share and not at the switch: %d requests failed", notOK)
	}
	time.Sleep(2 * time.Second)
	if got := browsers.lastAnswers(3); len(got) != 1 || got["200 v2"] != 150 {
		t.Errorf("once the new version took everything every visitor is on it: %v", got)
	}

	// v3: a version that breaks as soon as it has visitors. Its home page vanishes at the first step.
	dep, evs = run("v3", func(id string) {
		waitFor(t, time.Minute, "the first step of v3", func() bool {
			evs, _ := st.Events(context.Background(), id, 0)
			for _, e := range evs {
				if strings.HasPrefix(e.Message, "canary 20%: 20% of the visitors") {
					return true
				}
			}
			return false
		})
		exec.Command("docker", "exec", name+"-"+id, "rm", "/usr/share/nginx/html/index.html").Run()
	})
	if dep.Status != store.StatusRolledBack || !strings.Contains(dep.Error, "the canary failed") || !strings.Contains(dep.Error, "canary 20%") {
		t.Fatalf("a version that breaks at its first step is rolled back there: %s: %s\n%s", dep.Status, dep.Error, show(evs))
	}
	if serving, _ := st.AppState(context.Background(), name); serving.Ref != repo+":v2" {
		t.Errorf("v2 must still be what serves: %+v", serving)
	}
	if strings.Contains(show(evs), "canary 60%") {
		t.Errorf("the second step must never have started:\n%s", show(evs))
	}
	time.Sleep(2 * time.Second)
	browsers.end()
	if got := browsers.lastAnswers(3); len(got) != 1 || got["200 v2"] != 150 {
		t.Errorf("after the rollback every visitor is back on v2: %v", got)
	}
}
