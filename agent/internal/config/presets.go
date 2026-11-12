package config

import (
	"errors"
	"fmt"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"unicode/utf8"
)

// The build presets: the agent writes the Dockerfile of the app itself, so a repository without one can be built.
// Presets are chosen by the operator, never detected. See package build for the generated text.
const (
	PresetNextJS = "nextjs"
	PresetNode   = "node"
	PresetVite   = "vite"
	PresetStatic = "static"

	// PresetDockerfile is where the generated Dockerfile lives in the build context. The build refuses a repository
	// that already has a file of this name: a repository file is never overwritten.
	PresetDockerfile = ".keelson.Dockerfile"

	// DefaultPresetNode is the Node.js major version of the generated images.
	DefaultPresetNode = "22"
	// MinPresetNode is the oldest Node.js major version accepted.
	MinPresetNode = 18
	// DefaultPresetOutputDir is where Vite and most build tools write the site.
	DefaultPresetOutputDir = "dist"

	maxPresetCommand = 1024
)

// Presets are the values of build.preset, in the order the dashboard shows them.
var Presets = []string{PresetNextJS, PresetNode, PresetVite, PresetStatic}

var (
	presetNodePattern = regexp.MustCompile(`^[1-9][0-9]$`)
	// presetDirPattern keeps output_dir free of the characters COPY treats as wildcards, and of spaces.
	presetDirPattern = regexp.MustCompile(`^[A-Za-z0-9._/-]+$`)
	// presetHealthPattern is what a health path may hold for the generated image to carry it in an ENV line.
	presetHealthPattern = regexp.MustCompile(`^/[A-Za-z0-9._~/%?&=:@+,-]*$`)
)

// presetOptions say which tuning options each preset reads.
var presetOptions = map[string][]string{
	PresetNextJS: {"install", "build_command", "start", "node", "standalone"},
	PresetNode:   {"install", "build_command", "start", "node"},
	PresetVite:   {"install", "build_command", "output_dir", "node", "spa"},
	PresetStatic: {"install", "build_command", "output_dir", "node", "spa"},
}

// ValidPreset reports whether p is a preset name.
func ValidPreset(p string) bool {
	_, ok := presetOptions[p]
	return ok
}

// DockerfilePath is the Dockerfile the engine builds: the generated one with a preset, the configured one without.
func (b *Build) DockerfilePath() string {
	if b.Preset != "" {
		return PresetDockerfile
	}
	return b.Dockerfile
}

// SPAEnabled says whether unknown paths of a Vite or static site answer with /index.html (the default).
func (b *Build) SPAEnabled() bool { return b.SPA == nil || *b.SPA }

// HasBuildStage says whether the generated image builds the site with Node.js before serving it: always for the
// Vite, Next.js and Node presets, and for static only when it was given a build command.
func (b *Build) HasBuildStage() bool {
	return b.Preset != PresetStatic || b.BuildCommand != ""
}

// PresetPort is the container port the generated image listens on: the app's port, or the preset's default when the
// app has none (it is then not published, or the agent tells the container its host port through the environment).
func PresetPort(preset string, appPort int) int {
	switch {
	case appPort > 0:
		return appPort
	case preset == PresetStatic || preset == PresetVite:
		return 8080
	}
	return 3000
}

// setOptions names the preset options that carry a value.
func (b *Build) setOptions() []string {
	var out []string
	for _, o := range []struct {
		key string
		set bool
	}{
		{"install", b.Install != ""}, {"build_command", b.BuildCommand != ""}, {"start", b.Start != ""},
		{"output_dir", b.OutputDir != ""}, {"node", b.Node != ""}, {"spa", b.SPA != nil}, {"standalone", b.Standalone},
	} {
		if o.set {
			out = append(out, o.key)
		}
	}
	return out
}

// refusePresetOptions refuses preset options on a build without a preset: they would silently do nothing.
func refusePresetOptions(b *Build) error {
	if set := b.setOptions(); len(set) > 0 {
		return fmt.Errorf("build: %s only applies with a preset (nextjs, node, vite or static)", set[0])
	}
	return nil
}

