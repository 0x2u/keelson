package notify

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"testing"
	"time"

	"github.com/0x2u/keelson/agent/internal/config"
)

// closedURL is the address of a port nothing listens on.
func closedURL(t *testing.T) string {
	t.Helper()
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	addr := l.Addr().String()
	l.Close()
	return "http://" + addr
}

type channelHarness struct {
	svc    *Service
	ledger *Ledger
	logs   *bytes.Buffer
	proven atomic.Int32
}

// newChannels builds a service whose configuration is nc, with a ledger and a hook that counts the proofs.
func newChannels(t *testing.T, nc *config.Notifications) *channelHarness {
	t.Helper()
	h := &channelHarness{ledger: OpenLedger("", quiet), logs: &bytes.Buffer{}}
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	h.svc = NewService(ctx, &fakeSource{}, slog.New(slog.NewTextHandler(h.logs, nil)))
	h.svc.SetHooks(Hooks{Ledger: h.ledger, Proven: func(context.Context, time.Time) error { h.proven.Add(1); return nil }})
	if err := h.svc.Reconfigure(nc); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { h.svc.Close(time.Second) })
	return h
}

func tokenFile(t *testing.T, token string) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), "token")
	if err := os.WriteFile(p, []byte(token+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	return p
}

// A receiver that counts what it gets and answers with status.
type receiver struct {
	*httptest.Server
	mu     sync.Mutex
	events []string
	bodies []Event
}

func newReceiver(t *testing.T, status int, delay time.Duration) *receiver {
	t.Helper()
	r := &receiver{}
	r.Server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		var e Event
		json.NewDecoder(req.Body).Decode(&e)
		r.mu.Lock()
		r.events = append(r.events, req.Header.Get("X-Keelson-Event"))
		r.bodies = append(r.bodies, e)
		r.mu.Unlock()
		time.Sleep(delay)
		w.WriteHeader(status)
	}))
	t.Cleanup(r.Close)
	return r
}

func (r *receiver) count() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return len(r.events)
}

func TestEachChannelOfATestIsToldByTheKindOfItsFailure(t *testing.T) {
	ok := newReceiver(t, 204, 0)
	refusing := newReceiver(t, 500, 0)
	slow := newReceiver(t, 204, 3*time.Second)
	secret := "SECRET-TOKEN-IN-THE-PATH"
	h := newChannels(t, &config.Notifications{
		Events: []string{config.EventAppDown},
		Webhooks: []config.Webhook{
			{URL: ok.URL + "/hook/" + secret},
			{URL: refusing.URL + "/hook/" + secret},
			{URL: closedURL(t) + "/hook/" + secret},
			{URL: slow.URL + "/hook/" + secret},
		},
	})

	ctx, cancel := context.WithTimeout(context.Background(), 500*time.Millisecond)
	defer cancel()
	got, err := h.svc.Test(ctx)
	if err != nil {
		t.Fatal(err)
	}
	want := []ChannelResult{
		{Channel: "webhook", OK: true},
		{Channel: "webhook", Reason: "rejected"},
		{Channel: "webhook", Reason: "refused"},
		{Channel: "webhook", Reason: "timeout"},
	}
	if len(got) != len(want) {
		t.Fatalf("%+v", got)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("channel %d: got %+v, want %+v", i, got[i], want[i])
		}
	}
	if h.proven.Load() != 0 {
		t.Error("a test that did not reach every channel proves nothing")
	}

	raw, _ := json.Marshal(map[string]any{"channels": got})
	if strings.Contains(string(raw), secret) || strings.Contains(string(raw), "127.0.0.1") || strings.Contains(string(raw), "http") {
		t.Errorf("an error that could quote a URL or token must not be in the answer: %s", raw)
	}
	if strings.Contains(h.logs.String(), secret) {
		t.Errorf("the log must not carry the token in the path either:\n%s", h.logs)
	}
	if !strings.Contains(h.logs.String(), "notification test not delivered") {
		t.Errorf("but the operator finds the failure in the log:\n%s", h.logs)
	}
}

func TestATestMessageIsNotAnEventItIsSentOnceAndNeverStoredInTheHistory(t *testing.T) {
	ok := newReceiver(t, 200, 0)
	h := newChannels(t, &config.Notifications{Events: []string{config.EventAppDown}, Webhooks: []config.Webhook{{URL: ok.URL}}})

	got, err := h.svc.Test(context.Background())
	if err != nil || len(got) != 1 || !got[0].OK {
		t.Fatalf("%+v %v", got, err)
	}
	if ok.count() != 1 || ok.events[0] != EventTest || ok.bodies[0].Type != EventTest || ok.bodies[0].Title == "" {
		t.Errorf("one test message reached the channel: %v %+v", ok.events, ok.bodies)
	}
	if events := h.svc.Events(10); len(events) != 0 {
		t.Errorf("the test is not part of the history: %+v", events)
	}
	if h.proven.Load() != 1 {
		t.Errorf("every channel delivered: the proof is recorded once, not %d times", h.proven.Load())
	}
}

