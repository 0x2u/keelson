package docker

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// fakeEngine serves canned Docker Engine answers on a unix socket and records
// every request it receives.
type fakeEngine struct {
	mu      sync.Mutex
	reqs    []string // "METHOD path?query"
	handler http.HandlerFunc
}

func (f *fakeEngine) requests() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.reqs...)
}

func newClient(t *testing.T, f *fakeEngine) *Client {
	t.Helper()
	dir, err := os.MkdirTemp("", "kd")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })
	sock := filepath.Join(dir, "d.sock")
	ln, err := net.Listen("unix", sock)
	if err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		f.reqs = append(f.reqs, r.Method+" "+r.URL.RequestURI())
		f.mu.Unlock()
		f.handler(w, r)
	}))
	srv.Listener = ln
	srv.Start()
	t.Cleanup(srv.Close)
	return New(sock)
}

func frame(stream byte, payload string) []byte {
	hdr := make([]byte, 8)
	hdr[0] = stream
	binary.BigEndian.PutUint32(hdr[4:], uint32(len(payload)))
	return append(hdr, payload...)
}

const inspectBody = `{"Id":"abc","Name":"/web","Created":"2026-01-01T00:00:00Z","RestartCount":2,
"Config":{"Image":"nginx","Tty":%TTY%,"Env":["SECRET=hunter2"]},
"State":{"Status":"running","Running":true,"StartedAt":"2026-01-02T00:00:00Z","FinishedAt":"0001-01-01T00:00:00Z",
"Health":{"Status":"healthy"}}}`

func TestListContainersMapsEngineFields(t *testing.T) {
	f := &fakeEngine{handler: func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`[{"Id":"abc","Names":["/web"],"Image":"nginx","ImageID":"sha256:1","Command":"nginx","Created":5,
"State":"running","Status":"Up 1 hour","Labels":null,"Ports":[{"IP":"0.0.0.0","PrivatePort":80,"PublicPort":8080,"Type":"tcp"}]}]`))
	}}
	c := newClient(t, f)

	got, err := c.ListContainers(context.Background(), true)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 {
		t.Fatalf("want 1 container, got %d", len(got))
	}
	ct := got[0]
	if ct.Name != "web" || ct.Labels == nil || len(ct.Ports) != 1 || ct.Ports[0].PublicPort != 8080 {
		t.Errorf("unexpected mapping: %+v", ct)
	}
	if reqs := f.requests(); len(reqs) != 1 || reqs[0] != "GET /containers/json?all=1" {
		t.Errorf("unexpected requests: %v", reqs)
	}
}

func TestInspectHidesEnvironmentAndMapsHealth(t *testing.T) {
	f := &fakeEngine{handler: func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(strings.ReplaceAll(inspectBody, "%TTY%", "false")))
	}}
	d, err := newClient(t, f).Inspect(context.Background(), "web")
	if err != nil {
		t.Fatal(err)
	}
	if d.Name != "web" || d.State.Health != "healthy" || d.RestartCount != 2 {
		t.Errorf("unexpected detail: %+v", d)
	}
	if d.State.FinishedAt != nil {
		t.Errorf("zero FinishedAt must be omitted, got %v", d.State.FinishedAt)
	}
}

func TestInvalidIDsNeverReachTheEngine(t *testing.T) {
	f := &fakeEngine{handler: func(w http.ResponseWriter, r *http.Request) { w.Write([]byte(`{}`)) }}
	c := newClient(t, f)
	ctx := context.Background()

	for _, id := range []string{"", "../../etc", "a/b", "a b", "-x", "web?all=1", strings.Repeat("a", 129)} {
		if _, err := c.Inspect(ctx, id); !errors.Is(err, ErrInvalidID) {
			t.Errorf("Inspect(%q): want ErrInvalidID, got %v", id, err)
		}
		if err := c.Logs(ctx, id, LogOptions{}, nil); !errors.Is(err, ErrInvalidID) {
			t.Errorf("Logs(%q): want ErrInvalidID, got %v", id, err)
		}
		if err := c.Stats(ctx, id, nil); !errors.Is(err, ErrInvalidID) {
			t.Errorf("Stats(%q): want ErrInvalidID, got %v", id, err)
		}
	}
	if reqs := f.requests(); len(reqs) != 0 {
		t.Errorf("engine received requests for invalid ids: %v", reqs)
	}
}

func TestEngineNotFoundIsReported(t *testing.T) {
	f := &fakeEngine{handler: func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(404)
		w.Write([]byte(`{"message":"No such container: nope"}`))
	}}
	_, err := newClient(t, f).Inspect(context.Background(), "nope")
	if !IsNotFound(err) {
		t.Fatalf("want not found, got %v", err)
	}
}

