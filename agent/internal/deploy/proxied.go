package deploy

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"reflect"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/0x2u/keelson/agent/internal/config"
	"github.com/0x2u/keelson/agent/internal/docker"
	"github.com/0x2u/keelson/agent/internal/proxy"
	"github.com/0x2u/keelson/agent/internal/store"
)

// executeProxied deploys a blue/green app. The new container starts beside the
// old one and has to become healthy while the old one keeps serving; only
// then does the proxy switch, and only after the switch is the old container
// stopped. A failure anywhere before the switch removes the new container and
// leaves the old version serving, untouched.
func (d *Deployer) executeProxied(ctx context.Context, id string, a config.App, ref string, spec docker.ContainerSpec) (string, error) {
	old, hadOld, err := d.servingState(ctx, id, a)
	if err != nil {
		return store.StatusFailed, err
	}
	if hadOld {
		if err := d.store.SetPreviousRef(ctx, id, old.Ref); err != nil {
			return store.StatusFailed, err
		}
	}

	name := spec.Name
	fail := func(cause error) (string, error) {
		d.event(id, "error", "new container failed: %v", cause)
		d.recordOutput(id, name) // before the container goes: its output is the cause
		if err := d.eng.Remove(ctx, name); err != nil && !docker.IsNotFound(err) {
			d.event(id, "warn", "could not remove failed container %s: %v", name, err)
		}
		if hadOld {
			d.event(id, "info", "the previous version (%s) is still serving", old.Ref)
		}
		return store.StatusFailed, cause
	}

	// On the host network the agent picks the port: the one the old container
	// does not use, so both can run at once.
	port := 0
	if len(a.HostPorts) > 0 {
		port = pickHostPort(a.HostPorts, old.HostPort, hadOld)
		spec.Env = withEnv(spec.Env, a.PortEnv, strconv.Itoa(port))
		d.event(id, "info", "%s will listen on port %d (%s)", name, port, a.PortEnv)
	}

	if err := d.startNew(ctx, id, a, spec); err != nil {
		return fail(err)
	}
	if port == 0 { // a container with its own network: the engine chose the host port
		det, err := d.eng.Inspect(ctx, name)
		if err != nil {
			return fail(err)
		}
		if port = hostPort(det, a.ContainerPort); port == 0 {
			return fail(fmt.Errorf("container port %d is not published on the host", a.ContainerPort))
		}
	}
	if a.HealthPath != "" {
		if err := d.probeHTTP(ctx, a, port); err != nil {
			return fail(err)
		}
		d.event(id, "info", "http://127.0.0.1:%d%s answers", port, a.HealthPath)
	}

	d.event(id, "info", "switching traffic to 127.0.0.1:%d", port)
	// From the switch until the soak is over the app is being replaced: it is not judged by the watcher (see BeginSwap).
	d.BeginSwap(a.Name)
	defer d.EndSwap(a.Name)
	if err := d.switchTraffic(ctx, store.AppState{App: a.Name, Container: name, HostPort: port, Ref: ref}); err != nil {
		return fail(fmt.Errorf("switch traffic: %w", err))
	}
	d.event(id, "info", "traffic now goes to the new version")

	if hadOld {
		d.drain(ctx, id, a)
	}
	// The previous version is still running: if the new one fails now, traffic goes back to it.
	if a.SoakFor() > 0 {
		d.phase(id, store.PhaseSoak)
		if err := d.soak(ctx, id, a, name, port); err != nil {
			return d.undoSwitch(ctx, id, a, name, hadOld, old, err)
		}
	} else {
		d.skipPhase(id, store.PhaseSoak)
	}
	d.phase(id, store.PhaseLive)
	if hadOld {
		d.event(id, "info", "stopping previous container %s (%s)", old.Container, old.Ref)
		if err := d.eng.Stop(ctx, old.Container, int(a.Stop().Seconds())); err != nil && !docker.IsNotFound(err) {
			d.event(id, "warn", "could not stop %s: %v", old.Container, err)
		}
		if err := d.eng.Remove(ctx, old.Container); err != nil && !docker.IsNotFound(err) {
			d.event(id, "warn", "could not remove %s: %v", old.Container, err)
		}
	}
	return store.StatusSucceeded, nil
}

