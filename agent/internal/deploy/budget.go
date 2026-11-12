package deploy

import (
	"context"
	"time"

	"github.com/0x2u/keelson/agent/internal/config"
)

// A deployment has no single deadline of 15 minutes: that bound used to cover the pull, the release steps and the health
// gate together, so a 20 minute backup step was silently cut at 15 and a slow pull left the health gate nothing. Each
// phase now has its own budget, and the deployment as a whole is bounded by their sum (deployBudget).
const (
	// pullTimeout bounds one pull (or the check that a local image is there).
	pullTimeout = 15 * time.Minute
	// cleanupTimeout bounds what undoes a failed step (removing the new container, switching the proxy back, restoring
	// the previous container): it runs on a context of its own, so that a deadline that has passed never leaves a
	// half-replaced app behind.
	cleanupTimeout = 2 * time.Minute
	// probeTimeout is the timeout of one request of a probe (see New): a soak round asks each path up to twice.
	probeTimeout = 3 * time.Second
)

// cleanupContext returns a context that is not cancelled with ctx, nor expired when ctx is: cleanup must always run.
func cleanupContext(ctx context.Context) (context.Context, context.CancelFunc) {
	return context.WithTimeout(context.WithoutCancel(ctx), cleanupTimeout)
}

// releaseBudget is the time the release steps may take: the sum of their own timeouts, plus a pull for a step that
// brings its own image.
func releaseBudget(a config.App) time.Duration {
	if a.Release == nil {
		return 0
	}
	var total time.Duration
	for _, s := range a.Release.Steps {
		total += s.RunTimeout()
		if s.Container != nil && s.Container.Image != "" {
			total += pullTimeout
		}
	}
	return total
}

// healthBudget is the time the new container has to start and pass the health gate: the wait for health and the
// stability that follows it, the probe of health_path, and, for an app replaced in place, the same again for the
// previous container that comes back; plus the grace periods of the stops involved and the cleanup.
func healthBudget(a config.App) time.Duration {
	wait := a.HealthWait() + a.StableWait()
	return 2*wait + a.HealthWait() + 2*a.Stop() + cleanupTimeout
}

// soakBudget is the time from the traffic switch to the end of the deployment: the drain, the soak with its last round
// of requests, the stop of the previous container or the way back to it, and the cleanup.
func soakBudget(a config.App) time.Duration {
	rounds := time.Duration(len(a.Verify)+1) * 2 * probeTimeout
	return a.DrainFor() + a.SoakFor() + rounds + 2*a.Stop() + cleanupTimeout
}

// deployBudget bounds the whole deployment (everything after the build): the sum of the budgets of its phases.
func deployBudget(a config.App) time.Duration {
	return pullTimeout + releaseBudget(a) + healthBudget(a) + soakBudget(a)
}
