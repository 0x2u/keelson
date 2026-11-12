package config

// What is left of the apps that only build (build.only): a server that builds for others declares build_limits, and the
// builds come through POST /v1/builds. An app with build.only still loads, with a deprecation warning, and still builds
// through the old route. `keelson-agent config migrate --drop-builders` removes these apps and writes the build_limits
// that cover what they were allowed.

import (
	"fmt"

	"gopkg.in/yaml.v3"
)

// BuildOnly reports whether the app only builds its image here (build.only).
func (a App) BuildOnly() bool { return a.Build != nil && a.Build.Only }

// validateBuildOnly refuses what a builder cannot use: anything that describes a running container. port and
// health_path stay: a framework preset writes them into the image it builds.
func validateBuildOnly(a *App) error {
	for _, f := range []struct {
		name string
		set  bool
	}{
		{"domains", len(a.Domains) > 0}, {"publish", len(a.Publish) > 0}, {"port.host", len(a.Port.Host) > 0}, {"volumes", len(a.Volumes) > 0},
		{"release", a.Release != nil}, {"env_file", a.EnvFile != ""}, {"env", len(a.Env) > 0}, {"network", a.Network != ""},
		{"command", len(a.Command) > 0}, {"port.env", a.Port.Env != ""},
	} {
		if f.set {
			return fmt.Errorf("build.only: %s describes a running container, and nothing runs here: put it on the app that runs the image", f.name)
		}
	}
	return nil
}

// buildOnly flags a builder app: the upgrade cannot rewrite it (its replacement is a different thing), so it is a
// leftover until the migration is asked to drop the builders.
func (u *upgrader) buildOnly(d *parsedDoc, app, build *yaml.Node, p string) {
	k, v, i := entry(build, "only")
	if i < 0 || !isTrue(v) {
		return
	}
	u.leftover(d, k.Line, p+".build.only", "build.only", "build_limits",
		fmt.Sprintf("%s.build.only is deprecated: a server that builds for others declares build_limits and receives builds through POST /v1/builds (config migrate --drop-builders rewrites it)", p))
}