// undoSwitch is what a failure during the soak does. With a previous version still running, traffic goes back to it
// through the same proxy-and-state path as the forward switch, the new container is removed (its last output kept as
// events), and the deployment ends rolled back. Without one there is nothing to go back to: the new container stays and
// the deployment is reported as failed, so that nobody reads "succeeded" for a version that crashed.
func (d *Deployer) undoSwitch(ctx context.Context, id string, a config.App, name string, hadOld bool, old store.AppState, cause error) (string, error) {
	d.event(id, "error", "the new version failed during the soak: %v", cause)
	d.recordOutput(id, name) // before the container goes: its output is the cause
	if !hadOld {
		d.event(id, "warn", "nothing was serving before this version, so there is no previous version to go back to: %s stays", name)
		return store.StatusFailed, fmt.Errorf("the new version failed during the soak and nothing was serving before it: %w", cause)
	}
	cctx, cancel := cleanupContext(ctx)
	defer cancel()
	if det, err := d.eng.Inspect(cctx, old.Container); err != nil || !det.State.Running {
		d.event(id, "error", "the previous version (%s) is not running any more: traffic cannot go back to it", old.Ref)
		return store.StatusRollbackFailed, fmt.Errorf("the new version failed during the soak (%v) and the previous one is not running", cause)
	}
	d.event(id, "warn", "switching traffic back to the previous version (%s)", old.Ref)
	if err := d.switchTraffic(cctx, old); err != nil {
		d.event(id, "error", "could not switch traffic back: %v", err)
		return store.StatusRollbackFailed, fmt.Errorf("the new version failed during the soak (%v) and traffic could not go back: %w", cause, err)
	}
	d.event(id, "info", "traffic goes to the previous version again")
	if err := d.eng.Stop(cctx, name, int(a.Stop().Seconds())); err != nil && !docker.IsNotFound(err) {
		d.event(id, "warn", "could not stop %s: %v", name, err)
	}
	if err := d.eng.Remove(cctx, name); err != nil && !docker.IsNotFound(err) {
		d.event(id, "warn", "could not remove %s: %v", name, err)
	}
	return store.StatusRolledBack, fmt.Errorf("the new version failed during the soak: %w", cause)
}

// servingState returns what currently serves the app. Normally that is
// app_state. On the very first blue/green deployment of an app that already
// runs, as a container named after the app (typically left by docker compose),
// that container is adopted as the version to replace: it keeps serving until
// the switch and is stopped afterwards.
func (d *Deployer) servingState(ctx context.Context, id string, a config.App) (store.AppState, bool, error) {
	st, err := d.store.AppState(ctx, a.Name)
	if err == nil {
		return st, true, nil
	}
	if !errors.Is(err, store.ErrNotFound) {
		return store.AppState{}, false, err
	}
	det, err := d.eng.Inspect(ctx, a.Name)
	if docker.IsNotFound(err) {
		return store.AppState{}, false, nil
	}
	if err != nil {
		return store.AppState{}, false, err
	}
	if !det.State.Running {
		d.event(id, "warn", "container %s exists but is not running: leaving it alone", a.Name)
		return store.AppState{}, false, nil
	}
	port := 0
	if len(a.HostPorts) > 0 {
		port = envPort(det.Env, a.PortEnv)
	} else {
		port = hostPort(det, a.ContainerPort)
	}
	d.event(id, "info", "adopting the running container %s (%s) as the version to replace", a.Name, det.Image)
	return store.AppState{App: a.Name, Container: a.Name, HostPort: port, Ref: det.Image}, true, nil
}

// pickHostPort returns the port of the pair that the current container does
// not use.
func pickHostPort(ports []int, current int, hasCurrent bool) int {
	if hasCurrent && current == ports[0] {
		return ports[1]
	}
	return ports[0]
}

