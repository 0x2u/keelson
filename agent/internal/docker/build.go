package docker

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
)

// maxBuildLine bounds one line of build output handed to the caller.
const maxBuildLine = 4096

// buildNetwork is what a build's network may be called: the server's "host", or a user-defined network's plain name.
var buildNetwork = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$`)

// BuildOptions describes one image build. The build context is a tar stream sent with it.
type BuildOptions struct {
	// Tag is the reference the image gets, "repo:tag".
	Tag string
	// Dockerfile is the path of the Dockerfile inside the context.
	Dockerfile string
	// Target is the multi-stage target; empty builds the last stage.
	Target string
	// Args are the build arguments.
	Args map[string]string
	// Labels are put on the image.
	Labels map[string]string
	// MemoryBytes caps the memory of the build's containers, swap included (zero: no cap).
	MemoryBytes int64
	// CPUs caps their CPU time, in cores (zero: no cap).
	CPUs float64
	// Network is "" for the engine's default bridge, "host" for the server's own network, or the name of a user-defined
	// network; "none", "bridge", `container:` and anything that is not a plain network name are refused.
	Network string
	// Platform is "os/arch" ("linux/amd64"); empty builds for the engine's own platform.
	Platform string
}

// BuildError is a failure the engine reported inside the build stream: the Dockerfile's, not the transport's.
type BuildError struct{ Message string }

func (e *BuildError) Error() string { return e.Message }

// Build builds an image from the tar stream context with the engine's own builder and tags it. Every line of the
// builder's output goes to out. The containers of the build run with the caps of opt, unprivileged and without any host
// path or socket, on the default bridge network unless opt.Network names another; intermediate containers are removed
// whatever happens, and the engine abandons the build when ctx ends. Base images that are missing are pulled by the
// engine, as docker does.
func (a *Admin) Build(ctx context.Context, opt BuildOptions, buildContext io.Reader, out func(line string)) error {
	if !imageRef.MatchString(opt.Tag) {
		return ErrInvalidImageRef
	}
	q := url.Values{
		"t":       {opt.Tag},
		"rm":      {"1"},
		"forcerm": {"1"},
		"pull":    {"0"},
	}
	switch {
	case opt.Network == "":
	case opt.Network == "none" || opt.Network == "bridge" || opt.Network == "default" || !buildNetwork.MatchString(opt.Network):
		return fmt.Errorf("docker: build network %q is not supported", opt.Network)
	default:
		q.Set("networkmode", opt.Network) // "host", or the name of a user-defined network
	}
	if opt.Platform != "" {
		q.Set("platform", opt.Platform)
	}
	if opt.Dockerfile != "" {
		q.Set("dockerfile", opt.Dockerfile)
	}
	if opt.Target != "" {
		q.Set("target", opt.Target)
	}
	if len(opt.Args) > 0 {
		b, err := json.Marshal(opt.Args)
		if err != nil {
			return err
		}
		q.Set("buildargs", string(b))
	}
	if len(opt.Labels) > 0 {
		b, err := json.Marshal(opt.Labels)
		if err != nil {
			return err
		}
		q.Set("labels", string(b))
	}
	if opt.MemoryBytes > 0 {
		q.Set("memory", strconv.FormatInt(opt.MemoryBytes, 10))
		q.Set("memswap", strconv.FormatInt(opt.MemoryBytes, 10)) // equal to memory: no swap
	}
	if opt.CPUs > 0 {
		const period = 100000
		q.Set("cpuperiod", strconv.Itoa(period))
		q.Set("cpuquota", strconv.FormatInt(int64(opt.CPUs*period), 10))
	}

	resp, err := request(ctx, a.hc, http.MethodPost, "/build", q, buildContext, map[string]string{"Content-Type": "application/x-tar"})
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	// The engine answers 200 and reports failures inside the JSON stream.
	lines := lineSplitter{emit: out}
	dec := json.NewDecoder(resp.Body)
	for {
		var m struct {
			Stream string `json:"stream"`
			Error  string `json:"error"`
		}
		if err := dec.Decode(&m); err != nil {
			lines.flush()
			if errors.Is(err, io.EOF) {
				return nil
			}
			if ctx.Err() != nil {
				return ctx.Err()
			}
			return fmt.Errorf("read build output: %w", err)
		}
		lines.write(m.Stream)
		if m.Error != "" {
			lines.flush()
			return &BuildError{Message: m.Error}
		}
	}
}

// lineSplitter turns the builder's chunks of text into lines of bounded length.
type lineSplitter struct {
	emit func(string)
	buf  strings.Builder
}

func (l *lineSplitter) write(s string) {
	for s != "" {
		i := strings.IndexByte(s, '\n')
		if i < 0 {
			l.buf.WriteString(s)
			if l.buf.Len() >= maxBuildLine {
				l.flush() // a line that never ends must not grow without bound
			}
			return
		}
		l.buf.WriteString(s[:i])
		l.flush()
		s = s[i+1:]
	}
}

func (l *lineSplitter) flush() {
	if l.buf.Len() == 0 {
		return
	}
	line := strings.TrimRight(l.buf.String(), "\r")
	l.buf.Reset()
	if len(line) > maxBuildLine {
		line = strings.ToValidUTF8(line[:maxBuildLine], "") + "…"
	}
	if l.emit != nil && line != "" {
		l.emit(line)
	}
}
