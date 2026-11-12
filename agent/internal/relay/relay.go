// Package relay is the agent side of the dashboard's relay: a machine that cannot be reached (behind NAT, a laptop) opens
// one outbound HTTPS connection to the dashboard and the dashboard sends the requests it would send to a reachable agent
// down that connection. The agent hands each of them to its own http.Handler in process and posts the answer back, so the
// relay is only a transport: the same paths, the same authentication headers, the same answers.
//
// The wire format, all of it authenticated with the machine's credential as a bearer token:
//
//   - GET /api/relay/connect answers with an NDJSON stream that lives as long as the connection: {"type":"hello"} first,
//     {"type":"ping"} every 15 s, {"type":"request","id","method","path","headers","body"} (the body in base64, at most
//     1 MiB; or "stream":true and no body: the body is too large for a line and is fetched, see below),
//     {"type":"cancel","id"} when whoever asked gave up, and {"type":"replaced"} last when another connection with
//     the same credential took over. A 401 means the dashboard does not know the credential. The agent says what it can
//     do in X-Relay-Features (a comma-separated list; "request-stream" is the streamed request body).
//   - GET /api/relay/request/{id}/body streams the body of a request that came with "stream":true, once, at most 8 GiB.
//     It is read when the handler first reads the request's body, at the pace the handler reads it (TCP is the
//     backpressure), and it is abandoned when the request ends or is cancelled. The request's ContentLength is -1.
//   - POST /api/relay/response/{id} carries the answer in sequential chunks, each one a request of its own that returns
//     when the dashboard took the data (that is the backpressure): X-Relay-Seq (0-based), X-Relay-Status and
//     X-Relay-Headers (base64 of a JSON object) on the first, X-Relay-End on the last, at most 1 MiB of body. A 410 means
//     nobody waits for the answer any more.
package relay

