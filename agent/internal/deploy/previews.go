package deploy

import (
	"context"
	"errors"
	"fmt"
	"regexp"
	"sort"
	"strconv"
	"time"

	"github.com/0x2u/keelson/agent/internal/build"
	"github.com/0x2u/keelson/agent/internal/config"
	"github.com/0x2u/keelson/agent/internal/docker"
	"github.com/0x2u/keelson/agent/internal/store"
)

// Previews are ephemeral instances of an app, one per pull request, made from the app's previews template. An instance
// is deployed by the same blue/green pipeline as any proxied app, with an App synthesized from the template; it is not
// in the apps file, only in the database, and goes away with its pull request, its TTL, or newer instances (max).

// TriggerPreview is the trigger recorded on the deployments of preview instances.
const TriggerPreview = "preview"

// previewAuditPath prefixes the path of the audit entries the agent writes for what it removes by itself.
const previewAuditPath = "/v1/previews/"

// Errors of the preview operations.
var (
	ErrNoPreview    = errors.New("the app has no previews template")
	ErrInvalidPR    = errors.New("invalid pull request number")
	ErrShuttingDown = errors.New("the agent is shutting down")
)

// BeginShutdown makes the agent refuse to create or remove previews, and to start builds: it is stopping, and what
// such a call starts would be cut short. A build in progress is canceled.
func (d *Deployer) BeginShutdown() {
	d.stopping.Store(true)
	d.buildCancel()
}

// instances synthesizes the apps of the stored preview instances from the templates in force. An instance whose
// template (or parent app) is gone, or whose name a configured app has taken, is left out: nothing routes to it and the
// sweeper removes it.
func (d *Deployer) instances(ctx context.Context) ([]config.App, error) {
	rows, err := d.store.Previews(ctx)
	if err != nil {
		return nil, err
	}
	cfg := d.config()
	var out []config.App
	for _, row := range rows {
		if a, ok := synthesize(cfg, row); ok {
			out = append(out, a)
		}
	}
	return out, nil
}

// synthesize builds the app of an instance row from the configuration in force.
func synthesize(cfg *config.Config, row store.Preview) (config.App, bool) {
	tpl, ok := cfg.Previews(row.App)
	if !ok {
		return config.App{}, false
	}
	parent, ok := cfg.App(row.App)
	if !ok {
		return config.App{}, false
	}
	inst := tpl.Instance(parent, row.PR)
	if _, taken := cfg.App(inst.Name); taken {
		return config.App{}, false
	}
	return inst, true
}

// allApps is every app the agent runs: those of the file, then the preview instances. Everything that has to look
// after what is running (routes, orphans, recovery, image retention) goes through it; only the public listing
// of apps stays with the file.
func (d *Deployer) allApps(ctx context.Context) ([]config.App, error) {
	instances, err := d.instances(ctx)
	if err != nil {
		return nil, err
	}
	cfg := d.config()
	out := make([]config.App, 0, len(cfg.Apps)+len(instances))
	out = append(out, cfg.Apps...)
	return append(out, instances...), nil
}

// lookupApp finds an app of the file or a preview instance by name.
func (d *Deployer) lookupApp(ctx context.Context, name string) (config.App, bool, error) {
	cfg := d.config()
	if a, ok := cfg.App(name); ok {
		return a, true, nil
	}
	if _, _, ok := config.ParsePreviewName(name); !ok {
		return config.App{}, false, nil
	}
	row, err := d.store.Preview(ctx, name)
	if errors.Is(err, store.ErrNotFound) {
		return config.App{}, false, nil
	}
	if err != nil {
		return config.App{}, false, err
	}
	a, ok := synthesize(cfg, row)
	return a, ok, nil
}