func TestClientOnlyIssuesGET(t *testing.T) {
	f := &fakeEngine{handler: func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.HasSuffix(r.URL.Path, "/logs"):
			w.Write(frame(1, "2026-01-01T00:00:00Z hi\n"))
		case strings.HasSuffix(r.URL.Path, "/stats"):
			w.Write([]byte(`{"read":"2026-01-01T00:00:00Z"}`))
		case strings.HasSuffix(r.URL.Path, "/json") && strings.HasPrefix(r.URL.Path, "/containers/web"):
			w.Write([]byte(strings.ReplaceAll(inspectBody, "%TTY%", "false")))
		case r.URL.Path == "/containers/json":
			w.Write([]byte(`[]`))
		default:
			w.Write([]byte(`OK`))
		}
	}}
	c := newClient(t, f)
	ctx := context.Background()

	_ = c.Ping(ctx)
	_, _ = c.ListContainers(ctx, true)
	_, _ = c.Inspect(ctx, "web")
	_ = c.Logs(ctx, "web", LogOptions{Tail: "10"}, func(LogLine) error { return nil })
	_ = c.Stats(ctx, "web", func(Stats) error { return nil })

	reqs := f.requests()
	if len(reqs) < 6 {
		t.Fatalf("expected every call to reach the engine, got %v", reqs)
	}
	for _, r := range reqs {
		if !strings.HasPrefix(r, "GET ") {
			t.Errorf("non-GET request issued to the engine: %s", r)
		}
	}
}

func TestLogsDemultiplexesAndSplitsFramesIntoLines(t *testing.T) {
	var body bytes.Buffer
	body.Write(frame(1, "2026-01-01T00:00:01.5Z first\n2026-01-01T00:00:02Z sec"))
	body.Write(frame(2, "2026-01-01T00:00:03Z oops\r\n"))
	body.Write(frame(1, "ond\n2026-01-01T00:00:04Z trailing no newline"))

	var got []LogLine
	err := streamLogs(&body, false, func(l LogLine) error { got = append(got, l); return nil })
	if err != nil {
		t.Fatal(err)
	}
	want := []struct{ stream, line string }{
		{"stdout", "first"},
		{"stderr", "oops"}, // a line completes in the frame where its newline arrives
		{"stdout", "second"},
		{"stdout", "trailing no newline"},
	}
	if len(got) != len(want) {
		t.Fatalf("want %d lines, got %d: %+v", len(want), len(got), got)
	}
	for i, w := range want {
		if got[i].Stream != w.stream || got[i].Line != w.line {
			t.Errorf("line %d: want %+v, got %+v", i, w, got[i])
		}
	}
	if got[0].Time.IsZero() || got[0].Time.Nanosecond() != 500_000_000 {
		t.Errorf("timestamp not parsed: %v", got[0].Time)
	}
}

func TestLogsTTYStreamIsUnframed(t *testing.T) {
	raw := "2026-01-01T00:00:00Z a\n2026-01-01T00:00:01Z b\n"
	var got []string
	err := streamLogs(strings.NewReader(raw), true, func(l LogLine) error { got = append(got, l.Stream+":"+l.Line); return nil })
	if err != nil {
		t.Fatal(err)
	}
	if strings.Join(got, "|") != "stdout:a|stdout:b" {
		t.Errorf("got %v", got)
	}
}

func TestLogsRejectsOversizedFrame(t *testing.T) {
	hdr := make([]byte, 8)
	hdr[0] = 1
	binary.BigEndian.PutUint32(hdr[4:], maxFrame+1)
	if err := streamLogs(bytes.NewReader(hdr), false, func(LogLine) error { return nil }); err == nil {
		t.Fatal("oversized frame must fail")
	}
}

func TestLogsLongLineWithoutNewlineIsCut(t *testing.T) {
	var lb lineBuf
	var lines []string
	emit := func(s string) error { lines = append(lines, s); return nil }
	if err := lb.write(bytes.Repeat([]byte("x"), maxLine+1), emit); err != nil {
		t.Fatal(err)
	}
	if len(lines) != 1 || len(lines[0]) != maxLine+1 || len(lb.buf) != 0 {
		t.Errorf("long line not flushed: %d lines, %d buffered", len(lines), len(lb.buf))
	}
}

func TestLogsErrStopEndsWithoutError(t *testing.T) {
	f := &fakeEngine{handler: func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/logs") {
			w.Write(frame(1, "2026-01-01T00:00:00Z a\n2026-01-01T00:00:01Z b\n"))
			return
		}
		w.Write([]byte(strings.ReplaceAll(inspectBody, "%TTY%", "false")))
	}}
	n := 0
	err := newClient(t, f).Logs(context.Background(), "web", LogOptions{}, func(LogLine) error { n++; return ErrStop })
	if err != nil || n != 1 {
		t.Errorf("want 1 line and nil error, got %d, %v", n, err)
	}
}

