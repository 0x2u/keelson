// Package build builds an app's image on the agent's own host from a source archive, for the dashboard's GitHub App
// integration: it downloads the archive from a short-lived URL with a short-lived token, turns it into a Docker build
// context, has the engine build and tag it "<image>:<commit sha>", and reports the output, bounded, as it goes.
//
// Nothing here pushes an image, runs git, or needs the Docker CLI: the engine's own builder is driven through its API.
// Only the operator's apps file decides what may be built (the app's build block), and a source can only come from the
// hosts that block lists.
package build

import (
	"context"
	"errors"
	"fmt"
	"io"
	"maps"
	"net/http"
	"regexp"
	"sort"
	"strings"
	"sync"

	"github.com/0x2u/keelson/agent/internal/config"
	"github.com/0x2u/keelson/agent/internal/docker"
)

// Output bounds: the build log keeps its first lines as they come, then only the last ones.
const (
	maxLiveLines = 2000
	maxLiveBytes = 256 << 10
	maxTailLines = 2000
	maxTailBytes = 256 << 10

	// unpackedFactor is how many times the archive's own size its files may add up to.
	unpackedFactor = 8
)

// Errors of a build request.
var (
	ErrBadSHA   = errors.New("sha must be 40 lowercase hexadecimal characters")
	ErrNoConfig = errors.New("the app has no build block")
)

var shaPattern = regexp.MustCompile(`^[0-9a-f]{40}$`)

// ValidSHA reports whether s is a full commit hash.
func ValidSHA(s string) bool { return shaPattern.MatchString(s) }

// Engine is the part of the Docker engine a build needs.
type Engine interface {
	Build(ctx context.Context, opt docker.BuildOptions, buildContext io.Reader, out func(line string)) error
}

// Request is one build.
type Request struct {
	// Image is the repository the result is tagged with.
	Image string
	// SHA is the commit; the tag of the result.
	SHA string
	// Config is the app's build block (defaults applied).
	Config *config.Build
	// Source is where the archive comes from.
	Source Source
	// Args are build arguments set through the agent's API, merged under the build block's own (which win). They may
	// hold values the operator would rather not see: they never reach emit, an error or a log (see scrubbed).
	Args map[string]string
	// Port and HealthPath are the app's port and health_path: the image a preset generates listens on the port and its
	// HEALTHCHECK requests the path.
	Port       int
	HealthPath string
	// Network, when set, overrides the build block's `network`: deploy resolves it for the app (see config.App.BuildNetwork).
	Network string
}

// BuildNetwork is the network the build's containers run on: the request's own (resolved for the app: the one that
// reaches its managed database, with `database: true`), else the build block's, else the engine's default bridge.
func (r Request) BuildNetwork() string {
	if r.Network != "" {
		return r.Network
	}
	return r.Config.Network
}

// Ref is the reference the build produces.
func (r Request) Ref() string { return r.Image + ":" + r.SHA }

// BuildingLine is the progress line that says the source is downloaded and the image build starts: a deployment moves
// from its source phase to its build phase on it.
func BuildingLine(ref string) string { return "building " + ref }

// Emit receives the progress of a build: a level ("info", "warn", "error") and a line.
type Emit func(level, msg string)

// Builder runs builds, one at a time.
type Builder struct {
	eng Engine
	// platformEng builds the apps that name a platform; nil: eng does.
	platformEng Engine
	http        *http.Client
	slot        chan struct{}
}

// New returns a Builder that builds with eng.
func New(eng Engine) *Builder {
	return &Builder{eng: eng, http: defaultHTTPClient(), slot: make(chan struct{}, 1)}
}

// UsePlatformEngine sets the engine that builds when the app asks for a platform (build.platform): the engine's own
// classic builder cannot do that everywhere (see docker.CLI).
func (b *Builder) UsePlatformEngine(eng Engine) { b.platformEng = eng }

// TryAcquire takes the agent's single build slot. It reports false, at once, when a build already holds it. The
// returned function gives the slot back; it is safe to call twice.
func (b *Builder) TryAcquire() (release func(), ok bool) {
	select {
	case b.slot <- struct{}{}:
		var once sync.Once
		return func() { once.Do(func() { <-b.slot }) }, true
	default:
		return nil, false
	}
}

// Validate checks what can be checked before a build starts, so a bad request is refused instead of recorded as a
// failed build: the commit, the app's build block, the source URL and token.
func (b *Builder) Validate(req Request) error {
	switch {
	case !ValidSHA(req.SHA):
		return ErrBadSHA
	case req.Config == nil:
		return ErrNoConfig
	}
	_, err := b.validateSource(req.Source, req.Config.SourceHosts)
	return err
}

