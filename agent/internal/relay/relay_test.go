package relay

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/rand/v2"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

const testCredential = "credential-of-the-machine"

// got is one chunk the fake dashboard accepted.
type got struct {
	seq     int
	status  int
	headers map[string]string
	end     bool
	body    []byte
}

// serverConn is one open /api/relay/connect the fake dashboard holds: the test writes lines to the agent through it.
type serverConn struct {
	lines chan string
	stop  chan struct{}
	gone  chan struct{} // closed when the agent hung up
}

func (c *serverConn) send(t *testing.T, v any) {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	select {
	case c.lines <- string(b):
	case <-time.After(5 * time.Second):
		t.Fatal("the connection does not take lines")
	}
}

// connectStep scripts what the fake dashboard does with one connect.
type connectStep struct {
	status int  // answers with this status and nothing else
	drop   bool // greets, then closes the stream
	silent bool // greets, then says nothing at all
}

// dashboard is an in-process implementation of the contract's dashboard side.
type dashboard struct {
	t   *testing.T
	srv *httptest.Server

	mu       sync.Mutex
	connects int
	features []string // X-Relay-Features of each connect
	steps    []connectStep
	chunks   map[string][]got
	conns    chan *serverConn
	bodyGets []bodyGet
	// decide answers a chunk: the status to give (200 when nil). It may block, which is how the consumer's backpressure
	// is played.
	decide func(id string, c got) int
	// body serves GET /api/relay/request/{id}/body (a 404 when nil).
	body func(w http.ResponseWriter, r *http.Request, id string)
}

// bodyGet is one fetch of a streamed request body.
type bodyGet struct{ id, auth, encoding string }

func newDashboard(t *testing.T) *dashboard {
	d := &dashboard{t: t, chunks: map[string][]got{}, conns: make(chan *serverConn, 32)}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/relay/connect", d.connect)
	mux.HandleFunc("GET /api/relay/request/{id}/body", d.requestBody)
	mux.HandleFunc("POST /api/relay/response/{id}", d.response)
	d.srv = httptest.NewServer(mux)
	t.Cleanup(d.srv.Close)
	return d
}

func (d *dashboard) authorized(r *http.Request) bool {
	return r.Header.Get("Authorization") == "Bearer "+testCredential
}

func (d *dashboard) connect(w http.ResponseWriter, r *http.Request) {
	if !d.authorized(r) {
		w.WriteHeader(http.StatusUnauthorized)
		return
	}
	d.mu.Lock()
	d.connects++
	d.features = append(d.features, r.Header.Get("X-Relay-Features"))
	var step connectStep
	if len(d.steps) > 0 {
		step, d.steps = d.steps[0], d.steps[1:]
	}
	d.mu.Unlock()
	if step.status != 0 {
		w.WriteHeader(step.status)
		return
	}
	w.Header().Set("Content-Type", "application/x-ndjson")
	w.WriteHeader(http.StatusOK)
	flusher := w.(http.Flusher)
	io.WriteString(w, `{"type":"hello","server_id":"srv1","ping_every":15}`+"\n")
	flusher.Flush()
	c := &serverConn{lines: make(chan string, 16), stop: make(chan struct{}), gone: make(chan struct{})}
	d.conns <- c
	if step.drop {
		return
	}
	if step.silent {
		<-r.Context().Done()
		close(c.gone)
		return
	}
	for {
		select {
		case line := <-c.lines:
			io.WriteString(w, line+"\n")
			flusher.Flush()
			if strings.Contains(line, `"replaced"`) {
				return
			}
		case <-c.stop:
			return
		case <-r.Context().Done():
			close(c.gone)
			return
		}
	}
}

func (d *dashboard) response(w http.ResponseWriter, r *http.Request) {
	if !d.authorized(r) {
		w.WriteHeader(http.StatusUnauthorized)
		return
	}
	id := r.PathValue("id")
	seq, err := strconv.Atoi(r.Header.Get("X-Relay-Seq"))
	body, _ := io.ReadAll(r.Body)
	c := got{seq: seq, end: r.Header.Get("X-Relay-End") == "1", body: body}

	d.mu.Lock()
	prev := d.chunks[id]
	if err != nil || seq != len(prev) || (len(prev) > 0 && prev[len(prev)-1].end) {
		d.mu.Unlock()
		w.WriteHeader(http.StatusConflict)
		return
	}
	if seq == 0 {
		c.status, _ = strconv.Atoi(r.Header.Get("X-Relay-Status"))
		raw, _ := base64.StdEncoding.DecodeString(r.Header.Get("X-Relay-Headers"))
		if json.Unmarshal(raw, &c.headers) != nil {
			d.mu.Unlock()
			w.WriteHeader(http.StatusBadRequest)
			return
		}
	} else if r.Header.Get("X-Relay-Status") != "" || r.Header.Get("X-Relay-Headers") != "" {
		d.mu.Unlock()
		w.WriteHeader(http.StatusBadRequest) // the head is for seq 0 only
		return
	}
	d.chunks[id] = append(prev, c)
	decide := d.decide
	d.mu.Unlock()

	status := http.StatusOK
	if decide != nil {
		status = decide(id, c)
	}
	w.WriteHeader(status)
}

func (d *dashboard) requestBody(w http.ResponseWriter, r *http.Request) {
	if !d.authorized(r) {
		w.WriteHeader(http.StatusUnauthorized)
		return
	}
	id := r.PathValue("id")
	d.mu.Lock()
	d.bodyGets = append(d.bodyGets, bodyGet{id, r.Header.Get("Authorization"), r.Header.Get("Accept-Encoding")})
	serve := d.body
	d.mu.Unlock()
	if serve == nil {
		w.WriteHeader(http.StatusNotFound)
		return
	}
	serve(w, r, id)
}

