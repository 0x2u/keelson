package notify

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"errors"
	"math/big"
	"net"
	"strconv"
	"strings"
	"testing"
	"time"

	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"

	"github.com/0x2u/keelson/agent/internal/config"
)

// certRig is a watcher over one name whose certificate the test moves in time.
type certRig struct {
	w      *CertWatcher
	events []Event
	expiry time.Time
	err    error
	names  []string
}

func newCertRig(t *testing.T, warnDays int) *certRig {
	t.Helper()
	r := &certRig{names: []string{"shop.example.com"}}
	probe := func(context.Context, string) (time.Time, error) { return r.expiry, r.err }
	r.w = NewCertWatcher(func() []string { return r.names }, probe, func() int { return warnDays }, func(e Event) { r.events = append(r.events, e) }, quiet)
	return r
}

// at puts the certificate's end that many days away and makes one round.
func (r *certRig) at(days float64) {
	r.expiry = time.Now().Add(time.Duration(days * float64(24*time.Hour)))
	r.w.Check(context.Background())
}

func (r *certRig) types() []string {
	out := make([]string, len(r.events))
	for i, e := range r.events {
		out[i] = e.Type
	}
	return out
}

func TestACertificateIsAnnouncedOnceWhenItEntersTheWindowAndAgainAtEachStep(t *testing.T) {
	r := newCertRig(t, 14)
	r.at(30)
	r.at(20)
	if len(r.events) != 0 {
		t.Fatalf("a certificate with weeks left says nothing: %+v", r.events)
	}
	r.at(13)
	r.at(12)
	r.at(8)
	if len(r.events) != 1 {
		t.Fatalf("the window is announced once, not at every check: %+v", r.types())
	}
	e := r.events[0]
	if e.Type != config.EventCertificateExpiring || e.Severity != SeverityWarning || !strings.Contains(e.Title, "expires in 13 days") {
		t.Errorf("unexpected event: %+v", e)
	}
	r.at(6) // the 7-day step
	r.at(5)
	r.at(2) // the 3-day step
	if len(r.events) != 3 {
		t.Fatalf("one message per step: %+v", r.types())
	}
	if got := r.events[2].Severity; got != SeverityCritical {
		t.Errorf("three days left is critical, got %s", got)
	}
	r.at(0.5) // the 1-day step
	if n := len(r.events); n != 4 || !strings.Contains(r.events[3].Title, "expires tomorrow") {
		t.Errorf("%d events, last %q", n, r.events[3].Title)
	}
	r.at(-1)
	if n := len(r.events); n != 5 || !strings.Contains(r.events[4].Title, "has expired") {
		t.Errorf("%d events, last %q", n, r.events[len(r.events)-1].Title)
	}
	r.at(-2)
	if n := len(r.events); n != 5 {
		t.Errorf("an expired certificate is not repeated at every check: %d events", n)
	}
}

func TestARenewedCertificateIsAnnouncedAndTheWindowStartsOver(t *testing.T) {
	r := newCertRig(t, 14)
	r.at(5)
	r.at(89)
	if len(r.events) != 2 || r.events[1].Type != config.EventCertificateRenewed {
		t.Fatalf("%+v", r.types())
	}
	if !strings.Contains(r.events[1].Message, "89 days") {
		t.Errorf("the message says how long it now runs: %q", r.events[1].Message)
	}
	r.at(13)
	if n := len(r.events); n != 3 || r.events[2].Type != config.EventCertificateExpiring {
		t.Errorf("a renewed certificate that expires again warns again: %+v", r.types())
	}
}

func TestANameThatCannotBeProbedSaysNothing(t *testing.T) {
	r := newCertRig(t, 14)
	r.err = errors.New("connection refused")
	r.at(1)
	if len(r.events) != 0 {
		t.Errorf("a proxy that is down is not an expiry: %+v", r.events)
	}
}