// withEnv sets key=value, replacing any earlier entry for key.
func withEnv(env []string, key, value string) []string {
	out := make([]string, 0, len(env)+1)
	for _, e := range env {
		if !strings.HasPrefix(e, key+"=") {
			out = append(out, e)
		}
	}
	return append(out, key+"="+value)
}

// envPort reads a port out of a container's KEY=VALUE environment, 0 if absent.
func envPort(env []string, key string) int {
	for _, e := range env {
		if v, ok := strings.CutPrefix(e, key+"="); ok {
			n, err := strconv.Atoi(v)
			if err == nil && n > 0 && n < 65536 {
				return n
			}
		}
	}
	return 0
}

func hostPort(det *docker.Detail, containerPort int) int {
	for _, p := range det.Ports {
		if int(p.PrivatePort) == containerPort && p.Type == "tcp" && p.PublicPort != 0 {
			return int(p.PublicPort)
		}
	}
	return 0
}

// probeHTTP waits until GET http://127.0.0.1:<port><health_path> answers 2xx.
// It checks the port the new container really listens on, which an image
// HEALTHCHECK with a fixed port cannot.
func (d *Deployer) probeHTTP(ctx context.Context, a config.App, port int) error {
	url := fmt.Sprintf("http://127.0.0.1:%d%s", port, a.HealthPath)
	deadline := d.now().Add(a.HealthWait())
	var last error
	for {
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
		if err != nil {
			return err
		}
		resp, err := d.http.Do(req)
		if err == nil {
			_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 1<<16))
			resp.Body.Close()
			if resp.StatusCode/100 == 2 {
				return nil
			}
			err = fmt.Errorf("answered %d", resp.StatusCode)
		}
		last = err
		if !d.now().Before(deadline) {
			return fmt.Errorf("health check %s: %w", url, last)
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(d.PollEvery):
		}
	}
}

// switchTraffic points the proxy at st's container and records it in
// app_state, as one step under proxyMu. If recording fails the previous routes
// are restored, so the proxy never serves a container the state does not know.
func (d *Deployer) switchTraffic(ctx context.Context, st store.AppState) error {
	d.proxyMu.Lock()
	defer d.proxyMu.Unlock()

	routes, err := d.routesFromState(ctx, &st)
	if err != nil {
		return err
	}
	if err := d.proxyDriver().Apply(ctx, routes); err != nil {
		return err
	}
	d.applied, d.appliedSet = routes, true

	if err := d.store.SetAppState(ctx, st, d.now()); err != nil {
		if back, rerr := d.routesFromState(ctx, nil); rerr == nil {
			if aerr := d.proxyDriver().Apply(ctx, back); aerr == nil {
				d.applied = back
			}
		}
		return fmt.Errorf("record app state: %w", err)
	}
	return nil
}

// routesFromState builds the routes for every proxied app (preview instances included) that has a state,
// with override replacing the stored state of its app.
func (d *Deployer) routesFromState(ctx context.Context, override *store.AppState) ([]proxy.Route, error) {
	return d.buildRoutes(ctx, override, "")
}

// buildRoutes is routesFromState without the app named skip: a route about to go away is left out before its state is.
func (d *Deployer) buildRoutes(ctx context.Context, override *store.AppState, skip string) ([]proxy.Route, error) {
	states, err := d.store.AppStates(ctx)
	if err != nil {
		return nil, err
	}
	apps, err := d.allApps(ctx)
	if err != nil {
		return nil, err
	}
	byApp := map[string]store.AppState{}
	for _, s := range states {
		byApp[s.App] = s
	}
	if override != nil {
		byApp[override.App] = *override
	}
	var routes []proxy.Route
	for _, a := range apps {
		if a.Name == skip {
			continue
		}
		if st, ok := byApp[a.Name]; ok && a.Proxied() && st.HostPort != 0 {
			routes = append(routes, proxy.Route{App: a.Name, Hosts: a.Domains, Upstream: "127.0.0.1:" + strconv.Itoa(st.HostPort)})
		}
	}
	sortRoutes(routes)
	return d.withPlaceholders(routes, apps), nil
}

