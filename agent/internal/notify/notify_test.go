package notify

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/0x2u/keelson/agent/internal/config"
)

var quiet = slog.New(slog.NewTextHandler(io.Discard, nil))

func event(typ string) Event {
	return Event{Type: typ, Severity: SeverityWarning, Server: "vps-1", App: "web", Title: "web: deployment failed", Message: "boom", Ref: "ghcr.io/o/web:v1"}
}

// --- webhook ---------------------------------------------------------------

func TestWebhookPostsSignedJSON(t *testing.T) {
	var got struct {
		header http.Header
		body   []byte
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got.header = r.Header.Clone()
		got.body, _ = io.ReadAll(r.Body)
	}))
	defer srv.Close()

	if err := NewWebhook(srv.URL+"/hook/secret-path", "s3cret").Send(context.Background(), event(config.EventDeploymentFailed)); err != nil {
		t.Fatal(err)
	}
	var e Event
	if err := json.Unmarshal(got.body, &e); err != nil || e.Type != "deployment.failed" || e.App != "web" || e.Ref != "ghcr.io/o/web:v1" {
		t.Errorf("unexpected payload: %s (%v)", got.body, err)
	}
	if got.header.Get("X-Keelson-Event") != "deployment.failed" || got.header.Get("Content-Type") != "application/json" {
		t.Errorf("unexpected headers: %v", got.header)
	}
	if sig := got.header.Get("X-Keelson-Signature"); sig != Signature("s3cret", got.body) || !strings.HasPrefix(sig, "sha256=") {
		t.Errorf("signature %q does not match the body", sig)
	}
}

func TestWebhookWithoutSecretSendsNoSignature(t *testing.T) {
	var sig string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { sig = r.Header.Get("X-Keelson-Signature") }))
	defer srv.Close()
	if err := NewWebhook(srv.URL, "").Send(context.Background(), event("x")); err != nil || sig != "" {
		t.Errorf("err %v, signature %q", err, sig)
	}
}

func TestWebhookErrorsNeverRevealTheSecretURL(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(500) }))
	w := NewWebhook(srv.URL+"/services/T000/B000/XXXXSECRETXXXX", "")
	if err := w.Send(context.Background(), event("x")); err == nil || !strings.Contains(err.Error(), "500") {
		t.Fatalf("want a status error, got %v", err)
	}
	srv.Close()
	err := w.Send(context.Background(), event("x")) // connection refused: Go puts the URL in this error
	if err == nil || strings.Contains(err.Error(), "XXXXSECRETXXXX") {
		t.Errorf("a transport error must not carry the URL: %v", err)
	}
	if strings.Contains(w.Name(), "XXXXSECRETXXXX") {
		t.Errorf("the channel name appears in logs and must not carry the URL: %q", w.Name())
	}
}

// --- telegram --------------------------------------------------------------

func TestTelegramSendsHTMLToTheChat(t *testing.T) {
	var path string
	var body map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path = r.URL.Path
		json.NewDecoder(r.Body).Decode(&body)
		io.WriteString(w, `{"ok":true}`)
	}))
	defer srv.Close()

	if err := NewTelegram(srv.URL+"/", "123:TOKEN", "-1001").Send(context.Background(), event(config.EventDeploymentFailed)); err != nil {
		t.Fatal(err)
	}
	if path != "/bot123:TOKEN/sendMessage" {
		t.Errorf("unexpected path %q", path)
	}
	if body["chat_id"] != "-1001" || body["parse_mode"] != "HTML" || body["disable_web_page_preview"] != true {
		t.Errorf("unexpected body: %v", body)
	}
	if text := body["text"].(string); !strings.Contains(text, "<b>web: deployment failed</b>") || !strings.Contains(text, "<code>ghcr.io/o/web:v1</code>") {
		t.Errorf("unexpected text: %q", text)
	}
}

func TestTelegramTextEscapesEverythingDynamic(t *testing.T) {
	e := Event{Severity: SeverityCritical, Server: "<s>", Title: "a <b>&</b>", Message: `error: <script>alert("x")</script>`, Ref: "r:<tag>"}
	got := Text(e)
	for _, bad := range []string{"<script>", "<s>", "a <b>&</b>", "<tag>"} {
		if strings.Contains(got, bad) {
			t.Errorf("unescaped %q in %q", bad, got)
		}
	}
	if !strings.HasPrefix(got, "🔥") {
		t.Errorf("critical events get the fire icon: %q", got)
	}
}