func TestANameThatLeavesTheConfigurationIsForgotten(t *testing.T) {
	r := newCertRig(t, 14)
	r.at(2)
	r.names = nil
	r.at(2)
	r.names = []string{"shop.example.com"}
	r.at(2)
	if n := len(r.events); n != 2 {
		t.Errorf("a name that comes back is judged again from scratch: %d events", n)
	}
}

func TestTheWarningWindowFollowsTheConfiguredNumberOfDays(t *testing.T) {
	r := newCertRig(t, 30)
	r.at(25)
	if len(r.events) != 1 {
		t.Fatalf("cert_warn_days 30 warns at 25 days: %+v", r.types())
	}
}

func TestTheNamesWatchedAreTheDomainsOfTheProxiedAppsAndTheSites(t *testing.T) {
	c, issues := config.Parse([]byte(`proxy:
  sites:
    - {hosts: [docs.example.com], redirect: {to: "https://example.com"}}
apps:
  - {name: shop, image: o/shop, port: 3000, domains: [shop.example.com, www.shop.example.com]}
  - {name: worker, image: o/worker}
`))
	if c == nil {
		t.Fatalf("%+v", issues)
	}
	got := CertNames(c)
	want := []string{"docs.example.com", "shop.example.com", "www.shop.example.com"}
	if len(got) != len(want) {
		t.Fatalf("got %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("got %v, want %v", got, want)
		}
	}
	if CertNames(&config.Config{}) != nil {
		t.Error("a server with no proxy watches no certificate")
	}
}

// TestTheLocalProbeReadsTheCertificateAServerPresents runs the real probe against a TLS server on 127.0.0.1, which is
// what it does against the proxy of a server: the certificate is read whether or not it would be trusted.
func TestTheLocalProbeReadsTheCertificateAServerPresents(t *testing.T) {
	notAfter := time.Now().Add(40 * 24 * time.Hour).Truncate(time.Second)
	ln := tlsServer(t, notAfter)
	port := ln.Addr().(*net.TCPAddr).Port
	got, err := probeAt(context.Background(), port, "shop.example.com")
	if err != nil {
		t.Fatal(err)
	}
	if !got.Equal(notAfter) {
		t.Errorf("got %s, want %s", got, notAfter)
	}
	ln.Close()
	if _, err := probeAt(context.Background(), port, "shop.example.com"); err == nil {
		t.Error("a port nothing listens on must fail, not answer a date")
	}
}

// probeAt is LocalCertProbe against another port: the real one always asks 443, which a test cannot bind.
func probeAt(ctx context.Context, port int, host string) (time.Time, error) {
	d := tls.Dialer{Config: &tls.Config{ServerName: host, InsecureSkipVerify: true, MinVersion: tls.VersionTLS12}}
	conn, err := d.DialContext(ctx, "tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(port)))
	if err != nil {
		return time.Time{}, err
	}
	defer conn.Close()
	return conn.(*tls.Conn).ConnectionState().PeerCertificates[0].NotAfter, nil
}

// tlsServer answers TLS handshakes on 127.0.0.1 with a self-signed certificate that ends at notAfter.
func tlsServer(t *testing.T, notAfter time.Time) net.Listener {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	tpl := &x509.Certificate{
		SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "shop.example.com"},
		NotBefore: time.Now().Add(-time.Hour), NotAfter: notAfter,
		DNSNames: []string{"shop.example.com"},
	}
	der, err := x509.CreateCertificate(rand.Reader, tpl, tpl, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	ln, err := tls.Listen("tcp", "127.0.0.1:0", &tls.Config{Certificates: []tls.Certificate{{Certificate: [][]byte{der}, PrivateKey: key}}})
	if err != nil {
		t.Fatal(err)
	}
	go func() {
		for {
			conn, err := ln.Accept()
			if err != nil {
				return
			}
			go func() {
				_ = conn.(*tls.Conn).Handshake()
				conn.Close()
			}()
		}
	}()
	t.Cleanup(func() { ln.Close() })
	return ln
}
