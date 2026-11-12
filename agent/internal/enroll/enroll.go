// Package enroll lets a dashboard pair with an agent using a one-time code instead of five values copied by hand.
//
// On the server, root runs `keelson-agent enroll-code`: it makes a random code, issues a client certificate for the
// dashboard with the certificate authority's key (which only root can read) and leaves them in a file named after the
// code's hash, in the enrolment directory. The administrator gives the dashboard the code (inside an enrolment string,
// see Encode); the dashboard sends it to POST /v1/enroll, and the agent (Service.Redeem) answers with everything the
// dashboard needs. The agent never holds the authority's key: it only reads the pre-issued file, and deletes it.
//
// A code is single use: redeeming one inserts its hash into the store, and the primary key lets exactly one of any
// number of concurrent redemptions through, before anything is handed out.
package enroll

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"math"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

const (
	// Prefix starts every enrolment string.
	Prefix = "kse1."
	// CodeBytes is the entropy of a code: 192 bits.
	CodeBytes = 24
	// DefaultTTL is how long a code lives when nothing else is asked for; MaxTTL is the longest it may be given.
	DefaultTTL = 15 * time.Minute
	MaxTTL     = 24 * time.Hour

	// maxAttempts failed redemptions are tolerated per attemptWindow, for the whole agent. It is not per address: the
	// agent may sit behind a proxy that shows one address for everybody.
	maxAttempts   = 5
	attemptWindow = time.Minute

	// maxCodeLength bounds what is hashed: a code is 32 characters.
	maxCodeLength = 256
	// maxFileSize bounds a pending file (two PEM blocks are under 2 KiB).
	maxFileSize   = 64 << 10
	hashPrefixLen = 12
)

// NewCode returns a random code: CodeBytes random bytes, base64url without padding.
func NewCode() (string, error) {
	raw := make([]byte, CodeBytes)
	if _, err := rand.Read(raw); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(raw), nil
}

// Hash is what is kept of a code: the lowercase hex SHA-256 of it. It names the pending file.
func Hash(code string) string {
	sum := sha256.Sum256([]byte(code))
	return hex.EncodeToString(sum[:])
}

// Fingerprint is the lowercase hex SHA-256 of a certificate's DER encoding: what the enrolment string pins.
func Fingerprint(der []byte) string {
	sum := sha256.Sum256(der)
	return hex.EncodeToString(sum[:])
}

// ID is the short form of a hash that identifies a code in logs and in the audit log without being usable as one.
func ID(hash string) string {
	if len(hash) > hashPrefixLen {
		return hash[:hashPrefixLen]
	}
	return hash
}

// PendingFile is where the pending code with this hash lives under dir.
func PendingFile(dir, hash string) string { return filepath.Join(dir, hash+".json") }

// enrolmentString is the payload of an enrolment string.
type enrolmentString struct {
	URL         string `json:"u"`
	Fingerprint string `json:"fp"`
	Code        string `json:"c"`
}

// Encode builds the enrolment string the administrator pastes into the dashboard: the agent's URL, the fingerprint of
// its server certificate (so the dashboard talks to the right agent before it sends the code) and the code.
func Encode(url, fingerprint, code string) string {
	b, _ := json.Marshal(enrolmentString{URL: url, Fingerprint: fingerprint, Code: code})
	return Prefix + base64.RawURLEncoding.EncodeToString(b)
}

// Pending is a code waiting to be redeemed, as root leaves it in the enrolment directory. It never holds the code
// itself, only its hash.
type Pending struct {
	Version       int    `json:"version"`
	Hash          string `json:"hash"`
	CreatedAt     int64  `json:"created_at"`
	ExpiresAt     int64  `json:"expires_at"`
	ClientCertPEM string `json:"client_cert_pem"`
	ClientKeyPEM  string `json:"client_key_pem"`
}

// NewPending describes a code created at now that lives for ttl.
func NewPending(code string, now time.Time, ttl time.Duration, clientCertPEM, clientKeyPEM []byte) Pending {
	return Pending{
		Version: 1, Hash: Hash(code), CreatedAt: now.UnixMilli(), ExpiresAt: now.Add(ttl).UnixMilli(),
		ClientCertPEM: string(clientCertPEM), ClientKeyPEM: string(clientKeyPEM),
	}
}

