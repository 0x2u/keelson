package config

import (
	"errors"
	"fmt"
	"maps"
	"math"
	"net"
	"path"
	"regexp"
	"slices"
	"strings"
	"time"
)

// Build limits and defaults.
const (
	DefaultBuildTimeout    = 15 * time.Minute
	MaxBuildTimeout        = time.Hour
	DefaultBuildMemory     = 2 << 30
	MinBuildMemory         = 64 << 20
	DefaultBuildCPUs       = 2.0
	MaxBuildCPUs           = 256.0
	MinBuildCPUs           = 0.1
	DefaultBuildMaxSource  = 512 << 20
	MinBuildMaxSource      = 1 << 20
	MaxBuildMaxSource      = 8 << 30
	DefaultBuildDockerfile = "Dockerfile"
	DefaultBuildContext    = "."

	maxBuildArgs       = 64
	maxBuildArgValue   = 4096
	maxBuildSourceHost = 16
)

// BuildPlatforms are the platforms a build may target.
var BuildPlatforms = []string{"linux/amd64", "linux/arm64"}

// BuildNetworkHost runs a build's containers on the server's own network.
const BuildNetworkHost = "host"

// BuildDatabaseArg is the build argument set to "1" when the app's build block says `database: true` AND the app has not
// served yet: the build's database is the one the agent created for it, still new and empty. A Dockerfile creates its tables
// only when it is set, so that a database holding data (a native one reached through a variable the operator flagged for
// builds, or the managed one after the first deployment) is never migrated by a build, before the backup a release step takes.
const BuildDatabaseArg = "KEELSON_BUILD_DATABASE"

// DefaultSourceHosts are the hosts a build may download its source from when the app does not say otherwise: the GitHub
// API (which redirects to the codeload host).
var DefaultSourceHosts = []string{"api.github.com", "codeload.github.com"}