func (d *dashboard) fetched() []bodyGet {
	d.mu.Lock()
	defer d.mu.Unlock()
	return append([]bodyGet(nil), d.bodyGets...)
}

func (d *dashboard) answer(id string) []got {
	d.mu.Lock()
	defer d.mu.Unlock()
	return append([]got(nil), d.chunks[id]...)
}

func (d *dashboard) connectCount() int {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.connects
}

// whole is the answer of id once it ended: its status, headers and body.
func (d *dashboard) whole(t *testing.T, id string) (int, map[string]string, string) {
	t.Helper()
	eventually(t, func() bool {
		c := d.answer(id)
		return len(c) > 0 && c[len(c)-1].end
	}, "the answer of "+id+" to end")
	chunks := d.answer(id)
	var body []byte
	for _, c := range chunks {
		body = append(body, c.body...)
	}
	return chunks[0].status, chunks[0].headers, string(body)
}

func (d *dashboard) nextConn(t *testing.T) *serverConn {
	t.Helper()
	select {
	case c := <-d.conns:
		return c
	case <-time.After(5 * time.Second):
		t.Fatal("the agent did not connect")
		return nil
	}
}

func eventually(t *testing.T, ok func() bool, what string) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for !ok() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(2 * time.Millisecond)
	}
}

// logs collects what Run says.
type logs struct {
	mu    sync.Mutex
	lines []string
}

func (l *logs) logf(format string, args ...any) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.lines = append(l.lines, fmt.Sprintf(format, args...))
}

func (l *logs) all() string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return strings.Join(l.lines, "\n")
}

// agent is Run started against a fake dashboard.
type agent struct {
	d      *dashboard
	cancel context.CancelFunc
	done   chan error
	logs   *logs
}

func (a *agent) stop(t *testing.T) error {
	t.Helper()
	a.cancel()
	select {
	case err := <-a.done:
		return err
	case <-time.After(5 * time.Second):
		t.Fatal("Run did not return")
		return nil
	}
}

func start(t *testing.T, d *dashboard, h http.Handler, tune func(*timing)) *agent {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	a := &agent{d: d, cancel: cancel, done: make(chan error, 1), logs: &logs{}}
	opt := Options{Dashboard: d.srv.URL, Credential: testCredential, Name: "marc-mac", Handler: h, Logf: a.logs.logf}
	if tune != nil {
		tune(&opt.timing)
	}
	go func() { a.done <- Run(ctx, opt) }()
	t.Cleanup(func() { cancel() })
	return a
}

func request(id, method, path string) map[string]any {
	return map[string]any{"type": "request", "id": id, "method": method, "path": path}
}

func TestAGetIsAnsweredThroughTheHandlerAsADirectOneWould(t *testing.T) {
	d := newDashboard(t)
	type seenRequest struct {
		method, uri, auth, remote string
		body                      string
		length                    int64
	}
	seenCh := make(chan seenRequest, 2)
	h := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		seenCh <- seenRequest{r.Method, r.URL.RequestURI(), r.Header.Get("Authorization"), r.RemoteAddr, string(b), r.ContentLength}
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Content-Length", "999") // the dashboard frames the answer: it must not be given
		w.Header().Set("X-Thing", "1")
		w.Header().Set("Set-Cookie", "a=b")
		w.WriteHeader(http.StatusCreated)
		io.WriteString(w, `{"0a":true}`)
	})
	a := start(t, d, h, nil)
	c := d.nextConn(t)
	eventually(t, func() bool { return strings.Contains(a.logs.all(), "connected to "+d.srv.URL+" as marc-mac") }, "the connected message")

	req := request("a1", "POST", "/v1/apps/web/deploy?x=1&y=a%20b")
	req["headers"] = map[string]string{"Authorization": "Bearer tok", "X-Keelson-Signature": "sig"}
	req["body"] = base64.StdEncoding.EncodeToString([]byte(`{"tag":"abc"}`))
	c.send(t, req)
	status, headers, body := d.whole(t, "a1")

	if status != 201 || body != `{"0a":true}` {
		t.Errorf("status %d, body %q", status, body)
	}
	if headers["Content-Type"] != "application/json" || headers["X-Thing"] != "1" || len(headers) != 2 {
		t.Errorf("only the type and the X-* headers are kept: %v", headers)
	}
	if chunks := d.answer("a1"); len(chunks) != 1 || !chunks[0].end {
		t.Errorf("a small answer is one chunk: %+v", chunks)
	}
	if seen := <-seenCh; seen.method != "POST" || seen.uri != "/v1/apps/web/deploy?x=1&y=a%20b" || seen.auth != "Bearer tok" || seen.body != `{"tag":"abc"}` || seen.length != 13 || seen.remote != "relay" {
		t.Errorf("the handler saw %+v", seen)
	}

	// A request with no body at all.
	c.send(t, request("a2", "GET", "/v1/health"))
	if status, _, body := d.whole(t, "a2"); status != 201 || body != `{"0a":true}` {
		t.Errorf("%d %q", status, body)
	}
	if seen := <-seenCh; seen.method != "GET" || seen.length != 0 || seen.body != "" {
		t.Errorf("a request without a body: %+v", seen)
	}
	if err := a.stop(t); err != nil {
		t.Errorf("Run ends with nil when asked to stop, got %v", err)
	}
}

