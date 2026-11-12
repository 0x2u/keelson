package install

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"errors"
	"fmt"
	"math/big"
	"net"
	"time"
)

// The validity periods are long on purpose: a certificate that expires silently takes the agent off the dashboard,
// and renewing one means touching the server. The CA key stays on the server (root only) so new client certificates
// can be issued without reinstalling.
const (
	caValidity     = 10 * 365 * 24 * time.Hour
	leafValidity   = 5 * 365 * 24 * time.Hour
	renewBefore    = 60 * 24 * time.Hour
	clientCertName = "keelson-dashboard"
)

// CA signs the agent's server certificate and the dashboard's client certificates.
type CA struct {
	Cert *x509.Certificate
	Key  *ecdsa.PrivateKey
	PEM  []byte
}

func newSerial() (*big.Int, error) {
	return rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 127))
}

// NewCA creates a certificate authority for one server.
func NewCA(name string, now time.Time) (*CA, []byte, error) {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, nil, err
	}
	serial, err := newSerial()
	if err != nil {
		return nil, nil, err
	}
	tpl := &x509.Certificate{
		SerialNumber:          serial,
		Subject:               pkix.Name{CommonName: "Keelson agent CA (" + name + ")"},
		NotBefore:             now.Add(-time.Hour),
		NotAfter:              now.Add(caValidity),
		IsCA:                  true,
		BasicConstraintsValid: true,
		MaxPathLenZero:        true,
		KeyUsage:              x509.KeyUsageCertSign | x509.KeyUsageCRLSign,
	}
	der, err := x509.CreateCertificate(rand.Reader, tpl, tpl, &key.PublicKey, key)
	if err != nil {
		return nil, nil, err
	}
	cert, err := x509.ParseCertificate(der)
	if err != nil {
		return nil, nil, err
	}
	keyPEM, err := encodeKey(key)
	if err != nil {
		return nil, nil, err
	}
	return &CA{Cert: cert, Key: key, PEM: encodeCert(der)}, keyPEM, nil
}

// LoadCA reads a CA back from its PEM files.
func LoadCA(certPEM, keyPEM []byte) (*CA, error) {
	cert, err := parseCert(certPEM)
	if err != nil {
		return nil, err
	}
	key, err := parseKey(keyPEM)
	if err != nil {
		return nil, err
	}
	return &CA{Cert: cert, Key: key, PEM: certPEM}, nil
}

// Leaf is a certificate and its private key, PEM encoded.
type Leaf struct {
	CertPEM []byte
	KeyPEM  []byte
}

// IssueServer signs the agent's TLS certificate for the given host names and addresses.
func (ca *CA) IssueServer(hosts []string, now time.Time) (Leaf, error) {
	tpl := &x509.Certificate{
		Subject:     pkix.Name{CommonName: "keelson-agent"},
		KeyUsage:    x509.KeyUsageDigitalSignature,
		ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
	}
	for _, h := range hosts {
		if ip := net.ParseIP(h); ip != nil {
			tpl.IPAddresses = append(tpl.IPAddresses, ip)
		} else if h != "" {
			tpl.DNSNames = append(tpl.DNSNames, h)
		}
	}
	if len(tpl.IPAddresses)+len(tpl.DNSNames) == 0 {
		return Leaf{}, errors.New("a server certificate needs at least one host name or address")
	}
	return ca.issue(tpl, now)
}

// IssueClient signs a certificate the dashboard presents to this agent.
func (ca *CA) IssueClient(now time.Time) (Leaf, error) {
	return ca.issue(&x509.Certificate{
		Subject:     pkix.Name{CommonName: clientCertName},
		KeyUsage:    x509.KeyUsageDigitalSignature,
		ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageClientAuth},
	}, now)
}

func (ca *CA) issue(tpl *x509.Certificate, now time.Time) (Leaf, error) {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return Leaf{}, err
	}
	serial, err := newSerial()
	if err != nil {
		return Leaf{}, err
	}
	tpl.SerialNumber = serial
	tpl.NotBefore = now.Add(-time.Hour)
	tpl.NotAfter = now.Add(leafValidity)
	if tpl.NotAfter.After(ca.Cert.NotAfter) {
		tpl.NotAfter = ca.Cert.NotAfter
	}
	der, err := x509.CreateCertificate(rand.Reader, tpl, ca.Cert, &key.PublicKey, ca.Key)
	if err != nil {
		return Leaf{}, err
	}
	keyPEM, err := encodeKey(key)
	if err != nil {
		return Leaf{}, err
	}
	return Leaf{CertPEM: encodeCert(der), KeyPEM: keyPEM}, nil
}

// ServerCertCovers reports whether an existing server certificate is valid for at least renewBefore longer and
// covers every host: when it does not, it is reissued.
func ServerCertCovers(certPEM []byte, hosts []string, now time.Time) bool {
	cert, err := parseCert(certPEM)
	if err != nil || now.Add(renewBefore).After(cert.NotAfter) {
		return false
	}
	for _, h := range hosts {
		if h != "" && cert.VerifyHostname(h) != nil {
			return false
		}
	}
	return true
}

func encodeCert(der []byte) []byte {
	return pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})
}

func encodeKey(key *ecdsa.PrivateKey) ([]byte, error) {
	der, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		return nil, err
	}
	return pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der}), nil
}

func parseCert(certPEM []byte) (*x509.Certificate, error) {
	block, _ := pem.Decode(certPEM)
	if block == nil || block.Type != "CERTIFICATE" {
		return nil, errors.New("no certificate in PEM data")
	}
	return x509.ParseCertificate(block.Bytes)
}

func parseKey(keyPEM []byte) (*ecdsa.PrivateKey, error) {
	block, _ := pem.Decode(keyPEM)
	if block == nil {
		return nil, errors.New("no private key in PEM data")
	}
	k, err := x509.ParsePKCS8PrivateKey(block.Bytes)
	if err != nil {
		return nil, fmt.Errorf("parse private key: %w", err)
	}
	key, ok := k.(*ecdsa.PrivateKey)
	if !ok {
		return nil, errors.New("the CA key is not an ECDSA key")
	}
	return key, nil
}
