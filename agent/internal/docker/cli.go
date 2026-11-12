package docker

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"regexp"
	"sort"
	"strings"
)

// CLI builds images by running the `docker` command, which drives BuildKit. The engine's own classic builder cannot
// build for another platform on a Docker Desktop that stores images with containerd (it fails exporting the image: "content
// digest … not found"); BuildKit can, and talking to BuildKit needs a session the command already knows how to hold.
type CLI struct {
	// Bin is the command, "docker" by default (looked up in PATH when the build starts).
	Bin string
	// Socket is the engine's unix socket: the command is pointed at it, whatever its own context says.
	Socket string
}

// NewCLI returns a CLI builder for the engine at socket.
func NewCLI(socket string) *CLI { return &CLI{Bin: "docker", Socket: socket} }

// argName is what a build argument may be called to travel in the command's environment.
var argName = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`)

// reservedEnv are the names the command needs for itself, and prefixes that change how a process behaves: a build argument
// of that name would be passed by the environment, so it cannot be one.
var reservedEnv = map[string]bool{"PATH": true, "HOME": true, "USER": true, "TMPDIR": true, "SHELL": true}

func reservedArg(name string) bool {
	if reservedEnv[name] {
		return true
	}
	for _, p := range []string{"DOCKER_", "BUILDKIT_", "BUILDX_", "COMPOSE_", "LD_", "DYLD_"} {
		if strings.HasPrefix(name, p) {
			return true
		}
	}
	return false
}

// Build has the signature of Admin.Build. The context is the tar stream on the command's standard input; build arguments
// travel in its environment (`--build-arg NAME`), never on the command line where any process of the machine could read
// them. The command's output goes to out line by line. The caps of opt.MemoryBytes and opt.CPUs are not applied: BuildKit
// does not take them (the limits of the machine's Docker apply).
func (c *CLI) Build(ctx context.Context, opt BuildOptions, buildContext io.Reader, out func(line string)) error {
	if !imageRef.MatchString(opt.Tag) {
		return ErrInvalidImageRef
	}
	bin, err := exec.LookPath(c.Bin)
	if err != nil {
		return fmt.Errorf("building for %s needs the %q command on this machine, and it is not in PATH", opt.Platform, c.Bin)
	}
	args := []string{"build", "--progress=plain", "--tag", opt.Tag}
	if opt.Platform != "" {
		args = append(args, "--platform", opt.Platform)
	}
	if opt.Dockerfile != "" {
		args = append(args, "--file", opt.Dockerfile)
	}
	if opt.Target != "" {
		args = append(args, "--target", opt.Target)
	}
	switch {
	case opt.Network == "":
	case opt.Network == "none" || opt.Network == "bridge" || opt.Network == "default" || !buildNetwork.MatchString(opt.Network):
		return fmt.Errorf("docker: build network %q is not supported", opt.Network)
	default:
		args = append(args, "--network", opt.Network)
	}
	env := []string{"PATH=" + os.Getenv("PATH"), "HOME=" + os.Getenv("HOME"), "DOCKER_BUILDKIT=1"}
	if c.Socket != "" {
		env = append(env, "DOCKER_HOST=unix://"+c.Socket)
	}
	if v := os.Getenv("DOCKER_CONFIG"); v != "" {
		env = append(env, "DOCKER_CONFIG="+v)
	}
	names := make([]string, 0, len(opt.Args))
	for name := range opt.Args {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		if !argName.MatchString(name) || reservedArg(name) {
			return fmt.Errorf("docker: the build argument %q cannot be passed to a build for another platform (its name is not a plain variable name, or is one the command uses itself)", name)
		}
		args = append(args, "--build-arg", name)
		env = append(env, name+"="+opt.Args[name])
	}
	labels := make([]string, 0, len(opt.Labels))
	for k, v := range opt.Labels {
		labels = append(labels, k+"="+v)
	}
	sort.Strings(labels)
	for _, l := range labels {
		args = append(args, "--label", l)
	}
	args = append(args, "-") // the context comes on standard input, as a tar archive

	cmd := exec.CommandContext(ctx, bin, args...)
	cmd.Env = env
	cmd.Stdin = buildContext
	pipe, err := cmd.StdoutPipe()
	if err != nil {
		return err
	}
	cmd.Stderr = cmd.Stdout // BuildKit's plain progress is on standard error: one stream, in order
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("start %s: %w", c.Bin, err)
	}
	lines := lineSplitter{emit: out}
	var last string // the last "ERROR" line: what failed, in BuildKit's words
	sc := bufio.NewReaderSize(pipe, 64<<10)
	for {
		chunk, rerr := sc.ReadString('\n')
		if chunk != "" {
			if t := strings.TrimSpace(chunk); strings.HasPrefix(t, "ERROR:") || strings.Contains(t, " ERROR: ") {
				last = t
			}
			lines.write(chunk)
		}
		if rerr != nil {
			break
		}
	}
	lines.flush()
	if err := cmd.Wait(); err != nil {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		var ee *exec.ExitError
		if errors.As(err, &ee) {
			msg := fmt.Sprintf("docker build exited with status %d", ee.ExitCode())
			if last != "" {
				msg = last
			}
			return &BuildError{Message: msg}
		}
		return fmt.Errorf("docker build: %w", err)
	}
	return nil
}