func TestTelegramReportsApiErrorsAndHidesTheToken(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(403)
		io.WriteString(w, `{"ok":false,"description":"Forbidden: bot was blocked by the user"}`)
	}))
	tg := NewTelegram(srv.URL, "123:SECRETTOKEN", "1")
	if err := tg.Send(context.Background(), event("x")); err == nil || !strings.Contains(err.Error(), "bot was blocked") {
		t.Errorf("want Telegram's description, got %v", err)
	}
	srv.Close()
	err := tg.Send(context.Background(), event("x"))
	if err == nil || strings.Contains(err.Error(), "SECRETTOKEN") {
		t.Errorf("the bot token is in the URL: it must never reach an error or a log: %v", err)
	}
}

// --- notifier --------------------------------------------------------------

type fakeSender struct {
	name  string
	mu    sync.Mutex
	got   []Event
	fails int // how many calls fail before one succeeds
	calls int
}

func (f *fakeSender) Name() string { return f.name }
func (f *fakeSender) Send(_ context.Context, e Event) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls++
	if f.calls <= f.fails {
		return errors.New("channel down")
	}
	f.got = append(f.got, e)
	return nil
}
func (f *fakeSender) delivered() []Event {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]Event(nil), f.got...)
}

func newNotifier(cfg *config.Notifications, senders ...Sender) *Notifier {
	n, _ := New(cfg, quiet)
	n.senders = senders
	n.backoff = func(int) time.Duration { return 0 }
	n.sleep = func(context.Context, time.Duration) error { return nil }
	return n
}

func TestEventsAreFilteredAndStampedWithServerAndTime(t *testing.T) {
	s := &fakeSender{name: "s"}
	n := newNotifier(&config.Notifications{Name: "vps-1"}, s)
	n.Start()
	n.Emit(Event{Type: config.EventDeploymentSucceeded, Title: "ok"}) // not a default event
	n.Emit(Event{Type: config.EventDeploymentFailed, Title: "bad"})
	n.Close(time.Second)

	got := s.delivered()
	if len(got) != 1 || got[0].Title != "bad" || got[0].Server != "vps-1" || got[0].Time.IsZero() {
		t.Errorf("unexpected delivery: %+v", got)
	}
}

func TestExplicitEventListReplacesTheDefaults(t *testing.T) {
	s := &fakeSender{name: "s"}
	n := newNotifier(&config.Notifications{Events: []string{config.EventDeploymentSucceeded}}, s)
	n.Start()
	n.Emit(Event{Type: config.EventDeploymentSucceeded})
	n.Emit(Event{Type: config.EventAppDown})
	n.Close(time.Second)
	if got := s.delivered(); len(got) != 1 || got[0].Type != config.EventDeploymentSucceeded {
		t.Errorf("got %+v", got)
	}
}

func TestFailingChannelIsRetriedThenGivenUpWithoutBlockingOthers(t *testing.T) {
	flaky := &fakeSender{name: "flaky", fails: 2}
	dead := &fakeSender{name: "dead", fails: 100}
	good := &fakeSender{name: "good"}
	n := newNotifier(&config.Notifications{}, flaky, dead, good)
	n.Start()
	n.Emit(Event{Type: config.EventAppDown})
	n.Close(time.Second)

	if len(flaky.delivered()) != 1 || flaky.calls != 3 {
		t.Errorf("a channel that recovers on the third try must deliver: calls=%d", flaky.calls)
	}
	if dead.calls != attempts || len(dead.delivered()) != 0 {
		t.Errorf("a dead channel gets %d attempts then is dropped: calls=%d", attempts, dead.calls)
	}
	if len(good.delivered()) != 1 {
		t.Error("one dead channel must not stop the others")
	}
}

func TestEmitNeverBlocksAndDropsTheOldestWhenTheQueueIsFull(t *testing.T) {
	block := make(chan struct{})
	s := &blockingSender{release: block}
	n := newNotifier(&config.Notifications{}, s)
	// The worker is not started: nothing drains the queue.
	done := make(chan struct{})
	go func() {
		for i := range queueSize + 10 {
			n.Emit(Event{Type: config.EventAppDown, Title: string(rune('A' + i%26)), Message: strings.Repeat("x", i)})
		}
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("Emit blocked on a full queue")
	}
	if len(n.queue) != queueSize {
		t.Errorf("queue holds %d, want %d", len(n.queue), queueSize)
	}
	oldest := <-n.queue
	if len(oldest.Message) != 10 {
		t.Errorf("the 10 oldest events must have been dropped, first kept has index %d", len(oldest.Message))
	}
	close(block)
}

