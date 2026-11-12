package relay

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"sync"
)

// chunk is one POST of an answer: the contract's X-Relay-* headers and the body.
type chunk struct {
	seq int
	// status and headers are set on the first chunk only.
	status  int
	headers map[string]string
	end     bool
	body    []byte
}

// errGone is the cancellation cause of a request whose answer the dashboard no longer wants (410).
var errGone = errors.New("the dashboard no longer waits for this answer")

// response is the http.ResponseWriter a request's handler writes to, and the sender that turns what it writes into
// sequential chunks. The handler is never slowed by the network except by backpressure: it fills one buffer while the
// sender posts the previous one (a buffer is never reused: the transport may still be reading it), and blocks only when that buffer is full (maxChunk).
//
// Like net/http, it holds the answer back until the handler flushes, fills a chunk or returns, so a small answer is one
// POST and a stream arrives as the handler flushes it. It implements http.Flusher and not http.Hijacker: nothing here is
// a connection.
type response struct {
	ctx    context.Context
	cancel context.CancelCauseFunc
	// post sends one chunk and returns when the dashboard accepted it.
	post func(ctx context.Context, c chunk) error

	mu     sync.Mutex
	header http.Header
	status int // 0 until the header is written
	// sent are the headers captured when the status was written: later changes are ignored, as in net/http.
	sent    map[string]string
	sniffed bool
	buf     []byte
	flush   bool
	done    bool
	// started: a chunk was taken for sending, so the answer can no longer be replaced by an error.
	started bool

	wake chan struct{} // handler -> sender: something is ready
	room chan struct{} // sender -> handler: the buffer was taken
}

func newResponse(ctx context.Context, cancel context.CancelCauseFunc, post func(context.Context, chunk) error) *response {
	return &response{ctx: ctx, cancel: cancel, post: post, header: http.Header{}, wake: make(chan struct{}, 1), room: make(chan struct{}, 1)}
}

func signal(c chan struct{}) {
	select {
	case c <- struct{}{}:
	default:
	}
}

func (r *response) Header() http.Header { return r.header }

func (r *response) WriteHeader(code int) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.writeHeaderLocked(code)
}

func (r *response) writeHeaderLocked(code int) {
	// Informational statuses are interim answers; the final one follows.
	if r.status != 0 || code < 200 || code > 999 {
		return
	}
	r.status = code
	r.sent = keptHeaders(r.header)
}

// keptHeaders are the headers worth giving the dashboard: the type of the answer, a download's name, and the X-* ones.
// Content-Length is not among them: the dashboard frames the answer itself.
func keptHeaders(h http.Header) map[string]string {
	out := map[string]string{}
	for name, values := range h {
		if len(values) == 0 {
			continue
		}
		if name == "Content-Type" || name == "Content-Disposition" || strings.HasPrefix(name, "X-") {
			out[name] = values[0]
		}
	}
	return out
}

func (r *response) Write(p []byte) (int, error) {
	r.mu.Lock()
	if r.status == 0 {
		r.writeHeaderLocked(http.StatusOK)
	}
	// net/http names an answer's type from its first bytes when the handler did not.
	if !r.sniffed {
		r.sniffed = true
		if _, ok := r.sent["Content-Type"]; !ok && r.header.Get("Content-Encoding") == "" && len(p) > 0 {
			r.sent["Content-Type"] = http.DetectContentType(p)
		}
	}
	r.mu.Unlock()

	written := 0
	for len(p) > 0 {
		r.mu.Lock()
		if err := context.Cause(r.ctx); err != nil {
			r.mu.Unlock()
			return written, err
		}
		room := maxChunk - len(r.buf)
		if room <= 0 {
			r.mu.Unlock()
			select {
			case <-r.room:
				continue
			case <-r.ctx.Done():
				return written, context.Cause(r.ctx)
			}
		}
		n := min(room, len(p))
		r.buf = append(r.buf, p[:n]...)
		p = p[n:]
		written += n
		if len(r.buf) >= maxChunk {
			signal(r.wake)
		}
		r.mu.Unlock()
	}
	return written, nil
}

// Flush sends what the handler has written so far, or the status alone when that is all there is.
func (r *response) Flush() {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.writeHeaderLocked(http.StatusOK)
	if len(r.buf) == 0 && r.started {
		return // nothing to send: do not post an empty chunk for each keep-alive flush
	}
	r.flush = true
	signal(r.wake)
}

// finish tells the sender the handler returned: what is buffered is the rest of the answer.
func (r *response) finish() {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.writeHeaderLocked(http.StatusOK)
	r.done = true
	signal(r.wake)
}

// replaceWithError turns the answer into an error of its own, unless part of it is already on its way (then the status
// can no longer change and it reports false).
func (r *response) replaceWithError(status int, message string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.started {
		return false
	}
	body, _ := json.Marshal(map[string]string{"error": message})
	r.status = status
	r.sent = map[string]string{"Content-Type": "application/json"}
	r.buf = append(r.buf[:0], body...)
	return true
}

func (r *response) ready() bool {
	return r.done || r.flush || len(r.buf) >= maxChunk
}

// run sends the answer, one chunk after the other, until the last one is accepted or the request ends. A chunk the
// dashboard refuses ends the request: nothing could be sent in order after it.
func (r *response) run() {
	for seq := 0; ; seq++ {
		r.mu.Lock()
		for !r.ready() {
			r.mu.Unlock()
			select {
			case <-r.wake:
			case <-r.ctx.Done():
				return
			}
			r.mu.Lock()
		}
		c := chunk{seq: seq, end: r.done, body: r.buf}
		if seq == 0 {
			c.status, c.headers = r.status, r.sent
		}
		r.buf, r.flush, r.started = nil, false, true
		r.mu.Unlock()
		signal(r.room) // the handler fills a fresh buffer while this one is on its way

		err := r.post(r.ctx, c)

		if err != nil {
			r.cancel(err)
			return
		}
		if c.end {
			return
		}
	}
}
