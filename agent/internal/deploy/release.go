package deploy

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/0x2u/keelson/agent/internal/config"
	"github.com/0x2u/keelson/agent/internal/docker"
	"github.com/0x2u/keelson/agent/internal/hostexec"
)

const (
	// maxStepLines bounds how much of a step's output goes into the
	// deployment log: a chatty migration must not fill the database.
	maxStepLines = 500
)

// releaseLabel marks the throwaway containers of release steps, so leftovers
// of a crashed agent can be found and removed.
const releaseLabel = "keelson.release"

// releaseTimeoutLabel records the step's timeout on its container, so that a
// later agent knows how long the step may still legitimately run.
const releaseTimeoutLabel = "keelson.release.timeout"

// skipsRelease says whether the release steps are left out of the deployment: a rollback puts back a version whose
// migrations already ran, unless the app asks for its steps on a rollback.
func skipsRelease(a config.App, trigger string) bool {
	return trigger == TriggerRollback && (a.Release == nil || !a.Release.OnRollback)
}

// runRelease runs the app's release steps in order. It happens after the new
// image is pulled and before anything serving is touched, so a step that
// fails aborts the deployment with the running version untouched.
func (d *Deployer) runRelease(ctx context.Context, id string, a config.App, ref, trigger string, env []string) error {
	rel := a.Release
	if rel == nil {
		return nil
	}
	if skipsRelease(a, trigger) {
		d.event(id, "info", "release steps are skipped for a rollback")
		return nil
	}
	for n, step := range rel.Steps {
		d.event(id, "info", "release step %q: starting", step.Name)
		started := d.now()
		var err error
		switch {
		case step.Backup != "":
			err = d.runBackupStep(ctx, id, step)
		case len(step.Host) > 0:
			err = d.runHostStep(ctx, id, a, ref, trigger, step)
		default:
			err = d.runContainerStep(ctx, id, a, ref, env, step, n)
		}
		switch {
		case err == nil:
			d.event(id, "info", "release step %q: done in %s", step.Name, d.now().Sub(started).Round(time.Millisecond))
		case step.ContinueOnFailure:
			d.event(id, "warn", "release step %q failed, continuing: %v", step.Name, err)
		default:
			d.event(id, "error", "release step %q failed: %v", step.Name, err)
			return fmt.Errorf("release step %q failed: %w", step.Name, err)
		}
	}
	return nil
}

// stepOutput copies a step's output lines into the deployment log, up to a cap.
type stepOutput struct {
	d      *Deployer
	id     string
	prefix string
	lines  int
}

func (o *stepOutput) write(line string) {
	o.lines++
	switch {
	case o.lines <= maxStepLines:
		o.d.event(o.id, "info", "%s %s", o.prefix, line)
	case o.lines == maxStepLines+1:
		o.d.event(o.id, "warn", "%s further output is not recorded", o.prefix)
	}
}

// Backuper takes the backup of a declared database: the databases service, which also runs the scheduled backups.
type Backuper interface {
	// BackupBeforeDeploy is the backup of a `backup` step: kept apart from the scheduled ones, and reused when the database was
	// backed up a moment ago.
	BackupBeforeDeploy(ctx context.Context, name string, out func(line string)) error
}

// SetBackuper gives the release phase the means to run a `backup` step. Call it before the deployer serves requests.
func (d *Deployer) SetBackuper(b Backuper) { d.backups = b }

// runBackupStep takes a backup of the step's database, with the checks of a scheduled one (the dump is read back, the
// stored copy is hashed). Its output goes into the deployment log; a failure stops the deployment before the
// migration step that follows.
func (d *Deployer) runBackupStep(ctx context.Context, id string, step config.ReleaseStep) error {
	if d.backups == nil {
		return errors.New("this agent has no database service to take a backup with")
	}
	ctx, cancel := context.WithTimeout(ctx, step.RunTimeout())
	defer cancel()
	out := &stepOutput{d: d, id: id, prefix: "[" + step.Name + "]"}
	err := d.backups.BackupBeforeDeploy(ctx, step.Backup, out.write)
	if errors.Is(ctx.Err(), context.DeadlineExceeded) {
		return fmt.Errorf("timed out after %s", step.RunTimeout())
	}
	return err
}

// runHostStep runs a command on the host through hostexec: no shell, and
// without the agent's own KEELSON_* variables, which hold its secrets.
func (d *Deployer) runHostStep(ctx context.Context, id string, a config.App, ref, trigger string, step config.ReleaseStep) error {
	ctx, cancel := context.WithTimeout(ctx, step.RunTimeout())
	defer cancel()

	out := &stepOutput{d: d, id: id, prefix: "[" + step.Name + "]"}
	extra := []string{"KEELSON_APP=" + a.Name, "KEELSON_REF=" + ref, "KEELSON_DEPLOYMENT_ID=" + id, "KEELSON_TRIGGER=" + trigger}
	err := hostexec.Run(ctx, step.Host, step.Dir, extra, out.write)
	if errors.Is(ctx.Err(), context.DeadlineExceeded) {
		return fmt.Errorf("timed out after %s", step.RunTimeout())
	}
	return err
}

