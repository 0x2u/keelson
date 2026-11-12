package deploy

import (
	"context"
	"errors"
	"fmt"
	"maps"

	"github.com/0x2u/keelson/agent/internal/build"
	"github.com/0x2u/keelson/agent/internal/config"
	"github.com/0x2u/keelson/agent/internal/docker"
	"github.com/0x2u/keelson/agent/internal/store"
)

// TriggerBuild is the trigger recorded on deployments that built their image first (previews use TriggerPreview).
const TriggerBuild = "build"

// Errors of the build operations. The errors of the request itself (a bad commit, a source that is not allowed) are
// those of package build.
var (
	// ErrNoBuild: the app (or the parent of the preview) has no build block, or this agent cannot build.
	ErrNoBuild = errors.New("the app has no build block")
	// ErrBuildBusy: the agent builds one image at a time.
	ErrBuildBusy = errors.New("another build is running on this agent")
	// ErrBuildNameTaken: a build request names an app, or an image repository, that belongs to another app of this server.
	ErrBuildNameTaken = errors.New("the name or the image of the build is taken by an app of this server")
)

// Builder is the part of package build a deployment needs: one build at a time, validated before anything starts.
type Builder interface {
	TryAcquire() (release func(), ok bool)
	Validate(req build.Request) error
	Build(ctx context.Context, req build.Request, emit build.Emit) (ref string, err error)
}

// SetBuilder enables builds. Call it before the deployer serves requests.
func (d *Deployer) SetBuilder(b Builder) { d.builder = b }

// buildJob is the build phase of a deployment that builds its own image.
type buildJob struct {
	req build.Request
	// release gives the agent's build slot back; run calls it as soon as the build ends.
	release func()
	// varsOf is the app whose build variables of this server joined the arguments (a build for another server), and
	// vars how many: the names never leave the store, the log only counts them.
	varsOf string
	vars   int
}

// launchOpts are the variations of a deployment.
type launchOpts struct {
	// build, when set, builds the image inside the deployment, before anything else.
	build *buildJob
	// local says the image is on this server and was never pushed (it was built here): it is not pulled.
	local bool
	// elsewhere says the image runs on another server: nothing is deployed here once it is built (a build requested
	// through POST /v1/builds, whose app is not an app of this server).
	elsewhere bool
}

// abandon gives back what a launch that never started had taken.
func (o launchOpts) abandon() {
	if o.build != nil && o.build.release != nil {
		o.build.release()
	}
}

// StartBuild builds the image of app from the source at commit sha and deploys it, as one deployment: its events log
// the download, the build output (bounded) and the usual deploy steps. The image is tagged "<image>:<sha>" locally;
// nothing is pulled or pushed. A failed build fails the deployment and leaves what serves untouched.
//
// The token of src is held in memory for the download and nowhere else.
func (d *Deployer) StartBuild(ctx context.Context, app, sha string, src build.Source) (string, <-chan struct{}, error) {
	if d.stopping.Load() {
		return "", nil, ErrShuttingDown
	}
	a, ok := d.config().App(app)
	if !ok {
		return "", nil, ErrUnknownApp
	}
	return d.startBuild(ctx, a, sha, src, launchOpts{})
}

// BuildRequest is a build another server asks this one for (POST /v1/builds): the app is whatever the request names, it
// need not exist on this server.
type BuildRequest struct {
	// App is the name the build is recorded under: its history, its stored build variables, its images to prune.
	App string
	// Image is the repository the result is tagged with.
	Image      string
	SHA        string
	Source     build.Source
	Build      *config.Build
	Port       int
	HealthPath string
}

// BuildCeilings are the limits this server's builds for other servers are held to (the build_limits of its apps file).
func (d *Deployer) BuildCeilings() config.BuildCeilings { return d.config().BuildCeilings() }

// StartBuildRequest builds an image for another server. The request is held to this server's build_limits; the build
// runs as a deployment of req.App. Its arguments are, in order of precedence: the request's own args, this server's
// build variables for the name (PUT /v1/build-vars/{app}: what makes a build that needs a secret possible here), and the
// variables flagged for build of an app of this server with the same name. The build ends without deploying anything: the
// image is built here and kept for export.
//
// The name must be free: an app of this server's file with the same name must have the same image, and no other app
// of the file may use the image's repository (pruning an app's old images works per repository).
func (d *Deployer) StartBuildRequest(ctx context.Context, req BuildRequest) (string, <-chan struct{}, error) {
	if d.stopping.Load() {
		return "", nil, ErrShuttingDown
	}
	if d.builder == nil {
		return "", nil, ErrNoBuild
	}
	cfg := d.config()
	a, err := config.BuildRequestApp(req.App, req.Image, req.Port, req.HealthPath, req.Build, cfg.BuildCeilings())
	if err != nil {
		return "", nil, err
	}
	for _, other := range cfg.Apps {
		switch {
		case other.Name == a.Name && other.Image != a.Image:
			return "", nil, fmt.Errorf("%w: this server has an app named %q with the image %q, not %q", ErrBuildNameTaken, a.Name, other.Image, a.Image)
		case other.Name != a.Name && other.Image == a.Image:
			return "", nil, fmt.Errorf("%w: the app %q of this server uses the image %q", ErrBuildNameTaken, other.Name, a.Image)
		}
	}
	return d.startBuild(ctx, a, req.SHA, req.Source, launchOpts{elsewhere: true})
}

