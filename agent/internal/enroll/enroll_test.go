package enroll

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/0x2u/keelson/agent/internal/store"
)

const (
	testToken  = "tttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttt"
	testSecret = "ssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssss"
	testCA     = "-----BEGIN CERTIFICATE-----\nCA-PEM\n-----END CERTIFICATE-----\n"
	testCert   = "-----BEGIN CERTIFICATE-----\nCLIENT-PEM\n-----END CERTIFICATE-----\n"
	testKey    = "-----BEGIN PRIVATE KEY-----\nCLIENT-KEY\n-----END PRIVATE KEY-----\n"
)

type rig struct {
	t    *testing.T
	dir  string
	st   *store.Store
	logs *bytes.Buffer
	mu   sync.Mutex
	now  time.Time
	svc  *Service
}

func newRig(t *testing.T) *rig {
	t.Helper()
	st, err := store.Open(filepath.Join(t.TempDir(), "a.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	r := &rig{t: t, dir: t.TempDir(), st: st, logs: &bytes.Buffer{}, now: time.Date(2026, 10, 23, 12, 0, 0, 0, time.UTC)}
	r.svc, err = New(Options{
		Dir: r.dir, CAPEM: testCA, Token: testToken, DeploySecret: testSecret, Ledger: st,
		Log: slog.New(slog.NewTextHandler(&lockedWriter{r}, &slog.HandlerOptions{Level: slog.LevelDebug})),
		Now: r.clock,
	})
	if err != nil {
		t.Fatal(err)
	}
	return r
}

type lockedWriter struct{ r *rig }

func (w *lockedWriter) Write(p []byte) (int, error) {
	w.r.mu.Lock()
	defer w.r.mu.Unlock()
	return w.r.logs.Write(p)
}

func (r *rig) clock() time.Time {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.now
}

func (r *rig) advance(d time.Duration) {
	r.mu.Lock()
	r.now = r.now.Add(d)
	r.mu.Unlock()
}

// code leaves a pending code that lives for ttl and returns it.
func (r *rig) code(ttl time.Duration) string {
	r.t.Helper()
	code, err := NewCode()
	if err != nil {
		r.t.Fatal(err)
	}
	r.put(code, ttl)
	return code
}

func (r *rig) put(code string, ttl time.Duration) {
	r.t.Helper()
	b, err := json.Marshal(NewPending(code, r.clock(), ttl, []byte(testCert), []byte(testKey)))
	if err != nil {
		r.t.Fatal(err)
	}
	if err := os.WriteFile(PendingFile(r.dir, Hash(code)), b, 0o640); err != nil {
		r.t.Fatal(err)
	}
}

func (r *rig) exists(code string) bool {
	_, err := os.Stat(PendingFile(r.dir, Hash(code)))
	return err == nil
}

func (r *rig) logged() string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.logs.String()
}

func TestRedeemHandsOutEverythingOnceAndDeletesTheFile(t *testing.T) {
	r := newRig(t)
	code := r.code(15 * time.Minute)
	res, err := r.svc.Redeem(context.Background(), code)
	if err != nil {
		t.Fatal(err)
	}
	want := Credentials{CAPEM: testCA, ClientCertPEM: testCert, ClientKeyPEM: testKey, Token: testToken, DeploySecret: testSecret}
	if res.Credentials != want {
		t.Errorf("credentials: %+v", res.Credentials)
	}
	if res.ID != Hash(code)[:12] {
		t.Errorf("id %q", res.ID)
	}
	if r.exists(code) {
		t.Error("the pending file survived its redemption")
	}
	if _, used, _ := r.st.EnrolmentUsed(context.Background(), Hash(code)); !used {
		t.Error("the redemption was not recorded in the store")
	}
	if _, err := r.svc.Redeem(context.Background(), code); !errors.Is(err, ErrInvalid) {
		t.Errorf("the second redemption must be refused, got %v", err)
	}
}

func TestEmptyDeploySecretIsHandedOutAsEmpty(t *testing.T) {
	r := newRig(t)
	r.svc.o.DeploySecret = ""
	res, err := r.svc.Redeem(context.Background(), r.code(time.Minute))
	if err != nil || res.Credentials.DeploySecret != "" || res.Credentials.Token != testToken {
		t.Errorf("%+v %v", res.Credentials, err)
	}
}

func TestUnknownUsedAndExpiredCodesAreIndistinguishableToTheCaller(t *testing.T) {
	r := newRig(t)
	ctx := context.Background()

	unknown, _ := NewCode()
	_, errUnknown := r.svc.Redeem(ctx, unknown)

	used := r.code(time.Minute)
	if _, err := r.svc.Redeem(ctx, used); err != nil {
		t.Fatal(err)
	}
	r.put(used, time.Minute) // the file survived (a failed delete): the ledger still refuses
	_, errUsed := r.svc.Redeem(ctx, used)

	expired := r.code(time.Minute)
	r.advance(2 * time.Minute)
	_, errExpired := r.svc.Redeem(ctx, expired)

	for name, err := range map[string]error{"unknown": errUnknown, "used": errUsed, "expired": errExpired} {
		var inv *InvalidError
		if !errors.Is(err, ErrInvalid) || !errors.As(err, &inv) {
			t.Fatalf("%s: %v", name, err)
		}
		if err.Error() != "invalid or expired code" {
			t.Errorf("%s: message %q", name, err.Error())
		}
		if inv.Reason != name {
			t.Errorf("%s: reason %q (kept for the audit log)", name, inv.Reason)
		}
	}
	if r.exists(used) {
		t.Error("the leftover file of a used code must be deleted")
	}
	if r.exists(expired) {
		t.Error("an expired code's file must be deleted when it is tried")
	}
}

func TestACodeExpiresExactlyAtItsExpiry(t *testing.T) {
	r := newRig(t)
	code := r.code(time.Minute)
	r.advance(time.Minute - time.Millisecond)
	if _, err := r.svc.Redeem(context.Background(), code); err != nil {
		t.Fatalf("one millisecond before expiry: %v", err)
	}
	code = r.code(time.Minute)
	r.advance(time.Minute)
	if _, err := r.svc.Redeem(context.Background(), code); !errors.Is(err, ErrInvalid) {
		t.Fatalf("at expiry: %v", err)
	}
}

func TestOfConcurrentRedemptionsExactlyOneWins(t *testing.T) {
	// Five callers: at most four can fail before the last one looks, so the rate limit (five failures) never gets in
	// the way of the winner. The store test hammers the claim itself with more.
	const callers = 5
	for round := range 40 {
		r := newRig(t)
		code := r.code(time.Minute)
		var wg sync.WaitGroup
		results := make(chan error, callers)
		start := make(chan struct{})
		for range callers {
			wg.Add(1)
			go func() {
				defer wg.Done()
				<-start
				_, err := r.svc.Redeem(context.Background(), code)
				results <- err
			}()
		}
		close(start)
		wg.Wait()
		close(results)
		wins := 0
		for err := range results {
			switch {
			case err == nil:
				wins++
			case errors.Is(err, ErrInvalid):
			default:
				t.Fatalf("unexpected error: %v", err)
			}
		}
		if wins != 1 {
			t.Fatalf("round %d: %d redemptions succeeded, want exactly 1", round, wins)
		}
	}
}

func TestTheClaimComesBeforeAnythingIsHandedOut(t *testing.T) {
	// A ledger that loses the race: the pending file is there and valid, but the claim says "already used".
	r := newRig(t)
	r.svc.o.Ledger = ledgerFunc(func(string) (bool, error) { return false, nil })
	code := r.code(time.Minute)
	res, err := r.svc.Redeem(context.Background(), code)
	if !errors.Is(err, ErrInvalid) || res.Credentials != (Credentials{}) {
		t.Fatalf("a lost claim must hand out nothing: %+v %v", res, err)
	}
	// And a ledger that cannot record: nothing is handed out either, and it is not an "invalid code".
	r.svc.o.Ledger = ledgerFunc(func(string) (bool, error) { return false, errors.New("disk full") })
	code = r.code(time.Minute)
	res, err = r.svc.Redeem(context.Background(), code)
	if err == nil || errors.Is(err, ErrInvalid) || res.Credentials != (Credentials{}) {
		t.Fatalf("a ledger error must hand out nothing: %+v %v", res, err)
	}
}

type ledgerFunc func(hash string) (bool, error)

func (f ledgerFunc) ClaimEnrolment(_ context.Context, hash string, _, _ time.Time) (bool, error) {
	return f(hash)
}
func (ledgerFunc) PruneEnrolments(context.Context, time.Time) error { return nil }

func TestAFileUnderTheWrongNameIsNeverHonoured(t *testing.T) {
	r := newRig(t)
	a, b := r.code(time.Minute), r.code(time.Minute)
	// b's record placed under a's name: the name matches the presented code, the content does not.
	body, _ := os.ReadFile(PendingFile(r.dir, Hash(b)))
	if err := os.WriteFile(PendingFile(r.dir, Hash(a)), body, 0o640); err != nil {
		t.Fatal(err)
	}
	if _, err := r.svc.Redeem(context.Background(), a); !errors.Is(err, ErrInvalid) {
		t.Fatalf("want refusal, got %v", err)
	}
}

func TestEqualHashIsExactAndLengthSafe(t *testing.T) {
	h := Hash("x")
	if !equalHash(h, h) || equalHash(h, Hash("y")) || equalHash(h, h[:len(h)-1]) || equalHash(h, "") || equalHash("", h) {
		t.Error("equalHash is wrong")
	}
}

func TestMalformedFilesAndPathsAreRefused(t *testing.T) {
	r := newRig(t)
	ctx := context.Background()
	for name, content := range map[string]string{"garbage": "not json", "wrong version": `{"version":2,"hash":"x","client_cert_pem":"a","client_key_pem":"b"}`, "no key": `{"version":1,"hash":"x","client_cert_pem":"a"}`} {
		code, _ := NewCode()
		os.WriteFile(PendingFile(r.dir, Hash(code)), []byte(content), 0o640)
		if _, err := r.svc.Redeem(ctx, code); !errors.Is(err, ErrInvalid) {
			t.Errorf("%s: %v", name, err)
		}
	}
	// A symlink is not a pending file, even to a valid one.
	good := r.code(time.Minute)
	link, _ := NewCode()
	if err := os.Symlink(PendingFile(r.dir, Hash(good)), PendingFile(r.dir, Hash(link))); err != nil {
		t.Fatal(err)
	}
	if _, err := r.svc.Redeem(ctx, link); !errors.Is(err, ErrInvalid) {
		t.Errorf("symlink: %v", err)
	}
	// Whatever is presented is hashed, so it cannot name another path.
	for _, evil := range []string{"../../etc/passwd", "../x", "a/b", strings.Repeat("A", 1000), ""} {
		if _, err := r.svc.Redeem(ctx, evil); !errors.Is(err, ErrInvalid) && !errors.As(err, new(*RateLimitedError)) {
			t.Errorf("%q: %v", evil[:min(len(evil), 20)], err)
		}
	}
}

func TestTooManyFailuresAnywhereLimitTheWholeAgent(t *testing.T) {
	r := newRig(t)
	ctx := context.Background()
	good := r.code(time.Hour)
	for i := range 5 {
		bad, _ := NewCode()
		if _, err := r.svc.Redeem(ctx, bad); !errors.Is(err, ErrInvalid) {
			t.Fatalf("attempt %d: %v", i, err)
		}
		r.advance(time.Second)
	}
	// Even the right code is refused while limited: the answer must not tell a right guess from a wrong one.
	_, err := r.svc.Redeem(ctx, good)
	var rl *RateLimitedError
	if !errors.As(err, &rl) {
		t.Fatalf("want rate limiting, got %v", err)
	}
	if rl.RetryAfter <= 0 || rl.RetryAfter > time.Minute {
		t.Errorf("retry after %v", rl.RetryAfter)
	}
	if !r.exists(good) {
		t.Error("a limited attempt must not consume the code")
	}
	if got := RetryAfterSeconds(rl.RetryAfter); got < 1 || got > 60 {
		t.Errorf("Retry-After %d", got)
	}
	// Being refused is not a failure: it does not push the end of the window away.
	first := rl.RetryAfter
	r.advance(10 * time.Second)
	_, err = r.svc.Redeem(ctx, good)
	if !errors.As(err, &rl) || rl.RetryAfter != first-10*time.Second {
		t.Errorf("window moved: %v then %v", first, rl)
	}
	// The oldest failure leaves the window after a minute: one slot is free again.
	r.advance(rl.RetryAfter)
	if _, err := r.svc.Redeem(ctx, good); err != nil {
		t.Fatalf("after the wait: %v", err)
	}
}

func TestFailuresAgeOutOfTheWindow(t *testing.T) {
	r := newRig(t)
	for range 4 {
		bad, _ := NewCode()
		r.svc.Redeem(context.Background(), bad)
	}
	r.advance(attemptWindow)
	for i := range 4 { // four old failures are gone: four more are still tolerated
		bad, _ := NewCode()
		if _, err := r.svc.Redeem(context.Background(), bad); !errors.Is(err, ErrInvalid) {
			t.Fatalf("attempt %d: %v", i, err)
		}
	}
}

func TestSuccessfulRedemptionsAreNotCountedAsFailures(t *testing.T) {
	r := newRig(t)
	for i := range 8 {
		if _, err := r.svc.Redeem(context.Background(), r.code(time.Minute)); err != nil {
			t.Fatalf("redemption %d: %v", i, err)
		}
	}
}

func TestNothingSecretIsLogged(t *testing.T) {
	r := newRig(t)
	ctx := context.Background()
	good := r.code(time.Minute)
	// Make the delete fail, so that the error path logs too.
	if os.Geteuid() != 0 {
		if err := os.Chmod(r.dir, 0o500); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { os.Chmod(r.dir, 0o700) })
	}
	if _, err := r.svc.Redeem(ctx, good); err != nil {
		t.Fatal(err)
	}
	r.svc.Redeem(ctx, good) // used
	bad, _ := NewCode()
	r.svc.Redeem(ctx, bad)
	r.svc.Sweep(ctx)
	logs := r.logged()
	for _, secret := range []string{good, bad, Hash(good), testToken, testSecret, "CLIENT-KEY", "CLIENT-PEM", "CA-PEM"} {
		if strings.Contains(logs, secret) {
			t.Errorf("the log contains %q:\n%s", secret, logs)
		}
	}
	if os.Geteuid() != 0 && !strings.Contains(logs, ID(Hash(good))) {
		t.Errorf("the failed delete should be logged with the short hash:\n%s", logs)
	}
}

