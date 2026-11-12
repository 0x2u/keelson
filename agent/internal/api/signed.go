package api

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// Headers carrying a signed request's proof.
const (
	HeaderTimestamp = "X-Keelson-Timestamp"
	HeaderSignature = "X-Keelson-Signature"
)

const (
	// MaxSkew is how far a request timestamp may be from the agent's clock.
	MaxSkew = 5 * time.Minute
	// maxSignedBody bounds the body of a signed request.
	maxSignedBody = 64 << 10
)

// Replays remembers served signatures.
type Replays interface {
	// RecordRequest reports false when signature was already recorded.
	RecordRequest(ctx context.Context, signature string, now, expires time.Time) (fresh bool, err error)
}

// Sign returns the signature of a request: the hex HMAC-SHA256, keyed with
// secret, of
//
//	<unix timestamp> \n <METHOD> \n <request URI with query> \n <hex sha256 of body>
//
// Callers send it in X-Keelson-Signature with the timestamp in
// X-Keelson-Timestamp. The timestamp bounds the lifetime of a captured
// request and the agent refuses a signature it has already served.
func Sign(secret string, ts int64, method, requestURI string, body []byte) string {
	sum := sha256.Sum256(body)
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(strconv.FormatInt(ts, 10) + "\n" + method + "\n" + requestURI + "\n" + hex.EncodeToString(sum[:])))
	return hex.EncodeToString(mac.Sum(nil))
}

// verifySigned authenticates a POST with its HMAC signature. On success the
// request body is restored for the handler.
func (s *server) verifySigned(w http.ResponseWriter, r *http.Request, next http.Handler) {
	deny := func(reason string) {
		s.log.Warn("rejected signed request", "reason", reason, "method", r.Method, "path", r.URL.Path, "remote", r.RemoteAddr)
		writeError(w, http.StatusUnauthorized, "unauthorized")
	}

	ts, err := strconv.ParseInt(r.Header.Get(HeaderTimestamp), 10, 64)
	if err != nil {
		deny("missing or invalid timestamp")
		return
	}
	now := s.now()
	if d := now.Sub(time.Unix(ts, 0)); d > MaxSkew || d < -MaxSkew {
		deny("timestamp outside the allowed window")
		return
	}
	got, err := hex.DecodeString(r.Header.Get(HeaderSignature))
	if err != nil || len(got) != sha256.Size {
		deny("missing or malformed signature")
		return
	}

	// An image archive is not read here: the signature covers the request without it, and the handler checks the archive
	// against the SHA-256 that the signed query announces.
	streamed := isImageImport(r)
	var body []byte
	if !streamed {
		limit := int64(maxSignedBody)
		if isEnvChange(r) {
			limit = maxEnvBody
		}
		body, err = io.ReadAll(http.MaxBytesReader(w, r.Body, limit))
		if err != nil {
			writeError(w, http.StatusRequestEntityTooLarge, "request body too large")
			return
		}
	}
	want, _ := hex.DecodeString(Sign(s.deploy.Secret, ts, r.Method, r.URL.RequestURI(), body))
	if !hmac.Equal(got, want) {
		deny("bad signature")
		return
	}

	// Only a valid signature is recorded, so unauthenticated traffic cannot
	// grow the table.
	fresh, err := s.deploy.Replays.RecordRequest(r.Context(), hex.EncodeToString(got), now, now.Add(2*MaxSkew))
	if err != nil {
		s.log.Error("record signed request", "err", err)
		if diskFull(err) {
			// The replay table is written before anything runs, so on a full disk every signed action fails here, the ones
			// that would help included. Say what is wrong instead of "internal error": the way out is on the server.
			writeError(w, http.StatusInsufficientStorage, "the agent's disk is full, so it cannot record the request: free space on the server (docker image prune -f, old logs), then retry")
			return
		}
		writeError(w, http.StatusInternalServerError, "internal error")
		return
	}
	if !fresh {
		deny("replayed request")
		return
	}

	if !streamed {
		r.Body = io.NopCloser(bytes.NewReader(body))
	}
	s.serveAudited(w, r, next)
}

// diskFull says whether a database error is the disk running out of room (SQLITE_FULL).
func diskFull(err error) bool {
	msg := strings.ToLower(err.Error())
	return strings.Contains(msg, "database or disk is full") || strings.Contains(msg, "no space left on device")
}