// withPlaceholders adds, for each app that declares host ports and has no route, a route to its first port.
//
// nginx: the operator's server block names keelson_<app>: without that upstream nginx cannot load its configuration at
// all (a reload fails, and so would a restart or a boot), and the agent, which tests the file before it reloads, would have
// the configuration invalid for the seconds each attempt takes, again every tick, for as long as the app has no container.
// The upstream is marked down: nginx answers 502 for the app, which is what "nothing serves it" means.
//
// Caddy: without a route a host would answer an empty 200. A route to the first port answers 502 while nothing listens
// there, and is the adoption: the container the app ran as before Keelson (docker compose, on that very port) keeps
// serving through the proxy until the first deployment takes it over, with no gap at the moment the app is declared.
func (d *Deployer) withPlaceholders(routes []proxy.Route, apps []config.App) []proxy.Route {
	if d.config().Proxy == nil {
		return routes
	}
	routed := make(map[string]bool, len(routes))
	for _, r := range routes {
		routed[r.App] = true
	}
	for _, a := range apps {
		if len(a.HostPorts) > 0 && !routed[a.Name] {
			routes = append(routes, proxy.Route{App: a.Name, Hosts: a.Domains, Upstream: "127.0.0.1:" + strconv.Itoa(a.HostPorts[0]), Down: true})
		}
	}
	sortRoutes(routes)
	return routes
}

func sortedRoutes(r []proxy.Route) []proxy.Route {
	sortRoutes(r)
	return r
}

func sortRoutes(r []proxy.Route) {
	sort.Slice(r, func(i, j int) bool { return r[i].App < r[j].App })
}

// Reconcile makes the proxy match reality. Docker may hand a restarted
// container a different random host port, and a container can be gone, so the
// routes are rebuilt from what the engine reports and pushed when they
// changed.
func (d *Deployer) Reconcile(ctx context.Context) error {
	if d.proxyDriver() == nil {
		return nil
	}
	d.proxyMu.Lock()
	defer d.proxyMu.Unlock()

	states, err := d.store.AppStates(ctx)
	if err != nil {
		return err
	}
	apps, err := d.allApps(ctx)
	if err != nil {
		return err
	}
	byName := make(map[string]config.App, len(apps))
	for _, a := range apps {
		byName[a.Name] = a
	}
	var routes []proxy.Route
	for _, st := range states {
		a, ok := byName[st.App]
		if !ok || !a.Proxied() {
			continue
		}
		det, err := d.eng.Inspect(ctx, st.Container)
		if err != nil {
			if docker.IsNotFound(err) {
				d.log.Warn("proxied container is gone; its domains have no route", "app", a.Name, "container", st.Container)
				continue
			}
			return err
		}
		port := st.HostPort
		if len(a.HostPorts) == 0 {
			port = hostPort(det, a.ContainerPort) // Docker may have given a restarted container another random port
		}
		if !det.State.Running || port == 0 {
			d.log.Warn("proxied container is not serving; its app has no route", "app", a.Name, "container", st.Container)
			continue
		}
		if port != st.HostPort {
			st.HostPort = port
			if err := d.store.SetAppState(ctx, st, d.now()); err != nil {
				return err
			}
		}
		routes = append(routes, proxy.Route{App: a.Name, Hosts: a.Domains, Upstream: "127.0.0.1:" + strconv.Itoa(port)})
	}
	routes = d.withPlaceholders(sortedRoutes(routes), apps)

	if d.appliedSet && reflect.DeepEqual(routes, d.applied) && !d.proxyDrifted(ctx, routes) {
		return nil
	}
	if err := d.proxyDriver().Apply(ctx, routes); err != nil {
		return err
	}
	d.applied, d.appliedSet = routes, true
	d.log.Info("proxy routes updated", "routes", len(routes))
	return nil
}