func TestSweepDeletesExpiredAndUnreadableFilesAndPrunesTheLedger(t *testing.T) {
	r := newRig(t)
	ctx := context.Background()
	live := r.code(time.Hour)
	old := r.code(time.Minute)
	corrupt, _ := NewCode()
	os.WriteFile(PendingFile(r.dir, Hash(corrupt)), []byte("{"), 0o640)
	stranger := filepath.Join(r.dir, "notes.txt")
	os.WriteFile(stranger, []byte("x"), 0o640)
	temp := filepath.Join(r.dir, ".keelson-123")
	os.WriteFile(temp, []byte("x"), 0o640)
	r.st.ClaimEnrolment(ctx, "oldrow", r.clock().Add(time.Minute), r.clock())
	r.st.ClaimEnrolment(ctx, "liverow", r.clock().Add(time.Hour), r.clock())

	r.advance(2 * time.Minute)
	r.svc.Sweep(ctx)

	if !r.exists(live) {
		t.Error("a live code was swept")
	}
	if r.exists(old) {
		t.Error("an expired code's file survived the sweep")
	}
	if _, err := os.Stat(PendingFile(r.dir, Hash(corrupt))); err == nil {
		t.Error("an unreadable pending file survived the sweep")
	}
	for _, p := range []string{stranger, temp} {
		if _, err := os.Stat(p); err != nil {
			t.Errorf("the sweep deleted a file that is not a pending code: %s", p)
		}
	}
	if _, ok, _ := r.st.EnrolmentUsed(ctx, "oldrow"); ok {
		t.Error("an expired ledger row survived")
	}
	if _, ok, _ := r.st.EnrolmentUsed(ctx, "liverow"); !ok {
		t.Error("a live ledger row was pruned")
	}
}

