package deploy

import (
	"context"
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
	"github.com/0x2u/keelson/agent/internal/docker"
	"github.com/0x2u/keelson/agent/internal/store"
)

// The tests in this file break a deployment on purpose, against a real Docker engine, and check what still serves.
// They need Docker, the images alpine:3.20 and nginx:alpine, and only run when KEELSON_DOCKER_TEST is set.

// chaosRig is one app, "web", on a real engine: a good image that serves HTTP on its port and a bad one that exits
// at once. Both are local tags (recorded as built here, so nothing is pulled).
type chaosRig struct {
	t      *testing.T
	eng    *docker.Admin
	dbPath string
	app    config.App
	url    string
	good   string
	bad    string
}

func newChaosRig(t *testing.T) *chaosRig {
	t.Helper()
	if os.Getenv("KEELSON_DOCKER_TEST") == "" {
		t.Skip("set KEELSON_DOCKER_TEST=1 to run against a real Docker engine")
	}
	sfx := fmt.Sprintf("%d-%d", os.Getpid(), time.Now().UnixNano()%1e6)
	repo := "keelson-local/chaos-" + sfx
	r := &chaosRig{t: t, eng: docker.NewAdmin("/var/run/docker.sock"), dbPath: filepath.Join(t.TempDir(), "agent.db"), good: repo + ":good", bad: repo + ":bad"}
	r.retag()
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := l.Addr().(*net.TCPAddr).Port
	l.Close()
	r.url = fmt.Sprintf("http://127.0.0.1:%d/", port)
	r.app = config.App{
		Name: "chaos-web-" + sfx, Image: repo, Restart: "no", Publish: []string{fmt.Sprintf("127.0.0.1:%d:80", port)},
		StopTimeout: config.D(2 * time.Second), HealthTimeout: config.D(10 * time.Second), StableAfter: config.D(time.Second),
	}
	t.Cleanup(func() {
		for _, n := range []string{r.app.Name, r.app.Name + prevSuffix} {
			exec.Command("docker", "rm", "-f", n).Run()
		}
		exec.Command("docker", "rmi", r.good, r.bad).Run()
	})
	return r
}

// retag makes both tags exist: a successful deployment prunes the app's other local images, which are the ones the
// next deployment is about to use.
func (r *chaosRig) retag() {
	r.t.Helper()
	for tag, from := range map[string]string{r.good: "nginx:alpine", r.bad: "alpine:3.20"} {
		if out, err := exec.Command("docker", "tag", from, tag).CombinedOutput(); err != nil {
			r.t.Fatalf("docker tag %s %s: %v: %s", from, tag, err, out)
		}
	}
}

// deployer opens the agent's database and returns a Deployer over eng, as a freshly started agent would.
func (r *chaosRig) deployer(eng Engine) (*Deployer, *store.Store) {
	r.t.Helper()
	r.retag()
	st, err := store.Open(r.dbPath)
	if err != nil {
		r.t.Fatal(err)
	}
	r.t.Cleanup(func() { st.Close() })
	for _, ref := range []string{r.good, r.bad} {
		if err := st.RecordImport(context.Background(), r.app.Name, ref, time.Now()); err != nil {
			r.t.Fatal(err)
		}
	}
	d := New(eng, st, &config.Config{Apps: []config.App{r.app}, Proxy: &config.Proxy{}}, nil, slog.New(slog.NewTextHandler(io.Discard, nil)))
	d.PollEvery = 100 * time.Millisecond
	return d, st
}

// deploy runs one deployment to its end and returns its record.
func (r *chaosRig) deploy(d *Deployer, st *store.Store, ref string) store.Deployment {
	r.t.Helper()
	r.retag()
	tag := ref[strings.LastIndex(ref, ":")+1:]
	id, done, err := d.Start(context.Background(), r.app.Name, Target{Tag: tag}, "api")
	if err != nil {
		r.t.Fatalf("Start(%s): %v", tag, err)
	}
	select {
	case <-done:
	case <-time.After(90 * time.Second):
		r.t.Fatalf("deployment of %s did not end", tag)
	}
	dep, err := st.Deployment(context.Background(), id)
	if err != nil {
		r.t.Fatal(err)
	}
	return dep
}

// serves fails the test unless the app answers 200 on its published port and runs ref under its own name.
func (r *chaosRig) serves(ref string) {
	r.t.Helper()
	var last error
	for deadline := time.Now().Add(10 * time.Second); time.Now().Before(deadline); time.Sleep(200 * time.Millisecond) {
		resp, err := http.Get(r.url)
		if err == nil {
			resp.Body.Close()
			if resp.StatusCode == http.StatusOK {
				last = nil
				break
			}
			err = fmt.Errorf("status %d", resp.StatusCode)
		}
		last = err
	}
	if last != nil {
		r.t.Fatalf("the app does not answer on %s: %v", r.url, last)
	}
	det, err := r.eng.Inspect(context.Background(), r.app.Name)
	if err != nil {
		r.t.Fatalf("inspect %s: %v", r.app.Name, err)
	}
	if det.Image != ref || !det.State.Running {
		r.t.Fatalf("%s runs %q (running: %v), want %q running", r.app.Name, det.Image, det.State.Running, ref)
	}
	if _, err := r.eng.Inspect(context.Background(), r.app.Name+prevSuffix); !docker.IsNotFound(err) {
		r.t.Fatalf("%s must not be left behind: %v", r.app.Name+prevSuffix, err)
	}
}