func TestStatsComputesCPUAndMemoryLikeDockerStats(t *testing.T) {
	f := &fakeEngine{handler: func(w http.ResponseWriter, r *http.Request) {
		// cpuDelta 200, sysDelta 1000, 4 CPUs => 80%. Memory 1000 - 400 cache.
		w.Write([]byte(`{"read":"2026-01-01T00:00:01Z",
"cpu_stats":{"cpu_usage":{"total_usage":1200},"system_cpu_usage":11000,"online_cpus":4},
"precpu_stats":{"cpu_usage":{"total_usage":1000},"system_cpu_usage":10000},
"memory_stats":{"usage":1000,"limit":2000,"stats":{"inactive_file":400}},
"networks":{"eth0":{"rx_bytes":10,"tx_bytes":20},"eth1":{"rx_bytes":1,"tx_bytes":2}},
"pids_stats":{"current":7}}`))
	}}
	var got Stats
	err := newClient(t, f).Stats(context.Background(), "web", func(s Stats) error { got = s; return nil })
	if err != nil {
		t.Fatal(err)
	}
	if got.CPUPercent != 80 || got.MemUsage != 600 || got.MemPercent != 30 || got.NetRx != 11 || got.NetTx != 22 || got.PIDs != 7 {
		t.Errorf("unexpected stats: %+v", got)
	}
}

func TestStatsFirstSampleHasNoCPUAndNoUnderflow(t *testing.T) {
	raw := rawStats{Read: time.Now()}
	raw.CPUStats.CPUUsage.TotalUsage = 500
	raw.CPUStats.SystemUsage = 9000
	raw.MemoryStats.Usage = 100
	raw.MemoryStats.Stats = map[string]uint64{"inactive_file": 5000} // cache > usage
	s := raw.toStats()
	if s.CPUPercent != 0 {
		t.Errorf("first sample must report 0%% CPU, got %v", s.CPUPercent)
	}
	if s.MemUsage != 100 {
		t.Errorf("memory must not underflow when cache exceeds usage, got %d", s.MemUsage)
	}
}

func TestListByLabelSendsAFilterAndIncludesStoppedContainers(t *testing.T) {
	f := &fakeEngine{handler: func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`[{"Id":"x","Names":["/web-abc"],"State":"exited"}]`))
	}}
	got, err := newClient(t, f).ListByLabel(context.Background(), "keelson.app=web")
	if err != nil || len(got) != 1 || got[0].Name != "web-abc" {
		t.Fatalf("got %+v, %v", got, err)
	}
	req := f.requests()[0]
	if !strings.Contains(req, "all=1") || !strings.Contains(req, "filters=%7B%22label%22%3A%5B%22keelson.app%3Dweb%22%5D%7D") {
		t.Errorf("unexpected request: %s", req)
	}
}

func TestInspectReportsOnlyPublishedPorts(t *testing.T) {
	f := &fakeEngine{handler: func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"Id":"x","Name":"/web","Config":{},"State":{},
"NetworkSettings":{"Ports":{"3000/tcp":[{"HostIp":"127.0.0.1","HostPort":"40123"}],"9000/tcp":null,"53/udp":[{"HostIp":"0.0.0.0","HostPort":"5353"}]}}}`))
	}}
	d, err := newClient(t, f).Inspect(context.Background(), "web")
	if err != nil {
		t.Fatal(err)
	}
	if len(d.Ports) != 2 || d.Ports[0].PrivatePort != 53 || d.Ports[0].Type != "udp" ||
		d.Ports[1].PrivatePort != 3000 || d.Ports[1].PublicPort != 40123 || d.Ports[1].IP != "127.0.0.1" {
		t.Errorf("unexpected ports: %+v", d.Ports)
	}
}

func TestInspectKeepsTheEnvironmentOutOfTheJSON(t *testing.T) {
	f := &fakeEngine{handler: func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(strings.ReplaceAll(inspectBody, "%TTY%", "false")))
	}}
	d, err := newClient(t, f).Inspect(context.Background(), "web")
	if err != nil {
		t.Fatal(err)
	}
	if len(d.Env) != 1 || d.Env[0] != "SECRET=hunter2" {
		t.Fatalf("the agent needs the environment internally, got %v", d.Env)
	}
	b, _ := json.Marshal(d)
	if strings.Contains(string(b), "hunter2") || strings.Contains(string(b), "SECRET") {
		t.Errorf("the environment must never reach the API: %s", b)
	}
}