import (
	"bufio"
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/rand/v2"
	"net/http"
	"net/url"
	"regexp"
	"runtime/debug"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

const (
	// maxChunk is the most of an answer posted at once (the dashboard accepts 4 MiB).
	maxChunk = 1 << 20
	// maxInFlight bounds the requests handled at once: each holds up to two chunks of answer in memory.
	maxInFlight = 64
	// maxBody is the largest request body (decoded) the dashboard sends in a line.
	maxBody = 1 << 20
	// maxStream is the largest streamed request body: what the dashboard sends at most, and what the import of an image
	// takes at most.
	maxStream = 8 << 30
	// features is what X-Relay-Features announces on connect.
	features = "request-stream"
	// maxLine bounds one line of the stream: a request with a full body is a third bigger in base64.
	maxLine = 2 * maxBody

	idleTimeout = 45 * time.Second
	minBackoff  = time.Second
	maxBackoff  = 30 * time.Second
	// stableAfter is how long a connection must have lasted for the next failure to start the backoff over.
	stableAfter = time.Minute
	// drainTimeout is how long Run waits for requests still being handled when it ends.
	drainTimeout = 10 * time.Second
)

var (
	// ErrReplaced ends Run when another process connected with the same credential: two would take each other's place
	// forever.
	ErrReplaced = errors.New("another keelson-agent connected with the same credential and took this machine's place: stopping (is it running twice?)")
	// ErrRevoked ends Run when the dashboard does not know the credential any more.
	ErrRevoked = errors.New("the dashboard does not know this machine: it was removed there. Delete the keelson directory and connect again with a new code")

	errCancelled = errors.New("the dashboard cancelled the request")
	errPanicked  = errors.New("the handler panicked after it had started answering")

	requestID = regexp.MustCompile(`^[0-9a-f]{1,64}$`)
	method    = regexp.MustCompile(`^[A-Z]{1,16}$`)
)

// Options configure Run.
type Options struct {
	// Dashboard is the base URL of the dashboard, such as https://keelson.example.com.
	Dashboard string
	// Credential is what proves this machine to the dashboard (the one it was given at enrolment).
	Credential string
	// Name is how the machine is called in the dashboard, for the messages.
	Name string
	// Handler is the agent's API.
	Handler http.Handler
	// Client carries every call to the dashboard. The default is a client of its own that follows the environment's
	// proxy settings.
	Client *http.Client
	// Logf says what happens: connected, disconnected and why.
	Logf func(format string, args ...any)

	// timing is replaced by the tests: the zero value is the real one.
	timing timing
}

// timing holds what makes the loop slow, so that a test does not have to wait for it.
type timing struct {
	idle, minBackoff, maxBackoff, stableAfter time.Duration
	// maxStream bounds a streamed request body.
	maxStream int64
	now       func() time.Time
	// jitter returns a factor in [0.8, 1.2) the backoff is multiplied by.
	jitter func() float64
	// sleep waits for d and reports false when ctx ended first.
	sleep func(ctx context.Context, d time.Duration) bool
}

func (t timing) withDefaults() timing {
	if t.idle == 0 {
		t.idle = idleTimeout
	}
	if t.maxStream == 0 {
		t.maxStream = maxStream
	}
	if t.minBackoff == 0 {
		t.minBackoff = minBackoff
	}
	if t.maxBackoff == 0 {
		t.maxBackoff = maxBackoff
	}
	if t.stableAfter == 0 {
		t.stableAfter = stableAfter
	}
	if t.now == nil {
		t.now = time.Now
	}
	if t.jitter == nil {
		t.jitter = func() float64 { return 0.8 + 0.4*rand.Float64() }
	}
	if t.sleep == nil {
		t.sleep = func(ctx context.Context, d time.Duration) bool {
			timer := time.NewTimer(d)
			defer timer.Stop()
			select {
			case <-timer.C:
				return true
			case <-ctx.Done():
				return false
			}
		}
	}
	return t
}

type runner struct {
	base       string
	credential string
	name       string
	handler    http.Handler
	client     *http.Client
	logf       func(format string, args ...any)
	t          timing

	inflight atomic.Int32
	wg       sync.WaitGroup
}

// Run keeps this machine connected to the dashboard until ctx ends (it then returns nil) or the dashboard shows that it
// must not reconnect (ErrReplaced, ErrRevoked). Any other failure is retried: backoff of one second doubling to thirty,
// with 20 % of jitter, started over once a connection lasted a minute.
func Run(ctx context.Context, opt Options) error {
	r := &runner{
		base: strings.TrimRight(opt.Dashboard, "/"), credential: opt.Credential, name: opt.Name, handler: opt.Handler,
		client: opt.Client, logf: opt.Logf, t: opt.timing.withDefaults(),
	}
	if r.client == nil {
		transport := http.DefaultTransport.(*http.Transport).Clone()
		transport.MaxIdleConnsPerHost = 16
		// The relay API never redirects, and a redirect would carry the credential to wherever it points.
		r.client = &http.Client{Transport: transport, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	}
	if r.logf == nil {
		r.logf = func(string, ...any) {}
	}
	defer r.drain()

	backoff := r.t.minBackoff
	for {
		started := r.t.now()
		hello, err := r.session(ctx)
		if ctx.Err() != nil {
			return nil
		}
		if errors.Is(err, ErrReplaced) || errors.Is(err, ErrRevoked) {
			return err
		}
		if r.t.now().Sub(started) >= r.t.stableAfter {
			backoff = r.t.minBackoff
		}
		wait := time.Duration(float64(backoff) * r.t.jitter())
		what := "could not connect"
		if hello {
			what = "disconnected"
		}
		r.logf("%s (%s), retrying in %s", what, reason(err), roundWait(wait))
		if !r.t.sleep(ctx, wait) {
			return nil
		}
		backoff = min(backoff*2, r.t.maxBackoff)
	}
}

// reason is err without the URL a failed call repeats.
func reason(err error) string {
	var ue *url.Error
	if errors.As(err, &ue) {
		err = ue.Err
	}
	return err.Error()
}

func roundWait(d time.Duration) time.Duration {
	if d >= time.Second {
		return d.Round(time.Second)
	}
	return d.Round(time.Millisecond)
}

// drain waits a little for the requests that are still being handled: the caller is about to close what they use.
func (r *runner) drain() {
	done := make(chan struct{})
	go func() { r.wg.Wait(); close(done) }()
	select {
	case <-done:
	case <-time.After(drainTimeout):
		r.logf("%d requests are still running", r.inflight.Load())
	}
}

// message is one line of the stream.
type message struct {
	Type    string            `json:"type"`
	ID      string            `json:"id"`
	Method  string            `json:"method"`
	Path    string            `json:"path"`
	Headers map[string]string `json:"headers"`
	Body    *string           `json:"body"`
	// Stream: there is no body in the line, the request's body is fetched from the dashboard.
	Stream bool `json:"stream"`
}

// session is one connection: it reads the stream until it ends and starts a goroutine for each request. Everything it
// started is cancelled when it ends: the answers could not be delivered any more.
type session struct {
	*runner
	ctx context.Context

	mu      sync.Mutex
	cancels map[string]context.CancelCauseFunc
}

// session connects and serves one connection. hello reports whether the dashboard greeted us, which is what makes a
// later end a disconnection rather than a failure to connect.
func (r *runner) session(ctx context.Context) (hello bool, err error) {
	connCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	var idled atomic.Bool
	// A line arrives at least every ping: silence means the network dropped the connection without telling anyone.
	idle := time.AfterFunc(r.t.idle, func() { idled.Store(true); cancel() })
	defer idle.Stop()
	fail := func(err error) error {
		if idled.Load() {
			return fmt.Errorf("no data for %s", r.t.idle)
		}
		return err
	}

	req, err := http.NewRequestWithContext(connCtx, http.MethodGet, r.base+"/api/relay/connect", nil)
	if err != nil {
		return false, err
	}
	req.Header.Set("Authorization", "Bearer "+r.credential)
	req.Header.Set("Accept", "application/x-ndjson")
	req.Header.Set("X-Relay-Features", features)
	resp, err := r.client.Do(req)
	if err != nil {
		return false, fail(err)
	}
	defer resp.Body.Close()
	switch {
	case resp.StatusCode == http.StatusUnauthorized:
		return false, ErrRevoked
	case resp.StatusCode != http.StatusOK:
		return false, fmt.Errorf("the dashboard answered %s", resp.Status)
	}

	s := &session{runner: r, ctx: connCtx, cancels: map[string]context.CancelCauseFunc{}}
	sc := bufio.NewScanner(resp.Body)
	sc.Buffer(make([]byte, 0, 64<<10), maxLine)
	for sc.Scan() {
		idle.Reset(r.t.idle)
		var m message
		if err := json.Unmarshal(sc.Bytes(), &m); err != nil {
			return hello, fmt.Errorf("the dashboard sent a line that is not JSON: %w", err)
		}
		switch m.Type {
		case "hello":
			hello = true
			r.logf("connected to %s as %s", r.base, r.name)
		case "request":
			s.start(m)
		case "cancel":
			s.cancel(m.ID)
		case "replaced":
			return hello, ErrReplaced
		}
	}
	if err := sc.Err(); err != nil {
		return hello, fail(err)
	}
	return hello, fail(errors.New("the dashboard closed the connection"))
}

func (s *session) cancel(id string) {
	s.mu.Lock()
	cancel := s.cancels[id]
	s.mu.Unlock()
	if cancel != nil {
		cancel(errCancelled)
	}
}

// start handles one request in goroutines of its own, so that a slow one never holds up the stream.
func (s *session) start(m message) {
	if !requestID.MatchString(m.ID) {
		return // nothing can be answered to an id that cannot name a URL
	}
	s.mu.Lock()
	_, dup := s.cancels[m.ID]
	s.mu.Unlock()
	if dup {
		return
	}
	over := s.inflight.Add(1) > maxInFlight
	ctx, cancel := context.WithCancelCause(s.ctx)
	s.mu.Lock()
	s.cancels[m.ID] = cancel
	s.mu.Unlock()
	s.wg.Add(1)
	go func() {
		defer func() {
			s.mu.Lock()
			delete(s.cancels, m.ID)
			s.mu.Unlock()
			cancel(nil)
			s.inflight.Add(-1)
			s.wg.Done()
		}()
		s.serve(ctx, cancel, m, over)
	}()
}

// serve runs the handler on one request and sends what it answers. over: the machine already handles the most it
// takes, so the answer is a refusal.
func (s *session) serve(ctx context.Context, cancel context.CancelCauseFunc, m message, over bool) {
	resp := newResponse(ctx, cancel, func(ctx context.Context, c chunk) error { return s.postChunk(ctx, m.ID, c) })
	sent := make(chan struct{})
	go func() { resp.run(); close(sent) }()

	s.handle(resp, m, over)
	resp.finish()
	<-sent

	// A refusal by the dashboard is worth saying; the others are the ordinary ends of a request that nobody waits for.
	if cause := context.Cause(ctx); cause != nil && !errors.Is(cause, errGone) && !errors.Is(cause, errCancelled) && !errors.Is(cause, context.Canceled) {
		s.logf("an answer was abandoned: %v", cause)
	}
}

// handle gives the request to the agent's handler. A request the agent cannot even form, or a handler that panics before
// it sent anything, is answered with an error of its own.
func (s *session) handle(resp *response, m message, over bool) {
	fail := func(status int, text string) {
		resp.Header().Set("Content-Type", "application/json")
		resp.WriteHeader(status)
		body, _ := json.Marshal(map[string]string{"error": text})
		resp.Write(body)
	}
	if over {
		fail(http.StatusTooManyRequests, "this machine is handling too many requests")
		return
	}
	req, err := s.newRequest(resp.ctx, m)
	if err != nil {
		fail(http.StatusBadRequest, err.Error())
		return
	}
	// A server closes the body when the handler returns: what a streamed body had open ends with it.
	defer req.Body.Close()
	defer func() {
		if p := recover(); p != nil {
			s.logf("%s %s panicked: %v\n%s", m.Method, req.URL.Path, p, debug.Stack())
			if !resp.replaceWithError(http.StatusBadGateway, "the agent failed to handle the request") {
				// Part of the answer is gone already and its status cannot change: stop, and let the dashboard's own
				// timeout end what waits for the rest.
				resp.cancel(errPanicked)
			}
		}
	}()
	s.handler.ServeHTTP(resp, req)
}

// newRequest builds what the handler would have received from a listener.
func (s *session) newRequest(ctx context.Context, m message) (*http.Request, error) {
	if !method.MatchString(m.Method) || !strings.HasPrefix(m.Path, "/") {
		return nil, errors.New("not a request")
	}
	// A parsed URL, as a server has it: the handlers sign and compare r.URL.RequestURI().
	u, err := url.ParseRequestURI(m.Path)
	if err != nil {
		return nil, errors.New("not a request path")
	}
	header := http.Header{}
	for k, v := range m.Headers {
		header.Set(k, v)
	}
	var body io.ReadCloser = http.NoBody
	var length int64
	switch {
	case m.Stream && m.Body != nil:
		return nil, errors.New("a request has a body or a stream, not both")
	case m.Stream:
		// Not opened yet: the handler may refuse the request without ever reading it.
		body, length = http.MaxBytesReader(nil, newRequestBody(ctx, s.client, s.base+"/api/relay/request/"+m.ID+"/body", s.credential), s.t.maxStream), -1
	case m.Body != nil:
		if base64.StdEncoding.DecodedLen(len(*m.Body)) > maxBody+2 {
			return nil, errors.New("the request body is larger than 1 MiB")
		}
		b, err := base64.StdEncoding.DecodeString(*m.Body)
		if err != nil {
			return nil, errors.New("the request body is not base64")
		}
		if len(b) > maxBody {
			return nil, errors.New("the request body is larger than 1 MiB")
		}
		if len(b) > 0 {
			body, length = io.NopCloser(bytes.NewReader(b)), int64(len(b))
		}
	}
	return (&http.Request{
		Method: m.Method, URL: u, RequestURI: m.Path, Proto: "HTTP/1.1", ProtoMajor: 1, ProtoMinor: 1,
		Header: header, Body: body, ContentLength: length, Host: "keelson-agent",
		// There is no peer address: the dashboard's own is not the client's, and the audit log records this.
		RemoteAddr: "relay",
	}).WithContext(ctx), nil
}

// postChunk sends one chunk of an answer and returns when the dashboard took it: that is the backpressure.
func (r *runner) postChunk(ctx context.Context, id string, c chunk) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, r.base+"/api/relay/response/"+id, bytes.NewReader(c.body))
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+r.credential)
	req.Header.Set("Content-Type", "application/octet-stream")
	req.Header.Set("X-Relay-Seq", strconv.Itoa(c.seq))
	if c.seq == 0 {
		headers, _ := json.Marshal(c.headers)
		req.Header.Set("X-Relay-Status", strconv.Itoa(c.status))
		req.Header.Set("X-Relay-Headers", base64.StdEncoding.EncodeToString(headers))
	}
	if c.end {
		req.Header.Set("X-Relay-End", "1")
	}
	resp, err := r.client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	io.Copy(io.Discard, io.LimitReader(resp.Body, 4<<10)) // lets the connection be reused
	switch resp.StatusCode {
	case http.StatusOK:
		return nil
	case http.StatusGone:
		return errGone
	}
	return fmt.Errorf("the dashboard refused chunk %d of an answer: %s", c.seq, resp.Status)
}