type blockingSender struct{ release chan struct{} }

func (b *blockingSender) Name() string { return "blocking" }
func (b *blockingSender) Send(ctx context.Context, e Event) error {
	<-b.release
	return nil
}

func TestCloseDeliversWhatIsStillQueued(t *testing.T) {
	s := &fakeSender{name: "s"}
	n := newNotifier(&config.Notifications{}, s)
	for range 5 {
		n.Emit(Event{Type: config.EventAppDown})
	}
	n.Start()
	n.Close(2 * time.Second)
	if got := len(s.delivered()); got != 5 {
		t.Errorf("delivered %d of 5 queued events at close", got)
	}
}

func TestTestBypassesTheFilterAndReportsEachChannel(t *testing.T) {
	ok := &fakeSender{name: "ok"}
	ko := &fakeSender{name: "ko", fails: 100}
	n := newNotifier(&config.Notifications{Events: []string{config.EventAppDown}}, ok, ko)
	res := n.Test(context.Background())
	if len(res) != 2 || res[0].Err != nil || res[1].Err == nil {
		t.Fatalf("unexpected results: %+v", res)
	}
	if got := ok.delivered(); len(got) != 1 || got[0].Type != EventTest {
		t.Errorf("the test event must reach the channel: %+v", got)
	}
	if ko.calls != 1 {
		t.Errorf("a test does not retry, calls=%d", ko.calls)
	}
}

func TestNewReadsSecretFilesAtStartup(t *testing.T) {
	dir := t.TempDir()
	tokenFile := filepath.Join(dir, "token")
	os.WriteFile(tokenFile, []byte("123:abc\n"), 0o600)
	secretFile := filepath.Join(dir, "secret")
	os.WriteFile(secretFile, []byte("hook-secret\n"), 0o600)

	n, err := New(&config.Notifications{
		Webhooks: []config.Webhook{{URL: "https://hooks.example.com/x", SecretFile: secretFile}},
		Telegram: &config.Telegram{BotTokenFile: tokenFile, ChatID: "1", APIURL: "https://api.telegram.org"},
	}, quiet)
	if err != nil {
		t.Fatal(err)
	}
	if got := strings.Join(n.Channels(), ","); got != "webhook hooks.example.com,telegram" {
		t.Errorf("channels: %s", got)
	}
	if n.senders[0].(*Webhook).secret != "hook-secret" || n.senders[1].(*Telegram).token != "123:abc" {
		t.Error("secrets must be trimmed")
	}

	for name, cfg := range map[string]*config.Notifications{
		"missing token file":  {Telegram: &config.Telegram{BotTokenFile: filepath.Join(dir, "nope"), ChatID: "1", APIURL: "https://x"}},
		"missing secret file": {Webhooks: []config.Webhook{{URL: "https://x.example.com", SecretFile: filepath.Join(dir, "nope")}}},
	} {
		if _, err := New(cfg, quiet); err == nil {
			t.Errorf("%s: a typo in a path must fail at startup", name)
		}
	}
	empty := filepath.Join(dir, "empty")
	os.WriteFile(empty, []byte("\n"), 0o600)
	if _, err := New(&config.Notifications{Telegram: &config.Telegram{BotTokenFile: empty, ChatID: "1", APIURL: "https://x"}}, quiet); err == nil {
		t.Error("an empty token file must be refused")
	}
}

// --- heartbeat -------------------------------------------------------------

func TestHeartbeatPingsAtOnceThenPeriodicallyAndStops(t *testing.T) {
	var pings atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { pings.Add(1) }))
	defer srv.Close()

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { RunHeartbeat(ctx, srv.URL, 20*time.Millisecond, quiet); close(done) }()

	deadline := time.Now().Add(2 * time.Second)
	for pings.Load() < 3 && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	if pings.Load() < 3 {
		t.Fatalf("expected repeated pings, got %d", pings.Load())
	}
	cancel()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("the heartbeat must stop with its context")
	}
}

func TestHeartbeatSurvivesAnUnreachableServer(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(500) }))
	url := srv.URL
	srv.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 150*time.Millisecond)
	defer cancel()
	RunHeartbeat(ctx, url, 30*time.Millisecond, quiet) // must return when ctx ends, not panic or hang
}
