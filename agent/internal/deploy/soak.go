package deploy

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/0x2u/keelson/agent/internal/config"
	"github.com/0x2u/keelson/agent/internal/docker"
	"github.com/0x2u/keelson/agent/internal/store"
)

// phaseContext bounds one phase of a deployment by its own budget. A phase with no budget (no release step) only gets
// the parent's cancellation.
func phaseContext(ctx context.Context, budget time.Duration) (context.Context, context.CancelFunc) {
	if budget <= 0 {
		return context.WithCancel(ctx)
	}
	return context.WithTimeout(ctx, budget)
}

// restoreContext is the context of putting the previous container back in service: it does not end with the deployment's
// own (which may be the very thing that expired), and allows for the wait for the restored container's health.
func restoreContext(ctx context.Context, a config.App) (context.Context, context.CancelFunc) {
	return context.WithTimeout(context.WithoutCancel(ctx), a.HealthWait()+a.StableWait()+a.Stop()+cleanupTimeout)
}

// fetchImage makes the image of the deployment available on this server: a pull, or, for an image built or imported here,
// the check that it is still on the engine. It has its own budget (pullTimeout).
func (d *Deployer) fetchImage(ctx context.Context, id string, a config.App, ref string, local bool) error {
	ctx, cancel := context.WithTimeout(ctx, pullTimeout)
	defer cancel()
	if local {
		if err := d.checkLocalImage(ctx, ref); err != nil {
			return err
		}
		d.event(id, "info", "using %s from this server (not pulled)", ref)
		return nil
	}
	auth, err := d.registryAuth(a.Image)
	if err != nil {
		return err
	}
	repo, tagOrDigest := splitRef(ref)
	d.event(id, "info", "pulling %s", ref)
	return d.eng.Pull(ctx, repo, tagOrDigest, auth, func(s string) { d.event(id, "info", "%s", s) })
}

// checkAdoption refuses, before anything runs (a migration included), a first deployment that would adopt a running
// container whose port it cannot read. On the host network the agent alternates between the two host_ports and starts the
// new container on the one the old one does not use; without PORT in the old container's environment it would not know
// which that is, pick the first, and collide with it.
func (d *Deployer) checkAdoption(ctx context.Context, a config.App) error {
	if !a.Proxied() || len(a.HostPorts) == 0 {
		return nil
	}
	_, err := d.store.AppState(ctx, a.Name)
	switch {
	case err == nil:
		return nil
	case !errors.Is(err, store.ErrNotFound):
		return err
	}
	det, err := d.eng.Inspect(ctx, a.Name)
	if docker.IsNotFound(err) {
		return nil
	}
	if err != nil {
		return err
	}
	if !det.State.Running || envPort(det.Env, a.PortEnv) != 0 {
		return nil
	}
	return fmt.Errorf("the running container %s does not set %s, so the port it listens on is unknown and the new one could not pick the other of host_ports %v without colliding with it: set %s in its environment and recreate it, or stop it before the first deployment", a.Name, a.PortEnv, a.HostPorts, a.PortEnv)
}

