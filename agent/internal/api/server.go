// Package api is the agent's HTTP API. It is read-only: only GET routes
// exist, and every route except /v1/health requires the bearer token. The one exception is POST /v1/enroll, which
// redeems a one-time enrolment code and is reachable only while enrolment is enabled (see enroll.go).
package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strconv"
	"sync"
	"time"

	"github.com/0x2u/keelson/agent/internal/docker"
	"github.com/0x2u/keelson/agent/internal/sysinfo"
)

// MinTokenLength is the minimum accepted length of the API token.
const MinTokenLength = 32

const (
	requestTimeout   = 10 * time.Second
	keepAliveEvery   = 15 * time.Second
	defaultMaxStream = 32
	defaultLogTail   = "100"
)

// Docker is the subset of the engine client the API needs.
type Docker interface {
	Ping(ctx context.Context) error
	ListContainers(ctx context.Context, all bool) ([]docker.Container, error)
	Inspect(ctx context.Context, id string) (*docker.Detail, error)
	Logs(ctx context.Context, id string, opt docker.LogOptions, fn func(docker.LogLine) error) error
	Stats(ctx context.Context, id string, fn func(docker.Stats) error) error
	Info(ctx context.Context) (*docker.EngineInfo, error)
	DiskUsage(ctx context.Context) (*docker.DiskUsage, error)
}

// Options configures the API.
type Options struct {
	Token   string
	Version string
	Logger  *slog.Logger
	// MaxStreams caps concurrent log/stats streams; defaults to 32.
	MaxStreams int
	// Deploy enables the deployment routes. Nil keeps the API read-only.
	Deploy *DeployOptions
	// Host reads the machine's load, memory and disk; nil reads /proc and statfs. Tests replace it.
	Host func(diskPaths ...string) sysinfo.Host
	// RequireClientCert says the listener is configured for mutual TLS: every request but a redemption of an
	// enrolment code must then carry a client certificate the TLS layer verified. Set it whenever clients are
	// verified against a CA.
	RequireClientCert bool
	// Enroller enables POST /v1/enroll, the one route that needs neither the certificate nor the token. Nil answers
	// it 404.
	Enroller Enroller
}

type server struct {
	d       Docker
	version string
	log     *slog.Logger
	streams chan struct{}
	deploy  *DeployOptions
	now     func() time.Time
	host    func(diskPaths ...string) sysinfo.Host

	requireClientCert bool
	enroller          Enroller

	// The engine's disk accounting is slow and serialised on its side: one answer is shared for diskUsageTTL.
	dfMu   sync.Mutex
	dfAt   time.Time
	dfData *docker.DiskUsage
}

// New builds the API handler.
func New(d Docker, o Options) (http.Handler, error) {
	if len(o.Token) < MinTokenLength {
		return nil, fmt.Errorf("api token must be at least %d characters", MinTokenLength)
	}
	if o.Deploy != nil {
		if len(o.Deploy.Secret) < MinTokenLength {
			return nil, fmt.Errorf("deploy secret must be at least %d characters", MinTokenLength)
		}
		if o.Deploy.Secret == o.Token {
			return nil, errors.New("deploy secret must differ from the API token")
		}
	}
	if o.Enroller != nil && !o.RequireClientCert {
		// Without the gate, accepting certificate-less handshakes for enrolment would leave only the bearer token.
		return nil, errors.New("enrolment requires mutual TLS (RequireClientCert)")
	}
	if o.Logger == nil {
		o.Logger = slog.Default()
	}
	if o.MaxStreams <= 0 {
		o.MaxStreams = defaultMaxStream
	}
	if o.Host == nil {
		o.Host = func(diskPaths ...string) sysinfo.Host { return sysinfo.Read(sysinfo.ProcDir(), diskPaths...) }
	}
	s := &server{d: d, version: o.Version, log: o.Logger, streams: make(chan struct{}, o.MaxStreams), deploy: o.Deploy, now: time.Now, host: o.Host,
		requireClientCert: o.RequireClientCert, enroller: o.Enroller}

	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/health", s.health)
	mux.HandleFunc("GET /v1/info", s.info)
	mux.HandleFunc("GET /v1/containers", s.listContainers)
	mux.HandleFunc("GET /v1/containers/{id}", s.getContainer)
	mux.HandleFunc("GET /v1/containers/{id}/logs", s.logs)
	mux.HandleFunc("GET /v1/containers/{id}/stats", s.stats)
	mux.HandleFunc("GET /v1/system", s.system)
	mux.HandleFunc("GET /v1/system/disk", s.systemDisk)
	mux.HandleFunc("GET /metrics", s.metrics)
	if o.Deploy != nil {
		s.deployRoutes(mux)
	}

	return s.logRequests(s.frontGate(s.requireToken(o.Token, mux))), nil
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeError(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}

// fail maps an engine error to an HTTP answer without leaking engine details.
func (s *server) fail(w http.ResponseWriter, r *http.Request, err error) {
	switch {
	case errors.Is(err, docker.ErrInvalidID):
		writeError(w, http.StatusBadRequest, "invalid container id or name")
	case docker.IsNotFound(err):
		writeError(w, http.StatusNotFound, "container not found")
	default:
		s.log.Error("docker request failed", "path", r.URL.Path, "err", err)
		writeError(w, http.StatusBadGateway, "docker engine error")
	}
}

func (s *server) health(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
	defer cancel()
	if err := s.d.Ping(ctx); err != nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"status": "degraded"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func (s *server) info(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"version": s.version, "read_only": s.deploy == nil})
}