func TestSweepOfAMissingDirectoryIsQuiet(t *testing.T) {
	r := newRig(t)
	r.svc.o.Dir = filepath.Join(r.dir, "nope")
	r.svc.Sweep(context.Background())
	if r.logged() != "" {
		t.Errorf("logged: %s", r.logged())
	}
}

func TestRunSweepsAtStartAndStopsWithItsContext(t *testing.T) {
	r := newRig(t)
	old := r.code(time.Millisecond)
	r.advance(time.Second)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { r.svc.Run(ctx, time.Hour); close(done) }()
	deadline := time.Now().Add(5 * time.Second)
	for r.exists(old) && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	if r.exists(old) {
		t.Error("Run did not sweep when it started")
	}
	cancel()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Error("Run did not stop")
	}
}

func TestStringFormat(t *testing.T) {
	code, err := NewCode()
	if err != nil {
		t.Fatal(err)
	}
	if raw, err := base64.RawURLEncoding.DecodeString(code); err != nil || len(raw) != CodeBytes || CodeBytes != 24 {
		t.Errorf("code %q", code)
	}
	if other, _ := NewCode(); other == code {
		t.Error("codes repeat")
	}
	s := Encode("https://203.0.113.10:7443", "ab12", code)
	body, ok := strings.CutPrefix(s, "kse1.")
	if !ok {
		t.Fatal(s)
	}
	raw, err := base64.RawURLEncoding.DecodeString(body)
	if err != nil {
		t.Fatal(err)
	}
	if string(raw) != `{"u":"https://203.0.113.10:7443","fp":"ab12","c":"`+code+`"}` {
		t.Errorf("payload %s", raw)
	}
	if Hash("abc") != "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad" {
		t.Error("Hash is not the hex SHA-256")
	}
	if Fingerprint([]byte("abc")) != Hash("abc") {
		t.Error("Fingerprint is not the hex SHA-256")
	}
	if len(ID(Hash("abc"))) != 12 || ID("ab") != "ab" {
		t.Error("ID")
	}
}

func TestNewRequiresWhatItNeeds(t *testing.T) {
	for _, o := range []Options{{}, {Dir: "d", CAPEM: "c", Token: "t"}, {Dir: "d", Ledger: ledgerFunc(nil), Token: "t"}} {
		if _, err := New(o); err == nil {
			t.Errorf("New(%+v) must fail", o)
		}
	}
}
