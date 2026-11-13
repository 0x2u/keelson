package deploy

import (
	"context"
	"fmt"
	"time"

	"github.com/0x2u/keelson/agent/internal/config"
	"github.com/0x2u/keelson/agent/internal/docker"
)

// StoppedError is returned when an app that the file stops (enabled: false) is asked to deploy, roll back, build or have
// a container started: it stays stopped until the file says otherwise.
type StoppedError struct{ App string }

func (e *StoppedError) Error() string {
	return fmt.Sprintf("app %s is stopped (enabled: false): start it first", e.App)
}

// refuseStopped is the guard of every way to put a new version of an app on this server.
func refuseStopped(a config.App) error {
	if !a.IsEnabled() {
		return &StoppedError{App: a.Name}
	}
	return nil
}

// stoppedSet names the apps a configuration stops.
func stoppedSet(c *config.Config) map[string]bool {
	out := map[string]bool{}
	for _, a := range c.Apps {
		if !a.IsEnabled() {
			out[a.Name] = true
		}
	}
	return out
}

// EnforceStopped stops, with the app's stop_timeout, every running container of an app the file stops (enabled: false),
// and never removes one: starting the app again is a start. It runs at every reconcile tick and after a change of the
// file, so that whatever starts such a container (a person, a restart policy after a boot, a recovery after a crash of the
// agent) is undone within seconds. An app being deployed or acted on is left alone, the next tick looks again; it
// stops nothing else, and it is a no-op for an app already stopped.
func (d *Deployer) EnforceStopped(ctx context.Context) error {
	var firstErr error
	for _, a := range d.config().Apps {
		if a.IsEnabled() {
			continue
		}
		if err := d.enforceStopped(ctx, a); err != nil && firstErr == nil {
			firstErr = err
		}
	}
	return firstErr
}

func (d *Deployer) enforceStopped(ctx context.Context, a config.App) error {
	if !d.reserve(a.Name) {
		return nil // a deployment or a start of a container is under way: not fought with
	}
	defer d.release(a.Name)
	// The file may have changed while this waited for the app: look again at what is in force.
	if now, ok := d.config().App(a.Name); !ok || now.IsEnabled() {
		return nil
	}
	list, err := d.eng.ListByLabel(ctx, appLabel+"="+a.Name)
	if err != nil {
		return err
	}
	stop := int(a.Stop().Seconds())
	for _, c := range list {
		if c.State != "running" && c.State != "restarting" {
			continue
		}
		d.log.Warn("stopping a container of an app that is stopped (enabled: false)", "app", a.Name, "container", c.Name)
		sctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), time.Duration(stop)*time.Second+restartGrace)
		err := d.eng.Stop(sctx, c.Name, stop)
		cancel()
		if err != nil && !docker.IsNotFound(err) {
			return fmt.Errorf("stop %s: %w", c.Name, err)
		}
	}
	return nil
}

// settleStopped is what follows a change of the file that stopped or started an app: the containers of a stopped app are
// stopped, and the proxy is told. It runs in the background (a stop may take the whole stop_timeout, and the change is
// being applied by someone who should not wait for it); the reconcile loop would do the same at its next tick.
func (d *Deployer) settleStopped() {
	go func() {
		ctx := d.buildCtx
		if err := d.EnforceStopped(ctx); err != nil && ctx.Err() == nil {
			d.log.Warn("could not stop the apps that the file stops", "err", err)
		}
		if err := d.Reconcile(ctx); err != nil && ctx.Err() == nil {
			d.log.Warn("could not reconcile the proxy after a change of the apps that are stopped", "err", err)
		}
	}()
}