func TestAnAnswerThatWritesNothingIsAnEmpty200AndTheTypeIsSniffed(t *testing.T) {
	d := newDashboard(t)
	h := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/page" {
			io.WriteString(w, "<!DOCTYPE html><html><body>hi</body></html>")
		}
	})
	start(t, d, h, nil)
	c := d.nextConn(t)
	c.send(t, request("e1", "GET", "/nothing"))
	c.send(t, request("e2", "GET", "/page"))
	if status, _, body := d.whole(t, "e1"); status != 200 || body != "" {
		t.Errorf("%d %q", status, body)
	}
	if status, headers, _ := d.whole(t, "e2"); status != 200 || !strings.HasPrefix(headers["Content-Type"], "text/html") {
		t.Errorf("%d %v", status, headers)
	}
}

func TestAStreamArrivesInSeveralChunksAsTheHandlerFlushes(t *testing.T) {
	d := newDashboard(t)
	gates := []chan struct{}{make(chan struct{}), make(chan struct{}), make(chan struct{})}
	h := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(200)
		w.(http.Flusher).Flush() // the head alone, like the agent's SSE
		for i, g := range gates {
			<-g
			fmt.Fprintf(w, "event: %d\n\n", i)
			http.NewResponseController(w).Flush() // what sse.go does
		}
	})
	start(t, d, h, nil)
	c := d.nextConn(t)
	c.send(t, request("51", "GET", "/v1/containers/web/logs?follow=true"))

	eventually(t, func() bool { return len(d.answer("51")) == 1 }, "the head")
	if first := d.answer("51")[0]; first.status != 200 || first.headers["Content-Type"] != "text/event-stream" || len(first.body) != 0 || first.end {
		t.Errorf("the head must arrive before any data, alone: %+v", first)
	}
	for i, g := range gates {
		close(g)
		want := i + 2
		eventually(t, func() bool { return len(d.answer("51")) >= want }, fmt.Sprintf("chunk %d", want-1))
	}
	_, _, body := d.whole(t, "51")
	if body != "event: 0\n\nevent: 1\n\nevent: 2\n\n" {
		t.Errorf("body %q", body)
	}
	chunks := d.answer("51")
	for i, ch := range chunks {
		if ch.seq != i || ch.end != (i == len(chunks)-1) {
			t.Errorf("chunk %d: %+v", i, ch)
		}
		if i > 0 && (ch.status != 0 || ch.headers != nil) {
			t.Errorf("only the first chunk carries the head: %+v", ch)
		}
	}
	// The head, one chunk per flush, and the end: which may share the last flush's chunk when the handler returns at once.
	if len(chunks) < 4 || len(chunks) > 5 {
		t.Errorf("%d chunks, want 4 or 5", len(chunks))
	}
}

func TestALargeAnswerIsCutIntoChunksAndTheHandlerWaitsForTheConsumer(t *testing.T) {
	d := newDashboard(t)
	const total = 6<<20 + 12345
	payload := make([]byte, total)
	for i := range payload {
		payload[i] = byte(i * 7)
	}
	release := make(chan struct{})
	d.decide = func(id string, c got) int {
		if c.seq == 0 {
			<-release // a consumer that has not taken the first chunk yet
		}
		return 200
	}
	var written atomic.Int64
	h := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/x-tar")
		const piece = 32 << 10
		for p := payload; len(p) > 0; {
			n := min(piece, len(p))
			if _, err := w.Write(p[:n]); err != nil {
				return
			}
			written.Add(int64(n))
			p = p[n:]
		}
	})
	start(t, d, h, nil)
	c := d.nextConn(t)
	c.send(t, request("b16", "POST", "/v1/apps/web/image/export"))

	// One chunk is on its way and one more may fill behind it: no more of the answer is held, whatever the handler has.
	eventually(t, func() bool { return len(d.answer("b16")) == 1 }, "the first chunk")
	time.Sleep(100 * time.Millisecond)
	if w := written.Load(); w > 2*maxChunk+(32<<10) {
		t.Fatalf("the handler wrote %d bytes while the first chunk was not accepted: no backpressure", w)
	}
	close(release)
	status, _, body := d.whole(t, "b16")
	if status != 200 || !bytes.Equal([]byte(body), payload) {
		t.Fatalf("status %d, %d bytes (%d expected), equal=%v", status, len(body), total, bytes.Equal([]byte(body), payload))
	}
	chunks := d.answer("b16")
	if len(chunks) < 6 {
		t.Errorf("%d chunks for %d bytes", len(chunks), total)
	}
	for i, ch := range chunks {
		if len(ch.body) > maxChunk || ch.seq != i {
			t.Errorf("chunk %d: seq %d, %d bytes", i, ch.seq, len(ch.body))
		}
		if ch.end != (i == len(chunks)-1) {
			t.Errorf("only the last chunk ends: %d %v", i, ch.end)
		}
	}
}

func TestThingsProducedWhileAChunkIsInFlightAreSentTogether(t *testing.T) {
	d := newDashboard(t)
	release := make(chan struct{})
	d.decide = func(id string, c got) int {
		if c.seq == 0 {
			<-release
		}
		return 200
	}
	flushed := make(chan struct{})
	h := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		io.WriteString(w, "one,")
		w.(http.Flusher).Flush()
		for _, s := range []string{"two,", "three,", "four"} {
			io.WriteString(w, s)
			w.(http.Flusher).Flush()
		}
		close(flushed)
	})
	start(t, d, h, nil)
	c := d.nextConn(t)
	c.send(t, request("c0", "GET", "/x"))
	<-flushed
	close(release)
	if _, _, body := d.whole(t, "c0"); body != "one,two,three,four" {
		t.Errorf("body %q", body)
	}
	if n := len(d.answer("c0")); n > 3 {
		t.Errorf("what was produced while the first chunk was in flight must be coalesced: %d chunks", n)
	}
}