// validatePreset checks a build block with a preset and fills its defaults. The generated Dockerfile replaces
// dockerfile and target, which are refused.
func validatePreset(a *App, b *Build) error {
	if !ValidPreset(b.Preset) {
		return fmt.Errorf("build: preset must be one of %s", strings.Join(Presets, ", "))
	}
	if b.Dockerfile != "" {
		return errors.New("build: preset and dockerfile are alternatives: a preset generates the Dockerfile, so remove one of them")
	}
	if b.Target != "" {
		return errors.New("build: target selects a stage of your own Dockerfile and cannot be used with a preset")
	}
	applies := presetOptions[b.Preset]
	for _, key := range b.setOptions() {
		if !slices.Contains(applies, key) {
			return fmt.Errorf("build: %s does not apply to the %s preset (it reads %s)", key, b.Preset, strings.Join(applies, ", "))
		}
	}
	if !b.HasBuildStage() {
		for _, key := range []string{"install", "node"} {
			if slices.Contains(b.setOptions(), key) {
				return fmt.Errorf("build: %s on the static preset needs a build_command: without one the files are served as they are", key)
			}
		}
	}
	for _, c := range []struct{ key, value string }{{"install", b.Install}, {"build_command", b.BuildCommand}, {"start", b.Start}} {
		if err := validatePresetCommand(c.key, c.value); err != nil {
			return err
		}
	}
	b.Install, b.BuildCommand, b.Start = strings.TrimSpace(b.Install), strings.TrimSpace(b.BuildCommand), strings.TrimSpace(b.Start)

	if b.HasBuildStage() {
		if b.Node == "" {
			b.Node = DefaultPresetNode
		}
		if n, _ := strconv.Atoi(b.Node); !presetNodePattern.MatchString(b.Node) || n < MinPresetNode {
			return fmt.Errorf("build: node must be a Node.js major version, %d or later, such as %q", MinPresetNode, DefaultPresetNode)
		}
	}
	if b.Preset == PresetVite || b.Preset == PresetStatic {
		if err := validatePresetOutputDir(b); err != nil {
			return err
		}
	}

	if (b.Preset == PresetStatic || b.Preset == PresetVite) && a.ContainerPort > 0 && a.ContainerPort < 1024 {
		return fmt.Errorf("port %d is below 1024: the %s preset runs nginx as a regular user, so it needs a port of 1024 or more (such as 8080)", a.ContainerPort, b.Preset)
	}
	if a.HealthPath != "" && !presetHealthPattern.MatchString(a.HealthPath) {
		return fmt.Errorf("health_path %q has characters the %s preset's image cannot carry: use letters, digits and . _ ~ / %% ? & = : @ + , -", a.HealthPath, b.Preset)
	}
	if len(a.HostPorts) > 0 && a.PortEnv != "PORT" {
		return fmt.Errorf("port.env must be PORT with the %s preset: the generated image reads its port from it", b.Preset)
	}
	return nil
}

// validatePresetCommand bounds a command that is passed to sh -c: one line, printable.
func validatePresetCommand(key, v string) error {
	if v == "" {
		return nil
	}
	if strings.TrimSpace(v) == "" {
		return fmt.Errorf("build: %s is blank", key)
	}
	if len(v) > maxPresetCommand {
		return fmt.Errorf("build: %s is longer than %d bytes", key, maxPresetCommand)
	}
	if !utf8.ValidString(v) {
		return fmt.Errorf("build: %s is not valid UTF-8", key)
	}
	for _, r := range v {
		if r == '\t' {
			continue
		}
		if r < 0x20 || r == 0x7f || r == 0x2028 || r == 0x2029 {
			return fmt.Errorf("build: %s must be a single line without control characters (a newline or NUL byte is refused)", key)
		}
	}
	return nil
}

func validatePresetOutputDir(b *Build) error {
	if b.OutputDir == "" {
		b.OutputDir = DefaultPresetOutputDir
	}
	dir, err := cleanBuildPath("output_dir", b.OutputDir, DefaultPresetOutputDir)
	if err != nil {
		return err
	}
	if !presetDirPattern.MatchString(dir) {
		return errors.New("build: output_dir may only hold letters, digits and . _ / -")
	}
	if dir == "." && b.HasBuildStage() {
		return errors.New("build: output_dir cannot be the whole project when it is built: name the directory the build writes")
	}
	b.OutputDir = dir
	return nil
}