// Expires is when the code stops working.
func (p Pending) Expires() time.Time { return time.UnixMilli(p.ExpiresAt) }

// Credentials is what a redemption hands the dashboard.
type Credentials struct {
	CAPEM         string `json:"ca_pem"`
	ClientCertPEM string `json:"client_cert_pem"`
	ClientKeyPEM  string `json:"client_key_pem"`
	Token         string `json:"token"`
	DeploySecret  string `json:"deploy_secret"`
}

// Ledger remembers which codes were redeemed. The store implements it.
type Ledger interface {
	ClaimEnrolment(ctx context.Context, hash string, expires, now time.Time) (fresh bool, err error)
	PruneEnrolments(ctx context.Context, now time.Time) error
}

// Why a code was refused, for the audit log. The caller sees the same answer for all of them.
const (
	ReasonUnknown = "unknown"
	ReasonUsed    = "used"
	ReasonExpired = "expired"
)

// ErrInvalid is what an unknown, a used and an expired code have in common: callers must not tell them apart.
var ErrInvalid = errors.New("invalid or expired code")

// InvalidError is ErrInvalid with the (private) reason and the code's short hash.
type InvalidError struct {
	ID     string
	Reason string
}

func (e *InvalidError) Error() string   { return ErrInvalid.Error() }
func (e *InvalidError) Is(t error) bool { return t == ErrInvalid }

// RateLimitedError says that too many redemptions failed recently.
type RateLimitedError struct{ RetryAfter time.Duration }

func (e *RateLimitedError) Error() string {
	return fmt.Sprintf("too many failed enrolment attempts: retry in %s", e.RetryAfter.Round(time.Second))
}

// Options configures a Service.
type Options struct {
	// Dir holds the pending files. The agent reads and deletes them.
	Dir string
	// CAPEM is the certificate authority that signs the client certificates.
	CAPEM string
	// Token and DeploySecret are the agent's own secrets, handed to the dashboard. DeploySecret may be empty.
	Token, DeploySecret string
	Ledger              Ledger
	Log                 *slog.Logger
	// Now is replaceable in tests.
	Now func() time.Time
}

// Service redeems codes.
type Service struct {
	o Options

	mu       sync.Mutex
	failures []time.Time // when recent redemptions failed, oldest first
}

// New builds a Service.
func New(o Options) (*Service, error) {
	if o.Dir == "" || o.Ledger == nil || o.CAPEM == "" || o.Token == "" {
		return nil, errors.New("enrolment needs a directory, a ledger, the CA certificate and the API token")
	}
	if o.Log == nil {
		o.Log = slog.Default()
	}
	if o.Now == nil {
		o.Now = time.Now
	}
	return &Service{o: o}, nil
}

// limited returns how long the caller must wait, or zero. Failures older than the window are forgotten.
func (s *Service) limited(now time.Time) time.Duration {
	s.mu.Lock()
	defer s.mu.Unlock()
	i := 0
	for i < len(s.failures) && !s.failures[i].After(now.Add(-attemptWindow)) {
		i++
	}
	s.failures = s.failures[i:]
	if len(s.failures) < maxAttempts {
		return 0
	}
	wait := s.failures[0].Add(attemptWindow).Sub(now)
	if wait < time.Second {
		wait = time.Second
	}
	return wait
}

func (s *Service) fail(now time.Time, hash, reason string) error {
	s.mu.Lock()
	s.failures = append(s.failures, now)
	s.mu.Unlock()
	return &InvalidError{ID: ID(hash), Reason: reason}
}

// Result is a successful redemption.
type Result struct {
	Credentials Credentials
	// ID is the code's short hash, for the audit log.
	ID string
}

