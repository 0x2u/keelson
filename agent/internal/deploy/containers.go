package deploy

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/0x2u/keelson/agent/internal/config"
)

// appLabel is the label every container made for an app carries: it is what makes a container keelson's to act on.
const appLabel = "keelson.app"

// restartGrace is what a start or a restart may take on top of the stop timeout.
const restartGrace = 30 * time.Second

// ErrNotManaged is returned when a container exists but was not made by keelson: it has no app label.
var ErrNotManaged = errors.New("the container is not managed by keelson")

// StartContainer starts a stopped container of an app. Starting a running one is not an error.
func (d *Deployer) StartContainer(ctx context.Context, name string) error {
	return d.act(ctx, name, false)
}

// RestartContainer stops a container of an app, with the stop timeout of the app, and starts it again.
func (d *Deployer) RestartContainer(ctx context.Context, name string) error {
	return d.act(ctx, name, true)
}

// act starts a container, after stopping it when restart is set. Only a container with an app label is touched, and
// not while a deployment of its app runs: the deployment is moving containers about. The request's context does not
// end it: a connection dropped between the stop and the start must not leave the app down.
func (d *Deployer) act(ctx context.Context, name string, restart bool) error {
	app, err := d.managedApp(ctx, name)
	if err != nil {
		return err
	}
	stop := int(config.DefaultStopTimeout.Seconds())
	if a, ok, err := d.lookupApp(ctx, app); err != nil {
		return err
	} else if ok && a.Stop() > 0 {
		stop = int(a.Stop().Seconds())
	}
	if !d.reserve(app) {
		return ErrBusy
	}
	defer d.release(app)

	ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), time.Duration(stop)*time.Second+restartGrace)
	defer cancel()
	if restart {
		d.log.Info("restarting a container", "app", app, "container", name)
		if err := d.eng.Stop(ctx, name, stop); err != nil {
			return fmt.Errorf("stop %s: %w", name, err)
		}
	}
	if err := d.eng.Start(ctx, name); err != nil {
		return fmt.Errorf("start %s: %w", name, err)
	}
	d.log.Info("a container is running", "app", app, "container", name, "restart", restart)
	// Docker may give a restarted container another host port: point the proxy at the one it has now at once,
	// instead of at the next reconcile. The reconcile loop is the safety net, hence a failure here is only logged.
	if err := d.Reconcile(ctx); err != nil {
		d.log.Warn("could not reconcile the proxy after a container was started", "container", name, "err", err)
	}
	return nil
}

// managedApp returns the app a container belongs to: the value of its app label. A container that does not exist
// is a docker not-found error, one without the label ErrNotManaged.
func (d *Deployer) managedApp(ctx context.Context, name string) (string, error) {
	list, err := d.eng.ListByLabel(ctx, appLabel)
	if err != nil {
		return "", err
	}
	for _, c := range list {
		if c.Name == name {
			if app := c.Labels[appLabel]; app != "" {
				return app, nil
			}
		}
	}
	if _, err := d.eng.Inspect(ctx, name); err != nil {
		return "", err // not found, or an invalid name
	}
	return "", ErrNotManaged
}