// PreviewStatus is one instance as the API lists it.
type PreviewStatus struct {
	Name string `json:"name"`
	App  string `json:"app"`
	PR   int    `json:"pr"`
	// Domain and URL are where the instance is served.
	Domain string `json:"domain"`
	URL    string `json:"url"`
	// Ref is the image reference of the latest deployment requested.
	Ref string `json:"ref"`
	// Status is "deploying", "running" (the latest deployment succeeded) or "failed".
	Status       string    `json:"status"`
	DeploymentID string    `json:"deployment_id"`
	CreatedAt    time.Time `json:"created_at"`
	UpdatedAt    time.Time `json:"updated_at"`
	ExpiresAt    time.Time `json:"expires_at"`
}

// Preview statuses.
const (
	PreviewDeploying = "deploying"
	PreviewRunning   = "running"
	PreviewFailed    = "failed"
)

// previewStatus derives an instance's status from its latest deployment.
func (d *Deployer) previewStatus(ctx context.Context, row store.Preview) (string, error) {
	dep, err := d.store.Deployment(ctx, row.DeploymentID)
	switch {
	case errors.Is(err, store.ErrNotFound): // the row is written just before the deployment: still starting
		return PreviewDeploying, nil
	case err != nil:
		return "", err
	case dep.Status == store.StatusSucceeded:
		return PreviewRunning, nil
	case dep.Status != store.StatusRunning:
		return PreviewFailed, nil
	}
	return PreviewDeploying, nil
}

// Previews lists the instances, the oldest first.
func (d *Deployer) Previews(ctx context.Context) ([]PreviewStatus, error) {
	rows, err := d.store.Previews(ctx)
	if err != nil {
		return nil, err
	}
	cfg := d.config()
	out := make([]PreviewStatus, 0, len(rows))
	for _, row := range rows {
		domain := row.Domain
		if tpl, ok := cfg.Previews(row.App); ok {
			domain = tpl.Host(row.PR) // the template in force: a changed pattern moves the instance at the next reconcile
		}
		s := PreviewStatus{
			Name: row.Name, App: row.App, PR: row.PR, Domain: domain, URL: "https://" + domain, Ref: row.Ref,
			DeploymentID: row.DeploymentID, CreatedAt: row.CreatedAt, UpdatedAt: row.UpdatedAt, ExpiresAt: row.ExpiresAt,
			Status: PreviewDeploying,
		}
		status, err := d.previewStatus(ctx, row)
		if err != nil {
			return nil, err
		}
		s.Status = status
		out = append(out, s)
	}
	return out, nil
}

// PreviewStarted is the answer to a created or redeployed instance.
type PreviewStarted struct {
	DeploymentID string
	Name         string
	URL          string
	// Evicted are the instances removed to stay within the template's max, oldest first.
	Evicted []string
}

// StartPreview creates the instance of app for pull request pr, or redeploys it, with the image at target (a tag: the
// commit CI built). It returns once the deployment is under way; done is closed when it has finished. Creating an
// instance beyond the template's max first removes the oldest ones.
func (d *Deployer) StartPreview(ctx context.Context, app string, pr int, target Target) (PreviewStarted, <-chan struct{}, error) {
	return d.startPreview(ctx, app, pr, target, nil)
}

// StartPreviewBuild is StartPreview for an instance whose image is built here: the commit sha is built from src (the
// parent's build block says how) and tagged "<image>:<sha>", then deployed as the instance, all in one deployment.
func (d *Deployer) StartPreviewBuild(ctx context.Context, app string, pr int, sha string, src build.Source) (PreviewStarted, <-chan struct{}, error) {
	return d.startPreview(ctx, app, pr, Target{Tag: sha}, &src)
}