// TestRealABrokenReleaseNeverTakesTheSiteDown deploys an image that exits at once over one that serves, and checks
// that the old version is back and answering, and that the failed deployment says so.
func TestRealABrokenReleaseNeverTakesTheSiteDown(t *testing.T) {
	r := newChaosRig(t)
	d, st := r.deployer(r.eng)

	if dep := r.deploy(d, st, r.good); dep.Status != store.StatusSucceeded {
		t.Fatalf("first deployment: %s (%s)", dep.Status, dep.Error)
	}
	r.serves(r.good)

	dep := r.deploy(d, st, r.bad)
	if dep.Status != store.StatusRolledBack {
		t.Fatalf("a release that exits must end rolled_back, got %s (%s)", dep.Status, dep.Error)
	}
	if dep.PreviousRef != r.good {
		t.Errorf("previous ref %q, want %q", dep.PreviousRef, r.good)
	}
	r.serves(r.good)
}

// crashEngine stands for an agent that dies at one point of a deployment: from then on, a call to the engine blocks
// for good, so the goroutine of the deployment can change nothing more, as if its process had been killed. What it
// had already done to the real engine stays.
type crashEngine struct {
	Engine
	// afterStart is set on the call that must be the last: the first Inspect once the new container was started
	// (the health wait), or the Create of the new container (the swap has begun).
	at      string
	started bool
	hung    chan struct{}
}

func (c *crashEngine) die() {
	select {
	case c.hung <- struct{}{}:
	default:
	}
	select {} // never returns: the process is gone
}

func (c *crashEngine) Create(ctx context.Context, spec docker.ContainerSpec) (string, error) {
	if c.at == "create" {
		c.die()
	}
	return c.Engine.Create(ctx, spec)
}

func (c *crashEngine) Start(ctx context.Context, id string) error {
	err := c.Engine.Start(ctx, id)
	c.started = c.started || err == nil
	return err
}

func (c *crashEngine) Inspect(ctx context.Context, id string) (*docker.Detail, error) {
	if c.at == "health" && c.started {
		c.die()
	}
	return c.Engine.Inspect(ctx, id)
}

// TestRealAgentKilledDuringTheSwapComesBackOnThePreviousVersion kills the agent at the two worst moments of a
// deployment (the old container stopped and renamed, nothing new yet; the new container started and not yet judged)
// and starts a new agent on the same database and engine: it must put the old version back, serving, and close the
// interrupted deployment as rolled back.
func TestRealAgentKilledDuringTheSwapComesBackOnThePreviousVersion(t *testing.T) {
	for _, at := range []string{"create", "health"} {
		t.Run(at, func(t *testing.T) {
			r := newChaosRig(t)
			d, st := r.deployer(r.eng)
			if dep := r.deploy(d, st, r.good); dep.Status != store.StatusSucceeded {
				t.Fatalf("first deployment: %s (%s)", dep.Status, dep.Error)
			}
			r.serves(r.good)

			// The agent that dies: it starts deploying the broken image and is cut off at the chosen point.
			crash := &crashEngine{Engine: r.eng, at: at, hung: make(chan struct{}, 1)}
			dying, dyingStore := r.deployer(crash)
			id, _, err := dying.Start(context.Background(), r.app.Name, Target{Tag: "bad"}, "api")
			if err != nil {
				t.Fatal(err)
			}
			select {
			case <-crash.hung:
			case <-time.After(60 * time.Second):
				t.Fatal("the deployment never reached the point where the agent is killed")
			}
			if dep, err := dyingStore.Deployment(context.Background(), id); err != nil || dep.Status != store.StatusRunning {
				t.Fatalf("the interrupted deployment must still be marked running: %+v %v", dep, err)
			}
			if _, err := r.eng.Inspect(context.Background(), r.app.Name+prevSuffix); err != nil {
				t.Fatalf("the swap must be open (%s exists): %v", r.app.Name+prevSuffix, err)
			}

			// The agent that starts afterwards.
			next, nextStore := r.deployer(r.eng)
			if err := next.Recover(context.Background()); err != nil {
				t.Fatal(err)
			}
			dep, err := nextStore.Deployment(context.Background(), id)
			if err != nil {
				t.Fatal(err)
			}
			if dep.Status != store.StatusRolledBack || !strings.Contains(dep.Error, "interrupted") {
				t.Errorf("the interrupted deployment must end rolled_back as interrupted, got %s (%s)", dep.Status, dep.Error)
			}
			r.serves(r.good)

			// And the new agent deploys again.
			if dep := r.deploy(next, nextStore, r.good); dep.Status != store.StatusSucceeded {
				t.Fatalf("a deployment after the recovery: %s (%s)", dep.Status, dep.Error)
			}
			r.serves(r.good)
		})
	}
}