func (s *server) listContainers(w http.ResponseWriter, r *http.Request) {
	all := false
	if v := r.URL.Query().Get("all"); v != "" {
		var err error
		if all, err = strconv.ParseBool(v); err != nil {
			writeError(w, http.StatusBadRequest, "invalid all parameter")
			return
		}
	}
	ctx, cancel := context.WithTimeout(r.Context(), requestTimeout)
	defer cancel()
	list, err := s.d.ListContainers(ctx, all)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, list)
}

func (s *server) getContainer(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), requestTimeout)
	defer cancel()
	d, err := s.d.Inspect(ctx, r.PathValue("id"))
	if err != nil {
		s.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, d)
}

// exists answers 4xx/5xx itself and returns false when the container cannot
// be inspected, so streaming handlers can still send a proper status.
func (s *server) exists(w http.ResponseWriter, r *http.Request, id string) bool {
	ctx, cancel := context.WithTimeout(r.Context(), requestTimeout)
	defer cancel()
	if _, err := s.d.Inspect(ctx, id); err != nil {
		s.fail(w, r, err)
		return false
	}
	return true
}

// acquire reserves a stream slot, answering 429 when none is free.
func (s *server) acquire(w http.ResponseWriter) (release func(), ok bool) {
	select {
	case s.streams <- struct{}{}:
		return func() { <-s.streams }, true
	default:
		writeError(w, http.StatusTooManyRequests, "too many concurrent streams")
		return nil, false
	}
}

func parseBool(q string, def bool) (bool, error) {
	if q == "" {
		return def, nil
	}
	return strconv.ParseBool(q)
}

func isDigits(s string) bool {
	if s == "" {
		return false
	}
	for _, c := range s {
		if c < '0' || c > '9' {
			return false
		}
	}
	return true
}

// parseSince accepts a unix timestamp, an RFC 3339 time, or a duration such
// as "10m" meaning "the last 10 minutes", and returns a unix timestamp.
func parseSince(v string, now time.Time) (string, error) {
	switch {
	case v == "":
		return "", nil
	case isDigits(v):
		return v, nil
	}
	if t, err := time.Parse(time.RFC3339, v); err == nil {
		return strconv.FormatInt(t.Unix(), 10), nil
	}
	if d, err := time.ParseDuration(v); err == nil && d > 0 {
		return strconv.FormatInt(now.Add(-d).Unix(), 10), nil
	}
	return "", errors.New("invalid since parameter")
}

func (s *server) logs(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	q := r.URL.Query()

	follow, err := parseBool(q.Get("follow"), false)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid follow parameter")
		return
	}
	tail := q.Get("tail")
	if tail == "" {
		tail = defaultLogTail
	}
	if tail != "all" && (!isDigits(tail) || len(tail) > 9) {
		writeError(w, http.StatusBadRequest, "invalid tail parameter")
		return
	}
	since, err := parseSince(q.Get("since"), time.Now())
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	if !s.exists(w, r, id) {
		return
	}
	release, ok := s.acquire(w)
	if !ok {
		return
	}
	defer release()

	sse := newSSE(w)
	defer sse.keepAlive(r.Context(), keepAliveEvery)()

	err = s.d.Logs(r.Context(), id, docker.LogOptions{Follow: follow, Tail: tail, Since: since},
		func(l docker.LogLine) error { return sse.send("log", l) })
	s.endStream(sse, r, err)
}

func (s *server) stats(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	stream, err := parseBool(r.URL.Query().Get("stream"), true)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid stream parameter")
		return
	}
	if !s.exists(w, r, id) {
		return
	}
	release, ok := s.acquire(w)
	if !ok {
		return
	}
	defer release()

	if !stream {
		// The first sample of a stream has no CPU baseline: take the second.
		ctx, cancel := context.WithTimeout(r.Context(), requestTimeout)
		defer cancel()
		var last docker.Stats
		n := 0
		err := s.d.Stats(ctx, id, func(st docker.Stats) error {
			last = st
			if n++; n >= 2 {
				return docker.ErrStop
			}
			return nil
		})
		if n == 0 {
			if err == nil {
				writeError(w, http.StatusConflict, "no stats available")
			} else {
				s.fail(w, r, err)
			}
			return
		}
		writeJSON(w, http.StatusOK, last)
		return
	}

	sse := newSSE(w)
	defer sse.keepAlive(r.Context(), keepAliveEvery)()
	err = s.d.Stats(r.Context(), id, func(st docker.Stats) error { return sse.send("stats", st) })
	s.endStream(sse, r, err)
}

// endStream closes an SSE stream: "end" on a clean finish, "error" when the
// engine stream broke. Nothing is sent when the client itself went away.
func (s *server) endStream(sse *sseWriter, r *http.Request, err error) {
	if r.Context().Err() != nil {
		return
	}
	if err != nil {
		s.log.Error("stream failed", "path", r.URL.Path, "err", err)
		_ = sse.send("error", map[string]string{"error": "stream interrupted"})
		return
	}
	_ = sse.send("end", struct{}{})
}

// statusRecorder captures the status code for the request log. Unwrap keeps
// http.ResponseController (flushing) working through the wrapper.
type statusRecorder struct {
	http.ResponseWriter
	status int
}

func (s *statusRecorder) WriteHeader(code int) {
	s.status = code
	s.ResponseWriter.WriteHeader(code)
}

func (s *statusRecorder) Unwrap() http.ResponseWriter { return s.ResponseWriter }

func (s *server) logRequests(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		rec := &statusRecorder{ResponseWriter: w, status: http.StatusOK}
		next.ServeHTTP(rec, r)
		s.log.Info("request",
			"method", r.Method, "path", r.URL.Path, "status", rec.status,
			"duration", time.Since(start).Round(time.Millisecond).String(),
			"remote", r.RemoteAddr)
	})
}
