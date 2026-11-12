package install

import (
	"context"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/0x2u/keelson/agent/internal/enroll"
)

// decodeEnrolment splits an enrolment string the way the dashboard must.
func decodeEnrolment(t *testing.T, s string) (u, fp, code string) {
	t.Helper()
	body, ok := strings.CutPrefix(s, "kse1.")
	if !ok {
		t.Fatalf("enrolment string %q lacks the kse1. prefix", s)
	}
	raw, err := base64.RawURLEncoding.DecodeString(body)
	if err != nil {
		t.Fatalf("not unpadded base64url: %v", err)
	}
	var m map[string]string
	if err := json.Unmarshal(raw, &m); err != nil {
		t.Fatal(err)
	}
	if len(m) != 3 {
		t.Fatalf("payload keys: %v", m)
	}
	return m["u"], m["fp"], m["c"]
}

func installed(t *testing.T) *rig {
	t.Helper()
	r := newRig(t)
	r.opts.NoEnrolmentCode = true // the tests below make their own codes, and count the files
	r.install()
	return r
}

func TestEnrolmentStringPinsTheServerCertificateAndHoldsAFreshCode(t *testing.T) {
	r := installed(t)
	now := time.Date(2026, 10, 23, 12, 0, 0, 0, time.UTC)

	e, err := CreateEnrolment(EnrolOptions{Root: r.root, Sys: r.sys, Now: func() time.Time { return now }})
	if err != nil {
		t.Fatal(err)
	}
	u, fp, code := decodeEnrolment(t, e.String)
	if u != "https://203.0.113.10:7443" || e.URL != u {
		t.Errorf("url = %q (%q)", u, e.URL)
	}
	block, _ := pem.Decode([]byte(r.read("etc/keelson/tls/server.crt")))
	sum := sha256.Sum256(block.Bytes)
	if fp != hex.EncodeToString(sum[:]) {
		t.Errorf("fp = %q, want the SHA-256 of the server certificate's DER", fp)
	}
	if raw, err := base64.RawURLEncoding.DecodeString(code); err != nil || len(raw) != 24 || len(code) != 32 {
		t.Errorf("code %q is not 24 random bytes in base64url", code)
	}
	if !e.Expires.Equal(now.Add(15 * time.Minute)) {
		t.Errorf("default lifetime: expires %v", e.Expires)
	}

	// Another code is another code.
	e2, err := CreateEnrolment(EnrolOptions{Root: r.root, Sys: r.sys, Now: func() time.Time { return now }})
	if err != nil {
		t.Fatal(err)
	}
	if _, _, code2 := decodeEnrolment(t, e2.String); code2 == code {
		t.Error("two enrolments share a code")
	}
}

func TestPendingFileIsNamedAfterTheHashAndNeverHoldsTheCode(t *testing.T) {
	r := installed(t)
	p := Paths{r.root}
	e, err := CreateEnrolment(EnrolOptions{Root: r.root, Sys: r.sys, TTL: time.Hour})
	if err != nil {
		t.Fatal(err)
	}
	_, _, code := decodeEnrolment(t, e.String)
	file := enroll.PendingFile(p.EnrollDir(), enroll.Hash(code))
	body, err := os.ReadFile(file)
	if err != nil {
		t.Fatalf("no pending file for the code's hash: %v", err)
	}
	if strings.Contains(string(body), code) {
		t.Error("the pending file contains the code")
	}
	if got := mode(t, file); got != 0o640 {
		t.Errorf("pending file mode %o, want 640", got)
	}
	if got := r.sys.owners[file]; got != "root:keelson" {
		t.Errorf("pending file owner %q, want root:keelson (readable by the agent, not writable)", got)
	}
	if got := mode(t, p.EnrollDir()); got != 0o770 {
		t.Errorf("enrolment dir mode %o, want 770", got)
	}
	if got := r.sys.owners[p.EnrollDir()]; got != "root:keelson" {
		t.Errorf("enrolment dir owner %q", got)
	}
	entries, _ := os.ReadDir(p.EnrollDir())
	for _, en := range entries {
		if strings.Contains(en.Name(), code) {
			t.Errorf("a file name contains the code: %s", en.Name())
		}
	}
}