var (
	buildArgPattern    = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`)
	buildTargetPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$`)
	buildNetworkName   = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$`)
)

// Build lets the agent build the app's image itself from a source archive the dashboard hands it (a GitHub App
// installation: see docs/hosting.md), instead of pulling an image CI built. The agent downloads the source,
// builds it with Docker on this server, tags the result "<image>:<commit sha>" locally and deploys it through the usual
// pipeline. Nothing is pushed to a registry, and nothing builds unless a build is requested: declaring this block only
// makes the app able to.
//
// A build executes the repository's Dockerfile on this server (or the Dockerfile of its preset). Build inputs are
// separate from deploy inputs: the arguments are not secret, and no secret (the app's env, its registries) is ever
// given to a build.
type Build struct {
	// Preset makes the agent write the Dockerfile itself: nextjs, node, vite or static (see presets.go). Empty builds
	// the repository's own Dockerfile. A preset and a dockerfile are alternatives.
	Preset string `yaml:"preset" json:"preset"`
	// Dockerfile is the path of the Dockerfile inside Context. Default "Dockerfile". Not with a preset.
	Dockerfile string `yaml:"dockerfile" json:"dockerfile"`
	// Install, BuildCommand, Start, OutputDir, Node, SPA and Standalone tune a preset; they are refused without one.
	// Their defaults are in presets.go.
	Install      string `yaml:"install" json:"install"`
	BuildCommand string `yaml:"build_command" json:"build_command"`
	Start        string `yaml:"start" json:"start"`
	OutputDir    string `yaml:"output_dir" json:"output_dir"`
	Node         string `yaml:"node" json:"node"`
	SPA          *bool  `yaml:"spa" json:"spa"`
	Standalone   bool   `yaml:"standalone" json:"standalone"`
	// Context is the subdirectory of the repository sent to Docker as the build context. Default ".".
	Context string `yaml:"context" json:"context"`
	// Target is the multi-stage target to build; empty builds the last stage.
	Target string `yaml:"target" json:"target"`
	// Args are build arguments. They are NOT secret: they appear in the image history and in this document.
	Args map[string]string `yaml:"args" json:"args"`
	// Timeout bounds the whole build, source download included. Default 15m, at most 1h.
	Timeout *Duration `yaml:"timeout" json:"timeout"`
	// Memory caps the memory of the build's containers, such as "2g". Default 2g.
	Memory *Size `yaml:"memory" json:"memory"`
	// CPUs caps their CPU time, in cores. Default 2.
	CPUs *float64 `yaml:"cpus" json:"cpus"`
	// MaxSource is the largest source archive that is accepted, such as "512m". Default 512m.
	MaxSource *Size `yaml:"max_source" json:"max_source"`
	// Network is the network the build's containers run on: empty is the engine's default bridge, "host" is the server's
	// own network, any other value the name of a user-defined Docker network (such as the one the managed PostgreSQL lives
	// on). Host is for a build that must reach something only the server sees (a database on 127.0.0.1 that a framework
	// queries while it builds): the build's code then sees every port the server listens on, so turn it on only for a
	// repository you trust to that level. A named network gives the build the containers on it, no more. Empty with
	// `database: true` picks the network that reaches the app's managed database.
	Network string `yaml:"network" json:"network"`
	// Database lets the build use the app's managed database: its URL is passed to the build as a build argument (the
	// one case where a managed database's password reaches a build), and the build runs on the network that reaches it.
	// For a build that queries its database to build (static pages filled from it) on a database that is new and empty.
	Database bool `yaml:"database" json:"database"`
	// Platform is the platform the image is built for, "linux/amd64" or "linux/arm64". Empty builds for the engine's own.
	// It is what lets a build machine of another architecture (an Apple-silicon Mac) produce what the server runs.
	Platform string `yaml:"platform" json:"platform"`
	// Only makes the app a builder: this server builds its image and keeps it, nothing runs here. The dashboard then
	// sends the image to the app that runs it, on another server (a build needs memory a small server of a site does not
	// have to spare, and a server that builds can build for several). A build-only app has no container, no routing, no
	// release steps and no volumes, and cannot be deployed or rolled back: its image is only built and exported.
	//
	// Deprecated: a server that builds for others declares build_limits, and the builds come through POST /v1/builds
	// (see legacy_builder.go). Still read, with a deprecation warning, until the legacy code is removed.
	Only bool `yaml:"only" json:"only"`
	// SourceHosts are the hosts the source may be downloaded from (an exact match on the host name; redirects may only
	// go to these too, and to GitHub's codeload host). For GitHub Enterprise Server, list its host.
	SourceHosts []string `yaml:"source_hosts" json:"source_hosts"`
}

// Clone returns a deep copy, nil for nil.
func (b *Build) Clone() *Build {
	if b == nil {
		return nil
	}
	c := *b
	c.Args = maps.Clone(b.Args)
	c.SourceHosts = slices.Clone(b.SourceHosts)
	if b.SPA != nil {
		v := *b.SPA
		c.SPA = &v
	}
	c.Timeout = b.Timeout.clone()
	if b.Memory != nil {
		v := *b.Memory
		c.Memory = &v
	}
	if b.CPUs != nil {
		v := *b.CPUs
		c.CPUs = &v
	}
	if b.MaxSource != nil {
		v := *b.MaxSource
		c.MaxSource = &v
	}
	return &c
}

// TimeoutFor bounds the whole build (the default when unset).
func (b *Build) TimeoutFor() time.Duration {
	if b.Timeout == nil {
		return DefaultBuildTimeout
	}
	return b.Timeout.Std()
}

// MemoryBytes is the memory cap of the build in bytes (the default when unset).
func (b *Build) MemoryBytes() int64 {
	if b.Memory == nil {
		return DefaultBuildMemory
	}
	return b.Memory.Bytes()
}

// CPUCount is the CPU cap of the build, in cores (the default when unset).
func (b *Build) CPUCount() float64 {
	if b.CPUs == nil {
		return DefaultBuildCPUs
	}
	return *b.CPUs
}

// MaxSourceBytes is the largest accepted source archive in bytes (the default when unset).
func (b *Build) MaxSourceBytes() int64 {
	if b.MaxSource == nil {
		return DefaultBuildMaxSource
	}
	return b.MaxSource.Bytes()
}

// validateBuild checks the build block of one app and fills its defaults.
func validateBuild(a *App) error {
	b := a.Build
	if b == nil {
		return nil
	}
	var err error
	if b.Preset != "" {
		if err := validatePreset(a, b); err != nil {
			return err
		}
	} else {
		if err := refusePresetOptions(b); err != nil {
			return err
		}
		if b.Dockerfile, err = cleanBuildPath("dockerfile", b.Dockerfile, DefaultBuildDockerfile); err != nil {
			return err
		}
	}
	if b.Context, err = cleanBuildPath("context", b.Context, DefaultBuildContext); err != nil {
		return err
	}
	if b.Dockerfile == "." {
		return errors.New("build: dockerfile must name a file")
	}
	if b.Target != "" && !buildTargetPattern.MatchString(b.Target) {
		return fmt.Errorf("build: target must match %s", buildTargetPattern)
	}
	if len(b.Args) > maxBuildArgs {
		return fmt.Errorf("build: at most %d args", maxBuildArgs)
	}
	for k, v := range b.Args {
		if !buildArgPattern.MatchString(k) {
			return fmt.Errorf("build: arg %q must match %s", k, buildArgPattern)
		}
		if len(v) > maxBuildArgValue || strings.ContainsRune(v, 0) {
			return fmt.Errorf("build: the value of arg %q is too long or contains a NUL byte", k)
		}
	}
	switch {
	case b.Timeout == nil:
		b.Timeout = D(DefaultBuildTimeout)
	case b.Timeout.Std() <= 0 || b.Timeout.Std() > MaxBuildTimeout:
		return fmt.Errorf("build: timeout must be between 1s and %s", FormatDuration(MaxBuildTimeout))
	}
	switch {
	case b.Memory == nil:
		b.Memory = S(DefaultBuildMemory)
	case b.Memory.Bytes() < MinBuildMemory:
		return errors.New("build: memory must be at least 64m")
	}
	switch {
	case b.CPUs == nil:
		v := DefaultBuildCPUs
		b.CPUs = &v
	case math.IsNaN(*b.CPUs) || *b.CPUs < MinBuildCPUs || *b.CPUs > MaxBuildCPUs:
		return fmt.Errorf("build: cpus must be between %g and %g", MinBuildCPUs, MaxBuildCPUs)
	}
	if err := validateBuildNetwork(b.Network); err != nil {
		return err
	}
	if b.Platform != "" && !slices.Contains(BuildPlatforms, b.Platform) {
		return fmt.Errorf("build: platform must be empty (the engine's own) or one of %s", strings.Join(BuildPlatforms, ", "))
	}
	switch {
	case b.MaxSource == nil:
		b.MaxSource = S(DefaultBuildMaxSource)
	case b.MaxSource.Bytes() < MinBuildMaxSource || b.MaxSource.Bytes() > MaxBuildMaxSource:
		return errors.New("build: max_source must be between 1m and 8g")
	}
	return validateSourceHosts(b)
}

// validateBuildNetwork accepts the default bridge (empty), the server's network, or the name of a user-defined network. Not
// "none", "bridge" or "default" (the first two are not what a build needs, the third is empty), and not `container:` or
// anything else that is not a plain network name.
func validateBuildNetwork(n string) error {
	switch {
	case n == "" || n == BuildNetworkHost:
		return nil
	case n == "none" || n == "bridge" || n == "default" || !buildNetworkName.MatchString(n):
		return fmt.Errorf("build: network must be empty (the default bridge), %q, or the name of a user-defined Docker network", BuildNetworkHost)
	}
	return nil
}

// BuildNetwork is the network the app's build runs on: the one its build block names, else (with `database: true`) the one
// that reaches the app's managed database (the server's own network for an app on it, the managed PostgreSQL's network
// otherwise), else the engine's default bridge (empty).
func (a App) BuildNetwork() string {
	switch {
	case a.Build == nil:
		return ""
	case a.Build.Network != "":
		return a.Build.Network
	case !a.Build.Database:
		return ""
	case a.HostNetwork():
		return BuildNetworkHost
	case a.CanJoinNetworks():
		return ManagedPostgresNetwork
	}
	return ""
}

// cleanBuildPath checks a path that is relative to the repository (context) or to the context (dockerfile): no
// absolute path, no "..", and returns its clean form.
func cleanBuildPath(key, p, def string) (string, error) {
	if p == "" {
		return def, nil
	}
	if strings.ContainsAny(p, "\\\x00") || strings.HasPrefix(p, "/") {
		return "", fmt.Errorf("build: %s must be a relative path inside the repository", key)
	}
	c := path.Clean(p)
	if c == ".." || strings.HasPrefix(c, "../") {
		return "", fmt.Errorf("build: %s must not leave the repository (no ..)", key)
	}
	return c, nil
}

func validateSourceHosts(b *Build) error {
	if len(b.SourceHosts) == 0 {
		b.SourceHosts = slices.Clone(DefaultSourceHosts)
		return nil
	}
	if len(b.SourceHosts) > maxBuildSourceHost {
		return fmt.Errorf("build: at most %d source_hosts", maxBuildSourceHost)
	}
	seen := map[string]bool{}
	out := make([]string, 0, len(b.SourceHosts))
	for _, h := range b.SourceHosts {
		h = strings.ToLower(strings.TrimSpace(h))
		if len(h) > 253 || !domainPattern.MatchString(h) || net.ParseIP(h) != nil {
			return fmt.Errorf("build: source_hosts entry %q must be a plain host name (no scheme, port, path or IP address)", h)
		}
		if !seen[h] {
			seen[h] = true
			out = append(out, h)
		}
	}
	b.SourceHosts = out
	return nil
}