// startPreview creates or redeploys the instance; with src it builds the image first.
func (d *Deployer) startPreview(ctx context.Context, app string, pr int, target Target, src *build.Source) (PreviewStarted, <-chan struct{}, error) {
	if d.stopping.Load() {
		return PreviewStarted{}, nil, ErrShuttingDown
	}
	if !config.ValidPreviewNumber(pr) {
		return PreviewStarted{}, nil, ErrInvalidPR
	}
	cfg := d.config()
	tpl, ok := cfg.Previews(app)
	parent, parentOK := cfg.App(app)
	if !ok || !parentOK {
		return PreviewStarted{}, nil, ErrNoPreview
	}
	ref, err := target.Ref(parent.Image)
	if err != nil {
		return PreviewStarted{}, nil, err
	}
	inst := tpl.Instance(parent, pr)
	if _, taken := cfg.App(inst.Name); taken {
		return PreviewStarted{}, nil, ErrNoPreview
	}

	var opts launchOpts
	if src != nil {
		job, err := d.newBuildJob(ctx, inst, target.Tag, *src)
		if err != nil {
			return PreviewStarted{}, nil, err
		}
		opts.build = job
	}

	if !d.reserve(inst.Name) {
		return PreviewStarted{}, nil, ErrBusy
	}
	launched := false
	defer func() {
		if !launched {
			d.release(inst.Name)
			opts.abandon()
		}
	}()
	if opts.build != nil {
		release, ok := d.builder.TryAcquire()
		if !ok {
			return PreviewStarted{}, nil, ErrBuildBusy
		}
		opts.build.release = release
	}

	_, err = d.store.Preview(ctx, inst.Name)
	isNew := errors.Is(err, store.ErrNotFound)
	if err != nil && !isNew {
		return PreviewStarted{}, nil, err
	}
	var evicted []string
	if isNew {
		if evicted, err = d.makeRoom(ctx, app, tpl, inst.Name); err != nil {
			return PreviewStarted{}, nil, err
		}
	}

	// The row exists before the deployment runs: the proxy routes are built from the instances in the database.
	now := d.now()
	id := store.NewID()
	row := store.Preview{Name: inst.Name, App: app, PR: pr, Domain: inst.Domains[0], Ref: ref, DeploymentID: id, ExpiresAt: now.Add(tpl.TTLFor())}
	created, err := d.store.UpsertPreview(ctx, row, now)
	if err != nil {
		return PreviewStarted{}, nil, err
	}
	done, err := d.launch(ctx, inst, id, ref, TriggerPreview, opts)
	launched = true // launch released the name itself if it failed
	if err != nil {
		if created {
			if derr := d.store.DeletePreview(context.WithoutCancel(ctx), inst.Name); derr != nil {
				d.log.Error("forget a preview that could not start", "name", inst.Name, "err", derr)
			}
		}
		return PreviewStarted{}, nil, err
	}
	return PreviewStarted{DeploymentID: id, Name: inst.Name, URL: "https://" + inst.Domains[0], Evicted: evicted}, done, nil
}

// makeRoom removes instances of the template's app until one more fits within max: failed ones first, then the least
// recently deployed. An instance whose deployment or removal is running is skipped; when too many of them are busy,
// nothing more is removed and the request is refused as busy.
func (d *Deployer) makeRoom(ctx context.Context, app string, tpl config.Previews, except string) ([]string, error) {
	rows, err := d.store.Previews(ctx)
	if err != nil {
		return nil, err
	}
	var mine []store.Preview
	for _, row := range rows {
		if row.App == app && row.Name != except {
			mine = append(mine, row)
		}
	}
	if mine, err = d.evictionOrder(ctx, mine); err != nil {
		return nil, err
	}
	var evicted []string
	for _, victim := range mine {
		if len(mine)-len(evicted) < tpl.MaxCount() {
			break
		}
		detail := fmt.Sprintf("%s: first to go of %d (max %d), removed to make room for %s", victim.Name, len(mine), tpl.MaxCount(), except)
		switch err := d.removeAudited(ctx, victim, "preview.evict", detail); {
		case err == nil:
			evicted = append(evicted, victim.Name)
		case errors.Is(err, ErrBusy):
		default:
			return evicted, fmt.Errorf("evict %s: %w", victim.Name, err)
		}
	}
	if len(mine)-len(evicted) >= tpl.MaxCount() {
		return evicted, ErrBusy
	}
	return evicted, nil
}