// proxyDrifted tells whether the proxy itself no longer serves what was applied: Caddy was restarted (it comes back
// with an empty configuration) or somebody changed it. The agent owns the whole Caddy configuration, sites included,
// so it pushes it again. A proxy that cannot be read is not drifted: the next run looks again.
func (d *Deployer) proxyDrifted(ctx context.Context, routes []proxy.Route) bool {
	c, ok := d.proxyDriver().(DriftChecker)
	return ok && c.Drifted(ctx, routes)
}

// RunReconciler calls Reconcile every interval until ctx ends.
func (d *Deployer) RunReconciler(ctx context.Context, every time.Duration) {
	t := time.NewTicker(every)
	defer t.Stop()
	var last string
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			err := d.Reconcile(ctx)
			if ctx.Err() == nil {
				d.logReconcile(&last, err)
			}
		}
	}
}

// logReconcile says a failing reconcile once, not at every tick: a cause that lasts (an app that has no container yet,
// whose upstream nginx cannot find) would otherwise fill the log with the same line every few seconds. A different
// failure is said again, and so is the recovery.
func (d *Deployer) logReconcile(last *string, err error) {
	switch {
	case err == nil && *last != "":
		d.log.Info("proxy reconcile recovered")
		*last = ""
	case err != nil && err.Error() != *last:
		d.log.Warn("proxy reconcile failed (said once while the cause is the same)", "err", err)
		*last = err.Error()
	}
}

// removeOrphans deletes blue/green containers that app_state does not point
// at: new containers whose deployment died before the switch. Only names in
// the blue/green scheme ("<app>-<16 hex>") are touched.
//
// It never deletes the container that serves. If app_state names a container
// that is not there, or has no row for an app that has never been deployed from
// this database, the state is lost or stale (agent.db deleted, recreated after
// corruption, restored from an older copy) while the site still runs: the newest
// running blue/green container is adopted as the serving one, so the next
// reconcile routes to it, and running containers other than it are left alone
// (a later deployment, which then has a state, removes them).
func (d *Deployer) removeOrphans(ctx context.Context) error {
	apps, err := d.allApps(ctx)
	if err != nil {
		return err
	}
	for _, a := range apps {
		if !a.Proxied() {
			continue
		}
		keep := ""
		hasState := false
		if st, err := d.store.AppState(ctx, a.Name); err == nil {
			keep, hasState = st.Container, true
		} else if !errors.Is(err, store.ErrNotFound) {
			return err
		}
		scheme := regexp.MustCompile("^" + regexp.QuoteMeta(a.Name) + "-[a-f0-9]{16}$")
		list, err := d.eng.ListByLabel(ctx, "keelson.app="+a.Name)
		if err != nil {
			return err
		}
		var blueGreen []docker.Container
		for _, c := range list {
			if scheme.MatchString(c.Name) {
				blueGreen = append(blueGreen, c)
			}
		}
		stateLost, err := d.stateLost(ctx, a.Name, hasState, keep, blueGreen)
		if err != nil {
			return err
		}
		adopted := ""
		if stateLost {
			if adopted, err = d.adoptServing(ctx, a, blueGreen); err != nil {
				return err
			}
			if adopted != "" {
				keep = adopted
			}
		}
		for _, c := range blueGreen {
			if c.Name == keep {
				continue
			}
			if stateLost && c.State == "running" {
				d.log.Warn("the state of the app was lost: leaving a running container alone", "app", a.Name, "container", c.Name, "adopted", adopted)
				continue
			}
			d.log.Warn("removing orphaned container", "app", a.Name, "container", c.Name)
			if err := d.eng.Remove(ctx, c.Name); err != nil && !docker.IsNotFound(err) {
				return err
			}
		}
	}
	return nil
}