func TestATestRecordsAProofOnlyWhenEveryChannelDeliveredAndThereIsOne(t *testing.T) {
	t.Run("no section", func(t *testing.T) {
		h := newChannels(t, nil)
		got, err := h.svc.Test(context.Background())
		if err != nil || got == nil || len(got) != 0 {
			t.Fatalf("%v %v", got, err)
		}
		if raw, _ := json.Marshal(got); string(raw) != "[]" {
			t.Errorf("%s", raw)
		}
		if h.proven.Load() != 0 {
			t.Error("no channel proves nothing")
		}
	})
	t.Run("a section without a channel", func(t *testing.T) {
		h := newChannels(t, &config.Notifications{Events: []string{config.EventAppDown}})
		if got, err := h.svc.Test(context.Background()); err != nil || len(got) != 0 || h.proven.Load() != 0 {
			t.Fatalf("%v %v proven %d", got, err, h.proven.Load())
		}
	})
	t.Run("one of two fails", func(t *testing.T) {
		ok := newReceiver(t, 200, 0)
		h := newChannels(t, &config.Notifications{Events: []string{config.EventAppDown}, Webhooks: []config.Webhook{{URL: ok.URL}, {URL: closedURL(t)}}})
		got, _ := h.svc.Test(context.Background())
		if len(got) != 2 || !got[0].OK || got[1].OK || h.proven.Load() != 0 {
			t.Fatalf("%+v proven %d", got, h.proven.Load())
		}
	})
	t.Run("all deliver, telegram too", func(t *testing.T) {
		hook := newReceiver(t, 200, 0)
		tg := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if !strings.HasPrefix(r.URL.Path, "/bot123:TOKEN/") {
				w.WriteHeader(404)
				return
			}
			w.Write([]byte(`{"ok":true}`))
		}))
		defer tg.Close()
		h := newChannels(t, &config.Notifications{
			Events:   []string{config.EventAppDown},
			Webhooks: []config.Webhook{{URL: hook.URL}},
			Telegram: &config.Telegram{BotTokenFile: tokenFile(t, "123:TOKEN"), ChatID: "1", APIURL: tg.URL},
		})
		got, err := h.svc.Test(context.Background())
		if err != nil || len(got) != 2 || got[0] != (ChannelResult{Channel: "webhook", OK: true}) || got[1] != (ChannelResult{Channel: "telegram", OK: true}) {
			t.Fatalf("%+v %v", got, err)
		}
		if h.proven.Load() != 1 {
			t.Errorf("proven %d", h.proven.Load())
		}
	})
	t.Run("the proof cannot be recorded", func(t *testing.T) {
		ok := newReceiver(t, 200, 0)
		h := newChannels(t, &config.Notifications{Events: []string{config.EventAppDown}, Webhooks: []config.Webhook{{URL: ok.URL}}})
		h.svc.hooks.Proven = func(context.Context, time.Time) error { return errors.New("disk full") }
		if _, err := h.svc.Test(context.Background()); err == nil {
			t.Error("a delivered test whose proof is lost is an error, not a silent success")
		}
	})
}

func TestATelegramThatRefusesTheTokenIsRejectedAndNeverQuotesIt(t *testing.T) {
	tg := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(401)
		w.Write([]byte(`{"ok":false,"description":"Unauthorized"}`))
	}))
	defer tg.Close()
	h := newChannels(t, &config.Notifications{Events: []string{config.EventAppDown}, Telegram: &config.Telegram{BotTokenFile: tokenFile(t, "999:WRONG"), ChatID: "1", APIURL: tg.URL}})
	got, _ := h.svc.Test(context.Background())
	if len(got) != 1 || got[0] != (ChannelResult{Channel: "telegram", Reason: "rejected"}) {
		t.Fatalf("%+v", got)
	}

	// And a Telegram that cannot be reached: Go's own error quotes the URL, which carries the token.
	h = newChannels(t, &config.Notifications{Events: []string{config.EventAppDown}, Telegram: &config.Telegram{BotTokenFile: tokenFile(t, "999:WRONG"), ChatID: "1", APIURL: closedURL(t)}})
	got, _ = h.svc.Test(context.Background())
	if len(got) != 1 || got[0] != (ChannelResult{Channel: "telegram", Reason: "refused"}) {
		t.Fatalf("%+v", got)
	}
	if strings.Contains(h.logs.String(), "WRONG") {
		t.Errorf("the token reached the log:\n%s", h.logs)
	}
}

func TestReasonNamesTheKindOfFailureAndNothingElse(t *testing.T) {
	for name, tc := range map[string]struct {
		err  error
		want string
	}{
		"rejected":          {rejection{"answered 500"}, "rejected"},
		"wrapped rejection": {errors.Join(errors.New("x"), rejection{"telegram: no"}), "rejected"},
		"deadline":          {context.DeadlineExceeded, "timeout"},
		"refused":           {&net.OpError{Op: "dial", Err: os.NewSyscallError("connect", syscall.ECONNREFUSED)}, "refused"},
		"only the words":    {errors.New("connection refused"), "other"},
		"anything else":     {errors.New("boom https://hook/secret"), "other"},
	} {
		if got := Reason(tc.err); got != tc.want {
			t.Errorf("%s: %q, want %q", name, got, tc.want)
		}
	}
}