// runContainerStep runs the step's command in a throwaway container: the app's
// environment, volumes and network, the image being deployed (or the step's
// own image at the same tag). The container is always removed afterwards.
func (d *Deployer) runContainerStep(ctx context.Context, id string, a config.App, ref string, env []string, step config.ReleaseStep, n int) error {
	image := ref
	if step.Container.Image != "" {
		tag, ok := tagOfRef(ref)
		if !ok {
			return errors.New("a step with its own image is deployed at the app's tag: it cannot follow a digest deployment")
		}
		auth, err := d.registryAuth(step.Container.Image)
		if err != nil {
			return err
		}
		d.event(id, "info", "pulling %s:%s", step.Container.Image, tag)
		if err := d.eng.Pull(ctx, step.Container.Image, tag, auth, func(s string) { d.event(id, "info", "%s", s) }); err != nil {
			return err
		}
		image = step.Container.Image + ":" + tag
	}

	ctx, cancel := context.WithTimeout(ctx, step.RunTimeout())
	defer cancel()

	out := &stepOutput{d: d, id: id, prefix: "[" + step.Name + "]"}
	code, err := docker.RunThrowaway(ctx, d.eng, d.log, docker.ContainerSpec{
		Name:          fmt.Sprintf("%s-release-%s-%d", a.Name, id, n+1),
		Image:         image,
		Env:           env,
		Labels:        map[string]string{"keelson.app": a.Name, releaseLabel: "true", releaseTimeoutLabel: step.RunTimeout().String(), "keelson.deployment": id},
		Cmd:           step.Container.Command,
		Binds:         a.Volumes,
		NetworkMode:   a.Network,
		ExtraNetworks: d.config().ExtraNetworks(a),
		RestartPolicy: "no",
		StopTimeout:   int(a.Stop().Seconds()),
	}, out.write)
	switch {
	case errors.Is(ctx.Err(), context.DeadlineExceeded):
		return fmt.Errorf("timed out after %s", step.RunTimeout())
	case err != nil:
		return err
	case code != 0:
		return fmt.Errorf("exit code %d", code)
	}
	return nil
}

// tagOfRef returns the tag of "repo:tag", and false for a "repo@sha256:..." ref.
func tagOfRef(ref string) (string, bool) {
	if strings.Contains(ref, "@") {
		return "", false
	}
	i := strings.LastIndex(ref, ":")
	if i < 0 {
		return "", false
	}
	return ref[i+1:], true
}

// removeStaleReleases deletes throwaway containers left by an agent that died
// mid-run: release steps and container jobs. They are transient by nature:
// none can be worth keeping. A release step that is still running is the
// exception: cutting a migration in half leaves the database in a state the
// next attempt refuses to start from (Prisma's P3009), so it is given the
// rest of its own timeout to finish, in the background.
func (d *Deployer) removeStaleReleases(ctx context.Context) error {
	_, err := d.sweepStaleReleases(ctx)
	return err
}

// sweepStaleReleases removes the leftovers that have exited and starts a
// watcher for each release step still running. The returned channel closes
// once every watcher has ended (ctx done, container gone or removed): the
// caller may ignore it, tests wait on it so that nothing outlives them.
func (d *Deployer) sweepStaleReleases(ctx context.Context) (<-chan struct{}, error) {
	var wg sync.WaitGroup
	done := make(chan struct{})
	defer func() {
		go func() {
			wg.Wait()
			close(done)
		}()
	}()
	for _, label := range []string{releaseLabel, jobLabel} {
		list, err := d.eng.ListByLabel(ctx, label+"=true")
		if err != nil {
			return done, err
		}
		for _, c := range list {
			if label == releaseLabel && c.State == "running" {
				d.log.Warn("a release step is still running after an agent restart: leaving it to finish", "container", c.Name)
				wg.Add(1)
				go func() {
					defer wg.Done()
					d.removeReleaseWhenDone(ctx, c)
				}()
				continue
			}
			d.log.Warn("removing a leftover throwaway container", "container", c.Name)
			if err := d.eng.RemoveThrowaway(ctx, c.Name); err != nil && !docker.IsNotFound(err) {
				return done, err
			}
		}
	}
	return done, nil
}

// removeReleaseWhenDone waits for the running release container c to exit,
// for as long as is left of the step's timeout counted from when the
// container started, then removes it, forcibly when it is still running by
// then. It gives up without removing anything when ctx ends (the agent shuts
// down; the next start sweeps again) or when the engine cannot be asked.
func (d *Deployer) removeReleaseWhenDone(ctx context.Context, c docker.Container) {
	budget := stepTimeoutOf(c.Labels)
	det, err := d.eng.Inspect(ctx, c.Name)
	switch {
	case docker.IsNotFound(err):
		return
	case err == nil && det.State.StartedAt != nil:
		budget -= time.Since(*det.State.StartedAt)
	}
	waitCtx, cancel := context.WithTimeout(ctx, max(budget, 0))
	defer cancel()
	_, err = d.eng.Wait(waitCtx, c.Name)
	switch {
	case ctx.Err() != nil, docker.IsNotFound(err):
		return
	case err != nil && waitCtx.Err() == nil:
		d.log.Warn("could not wait for a leftover release container", "container", c.Name, "err", err)
		return
	}
	rmCtx, rmCancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer rmCancel()
	if err := d.eng.RemoveThrowaway(rmCtx, c.Name); err != nil && !docker.IsNotFound(err) {
		d.log.Warn("could not remove a leftover release container", "container", c.Name, "err", err)
	}
}

// stepTimeoutOf reads back the timeout runContainerStep recorded on the
// container. A container without a usable record (made by an older agent) is
// given the longest timeout a step may have.
func stepTimeoutOf(labels map[string]string) time.Duration {
	t, err := time.ParseDuration(labels[releaseTimeoutLabel])
	if err != nil || t <= 0 || t > config.MaxReleaseTimeout {
		return config.MaxReleaseTimeout
	}
	return t
}