// stateLost says whether app_state cannot be trusted to name the serving container: it names one that does not exist, or
// it has no row and nothing was ever deployed from this database (a crashed first deployment leaves a deployment row,
// and its container is an orphan to remove; a database that was wiped has neither).
func (d *Deployer) stateLost(ctx context.Context, app string, hasState bool, keep string, blueGreen []docker.Container) (bool, error) {
	if hasState {
		for _, c := range blueGreen {
			if c.Name == keep {
				return false, nil
			}
		}
		return len(blueGreen) > 0, nil
	}
	past, err := d.store.ListDeployments(ctx, app, 1)
	if err != nil {
		return false, err
	}
	return len(past) == 0 && len(blueGreen) > 0, nil
}

// adoptServing records the newest running blue/green container as the one that serves, and returns its name ("" when
// there is none, or its host port cannot be read: nothing is then adopted and nothing is removed that runs).
func (d *Deployer) adoptServing(ctx context.Context, a config.App, blueGreen []docker.Container) (string, error) {
	var newest *docker.Container
	for i := range blueGreen {
		c := &blueGreen[i]
		if c.State == "running" && (newest == nil || c.Created > newest.Created) {
			newest = c
		}
	}
	if newest == nil {
		return "", nil
	}
	det, err := d.eng.Inspect(ctx, newest.Name)
	if err != nil {
		return "", err
	}
	port := 0
	if len(a.HostPorts) > 0 {
		port = envPort(det.Env, a.PortEnv)
	} else {
		port = hostPort(det, a.ContainerPort)
	}
	if port == 0 {
		d.log.Warn("the state of the app was lost and the port of its running container is unknown: nothing adopted", "app", a.Name, "container", newest.Name)
		return "", nil
	}
	st := store.AppState{App: a.Name, Container: newest.Name, HostPort: port, Ref: det.Image}
	if err := d.store.SetAppState(ctx, st, d.now()); err != nil {
		return "", err
	}
	d.log.Warn("the state of the app was lost: adopted its running container as the serving one", "app", a.Name, "container", newest.Name, "ref", det.Image, "port", port)
	return newest.Name, nil
}

// recoverProxied resolves a blue/green deployment found running at startup.
// If app_state already points at its container the switch happened and the
// new version is serving; otherwise nothing was switched and the previous
// version (if any) kept serving. Leftover containers are removed afterwards by
// removeOrphans.
func (d *Deployer) recoverProxied(ctx context.Context, dep store.Deployment, a config.App) error {
	st, err := d.store.AppState(ctx, a.Name)
	if err != nil && !errors.Is(err, store.ErrNotFound) {
		return err
	}
	if err == nil && st.Container == a.Name+"-"+dep.ID {
		d.event(dep.ID, "warn", "interrupted by an agent restart after traffic was switched; the new version is serving")
		d.finish(dep.ID, store.StatusSucceeded, nil)
		return nil
	}
	d.event(dep.ID, "warn", "interrupted by an agent restart before traffic was switched; the previous version, if any, kept serving")
	d.finish(dep.ID, store.StatusFailed, errors.New("interrupted: agent restarted"))
	return nil
}

// currentRef returns the image ref an app is serving, or "" if none.
func (d *Deployer) currentRef(ctx context.Context, a config.App) (string, error) {
	if a.Proxied() {
		st, err := d.store.AppState(ctx, a.Name)
		if errors.Is(err, store.ErrNotFound) {
			return "", nil
		}
		return st.Ref, err
	}
	det, err := d.eng.Inspect(ctx, a.Name)
	switch {
	case err == nil:
		return det.Image, nil
	case docker.IsNotFound(err):
		return "", nil
	}
	return "", err
}

// liveContainer returns the container serving an app, or nil if none.
func (d *Deployer) liveContainer(ctx context.Context, a config.App) (*docker.Detail, error) {
	name := a.Name
	if a.Proxied() {
		st, err := d.store.AppState(ctx, a.Name)
		if errors.Is(err, store.ErrNotFound) {
			return nil, nil
		}
		if err != nil {
			return nil, err
		}
		name = st.Container
	}
	det, err := d.eng.Inspect(ctx, name)
	if docker.IsNotFound(err) {
		return nil, nil
	}
	return det, err
}