// RemovePreview removes the instance of app for pull request pr completely: containers, route, database row and images.
// Removing what does not exist is not an error. It refuses with ErrBusy while a deployment of the instance runs.
func (d *Deployer) RemovePreview(ctx context.Context, app string, pr int) error {
	if d.stopping.Load() {
		return ErrShuttingDown
	}
	if !config.ValidPreviewNumber(pr) {
		return ErrInvalidPR
	}
	name := config.PreviewName(app, pr)
	if !d.reserve(name) {
		return ErrBusy
	}
	defer d.release(name)
	row, err := d.store.Preview(ctx, name)
	if errors.Is(err, store.ErrNotFound) {
		return nil // only what the agent created under this name is ever touched
	}
	if err != nil {
		return err
	}
	return d.destroyPreview(ctx, row)
}

// evictionOrder sorts instances in the order they are evicted: those whose latest deployment failed first, then the
// least recently deployed (updated_at), so a pull request being redeployed outlives an idle newer one.
func (d *Deployer) evictionOrder(ctx context.Context, rows []store.Preview) ([]store.Preview, error) {
	failed := make(map[string]bool, len(rows))
	for _, row := range rows {
		status, err := d.previewStatus(ctx, row)
		if err != nil {
			return nil, err
		}
		failed[row.Name] = status == PreviewFailed
	}
	out := append([]store.Preview(nil), rows...)
	sort.SliceStable(out, func(i, j int) bool {
		a, b := out[i], out[j]
		if failed[a.Name] != failed[b.Name] {
			return failed[a.Name]
		}
		if !a.UpdatedAt.Equal(b.UpdatedAt) {
			return a.UpdatedAt.Before(b.UpdatedAt)
		}
		if !a.CreatedAt.Equal(b.CreatedAt) {
			return a.CreatedAt.Before(b.CreatedAt)
		}
		return a.Name < b.Name
	})
	return out, nil
}

// dropUnservedPreview removes the instance whose first deployment, id, failed: nothing was ever served, so it must not
// linger or count against the template's max. The deployment record stays for the caller polling it. The caller holds
// the instance's lock.
func (d *Deployer) dropUnservedPreview(ctx context.Context, id, name string) {
	row, err := d.store.Preview(ctx, name)
	if err != nil || row.DeploymentID != id {
		return
	}
	if _, err := d.store.AppState(ctx, name); !errors.Is(err, store.ErrNotFound) {
		return // it serves a version (or the state cannot be read): keep it
	}
	if err := d.destroyPreview(ctx, row); err != nil {
		d.log.Warn("could not remove a preview that never served", "name", name, "err", err)
		return
	}
	d.event(id, "info", "removed %s: its first deployment failed", name)
}

// removeAudited removes an instance the agent decided to remove (eviction, expiry) and records it in the audit log.
func (d *Deployer) removeAudited(ctx context.Context, row store.Preview, action, detail string) error {
	if !d.reserve(row.Name) {
		return ErrBusy
	}
	defer d.release(row.Name)
	if err := d.destroyPreview(ctx, row); err != nil {
		return err
	}
	e := store.AuditEntry{
		At: d.now().UTC(), Actor: "agent", Method: "AGENT", Path: previewAuditPath + row.App + "/" + strconv.Itoa(row.PR),
		Action: action, Status: 200, Detail: detail,
	}
	if err := d.store.AddAudit(context.WithoutCancel(ctx), e); err != nil {
		d.log.Error("record audit entry", "action", action, "err", err)
	}
	return nil
}