func TestPendingFileHoldsAClientCertificateIssuedLikeIssueClient(t *testing.T) {
	r := installed(t)
	p := Paths{r.root}
	now := time.Now()
	e, err := CreateEnrolment(EnrolOptions{Root: r.root, Sys: r.sys, Now: func() time.Time { return now }, TTL: 2 * time.Hour})
	if err != nil {
		t.Fatal(err)
	}
	_, _, code := decodeEnrolment(t, e.String)
	var pending enroll.Pending
	body, _ := os.ReadFile(enroll.PendingFile(p.EnrollDir(), enroll.Hash(code)))
	if err := json.Unmarshal(body, &pending); err != nil {
		t.Fatal(err)
	}
	if pending.Hash != enroll.Hash(code) || !pending.Expires().Equal(now.Add(2*time.Hour).Truncate(time.Millisecond)) {
		t.Errorf("pending record: %+v", pending)
	}
	block, _ := pem.Decode([]byte(pending.ClientCertPEM))
	cert, err := x509.ParseCertificate(block.Bytes)
	if err != nil {
		t.Fatal(err)
	}
	ca, err := LoadCA([]byte(r.read("etc/keelson/tls/ca.crt")), []byte(r.read("etc/keelson/tls/ca.key")))
	if err != nil {
		t.Fatal(err)
	}
	pool := x509.NewCertPool()
	pool.AddCert(ca.Cert)
	if _, err := cert.Verify(x509.VerifyOptions{Roots: pool, KeyUsages: []x509.ExtKeyUsage{x509.ExtKeyUsageClientAuth}}); err != nil {
		t.Errorf("the client certificate is not signed by the agent's CA for client auth: %v", err)
	}
	if _, err := cert.Verify(x509.VerifyOptions{Roots: pool, KeyUsages: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}, DNSName: "keelson-dashboard"}); err == nil {
		t.Error("the client certificate must not be valid as a server certificate")
	}
	ref, _ := ca.IssueClient(now)
	refBlock, _ := pem.Decode(ref.CertPEM)
	refCert, _ := x509.ParseCertificate(refBlock.Bytes)
	if cert.Subject.CommonName != "keelson-dashboard" || cert.Subject.CommonName != refCert.Subject.CommonName ||
		cert.NotAfter.Sub(cert.NotBefore) != refCert.NotAfter.Sub(refCert.NotBefore) ||
		cert.KeyUsage != refCert.KeyUsage || len(cert.ExtKeyUsage) != 1 || cert.ExtKeyUsage[0] != x509.ExtKeyUsageClientAuth {
		t.Errorf("client certificate differs from CA.IssueClient's: %+v vs %+v", cert, refCert)
	}
	if !strings.Contains(pending.ClientKeyPEM, "PRIVATE KEY") {
		t.Error("no client key in the pending file")
	}
}

func TestEnrolmentLifetimeBounds(t *testing.T) {
	r := installed(t)
	for _, ttl := range []time.Duration{24*time.Hour + time.Second, -time.Minute} {
		if _, err := CreateEnrolment(EnrolOptions{Root: r.root, Sys: r.sys, TTL: ttl}); err == nil {
			t.Errorf("a lifetime of %v must be refused", ttl)
		}
	}
	if _, err := CreateEnrolment(EnrolOptions{Root: r.root, Sys: r.sys, TTL: 24 * time.Hour}); err != nil {
		t.Errorf("24h is the longest allowed: %v", err)
	}
	// Nothing is left behind by the refused ones.
	entries, _ := os.ReadDir(Paths{r.root}.EnrollDir())
	if len(entries) != 1 {
		t.Errorf("%d pending files, want 1", len(entries))
	}
}

func TestEnrolmentURLOverrideIsValidated(t *testing.T) {
	r := installed(t)
	e, err := CreateEnrolment(EnrolOptions{Root: r.root, Sys: r.sys, URL: "https://agent.example.com:9443/"})
	if err != nil {
		t.Fatal(err)
	}
	if u, _, _ := decodeEnrolment(t, e.String); u != "https://agent.example.com:9443" {
		t.Errorf("url = %q", u)
	}
	for _, bad := range []string{"http://x:1", "agent.example.com", "https://", "https://u:p@x:1", "https://x:1/path", "https://x:1?q=1", "https://x:1#f", "ftp://x"} {
		if _, err := CreateEnrolment(EnrolOptions{Root: r.root, Sys: r.sys, URL: bad}); err == nil {
			t.Errorf("--url %q must be refused", bad)
		}
	}
}