func TestACancelLineCancelsTheHandlersContext(t *testing.T) {
	d := newDashboard(t)
	started, ended := make(chan struct{}), make(chan error, 1)
	h := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		close(started)
		<-r.Context().Done()
		ended <- context.Cause(r.Context())
	})
	start(t, d, h, nil)
	c := d.nextConn(t)
	c.send(t, request("c1", "GET", "/v1/containers/web/logs?follow=true"))
	<-started
	c.send(t, map[string]string{"type": "cancel", "id": "c1"})
	select {
	case err := <-ended:
		if !errors.Is(err, errCancelled) {
			t.Errorf("cause %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("the handler's context was not cancelled")
	}
	time.Sleep(20 * time.Millisecond)
	if chunks := d.answer("c1"); len(chunks) != 0 {
		t.Errorf("nobody waits for a cancelled request: %+v", chunks)
	}
}

func TestA410StopsTheRequestAndNothingMoreIsSent(t *testing.T) {
	d := newDashboard(t)
	d.decide = func(id string, c got) int {
		if c.seq == 1 {
			return http.StatusGone
		}
		return 200
	}
	ended := make(chan error, 1)
	step := make(chan struct{})
	h := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		for i := 0; ; i++ {
			if _, err := fmt.Fprintf(w, "line %d\n", i); err != nil {
				ended <- err
				return
			}
			w.(http.Flusher).Flush()
			select {
			case <-step:
			case <-r.Context().Done():
				ended <- context.Cause(r.Context())
				return
			}
		}
	})
	start(t, d, h, nil)
	c := d.nextConn(t)
	c.send(t, request("91", "GET", "/stream"))
	eventually(t, func() bool { return len(d.answer("91")) == 1 }, "the first chunk")
	step <- struct{}{} // the second chunk is refused with 410
	select {
	case err := <-ended:
		if !errors.Is(err, errGone) {
			t.Errorf("the handler must be stopped because nobody waits: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("the handler was not stopped by the 410")
	}
	time.Sleep(30 * time.Millisecond)
	if n := len(d.answer("91")); n != 2 {
		t.Errorf("nothing is sent after a 410: %d chunks", n)
	}
}

func TestAnyOtherRefusalOfAChunkEndsTheRequestToo(t *testing.T) {
	d := newDashboard(t)
	d.decide = func(id string, c got) int { return http.StatusRequestEntityTooLarge }
	ended := make(chan struct{})
	h := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		io.WriteString(w, "x")
		w.(http.Flusher).Flush()
		<-r.Context().Done()
		close(ended)
	})
	a := start(t, d, h, nil)
	c := d.nextConn(t)
	c.send(t, request("f1", "GET", "/x"))
	select {
	case <-ended:
	case <-time.After(5 * time.Second):
		t.Fatal("the handler kept running")
	}
	eventually(t, func() bool { return strings.Contains(a.logs.all(), "413") }, "the refusal to be said")
}

func TestAHandlerThatPanicsBeforeAnswering502s(t *testing.T) {
	d := newDashboard(t)
	h := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Partial", "no")
		w.WriteHeader(200)
		io.WriteString(w, "half of an ans")
		panic("boom")
	})
	a := start(t, d, h, nil)
	c := d.nextConn(t)
	c.send(t, request("a9", "GET", "/x"))
	status, headers, body := d.whole(t, "a9")
	if status != 502 || headers["Content-Type"] != "application/json" || len(headers) != 1 {
		t.Errorf("%d %v", status, headers)
	}
	var out map[string]string
	if json.Unmarshal([]byte(body), &out) != nil || out["error"] == "" || strings.Contains(body, "boom") || strings.Contains(body, "half") {
		t.Errorf("the body is a JSON error that leaks nothing: %q", body)
	}
	if !strings.Contains(a.logs.all(), "boom") {
		t.Errorf("the panic must be logged: %q", a.logs.all())
	}
	// The agent still serves.
	c.send(t, request("a8", "GET", "/x"))
	if status, _, _ := d.whole(t, "a8"); status != 502 {
		t.Errorf("%d", status)
	}
}

func TestAHandlerThatPanicsMidStreamCannotChangeTheStatusAndStops(t *testing.T) {
	d := newDashboard(t)
	h := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		io.WriteString(w, "first part")
		w.(http.Flusher).Flush()
		time.Sleep(50 * time.Millisecond) // the first chunk is on its way
		panic("late")
	})
	start(t, d, h, nil)
	c := d.nextConn(t)
	c.send(t, request("e4", "GET", "/x"))
	eventually(t, func() bool { return len(d.answer("e4")) == 1 }, "the first chunk")
	time.Sleep(150 * time.Millisecond)
	chunks := d.answer("e4")
	if len(chunks) != 1 || chunks[0].status != 200 || chunks[0].end {
		t.Errorf("a stream that failed after it started must not look complete nor change its status: %+v", chunks)
	}
}

func TestARequestThatCannotBeFormedIsAnswered(t *testing.T) {
	d := newDashboard(t)
	var called atomic.Bool
	start(t, d, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { called.Store(true) }), nil)
	c := d.nextConn(t)
	bad := map[string]map[string]any{
		"b1": {"type": "request", "id": "b1", "method": "GET", "path": "no-slash"},
		"b2": {"type": "request", "id": "b2", "method": "get it", "path": "/x"},
		"b3": {"type": "request", "id": "b3", "method": "POST", "path": "/x", "body": "not base64!!"},
		"b4": {"type": "request", "id": "b4", "method": "POST", "path": "/x", "body": base64.StdEncoding.EncodeToString(make([]byte, maxBody+1))},
	}
	for _, m := range bad {
		c.send(t, m)
	}
	for id := range bad {
		if status, _, body := d.whole(t, id); status != 400 || !strings.Contains(body, `"error"`) {
			t.Errorf("%s: %d %s", id, status, body)
		}
	}
	if called.Load() {
		t.Error("the handler must not see a request that is not one")
	}
	// The largest body the dashboard may send is taken.
	got := make(chan int, 1)
	start2 := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { b, _ := io.ReadAll(r.Body); got <- len(b) })
	d2 := newDashboard(t)
	start(t, d2, start2, nil)
	c2 := d2.nextConn(t)
	c2.send(t, map[string]any{"type": "request", "id": "0a", "method": "POST", "path": "/x", "body": base64.StdEncoding.EncodeToString(make([]byte, maxBody))})
	if n := <-got; n != maxBody {
		t.Errorf("a body of %d bytes arrived as %d", maxBody, n)
	}
}

