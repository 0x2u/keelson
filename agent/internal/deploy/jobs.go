package deploy

import (
	"context"
	"errors"
	"fmt"

	"github.com/0x2u/keelson/agent/internal/docker"
	"github.com/0x2u/keelson/agent/internal/store"
)

// jobLabel marks the throwaway containers of scheduled container jobs.
const jobLabel = "keelson.job"

// ErrNotServing is returned for a container job whose app has no version
// serving yet: there is no image to run the command from.
var ErrNotServing = errors.New("the app has no serving version yet")

// RunOneOff runs command in a throwaway container made from the version the
// app is serving now, with the app's environment, volumes and network, and
// streams its output to out. A non-zero exit code is an error. The caller's
// context bounds the run (the container is removed when it ends).
func (d *Deployer) RunOneOff(ctx context.Context, app string, command []string, out func(line string)) error {
	a, ok := d.config().App(app)
	if !ok {
		return ErrUnknownApp
	}
	ref, err := d.currentRef(ctx, a)
	if err != nil {
		return err
	}
	if ref == "" {
		return ErrNotServing
	}
	env, err := d.environment(a, "")
	if err != nil {
		return fmt.Errorf("read environment: %w", err)
	}

	code, err := docker.RunThrowaway(ctx, d.eng, d.log, docker.ContainerSpec{
		Name:          fmt.Sprintf("%s-job-%s", a.Name, store.NewID()),
		Image:         ref,
		Env:           env,
		Labels:        map[string]string{"keelson.app": a.Name, jobLabel: "true"},
		Cmd:           command,
		Binds:         a.Volumes,
		NetworkMode:   a.Network,
		ExtraNetworks: d.config().ExtraNetworks(a),
		RestartPolicy: "no",
		StopTimeout:   int(a.Stop().Seconds()),
	}, out)
	switch {
	case errors.Is(ctx.Err(), context.DeadlineExceeded):
		return fmt.Errorf("timed out")
	case err != nil:
		return err
	case code != 0:
		return fmt.Errorf("exit code %d", code)
	}
	return nil
}