// Build downloads the source, builds it and returns the reference it was tagged with. The caller holds the slot. It
// reports progress to emit; the engine's output is bounded (the last lines are always kept). On any failure nothing
// is tagged, so whatever serves is untouched. The token never reaches emit, a log or an error.
func (b *Builder) Build(ctx context.Context, req Request, emit Emit) (ref string, err error) {
	token := req.Source.Token
	secrets := scrubbed(req.Args)
	scrub := func(s string) string {
		if token != "" {
			s = strings.ReplaceAll(s, token, redacted)
		}
		for _, v := range secrets {
			s = strings.ReplaceAll(s, v, redacted)
		}
		return s
	}
	say := func(level, msg string) { emit(level, scrub(msg)) }
	defer func() {
		if err != nil {
			if msg := scrub(err.Error()); msg != err.Error() {
				err = &scrubbedError{msg: msg, err: err}
			}
		}
	}()

	if err := b.Validate(req); err != nil {
		return "", err
	}
	cfg := req.Config
	ref = req.Ref()

	ctx, cancel := context.WithTimeout(ctx, cfg.TimeoutFor())
	defer cancel()
	fail := func(err error) (string, error) {
		switch {
		case errors.Is(context.Cause(ctx), context.DeadlineExceeded):
			return "", fmt.Errorf("build timed out after %s", cfg.TimeoutFor())
		case ctx.Err() != nil:
			return "", errors.New("build canceled")
		}
		return "", err
	}

	say("info", "downloading source from "+req.Source.Host())
	body, err := b.fetch(ctx, req.Source, cfg.SourceHosts, cfg.MaxSourceBytes())
	if err != nil {
		return fail(err)
	}
	defer body.Close()

	say("info", BuildingLine(ref))
	log := newOutput(say)
	defer log.finish()

	// The arguments the build really gets: the stored build variables under the apps file's own. The generated Dockerfile
	// of a preset must declare every one of them, or Docker would ignore the ones that come from the store.
	args := mergedArgs(req.Args, cfg.Args)
	opts := archiveOptions{
		Context: cfg.Context, Dockerfile: cfg.Dockerfile, MaxUnpacked: cfg.MaxSourceBytes() * unpackedFactor,
	}
	if cfg.Preset != "" {
		names := argNames(args)
		opts.Generate = func(root map[string]bool) ([]contextFile, error) {
			return presetFiles(presetInput{Build: cfg, Port: req.Port, HealthPath: req.HealthPath, Args: names, Root: root})
		}
	}
	pr, pw := io.Pipe()
	archiveDone := make(chan error, 1)
	go func() {
		err := buildContext(pw, body, opts)
		pw.CloseWithError(err) // nil closes with EOF: the context is complete
		archiveDone <- err
	}()
	eng := b.eng
	if cfg.Platform != "" && b.platformEng != nil {
		eng = b.platformEng
	}
	buildErr := eng.Build(ctx, docker.BuildOptions{
		Tag: ref, Dockerfile: cfg.DockerfilePath(), Target: cfg.Target, Args: args,
		Labels:      map[string]string{"org.opencontainers.image.revision": req.SHA},
		MemoryBytes: cfg.MemoryBytes(), CPUs: cfg.CPUCount(), Network: req.BuildNetwork(), Platform: cfg.Platform,
	}, pr, log.add)
	pr.CloseWithError(io.ErrClosedPipe) // let the archive goroutine end if the engine stopped reading
	aerr := <-archiveDone

	// A refused archive is the real cause of whatever the engine then said about its truncated input.
	if aerr != nil && !errors.Is(aerr, io.ErrClosedPipe) {
		return fail(aerr)
	}
	if buildErr != nil {
		var be *docker.BuildError
		if errors.As(buildErr, &be) {
			buildErr = fmt.Errorf("build failed: %s", be.Message)
		}
		return fail(buildErr)
	}
	say("info", "built "+ref)
	return ref, nil
}

// minScrubbed is the shortest argument value removed from the build output. A shorter one ("true", "3000") would
// garble the log wherever it happens to appear, and is no secret anyway: build arguments are not a place for secrets.
const minScrubbed = 6

// scrubbed returns the values of args to remove from the output, longest first, so a value that contains another is
// removed whole.
func scrubbed(args map[string]string) []string {
	var out []string
	for _, v := range args {
		if len(v) >= minScrubbed {
			out = append(out, v)
		}
	}
	sort.Slice(out, func(i, j int) bool { return len(out[i]) > len(out[j]) })
	return out
}

// mergedArgs is the build arguments of a build: those set through the API, overridden by the build block's.
func mergedArgs(managed, file map[string]string) map[string]string {
	if len(managed) == 0 {
		return file
	}
	args := make(map[string]string, len(managed)+len(file))
	maps.Copy(args, managed)
	maps.Copy(args, file)
	return args
}

// output hands build lines to emit as they come, up to a bound; beyond it only the last lines are kept, and written
// by finish. The log of a build that failed late thus still ends with the reason.
type output struct {
	emit        func(level, msg string)
	liveLines   int
	liveBytes   int
	tail        []string
	tailBytes   int
	dropped     int
	overflowing bool
}

func newOutput(emit func(level, msg string)) *output { return &output{emit: emit} }

func (o *output) add(line string) {
	if !o.overflowing {
		if o.liveLines < maxLiveLines && o.liveBytes+len(line) <= maxLiveBytes {
			o.liveLines++
			o.liveBytes += len(line)
			o.emit("info", line)
			return
		}
		o.overflowing = true
	}
	o.tail = append(o.tail, line)
	o.tailBytes += len(line)
	for len(o.tail) > maxTailLines || o.tailBytes > maxTailBytes {
		o.tailBytes -= len(o.tail[0])
		o.tail = o.tail[1:]
		o.dropped++
	}
}

func (o *output) finish() {
	if !o.overflowing {
		return
	}
	if o.dropped > 0 {
		o.emit("warn", fmt.Sprintf("build output truncated: %d lines omitted, the last %d follow", o.dropped, len(o.tail)))
	}
	for _, l := range o.tail {
		o.emit("info", l)
	}
	o.tail = nil
}

// scrubbedError is an error whose text had the token removed; it keeps the chain for errors.Is.
type scrubbedError struct {
	msg string
	err error
}

func (e *scrubbedError) Error() string { return e.msg }
func (e *scrubbedError) Unwrap() error { return e.err }