func TestNoMoreThanSixtyFourRequestsRunAtOnce(t *testing.T) {
	d := newDashboard(t)
	release := make(chan struct{})
	var running atomic.Int32
	h := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		running.Add(1)
		<-release
	})
	start(t, d, h, nil)
	c := d.nextConn(t)
	for i := range maxInFlight + 1 {
		c.send(t, request(fmt.Sprintf("f%02x", i), "GET", "/x"))
	}
	eventually(t, func() bool { return running.Load() == maxInFlight }, "64 handlers to run")
	over := fmt.Sprintf("f%02x", maxInFlight)
	if status, _, _ := d.whole(t, over); status != 429 {
		t.Errorf("the 65th request: %d", status)
	}
	if running.Load() != maxInFlight {
		t.Errorf("%d handlers run", running.Load())
	}
	close(release)
}

func TestTheWriterOffersFlushAndNoHijack(t *testing.T) {
	d := newDashboard(t)
	type caps struct{ flusher, hijacker bool }
	seen := make(chan caps, 1)
	h := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, flusher := w.(http.Flusher)
		_, hijacker := w.(http.Hijacker)
		seen <- caps{flusher, hijacker}
	})
	start(t, d, h, nil)
	c := d.nextConn(t)
	c.send(t, request("e6", "GET", "/x"))
	if got := <-seen; !got.flusher || got.hijacker {
		t.Errorf("%+v", got)
	}
}

// fakeTime lets the loop's sleeps and clock run without waiting.
type fakeTime struct {
	mu     sync.Mutex
	now    time.Time
	sleeps []time.Duration
	tick   chan struct{}
}

func newFakeTime() *fakeTime {
	return &fakeTime{now: time.Unix(1_700_000_000, 0), tick: make(chan struct{}, 64)}
}

func (f *fakeTime) tune(tm *timing) {
	tm.now = func() time.Time { f.mu.Lock(); defer f.mu.Unlock(); return f.now }
	tm.jitter = func() float64 { return 1 }
	tm.sleep = func(ctx context.Context, d time.Duration) bool {
		f.mu.Lock()
		f.sleeps = append(f.sleeps, d)
		f.mu.Unlock()
		f.tick <- struct{}{}
		return ctx.Err() == nil
	}
}

func (f *fakeTime) advance(d time.Duration) {
	f.mu.Lock()
	f.now = f.now.Add(d)
	f.mu.Unlock()
}

func (f *fakeTime) slept() []time.Duration {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]time.Duration(nil), f.sleeps...)
}

func (f *fakeTime) waitSleep(t *testing.T) {
	t.Helper()
	select {
	case <-f.tick:
	case <-time.After(5 * time.Second):
		t.Fatal("the agent did not wait before reconnecting")
	}
}

func TestItReconnectsWithABackoffThatDoublesAndStartsOverAfterAStableConnection(t *testing.T) {
	d := newDashboard(t)
	d.steps = []connectStep{{drop: true}, {status: 503}, {status: 429}, {drop: true}, {}, {drop: true}}
	ft := newFakeTime()
	a := start(t, d, http.NotFoundHandler(), ft.tune)

	// Connects 1 and 4 are dropped at once, 2 and 3 are refused: four failures in a row.
	for range 4 {
		ft.waitSleep(t)
	}
	d.nextConn(t)
	d.nextConn(t)
	// Connect 5 lasts "two minutes" before it drops: the failure after it starts the backoff over.
	c5 := d.nextConn(t)
	ft.advance(2 * time.Minute)
	close(c5.stop)
	ft.waitSleep(t)
	// Connect 6 is dropped at once: the loop goes on.
	ft.waitSleep(t)

	want := []time.Duration{time.Second, 2 * time.Second, 4 * time.Second, 8 * time.Second, time.Second, 2 * time.Second}
	got := ft.slept()
	if len(got) < len(want) {
		t.Fatalf("waited %v", got)
	}
	for i, w := range want {
		if got[i] != w {
			t.Errorf("wait %d: %v, want %v (all: %v)", i, got[i], w, got)
		}
	}
	logs := a.logs.all()
	for _, want := range []string{"disconnected (the dashboard closed the connection), retrying in 1s", "could not connect (the dashboard answered 503 Service Unavailable), retrying in 2s", "retrying in 8s"} {
		if !strings.Contains(logs, want) {
			t.Errorf("missing %q in:\n%s", want, logs)
		}
	}
	if err := a.stop(t); err != nil {
		t.Error(err)
	}
}

func TestTheBackoffStopsGrowingAtThirtySecondsAndIsJittered(t *testing.T) {
	d := newDashboard(t)
	for range 8 {
		d.steps = append(d.steps, connectStep{status: 503})
	}
	ft := newFakeTime()
	var factors = []float64{0.8, 1.2}
	var n atomic.Int32
	start(t, d, http.NotFoundHandler(), func(tm *timing) {
		ft.tune(tm)
		tm.jitter = func() float64 { return factors[int(n.Add(1)-1)%2] }
	})
	for range 8 {
		ft.waitSleep(t)
	}
	got := ft.slept()
	base := []float64{1, 2, 4, 8, 16, 30, 30, 30}
	for i, b := range base {
		want := time.Duration(b * factors[i%2] * float64(time.Second))
		if got[i] != want {
			t.Errorf("wait %d: %v, want %v", i, got[i], want)
		}
	}
}