// destroyPreview removes everything of an instance. The caller holds the instance's lock. The route goes first (the
// proxy stops sending traffic), then the containers, then the row, so that a failure part way leaves a row to retry from.
func (d *Deployer) destroyPreview(ctx context.Context, row store.Preview) error {
	name := row.Name
	stopTimeout := int(config.DefaultStopTimeout.Seconds())
	if a, ok := synthesize(d.config(), row); ok {
		stopTimeout = int(a.Stop().Seconds())
	}

	containers := map[string]bool{}
	st, stateErr := d.store.AppState(ctx, name)
	switch {
	case stateErr == nil:
		containers[st.Container] = true
	case !errors.Is(stateErr, store.ErrNotFound):
		return stateErr
	}
	if err := d.dropRoute(ctx, name, stateErr == nil); err != nil {
		return fmt.Errorf("remove the route: %w", err)
	}

	// Leftovers of a deployment cut short are named "<name>-<16 hex>", like the serving container.
	scheme := regexp.MustCompile("^" + regexp.QuoteMeta(name) + "-[a-f0-9]{16}$")
	list, err := d.eng.ListByLabel(ctx, "keelson.app="+name)
	if err != nil {
		return err
	}
	for _, c := range list {
		if c.Name == name || scheme.MatchString(c.Name) {
			containers[c.Name] = true
		}
	}
	for c := range containers {
		if err := d.eng.Stop(ctx, c, stopTimeout); err != nil && !docker.IsNotFound(err) {
			d.log.Warn("could not stop a preview container", "name", name, "container", c, "err", err)
		}
		if err := d.eng.Remove(ctx, c); err != nil && !docker.IsNotFound(err) {
			return fmt.Errorf("remove container %s: %w", c, err)
		}
	}

	if err := d.store.DeletePreview(ctx, name); err != nil {
		return err
	}
	d.removePreviewImages(ctx, name)
	d.log.Info("preview removed", "name", name)
	return nil
}

// dropRoute removes an app's route from the proxy and its state from the database, as one step under proxyMu.
func (d *Deployer) dropRoute(ctx context.Context, name string, hadState bool) error {
	d.proxyMu.Lock()
	defer d.proxyMu.Unlock()
	if hadState {
		if drv := d.proxyDriver(); drv != nil {
			routes, err := d.buildRoutes(ctx, nil, name)
			if err != nil {
				return err
			}
			if err := drv.Apply(ctx, routes); err != nil {
				return err
			}
			d.applied, d.appliedSet = routes, true
		}
	}
	return d.store.DeleteAppState(ctx, name)
}

// instanceRefs are the image references the preview instances run or last asked for, except those of the instance
// named except: they must survive any pruning.
func (d *Deployer) instanceRefs(ctx context.Context, except string) (map[string]bool, error) {
	rows, err := d.store.Previews(ctx)
	if err != nil {
		return nil, err
	}
	out := map[string]bool{}
	for _, row := range rows {
		if row.Name == except {
			continue
		}
		out[row.Ref] = true
		switch st, err := d.store.AppState(ctx, row.Name); {
		case err == nil:
			out[st.Ref] = true
		case !errors.Is(err, store.ErrNotFound):
			return nil, err
		}
	}
	return out, nil
}

// previewCandidates are the references an instance's deployments pulled, the newest first.
func (d *Deployer) previewCandidates(ctx context.Context, name string) ([]string, error) {
	deps, err := d.store.ListDeployments(ctx, name, 100)
	if err != nil {
		return nil, err
	}
	var out []string
	seen := map[string]bool{}
	for _, dep := range deps {
		if !seen[dep.Ref] {
			seen[dep.Ref] = true
			out = append(out, dep.Ref)
		}
	}
	return out, nil
}

// protectedForPreview are the references an instance's pruning must leave alone: the versions the parent app keeps and
// those of every other instance. The instance's repository is the parent's, so its images are shared with them.
func (d *Deployer) protectedForPreview(ctx context.Context, name string) (map[string]bool, error) {
	protected, err := d.instanceRefs(ctx, name)
	if err != nil {
		return nil, err
	}
	parentName, _, _ := config.ParsePreviewName(name)
	if parent, ok := d.config().App(parentName); ok {
		current, err := d.currentRef(ctx, parent)
		if err != nil {
			return nil, err
		}
		kept, err := d.keptRefs(ctx, parent, current)
		if err != nil {
			return nil, err
		}
		for r := range kept {
			protected[r] = true
		}
	}
	return protected, nil
}

