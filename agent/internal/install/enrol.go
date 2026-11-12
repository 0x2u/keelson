package install

import (
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"net"
	"net/url"
	"os"
	"strconv"
	"time"

	"github.com/0x2u/keelson/agent/internal/enroll"
)

// EnrollDir holds the pending enrolment codes. It is root:keelson 0770 so the agent can delete a file once it was
// redeemed (a file is removed with write access to its directory, not to itself); the files in it are root:keelson
// 0640, so the agent can read but not change them. The directory is not sticky on purpose: that would stop the
// agent from deleting files root created.
func (p Paths) EnrollDir() string { return p.at("etc/keelson/enroll") }

// EnrolOptions configure CreateEnrolment.
type EnrolOptions struct {
	// Root is the filesystem root; empty means "/".
	Root string
	// TTL is how long the code works: enroll.DefaultTTL when zero, at most enroll.MaxTTL.
	TTL time.Duration
	// URL is the address the dashboard reaches the agent at. Empty: the first host name and the port the install
	// recorded.
	URL string
	Sys System
	Now func() time.Time
}

// Enrolment is a code ready to be pasted into the dashboard.
type Enrolment struct {
	// String is the enrolment string: it holds the code, so it is shown to the administrator and kept nowhere.
	String  string
	URL     string
	Expires time.Time
}

// CreateEnrolment makes a one-time code for this server. It needs root: it signs a client certificate with the
// authority's key, which no other account can read. The certificate and its key wait in a file named after the code's
// hash (never the code) until the agent redeems it or it expires. Nothing is changed in the agent, which need not run
// at this moment.
func CreateEnrolment(o EnrolOptions) (Enrolment, error) {
	if o.Root == "" {
		o.Root = "/"
	}
	if o.Sys == nil {
		o.Sys = HostSystem()
	}
	if o.Now == nil {
		o.Now = time.Now
	}
	if o.TTL == 0 {
		o.TTL = enroll.DefaultTTL
	}
	if o.TTL < 0 || o.TTL > enroll.MaxTTL {
		return Enrolment{}, fmt.Errorf("the code's lifetime must be between 1s and %s", enroll.MaxTTL)
	}
	p := Paths{o.Root}
	now := o.Now()

	certPEM, err := os.ReadFile(p.CACert())
	if err != nil {
		return Enrolment{}, fmt.Errorf("read the CA certificate: %w (is the agent installed here?)", err)
	}
	keyPEM, err := os.ReadFile(p.CAKey())
	if err != nil {
		if errors.Is(err, os.ErrPermission) {
			return Enrolment{}, errors.New("the CA key is readable by root only: run it as root (sudo keelson-agent enroll-code)")
		}
		return Enrolment{}, fmt.Errorf("read the CA key: %w", err)
	}
	ca, err := LoadCA(certPEM, keyPEM)
	if err != nil {
		return Enrolment{}, fmt.Errorf("load the certificate authority: %w", err)
	}
	fp, err := serverFingerprint(p)
	if err != nil {
		return Enrolment{}, err
	}
	addr, err := enrolURL(p, o.URL)
	if err != nil {
		return Enrolment{}, err
	}

	client, err := ca.IssueClient(now)
	if err != nil {
		return Enrolment{}, err
	}
	code, err := enroll.NewCode()
	if err != nil {
		return Enrolment{}, err
	}
	pending := enroll.NewPending(code, now, o.TTL, client.CertPEM, client.KeyPEM)
	body, err := json.Marshal(pending)
	if err != nil {
		return Enrolment{}, err
	}
	if err := mkdir(o.Sys, p.EnrollDir(), 0o770, "root", ServiceUser); err != nil {
		return Enrolment{}, err
	}
	if err := put(o.Sys, enroll.PendingFile(p.EnrollDir(), pending.Hash), body, 0o640, "root", ServiceUser); err != nil {
		return Enrolment{}, err
	}
	return Enrolment{String: enroll.Encode(addr, fp, code), URL: addr, Expires: pending.Expires()}, nil
}

// serverFingerprint is the SHA-256 of the DER of the certificate the agent presents: what the dashboard pins.
func serverFingerprint(p Paths) (string, error) {
	b, err := os.ReadFile(p.ServerCert())
	if err != nil {
		return "", fmt.Errorf("read the server certificate: %w", err)
	}
	block, _ := pem.Decode(b)
	if block == nil || block.Type != "CERTIFICATE" {
		return "", fmt.Errorf("%s holds no certificate", p.ServerCert())
	}
	if _, err := x509.ParseCertificate(block.Bytes); err != nil {
		return "", fmt.Errorf("the server certificate: %w", err)
	}
	return enroll.Fingerprint(block.Bytes), nil
}

// enrolURL is the URL given, checked, or the one the install recorded.
func enrolURL(p Paths, given string) (string, error) {
	if given == "" {
		m := readMeta(p)
		if m.Listen == "" || len(m.Hosts) == 0 {
			return "", fmt.Errorf("no recorded address in %s: give --url https://HOST:PORT", p.Meta())
		}
		return "https://" + net.JoinHostPort(m.Hosts[0], strconv.Itoa(listenPort(m.Listen))), nil
	}
	u, err := url.Parse(given)
	if err != nil || u.Scheme != "https" || u.Hostname() == "" || u.User != nil ||
		(u.Path != "" && u.Path != "/") || u.RawQuery != "" || u.Fragment != "" {
		return "", fmt.Errorf("--url %q is not an https://HOST[:PORT] address", given)
	}
	return "https://" + u.Host, nil
}