func TestEnrolmentNeedsTheInstallRecordOrAURL(t *testing.T) {
	r := installed(t)
	if err := os.Remove(Paths{r.root}.Meta()); err != nil {
		t.Fatal(err)
	}
	if _, err := CreateEnrolment(EnrolOptions{Root: r.root, Sys: r.sys}); err == nil || !strings.Contains(err.Error(), "--url") {
		t.Errorf("want a hint about --url, got %v", err)
	}
	if _, err := CreateEnrolment(EnrolOptions{Root: r.root, Sys: r.sys, URL: "https://203.0.113.10:7443"}); err != nil {
		t.Errorf("--url is enough: %v", err)
	}
}

func TestEnrolmentFailsWithoutTheCAKeyAndSaysToRunAsRoot(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("root reads everything")
	}
	r := installed(t)
	key := Paths{r.root}.CAKey()
	if err := os.Chmod(key, 0); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.Chmod(key, 0o600) })
	_, err := CreateEnrolment(EnrolOptions{Root: r.root, Sys: r.sys})
	if err == nil || !strings.Contains(err.Error(), "root") {
		t.Errorf("want a hint to run as root, got %v", err)
	}
	if entries, _ := os.ReadDir(Paths{r.root}.EnrollDir()); len(entries) != 0 {
		t.Error("a failed enrolment left a file behind")
	}
}

func TestEnrolmentLeavesTheCAKeyAlone(t *testing.T) {
	r := installed(t)
	p := Paths{r.root}
	before := r.read("etc/keelson/tls/ca.key")
	owner := r.sys.owners[p.CAKey()]
	if _, err := CreateEnrolment(EnrolOptions{Root: r.root, Sys: r.sys}); err != nil {
		t.Fatal(err)
	}
	if r.read("etc/keelson/tls/ca.key") != before || mode(t, p.CAKey()) != 0o600 || r.sys.owners[p.CAKey()] != owner || owner != "root:root" {
		t.Error("enrolment must not touch the CA key or its permissions")
	}
}

func TestInstallEndsWithAnEnrolmentCode(t *testing.T) {
	r := newRig(t)
	b := r.install()
	if b.Enrolment == "" || b.EnrolmentExpires == "" {
		t.Fatalf("a fresh install must end with an enrolment string: %+v", b)
	}
	u, _, code := decodeEnrolment(t, b.Enrolment)
	if u != b.URL {
		t.Errorf("enrolment url %q, bundle url %q", u, b.URL)
	}
	if _, err := os.Stat(enroll.PendingFile(Paths{r.root}.EnrollDir(), enroll.Hash(code))); err != nil {
		t.Errorf("the code the install printed has no pending file: %v", err)
	}
	if exp, err := time.Parse(time.RFC3339, b.EnrolmentExpires); err != nil || time.Until(exp) > 15*time.Minute || time.Until(exp) < 14*time.Minute {
		t.Errorf("expires %q", b.EnrolmentExpires)
	}
	// The existing bundle fields are all still there, for compatibility.
	raw, _ := json.Marshal(b)
	for _, k := range []string{"version", "name", "url", "token", "deploy_secret", "ca_cert", "client_cert", "client_key", "agent_version", "enrolment", "enrolment_expires"} {
		if !strings.Contains(string(raw), `"`+k+`"`) {
			t.Errorf("bundle JSON lacks %q", k)
		}
	}
}

func TestUpgradeAndOptOutMakeNoEnrolmentCode(t *testing.T) {
	r := newRig(t)
	r.install()
	files := func() int { e, _ := os.ReadDir(Paths{r.root}.EnrollDir()); return len(e) }
	if files() != 1 {
		t.Fatalf("a fresh install leaves one pending code, found %d", files())
	}
	up := r.opts
	up.Upgrade = true
	b, err := Install(context.Background(), up)
	if err != nil {
		t.Fatal(err)
	}
	if b.Enrolment != "" || files() != 1 {
		t.Errorf("an upgrade must not make a code: %q, %d files", b.Enrolment, files())
	}

	r2 := newRig(t)
	r2.opts.NoEnrolmentCode = true
	b2 := r2.install()
	if b2.Enrolment != "" {
		t.Error("NoEnrolmentCode still made a code")
	}
	if e, _ := os.ReadDir(Paths{r2.root}.EnrollDir()); len(e) != 0 {
		t.Error("NoEnrolmentCode still left a file")
	}
	if _, err := os.Stat(filepath.Join(r2.root, "etc/keelson/enroll")); err != nil {
		t.Error("the directory is still prepared, so a later enroll-code finds it ready")
	}
}