// Redeem exchanges a code for credentials. While the rate limit holds, even a right code is refused: the limit is
// there to bound guessing, and the answer to a guess must not depend on whether it was right.
func (s *Service) Redeem(ctx context.Context, code string) (Result, error) {
	now := s.o.Now()
	if wait := s.limited(now); wait > 0 {
		return Result{}, &RateLimitedError{RetryAfter: wait}
	}
	if code == "" || len(code) > maxCodeLength {
		return Result{}, s.fail(now, Hash(code), ReasonUnknown)
	}
	hash := Hash(code)
	path := PendingFile(s.o.Dir, hash)

	p, err := readPending(path)
	switch {
	case errors.Is(err, os.ErrNotExist):
		return Result{}, s.fail(now, hash, ReasonUnknown)
	case err != nil:
		s.o.Log.Error("read a pending enrolment", "id", ID(hash), "err", cause(err))
		return Result{}, s.fail(now, hash, ReasonUnknown)
	}
	// The file is looked up by name; what it says about itself is compared too, in constant time, so that a file put
	// under the wrong name is never honoured.
	if !equalHash(p.Hash, hash) {
		return Result{}, s.fail(now, hash, ReasonUnknown)
	}
	if !now.Before(p.Expires()) {
		s.remove(path, hash)
		return Result{}, s.fail(now, hash, ReasonExpired)
	}

	// From here the code is spent, whatever happens next: nothing is read or handed out before the claim.
	fresh, err := s.o.Ledger.ClaimEnrolment(ctx, hash, p.Expires(), now)
	if err != nil {
		return Result{}, fmt.Errorf("record the redemption: %w", err)
	}
	if !fresh {
		s.remove(path, hash) // a leftover of a redemption whose file could not be deleted
		return Result{}, s.fail(now, hash, ReasonUsed)
	}
	s.remove(path, hash)
	return Result{ID: ID(hash), Credentials: Credentials{
		CAPEM: s.o.CAPEM, ClientCertPEM: p.ClientCertPEM, ClientKeyPEM: p.ClientKeyPEM,
		Token: s.o.Token, DeploySecret: s.o.DeploySecret,
	}}, nil
}

// equalHash compares two hashes in constant time.
func equalHash(a, b string) bool {
	return subtle.ConstantTimeCompare([]byte(a), []byte(b)) == 1
}

func (s *Service) remove(path, hash string) {
	if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
		// Only the short hash and the cause are logged: the path carries the whole hash. The ledger keeps the file
		// from being redeemed anyway.
		s.o.Log.Error("delete a pending enrolment", "id", ID(hash), "err", cause(err))
	}
}

// cause strips the path from a file error: the file's name carries the code's whole hash.
func cause(err error) error {
	var pe *os.PathError
	if errors.As(err, &pe) {
		return pe.Err
	}
	return err
}

func readPending(path string) (Pending, error) {
	fi, err := os.Lstat(path)
	if err != nil {
		return Pending{}, err
	}
	if !fi.Mode().IsRegular() {
		return Pending{}, errors.New("not a regular file")
	}
	f, err := os.Open(path)
	if err != nil {
		return Pending{}, err
	}
	defer f.Close()
	b, err := io.ReadAll(io.LimitReader(f, maxFileSize+1))
	if err != nil {
		return Pending{}, err
	}
	if len(b) > maxFileSize {
		return Pending{}, errors.New("file too large")
	}
	var p Pending
	if err := json.Unmarshal(b, &p); err != nil {
		return Pending{}, err
	}
	if p.Version != 1 || p.Hash == "" || p.ClientCertPEM == "" || p.ClientKeyPEM == "" {
		return Pending{}, errors.New("unrecognised pending file")
	}
	return p, nil
}

// Sweep deletes the pending files that expired (or cannot be read: they could never be redeemed) and forgets the
// redeemed codes that expired.
func (s *Service) Sweep(ctx context.Context) {
	now := s.o.Now()
	entries, err := os.ReadDir(s.o.Dir)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		s.o.Log.Error("list pending enrolments", "err", err)
	}
	for _, e := range entries {
		name := e.Name()
		hash, ok := strings.CutSuffix(name, ".json")
		if !ok || len(hash) != sha256.Size*2 {
			continue // not ours: temporary files of a writer, or something else
		}
		path := filepath.Join(s.o.Dir, name)
		p, err := readPending(path)
		if err == nil && now.Before(p.Expires()) {
			continue
		}
		s.remove(path, hash)
	}
	if err := s.o.Ledger.PruneEnrolments(ctx, now); err != nil {
		s.o.Log.Error("prune redeemed enrolments", "err", err)
	}
}

// Run sweeps now and then every interval until ctx ends.
func (s *Service) Run(ctx context.Context, interval time.Duration) {
	s.Sweep(ctx)
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			s.Sweep(ctx)
		}
	}
}

// RetryAfterSeconds is a wait rounded up to whole seconds, for the Retry-After header.
func RetryAfterSeconds(d time.Duration) int {
	return int(math.Ceil(d.Seconds()))
}
