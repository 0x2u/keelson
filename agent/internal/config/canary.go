package config

import (
	"errors"
	"fmt"
	"time"
)

// Canary bounds. A canary keeps two copies of the app alive for the whole rollout, steps times the hold, so the product
// is what a small server can carry; the floor on the hold gives a step enough requests to show anything.
const (
	MaxCanarySteps     = 5
	DefaultCanaryHold  = time.Minute
	MinCanaryHold      = 10 * time.Second
	MaxCanaryHold      = 10 * time.Minute
	minCanaryPercent   = 1
	maxCanaryPercent   = 99
	canaryStepsExample = "steps: [10, 50]"
)

// Canary replaces the single traffic switch of a blue/green deployment by a progression: the new version receives a
// share of the visitors, is watched, receives more, and takes everything after the last step. A step that fails (the
// container, a verify path or a metric gate) sends every visitor back to the previous version, which never stopped.
//
// The share is of visitors, not of requests: a cookie keeps a browser on the version it was given, so that a page and
// the assets it references (hashed bundles of a front-end build) come from the same version. Only Caddy can do that.
type Canary struct {
	// Steps are the shares of visitors, in percent (1 to 99, rising, at most 5), the new version receives one after
	// the other: [10, 50] sends it 10% for one hold, then 50% for one hold, then 100%.
	Steps []int `yaml:"steps"`
	// Hold is how long each step is watched before the next one. Default 1m, from 10s to 10m. Each step is judged
	// afresh: the checks of verify and the metrics of analysis run during every one.
	Hold *Duration `yaml:"hold"`
}

// HoldFor is how long each step is watched. Loading a file always sets it; an App built by hand has the default.
func (c Canary) HoldFor() time.Duration {
	if c.Hold == nil {
		return DefaultCanaryHold
	}
	return c.Hold.Std()
}

// CanaryTime is the time the steps of a canary take: zero for an app without one.
func (a App) CanaryTime() time.Duration {
	if a.Canary == nil {
		return 0
	}
	return time.Duration(len(a.Canary.Steps)) * a.Canary.HoldFor()
}

func (c *Config) validateCanary(a *App) error {
	if a.Canary == nil {
		return nil
	}
	if !a.Proxied() {
		return errors.New("canary is only used with deploy.strategy switch (an app with port or domains): it shares the traffic between two running versions")
	}
	if c.Proxy != nil && c.Proxy.Type == ProxyNginx {
		return errors.New("canary needs proxy type caddy: nginx cannot keep a visitor on one version")
	}
	k := a.Canary
	if n := len(k.Steps); n == 0 || n > MaxCanarySteps {
		return fmt.Errorf("canary lists %d steps: between 1 and %d, such as %s", len(k.Steps), MaxCanarySteps, canaryStepsExample)
	}
	for i, p := range k.Steps {
		switch {
		case p < minCanaryPercent || p > maxCanaryPercent:
			return fmt.Errorf("canary.steps[%d] is %d: a step is a percentage from %d to %d (100 is the end of the rollout, it needs no step)", i, p, minCanaryPercent, maxCanaryPercent)
		case i > 0 && p <= k.Steps[i-1]:
			return fmt.Errorf("canary.steps[%d] is %d after %d: the steps must rise", i, p, k.Steps[i-1])
		}
	}
	switch {
	case k.Hold == nil:
		k.Hold = D(DefaultCanaryHold)
	case k.Hold.Std() < MinCanaryHold || k.Hold.Std() > MaxCanaryHold:
		return fmt.Errorf("canary.hold must be between %s and %s", FormatDuration(MinCanaryHold), FormatDuration(MaxCanaryHold))
	}
	return nil
}