func TestAReplacedAgentStopsAndDoesNotReconnect(t *testing.T) {
	d := newDashboard(t)
	ended := make(chan error, 1)
	h := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		<-r.Context().Done()
		ended <- context.Cause(r.Context())
	})
	ft := newFakeTime()
	a := start(t, d, h, ft.tune)
	c := d.nextConn(t)
	c.send(t, request("e5", "GET", "/slow"))
	c.send(t, map[string]string{"type": "replaced"})

	select {
	case err := <-a.done:
		if !errors.Is(err, ErrReplaced) {
			t.Fatalf("got %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("Run did not stop")
	}
	select {
	case <-ended:
	case <-time.After(5 * time.Second):
		t.Error("the request in flight was not cancelled")
	}
	if d.connectCount() != 1 || len(ft.slept()) != 0 {
		t.Errorf("it must not reconnect: %d connects, waits %v", d.connectCount(), ft.slept())
	}
}

func TestAnUnknownCredentialStopsTheAgentAndSaysTheMachineWasRemoved(t *testing.T) {
	d := newDashboard(t)
	ft := newFakeTime()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	opt := Options{Dashboard: d.srv.URL, Credential: "revoked", Name: "m", Handler: http.NotFoundHandler()}
	ft.tune(&opt.timing)
	err := Run(ctx, opt)
	if !errors.Is(err, ErrRevoked) || !strings.Contains(err.Error(), "removed") {
		t.Fatalf("got %v", err)
	}
	if d.connectCount() != 0 || len(ft.slept()) != 0 {
		t.Errorf("no retry: %v", ft.slept())
	}
}

func TestSilenceMeansADeadConnectionAndTheAgentReconnects(t *testing.T) {
	d := newDashboard(t)
	d.steps = []connectStep{{silent: true}, {}}
	ft := newFakeTime()
	a := start(t, d, http.NotFoundHandler(), func(tm *timing) {
		ft.tune(tm)
		tm.idle = 100 * time.Millisecond
	})
	first := d.nextConn(t)
	select {
	case <-first.gone:
	case <-time.After(5 * time.Second):
		t.Fatal("the agent did not hang up a connection that said nothing")
	}
	d.nextConn(t)
	if !strings.Contains(a.logs.all(), "disconnected (no data for 100ms), retrying in 1s") {
		t.Errorf("logs:\n%s", a.logs.all())
	}
}

func TestAnyLineKeepsTheConnectionAlive(t *testing.T) {
	d := newDashboard(t)
	a := start(t, d, http.NotFoundHandler(), func(tm *timing) { tm.idle = 150 * time.Millisecond })
	c := d.nextConn(t)
	for range 8 { // 400 ms in all, with a ping every 50 ms
		time.Sleep(50 * time.Millisecond)
		c.send(t, map[string]string{"type": "ping"})
	}
	if strings.Contains(a.logs.all(), "disconnected") {
		t.Errorf("a ping every 50 ms must keep a 150 ms silence limit from firing:\n%s", a.logs.all())
	}
}

func TestADroppedConnectionCancelsTheRequestsInFlight(t *testing.T) {
	d := newDashboard(t)
	ended := make(chan struct{})
	h := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		<-r.Context().Done()
		close(ended)
	})
	ft := newFakeTime()
	start(t, d, h, ft.tune)
	c := d.nextConn(t)
	c.send(t, request("d1", "GET", "/slow"))
	time.Sleep(20 * time.Millisecond)
	close(c.stop)
	select {
	case <-ended:
	case <-time.After(5 * time.Second):
		t.Fatal("nobody can receive the answer any more: the handler must be stopped")
	}
}

func TestAnErrorStatusThatIsNotAChunkRefusalDoesNotEndTheLoop(t *testing.T) {
	// A dashboard that answers 404 to a connect (an older one) is retried, not fatal.
	d := newDashboard(t)
	d.steps = []connectStep{{status: 404}, {}}
	ft := newFakeTime()
	a := start(t, d, http.NotFoundHandler(), ft.tune)
	ft.waitSleep(t)
	d.nextConn(t)
	if !strings.Contains(a.logs.all(), "the dashboard answered 404") {
		t.Errorf("logs:\n%s", a.logs.all())
	}
}

// ---- Streamed request bodies ---------------------------------------------------------------------------------------

// streamed is a request the dashboard sends with "stream":true and no body.
func streamed(id, method, path string) map[string]any {
	m := request(id, method, path)
	m["stream"] = true
	return m
}

// randomBytes is a payload that no pattern in a transport could get right by accident.
func randomBytes(n int) []byte {
	b := make([]byte, n)
	rand.NewChaCha8([32]byte{1, 2, 3}).Read(b)
	return b
}

// serveBody makes the fake dashboard serve payload as the request's body, in pieces.
func serveBody(payload []byte) func(http.ResponseWriter, *http.Request, string) {
	return func(w http.ResponseWriter, r *http.Request, id string) {
		w.Header().Set("Content-Type", "application/octet-stream")
		for p := payload; len(p) > 0; {
			n := min(256<<10, len(p))
			if _, err := w.Write(p[:n]); err != nil {
				return
			}
			p = p[n:]
		}
	}
}