func (d *Deployer) startBuild(ctx context.Context, a config.App, sha string, src build.Source, opts launchOpts) (string, <-chan struct{}, error) {
	job, err := d.newBuildJob(ctx, a, sha, src)
	if err != nil {
		return "", nil, err
	}
	if opts.elsewhere {
		vars, err := d.env.BuildVars(a.Name)
		if err != nil {
			return "", nil, fmt.Errorf("read build variables: %w", err)
		}
		if len(vars) > 0 {
			args := maps.Clone(job.req.Args)
			if args == nil {
				args = make(map[string]string, len(vars))
			}
			maps.Copy(args, vars)
			job.req.Args, job.varsOf, job.vars = args, a.Name, len(vars)
		}
	}
	if !d.reserve(a.Name) {
		return "", nil, ErrBusy
	}
	release, ok := d.builder.TryAcquire()
	if !ok {
		d.release(a.Name)
		return "", nil, ErrBuildBusy
	}
	job.release = release
	opts.build = job
	id := store.NewID()
	done, err := d.launch(ctx, a, id, job.req.Ref(), TriggerBuild, opts)
	if err != nil {
		return "", nil, err
	}
	return id, done, nil
}

// newBuildJob checks a build request against the app: it must have a build block, and the commit and the source must be
// acceptable. Nothing is reserved yet.
func (d *Deployer) newBuildJob(ctx context.Context, a config.App, sha string, src build.Source) (*buildJob, error) {
	if d.builder == nil || a.Build == nil {
		return nil, ErrNoBuild
	}
	args, err := d.env.BuildArgs(a)
	if err != nil {
		return nil, fmt.Errorf("read build arguments: %w", err)
	}
	if a.Build.Database {
		// A Dockerfile may create the tables of a new, empty database before it builds, but must never do that to a database
		// that holds data (a native production one reached by a variable the operator flagged, or the managed one once the app
		// has served): the mark says the database is still the empty one the agent created. After the first successful
		// deployment it is gone, and the release steps migrate, after the backup. A failed migration run by a build would
		// otherwise be recorded in the live database and refuse every deployment that follows.
		past, err := d.store.Succeeded(ctx, a.Name, 1)
		if err != nil {
			return nil, fmt.Errorf("read the deployments of %s: %w", a.Name, err)
		}
		if len(past) == 0 {
			args = maps.Clone(args)
			if args == nil {
				args = map[string]string{}
			}
			args[config.BuildDatabaseArg] = "1"
		}
	}
	req := build.Request{Image: a.Image, SHA: sha, Config: a.Build, Source: src, Args: args, Port: a.ContainerPort, HealthPath: a.HealthPath, Network: a.BuildNetwork()}
	if err := d.builder.Validate(req); err != nil {
		return nil, err
	}
	return &buildJob{req: req}, nil
}

// runBuild runs the source and build phases of a deployment: the download of the source, then the image build, which
// starts where the builder says so. The build has its own timeout (the app's), and is canceled when the agent starts
// shutting down.
func (d *Deployer) runBuild(id string, job *buildJob) error {
	defer job.release()
	before := d.danglingImages(d.buildCtx)
	building := build.BuildingLine(job.req.Ref())
	if job.vars > 0 {
		d.event(id, "info", "%d build variable(s) from this server's build-vars for %s", job.vars, job.varsOf)
	}
	_, err := d.builder.Build(d.buildCtx, job.req, func(level, msg string) {
		if msg == building {
			d.phase(id, store.PhaseBuild)
		}
		d.event(id, level, "%s", msg)
	})
	if err == nil {
		d.removeOldBuildLeftovers(d.buildCtx, id, before)
	}
	return err
}

// danglingImages are the ids of the untagged leaf images now on the engine; nil when they cannot be listed.
func (d *Deployer) danglingImages(ctx context.Context) map[string]bool {
	imgs, err := d.eng.ListDanglingImages(ctx)
	if err != nil {
		return nil
	}
	out := make(map[string]bool, len(imgs))
	for _, img := range imgs {
		out[img.ID] = true
	}
	return out
}

// removeOldBuildLeftovers removes, after a successful build, the untagged images that were already there when it started:
// the stages the builds before it left behind, which nothing needs. What this build left stays, because the next one
// reuses its cached layers (a Next.js dependency install is minutes), and goes after that one. Without it every multi-stage
// build keeps a few hundred megabytes for ever. The engine refuses to remove an image a container uses, and nothing is forced.
// It never fails a build: what it cannot do is reported.
func (d *Deployer) removeOldBuildLeftovers(ctx context.Context, id string, before map[string]bool) {
	if len(before) == 0 {
		return
	}
	now := d.danglingImages(ctx)
	removed := 0
	for imgID := range before {
		if !now[imgID] {
			continue
		}
		switch err := d.eng.RemoveImage(ctx, imgID); {
		case err == nil:
			removed++
		case errors.Is(err, docker.ErrImageInUse):
		default:
			d.event(id, "warn", "could not remove an image left by an earlier build: %v", err)
		}
	}
	if removed > 0 {
		d.event(id, "info", "removed %s left by earlier builds", plural(removed, "untagged image"))
	}
}

// checkLocalImage makes sure an image that must not be pulled is on this server.
func (d *Deployer) checkLocalImage(ctx context.Context, ref string) error {
	if _, err := d.eng.ImageRepoDigests(ctx, ref); err != nil {
		if docker.IsNotFound(err) {
			return fmt.Errorf("the image %s was built on this server and is not here any more (older images are removed after keep_images deployments)", ref)
		}
		return fmt.Errorf("look for the local image %s: %w", ref, err)
	}
	return nil
}
