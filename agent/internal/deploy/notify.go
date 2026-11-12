package deploy

import (
	"context"
	"fmt"
	"regexp"
	"strings"
	"time"

	"github.com/0x2u/keelson/agent/internal/config"
	"github.com/0x2u/keelson/agent/internal/notify"
	"github.com/0x2u/keelson/agent/internal/store"
)

// SetEmitter makes the deployer report the end of every deployment. Without
// one it stays silent. It must be set before deployments start.
func (d *Deployer) SetEmitter(e notify.Emitter) { d.emitter = e }

// emit sends one event, if there is anywhere to send it.
func (d *Deployer) emit(e notify.Event) {
	if d.emitter != nil {
		d.emitter.Emit(e)
	}
}

// Config returns the apps configuration the deployer works with.
func (d *Deployer) Config() *config.Config { return d.config() }

// emitFinished reports how a deployment ended. It reads the record back, so the event carries exactly what the history
// shows. The words are the verbs of the product: Deploy and Roll back; a deployment is never a noun in a title.
func (d *Deployer) emitFinished(id string) {
	if d.emitter == nil {
		return
	}
	dep, err := d.store.Deployment(context.Background(), id)
	if err != nil {
		d.log.Error("read deployment for notification", "id", id, "err", err)
		return
	}
	if dep.Trigger == TriggerPreview {
		return // a preview comes and goes with its pull request: the pull request's status says how it went
	}
	rollback := dep.Trigger == TriggerRollback
	e := notify.Event{
		Type:         "deployment." + dep.Status,
		App:          dep.App,
		Ref:          dep.Ref,
		DeploymentID: dep.ID,
		Message:      dep.Error,
	}
	switch dep.Status {
	case store.StatusSucceeded:
		e.Severity = notify.SeverityInfo
		e.Title = dep.App + " deployed " + versionOf(dep.Ref)
		if rollback {
			e.Title = dep.App + " rolled back to " + versionOf(dep.Ref)
		}
		if dep.FinishedAt != nil {
			e.Message = fmt.Sprintf("Took %s.", dep.FinishedAt.Sub(dep.StartedAt).Round(time.Second))
		}
	case store.StatusFailed:
		e.Severity = notify.SeverityWarning
		e.Title = dep.App + ": deploy failed"
		if rollback {
			e.Title = dep.App + ": rollback failed"
		}
		if dep.ServingRef != "" {
			e.Message = versionOf(dep.ServingRef) + " is still serving. " + dep.Error
		}
	case store.StatusRolledBack:
		e.Severity = notify.SeverityWarning
		e.Title = dep.App + ": deploy rolled back"
		if rollback {
			e.Title = dep.App + ": rollback failed"
		}
		e.Message = versionOf(dep.ServingRef) + " is serving again. " + dep.Error
	case store.StatusRollbackFailed:
		e.Severity = notify.SeverityCritical
		e.Title = dep.App + ": deploy failed and the previous version could not be restored"
		if rollback {
			e.Title = dep.App + ": rollback failed"
		}
		e.Message = "The app may be down. " + dep.Error
	default:
		return // still running: nothing to tell
	}
	d.emitter.Emit(e)
}

// shaTag matches a tag that is a full commit hash, which is what a build tags its image with.
var shaTag = regexp.MustCompile(`^[0-9a-f]{40}$`)

// versionOf is how a notification names the version of an image reference: its tag (a commit hash cut to seven
// characters), or the start of its digest.
func versionOf(ref string) string {
	if _, digest, ok := strings.Cut(ref, "@sha256:"); ok {
		return "sha256:" + digest[:min(12, len(digest))]
	}
	tag, ok := tagOfRef(ref)
	switch {
	case !ok:
		return ref
	case shaTag.MatchString(tag):
		return tag[:7]
	}
	return tag
}

// BeginSwap opens a swap window for app: the serving container is about to be replaced, so for a while it is
// expected to stop, restart or be unhealthy and the app watcher must not judge it. Call it right before the step
// that takes the serving container away (the traffic switch of a proxied app, the stop of the serving container of
// an in-place app) and call EndSwap when the replacement has settled (soak and drain included, or the switch was
// undone). The calls are counted, so windows nest; they are safe from any goroutine.
//
// Only the window is muted: the live container is watched during the pull, the build and the release steps of a
// deployment, so a crash of the app during a nine-minute build still raises app.down. A window that is never
// closed ends with the deployment (see Observe), so a forgotten EndSwap cannot mute an app for good.
func (d *Deployer) BeginSwap(app string) {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.swapping == nil {
		d.swapping = map[string]int{}
	}
	d.swapping[app]++
}

// EndSwap closes the window BeginSwap opened.
func (d *Deployer) EndSwap(app string) {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.swapping[app] <= 1 {
		delete(d.swapping, app)
		return
	}
	d.swapping[app]--
}

// swapOpen reports whether the serving container of app is being replaced right now. The caller holds d.mu.
func (d *Deployer) swapOpen(app string) bool {
	return d.swapping[app] > 0 && d.active[app]
}

// Observe reports the state of every configured app, for the watcher.
func (d *Deployer) Observe(ctx context.Context) ([]notify.AppState, error) {
	cfg := d.config()
	out := make([]notify.AppState, 0, len(cfg.Apps))
	for _, a := range cfg.Apps {
		det, err := d.liveContainer(ctx, a)
		if err != nil {
			return nil, err
		}
		d.mu.Lock()
		busy := d.swapOpen(a.Name)
		d.mu.Unlock()

		s := notify.AppState{Name: a.Name, Busy: busy}
		if det != nil {
			s.Present = true
			s.Running = det.State.Running
			s.Restarting = det.State.Restarting
			s.Health = det.State.Health
			s.ExitCode = det.State.ExitCode
		}
		out = append(out, s)
	}
	return out, nil
}