// soak watches the new version for the app's soak after the traffic switched to it. Every round it looks at the container
// (still running, not restarting, not unhealthy) and requests health_path and each verify path on 127.0.0.1:<port>; a
// request that fails is asked once more at once before it counts, because one dropped packet must not undo a good
// deployment. It always makes a round at the start and one at the end. When the app has an analysis, each of its metrics
// is asked of Prometheus every interval (see gateRound) and a metric that is out of bounds failure_limit times in a row
// ends the soak as a failure. A nil return means the new version held.
//
// What the pages show is what 127.0.0.1 sees: the app, not Cloudflare, the proxy or DNS.
func (d *Deployer) soak(ctx context.Context, id string, a config.App, name, ref string, port int) error {
	checks := d.soakChecks(a)
	gates := d.newGates(a, name, ref)
	wait := a.SoakFor()
	d.event(id, "info", "watching the new version for %s (%s)", wait, describeChecks(checks, gates))
	deadline := d.now().Add(wait)
	rounds := 0
	round := func() error {
		if err := d.soakRound(ctx, name, port, checks); err != nil {
			return err
		}
		rounds++
		return d.gateRound(ctx, id, a, gates, false)
	}
	for {
		if err := round(); err != nil {
			return err
		}
		left := deadline.Sub(d.now())
		if left <= 0 {
			break
		}
		step := min(d.soakEvery, left)
		if at := nextGate(gates); !at.IsZero() {
			// wake up when a metric is due, so that its evaluations fall on its interval and the last one on the deadline
			step = max(min(step, at.Sub(d.now())), time.Millisecond)
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(step):
		}
		if !d.now().Before(deadline) {
			if err := round(); err != nil {
				return err
			}
			break
		}
	}
	// A metric whose first evaluation would have come after the end is still judged once.
	if err := d.gateRound(ctx, id, a, gates, true); err != nil {
		return err
	}
	if len(gates) > 0 {
		d.event(id, "info", "metrics: %s", summarizeGates(gates))
	}
	d.event(id, "info", "the new version held for the full %s (%d checks of %s)", wait, rounds, describeChecks(checks, gates))
	return nil
}

// soakCheck is one page requested during the soak.
type soakCheck struct {
	path   string
	status int // 0: any 2xx
}

func (d *Deployer) soakChecks(a config.App) []soakCheck {
	var out []soakCheck
	if a.HealthPath != "" {
		out = append(out, soakCheck{path: a.HealthPath})
	}
	for _, v := range a.Verify {
		if v.Path == a.HealthPath && v.Status == 0 {
			continue
		}
		out = append(out, soakCheck{path: v.Path, status: v.Status})
	}
	return out
}

func describeChecks(checks []soakCheck, gates []*metricGate) string {
	parts := []string{"the container"}
	if len(checks) > 0 {
		paths := make([]string, len(checks))
		for i, c := range checks {
			paths[i] = c.path
		}
		parts = append(parts, strings.Join(paths, ", "))
	}
	if len(gates) > 0 {
		parts = append(parts, "metrics "+describeGates(gates))
	}
	if len(parts) == 1 {
		return "the container only"
	}
	return strings.Join(parts[:1], "") + " and " + strings.Join(parts[1:], " and ")
}

func (d *Deployer) soakRound(ctx context.Context, name string, port int, checks []soakCheck) error {
	det, err := d.eng.Inspect(ctx, name)
	if err != nil {
		return fmt.Errorf("look at %s: %w", name, err)
	}
	switch st := det.State; {
	case st.Restarting:
		return fmt.Errorf("the new container is restarting in a loop (exit code %d)", st.ExitCode)
	case !st.Running:
		return fmt.Errorf("the new container exited with code %d", st.ExitCode)
	case st.Health == "unhealthy":
		return errors.New("the new container reported unhealthy")
	}
	for _, c := range checks {
		err := d.soakRequest(ctx, port, c)
		if err != nil && ctx.Err() == nil {
			err = d.soakRequest(ctx, port, c) // once more before it counts
		}
		if err != nil {
			return err
		}
	}
	return nil
}

func (d *Deployer) soakRequest(ctx context.Context, port int, c soakCheck) error {
	url := fmt.Sprintf("http://127.0.0.1:%d%s", port, c.path)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return err
	}
	resp, err := d.http.Do(req)
	if err != nil {
		return fmt.Errorf("%s: %w", c.path, err)
	}
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 1<<16))
	resp.Body.Close()
	switch {
	case c.status == 0 && resp.StatusCode/100 == 2, c.status != 0 && resp.StatusCode == c.status:
		return nil
	case c.status != 0:
		return fmt.Errorf("%s answered %d, wanted %d", c.path, resp.StatusCode, c.status)
	}
	return fmt.Errorf("%s answered %d", c.path, resp.StatusCode)
}