func TestTheAgentSaysItCanReceiveAStreamedRequestBody(t *testing.T) {
	d := newDashboard(t)
	start(t, d, http.NotFoundHandler(), nil)
	d.nextConn(t)
	d.mu.Lock()
	defer d.mu.Unlock()
	if len(d.features) != 1 || d.features[0] != "request-stream" {
		t.Errorf("X-Relay-Features of the connects: %q", d.features)
	}
}

func TestAStreamedBodyArrivesWholeAndTheHandlerSeesAnUnknownLength(t *testing.T) {
	d := newDashboard(t)
	payload := randomBytes(24<<20 + 12345)
	d.body = serveBody(payload)
	type seenRequest struct {
		length int64
		size   int64
		sum    string
	}
	seen := make(chan seenRequest, 1)
	h := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		sum := sha256.New()
		n, err := io.Copy(sum, r.Body)
		if err != nil {
			t.Errorf("reading the body: %v", err)
		}
		seen <- seenRequest{r.ContentLength, n, hex.EncodeToString(sum.Sum(nil))}
		w.WriteHeader(http.StatusNoContent)
	})
	start(t, d, h, nil)
	c := d.nextConn(t)
	req := streamed("b1", "PUT", "/v1/apps/web/image/abc?sha256=00")
	req["headers"] = map[string]string{"Content-Type": "application/x-tar"}
	c.send(t, req)

	status, _, _ := d.whole(t, "b1")
	want := sha256.Sum256(payload)
	if got := <-seen; status != 204 || got.length != -1 || got.size != int64(len(payload)) || got.sum != hex.EncodeToString(want[:]) {
		t.Errorf("status %d, the handler saw %+v: %d bytes with sha256 %x expected", status, got, len(payload), want)
	}
	// One fetch, as the machine, for that request, and the bytes as they were sent.
	if gets := d.fetched(); len(gets) != 1 || gets[0] != (bodyGet{"b1", "Bearer " + testCredential, "identity"}) {
		t.Errorf("fetches: %+v", gets)
	}
}

func TestAHandlerThatNeverReadsTheBodyFetchesNothing(t *testing.T) {
	d := newDashboard(t)
	d.body = serveBody([]byte("never asked for"))
	h := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadRequest) // refused on the headers alone
	})
	start(t, d, h, nil)
	c := d.nextConn(t)
	c.send(t, streamed("b2", "PUT", "/v1/apps/web/image/abc"))
	if status, _, _ := d.whole(t, "b2"); status != 400 {
		t.Errorf("status %d", status)
	}
	if gets := d.fetched(); len(gets) != 0 {
		t.Errorf("the body was fetched for a request that did not read it: %+v", gets)
	}
}

func TestTheFetchEndsWhenTheHandlerReturnsBeforeTheEndOfTheBody(t *testing.T) {
	d := newDashboard(t)
	gone := make(chan struct{})
	d.body = func(w http.ResponseWriter, r *http.Request, id string) {
		defer close(gone)
		for {
			if _, err := w.Write(make([]byte, 64<<10)); err != nil {
				return
			}
			select {
			case <-r.Context().Done():
				return
			case <-time.After(time.Millisecond):
			}
		}
	}
	h := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		io.ReadFull(r.Body, make([]byte, 1)) // takes a byte of the body and answers
		w.WriteHeader(http.StatusRequestEntityTooLarge)
	})
	start(t, d, h, nil)
	c := d.nextConn(t)
	c.send(t, streamed("b3", "PUT", "/v1/apps/web/image/abc"))
	if status, _, _ := d.whole(t, "b3"); status != 413 {
		t.Errorf("status %d", status)
	}
	select {
	case <-gone:
	case <-time.After(5 * time.Second):
		t.Fatal("the dashboard went on sending a body nobody reads")
	}
}

func TestACancelAbortsTheFetchOfTheBody(t *testing.T) {
	d := newDashboard(t)
	fetchEnded := make(chan struct{})
	d.body = func(w http.ResponseWriter, r *http.Request, id string) {
		w.Write(make([]byte, 1024))
		w.(http.Flusher).Flush()
		<-r.Context().Done() // the rest of the body never comes
		close(fetchEnded)
	}
	reading := make(chan struct{})
	readErr := make(chan error, 1)
	h := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, err := io.ReadFull(r.Body, make([]byte, 1024))
		if err != nil {
			readErr <- err
			return
		}
		close(reading)
		_, err = io.Copy(io.Discard, r.Body)
		readErr <- err
	})
	start(t, d, h, nil)
	c := d.nextConn(t)
	c.send(t, streamed("b4", "PUT", "/v1/apps/web/image/abc"))
	select {
	case <-reading:
	case <-time.After(5 * time.Second):
		t.Fatal("the handler did not get the first bytes")
	}
	c.send(t, map[string]string{"type": "cancel", "id": "b4"})
	select {
	case <-fetchEnded:
	case <-time.After(5 * time.Second):
		t.Fatal("the fetch of the body was not aborted by the cancel")
	}
	if err := <-readErr; !errors.Is(err, errCancelled) {
		t.Errorf("the handler's read must say why it ended: %v", err)
	}
}

func TestALostConnectionAbortsTheFetchOfTheBody(t *testing.T) {
	d := newDashboard(t)
	fetchEnded := make(chan struct{})
	d.body = func(w http.ResponseWriter, r *http.Request, id string) {
		w.Write(make([]byte, 1024))
		w.(http.Flusher).Flush()
		<-r.Context().Done()
		close(fetchEnded)
	}
	reading := make(chan struct{})
	readErr := make(chan error, 1)
	h := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		io.ReadFull(r.Body, make([]byte, 1024))
		close(reading)
		_, err := io.Copy(io.Discard, r.Body)
		readErr <- err
	})
	start(t, d, h, newFakeTime().tune)
	c := d.nextConn(t)
	c.send(t, streamed("b5", "PUT", "/v1/apps/web/image/abc"))
	<-reading
	close(c.stop)
	select {
	case <-fetchEnded:
	case <-time.After(5 * time.Second):
		t.Fatal("the fetch of the body outlived the connection")
	}
	if err := <-readErr; err == nil {
		t.Error("the handler must not see a clean end of a body that was cut")
	}
}

