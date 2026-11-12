package api

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"strconv"

	"github.com/0x2u/keelson/agent/internal/enroll"
	"github.com/0x2u/keelson/agent/internal/store"
)

// enrollPath is the one route that is reachable without a client certificate and without the bearer token: its only
// credential is the one-time code in the body.
const enrollPath = "/v1/enroll"

// maxEnrollBody bounds the request: it holds a 32 character code.
const maxEnrollBody = 4 << 10

// Enroller redeems one-time enrolment codes. enroll.Service is one.
type Enroller interface {
	Redeem(ctx context.Context, code string) (enroll.Result, error)
}

// ServerTLSConfig is the listener's TLS configuration for mutual TLS: clients must present a certificate signed by
// the CA in clientCAPEM. With enrolment, the handshake also accepts a client with no certificate at all, because that
// is how a dashboard that was not given one yet reaches POST /v1/enroll; the handler chain then refuses it everywhere
// else (see frontGate), so the certificate remains mandatory for every other request. A certificate that is presented
// but not signed by that CA fails the handshake in both modes.
func ServerTLSConfig(clientCAPEM []byte, withEnrolment bool) (*tls.Config, error) {
	pool := x509.NewCertPool()
	if !pool.AppendCertsFromPEM(clientCAPEM) {
		return nil, errors.New("no certificate in the client CA")
	}
	cfg := &tls.Config{MinVersion: tls.VersionTLS13, ClientCAs: pool, ClientAuth: tls.RequireAndVerifyClientCert}
	if withEnrolment {
		cfg.ClientAuth = tls.VerifyClientCertIfGiven
	}
	return cfg, nil
}

// verifiedClient reports whether the connection carries a client certificate the TLS layer verified.
func verifiedClient(r *http.Request) bool {
	return r.TLS != nil && len(r.TLS.VerifiedChains) > 0
}

// frontGate sits in front of everything else. When mutual TLS is configured it refuses, before any handler runs and
// for every path and method (unknown paths and 404s included), a request that does not carry a verified client
// certificate, except POST /v1/enroll while enrolment is enabled. Without it, accepting certificate-less handshakes
// for enrolment would silently downgrade mutual TLS to the bearer token.
func (s *server) frontGate(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		isEnrol := r.Method == http.MethodPost && r.URL.Path == enrollPath
		if isEnrol && s.enroller != nil {
			s.enrol(w, r)
			return
		}
		if s.requireClientCert && !verifiedClient(r) {
			writeError(w, http.StatusUnauthorized, "client certificate required")
			return
		}
		if isEnrol {
			writeError(w, http.StatusNotFound, "enrolment is not enabled on this agent")
			return
		}
		next.ServeHTTP(w, r)
	})
}

type enrolRequest struct {
	Code string `json:"code"`
}

// enrol redeems a code. Unknown, used and expired codes get the same answer. Nothing secret is logged here: not the
// code, not what is handed out.
func (s *server) enrol(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, maxEnrollBody)
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	var req enrolRequest
	if err := dec.Decode(&req); err != nil || req.Code == "" {
		writeError(w, http.StatusBadRequest, "the body must be {\"code\": \"...\"}")
		return
	}
	if _, err := dec.Token(); !errors.Is(err, io.EOF) {
		writeError(w, http.StatusBadRequest, "the body must be {\"code\": \"...\"}")
		return
	}

	res, err := s.enroller.Redeem(r.Context(), req.Code)
	var limited *enroll.RateLimitedError
	var invalid *enroll.InvalidError
	switch {
	case errors.As(err, &limited):
		w.Header().Set("Retry-After", strconv.Itoa(enroll.RetryAfterSeconds(limited.RetryAfter)))
		writeError(w, http.StatusTooManyRequests, "too many failed attempts: try again later")
	case errors.As(err, &invalid):
		// A code that was once valid (used, expired) is worth a line in the audit log; a guess is not: anyone could
		// fill the log with them.
		if invalid.Reason != enroll.ReasonUnknown {
			s.auditEnrol(r, invalid.ID, http.StatusForbidden, "rejected ("+invalid.Reason+")")
		}
		writeError(w, http.StatusForbidden, enroll.ErrInvalid.Error())
	case err != nil:
		s.log.Error("enrolment failed", "err", err)
		writeError(w, http.StatusInternalServerError, "enrolment failed")
	default:
		s.auditEnrol(r, res.ID, http.StatusOK, "redeemed")
		writeJSON(w, http.StatusOK, res.Credentials)
	}
}

// auditEnrol records an enrolment: the short hash of the code (never the code) and where the caller came from.
func (s *server) auditEnrol(r *http.Request, id string, status int, what string) {
	if s.deploy == nil || s.deploy.Audit == nil {
		return
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		host = r.RemoteAddr
	}
	e := store.AuditEntry{
		At: s.now().UTC(), Actor: "enrolment", IP: host, Method: r.Method, Path: r.URL.Path,
		Action: "enroll", Status: status, Detail: fmt.Sprintf("code %s %s", id, what),
	}
	if err := s.deploy.Audit.AddAudit(context.WithoutCancel(r.Context()), e); err != nil {
		s.log.Error("record audit entry", "err", err)
	}
}