// removeRefs removes the local images of the references that are not protected, and returns how many went. An image a
// container still uses is left (the engine refuses, and the agent never forces it).
func (d *Deployer) removeRefs(ctx context.Context, refs []string, protected map[string]bool) (int, error) {
	removed := 0
	var failure error
	for _, ref := range refs {
		if protected[ref] {
			continue
		}
		switch err := d.eng.RemoveImage(ctx, ref); {
		case err == nil:
			removed++
		case errors.Is(err, docker.ErrImageInUse):
		default:
			failure = err
		}
	}
	return removed, failure
}

// prunePreviewImages removes the images an instance used before this deployment, once it succeeded. Only the
// references its own deployments pulled are candidates: the repository is the parent's, and what the parent or another
// instance keeps is never touched.
func (d *Deployer) prunePreviewImages(ctx context.Context, id string, a config.App, ref string) {
	candidates, err := d.previewCandidates(ctx, a.Name)
	if err == nil {
		var protected map[string]bool
		if protected, err = d.protectedForPreview(ctx, a.Name); err == nil {
			protected[ref] = true
			var removed int
			removed, err = d.removeRefs(ctx, candidates, protected)
			if removed > 0 {
				d.event(id, "info", "removed %s", plural(removed, "old image"))
			}
		}
	}
	if err != nil {
		d.event(id, "warn", "could not remove some old images: %v", err)
	}
}

// removePreviewImages removes the images of a removed instance, with the same care. It never fails the removal.
func (d *Deployer) removePreviewImages(ctx context.Context, name string) {
	candidates, err := d.previewCandidates(ctx, name)
	if err == nil {
		var protected map[string]bool
		if protected, err = d.protectedForPreview(ctx, name); err == nil {
			_, err = d.removeRefs(ctx, candidates, protected)
		}
	}
	if err != nil {
		d.log.Warn("could not remove the images of a preview", "name", name, "err", err)
	}
}

// SweepPreviews removes the instances that are expired, whose template is gone, or that exceed their template's max
// (the oldest first), each through the same removal as a DELETE and with an audit entry. An instance being deployed
// or removed is left for the next sweep.
func (d *Deployer) SweepPreviews(ctx context.Context) {
	rows, err := d.store.Previews(ctx)
	if err != nil {
		d.log.Warn("list previews to sweep", "err", err)
		return
	}
	cfg := d.config()
	now := d.now()
	remove := func(row store.Preview, action, detail string) bool {
		switch err := d.removeAudited(ctx, row, action, detail); {
		case err == nil:
			return true
		case errors.Is(err, ErrBusy):
		case ctx.Err() == nil:
			d.log.Warn("could not remove a preview", "name", row.Name, "action", action, "err", err)
		}
		return false
	}
	stop := func() bool { return ctx.Err() != nil || d.stopping.Load() }

	kept := map[string][]store.Preview{}
	for _, row := range rows { // oldest first
		if stop() {
			return
		}
		if _, ok := synthesize(cfg, row); !ok {
			remove(row, "preview.remove", row.Name+": its previews template was removed")
			continue
		}
		if now.After(row.ExpiresAt) &&
			remove(row, "preview.expire", fmt.Sprintf("%s: expired %s ago", row.Name, now.Sub(row.ExpiresAt).Round(time.Second))) {
			continue
		}
		kept[row.App] = append(kept[row.App], row)
	}
	for app, list := range kept {
		tpl, _ := cfg.Previews(app)
		list, err := d.evictionOrder(ctx, list)
		if err != nil {
			d.log.Warn("order previews for eviction", "app", app, "err", err)
			continue
		}
		gone := 0
		for _, row := range list {
			if len(list)-gone <= tpl.MaxCount() {
				break
			}
			if stop() {
				return
			}
			if remove(row, "preview.evict", fmt.Sprintf("%s: first to go of %d, above the template's max of %d", row.Name, len(list), tpl.MaxCount())) {
				gone++
			}
		}
	}
}

// RunPreviewSweeper calls SweepPreviews every interval until ctx ends.
func (d *Deployer) RunPreviewSweeper(ctx context.Context, every time.Duration) {
	t := time.NewTicker(every)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			d.SweepPreviews(ctx)
		}
	}
}