func TestADashboardThatRefusesTheBodyGivesTheHandlerAReadError(t *testing.T) {
	for name, status := range map[string]int{"gone": http.StatusGone, "unknown": http.StatusNotFound, "taken": http.StatusConflict} {
		t.Run(name, func(t *testing.T) {
			d := newDashboard(t)
			d.body = func(w http.ResponseWriter, r *http.Request, id string) { w.WriteHeader(status) }
			h := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				_, first := io.ReadAll(r.Body)
				_, second := io.ReadAll(r.Body)
				w.Header().Set("Content-Type", "text/plain")
				w.WriteHeader(http.StatusBadRequest)
				fmt.Fprintf(w, "%v | %v", first, second)
			})
			start(t, d, h, nil)
			c := d.nextConn(t)
			c.send(t, streamed("b6", "PUT", "/v1/apps/web/image/abc"))
			code, _, body := d.whole(t, "b6")
			want := "the dashboard refused the request body: " + strconv.Itoa(status)
			if code != 400 || !strings.Contains(body, want) {
				t.Errorf("status %d, body %q, want it to say %q", code, body, want)
			}
			if first, second, ok := strings.Cut(body, " | "); !ok || first != second {
				t.Errorf("a refused body fails the same way every time: %q", body)
			}
			if n := len(d.fetched()); n != 1 {
				t.Errorf("the refusal is not retried: %d fetches", n)
			}
		})
	}
}

func TestABodyCutShortByTheDashboardIsNotACleanEnd(t *testing.T) {
	d := newDashboard(t)
	d.body = func(w http.ResponseWriter, r *http.Request, id string) {
		w.Write(make([]byte, 4096))
		w.(http.Flusher).Flush()
		panic(http.ErrAbortHandler) // the connection drops without the end of the stream
	}
	readErr := make(chan error, 1)
	h := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, err := io.Copy(io.Discard, r.Body)
		readErr <- err
	})
	start(t, d, h, nil)
	c := d.nextConn(t)
	c.send(t, streamed("b7", "PUT", "/v1/apps/web/image/abc"))
	if err := <-readErr; !errors.Is(err, io.ErrUnexpectedEOF) {
		t.Errorf("got %v", err)
	}
}

func TestAStreamedBodyLargerThanTheLimitIsRefusedByTheAgentToo(t *testing.T) {
	const limit = 1 << 20
	d := newDashboard(t)
	d.body = func(w http.ResponseWriter, r *http.Request, id string) {
		serveBody(make([]byte, limit+1))(w, r, id)
	}
	type result struct {
		n   int64
		err error
	}
	results := make(chan result, 2)
	h := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n, err := io.Copy(io.Discard, r.Body)
		results <- result{n, err}
	})
	start(t, d, h, func(tm *timing) { tm.maxStream = limit })
	c := d.nextConn(t)
	c.send(t, streamed("b8", "PUT", "/v1/apps/web/image/abc"))
	var tooBig *http.MaxBytesError
	if got := <-results; !errors.As(got.err, &tooBig) || got.n != limit {
		t.Errorf("%d bytes, %v", got.n, got.err)
	}

	// Exactly the limit is taken.
	d.body = serveBody(make([]byte, limit))
	c.send(t, streamed("b9", "PUT", "/v1/apps/web/image/abc"))
	if got := <-results; got.err != nil || got.n != limit {
		t.Errorf("%d bytes, %v", got.n, got.err)
	}
}

func TestABodyAndAStreamTogetherAreNotARequest(t *testing.T) {
	d := newDashboard(t)
	var called atomic.Bool
	start(t, d, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { called.Store(true) }), nil)
	c := d.nextConn(t)
	req := streamed("ba", "PUT", "/x")
	req["body"] = base64.StdEncoding.EncodeToString([]byte("both"))
	c.send(t, req)
	if status, _, body := d.whole(t, "ba"); status != 400 || !strings.Contains(body, "not both") {
		t.Errorf("%d %s", status, body)
	}
	if called.Load() {
		t.Error("the handler must not see it")
	}
}

func TestSlowlyReadingABodyDoesNotMakeTheConnectionLookDead(t *testing.T) {
	d := newDashboard(t)
	const pieces = 6
	d.body = func(w http.ResponseWriter, r *http.Request, id string) {
		for range pieces {
			w.Write(make([]byte, 1024))
			w.(http.Flusher).Flush()
			time.Sleep(80 * time.Millisecond)
		}
	}
	got := make(chan int64, 1)
	h := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n, _ := io.Copy(io.Discard, r.Body)
		got <- n
	})
	// The body takes 480 ms; a silence of 200 ms on the connection would end the session.
	a := start(t, d, h, func(tm *timing) { tm.idle = 200 * time.Millisecond })
	c := d.nextConn(t)
	c.send(t, streamed("bb", "PUT", "/v1/apps/web/image/abc"))
	for len(got) == 0 {
		time.Sleep(50 * time.Millisecond)
		c.send(t, map[string]string{"type": "ping"}) // what the dashboard does every 15 s
	}
	if n := <-got; n != pieces*1024 {
		t.Errorf("%d bytes", n)
	}
	if strings.Contains(a.logs.all(), "disconnected") || d.connectCount() != 1 {
		t.Errorf("the body download must leave the session alone:\n%s", a.logs.all())
	}
}
