package deploy

import (
	"fmt"
	"strings"

	"github.com/0x2u/keelson/agent/internal/appenv"
	"github.com/0x2u/keelson/agent/internal/config"
)

// SetEnvStore enables the variables set through the API: the environment of every container the deployer creates (apps,
// release steps, one-off jobs, preview instances) is then the apps file's, overridden by the stored ones. Call it
// before the deployer serves requests.
func (d *Deployer) SetEnvStore(st *appenv.Store) {
	d.env = &appenv.Service{Store: st, Config: d.config}
}

// Env is the service behind the variables API; nil when no store was set.
func (d *Deployer) Env() *appenv.Service { return d.env }

// environment is the environment of the container to run for a: one consistent read of the stored variables, merged
// over the apps file's. A stored key the agent owns for this app is left out, and the deployment's log (id, when it
// has one) says so, by name.
func (d *Deployer) environment(a config.App, id string) ([]string, error) {
	env, ignored, err := d.env.Effective(a)
	if err != nil {
		return nil, err
	}
	if len(ignored) > 0 && id != "" {
		d.event(id, "warn", "stored variables left out because the agent controls them for this app: %s", strings.Join(ignored, ", "))
	}
	return env, nil
}

// EnvVar returns a variable of an app's environment (the apps file's and the stored ones), read now so a rotated
// secret is picked up without a restart.
func (d *Deployer) EnvVar(app, name string) (string, error) {
	a, ok := d.config().App(app)
	if !ok {
		return "", ErrUnknownApp
	}
	env, err := d.environment(a, "")
	if err != nil {
		return "", fmt.Errorf("read environment: %w", err)
	}
	prefix := name + "="
	for i := len(env) - 1; i >= 0; i-- { // the last entry wins, as in Docker
		if len(env[i]) >= len(prefix) && env[i][:len(prefix)] == prefix {
			return env[i][len(prefix):], nil
		}
	}
	return "", fmt.Errorf("%s is not set in the environment of %s", name, app)
}
