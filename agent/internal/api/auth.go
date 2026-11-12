package api

import (
	"crypto/sha256"
	"crypto/subtle"
	"net/http"
	"strings"
)

// requireToken authenticates every request except GET /v1/health, so
// unauthenticated callers cannot enumerate routes. Reads use the bearer
// token, compared through SHA-256 digests in constant time. When deployments
// are enabled, every request that changes something (POST, PUT, DELETE) is
// instead authenticated by its HMAC signature in one place (verifySigned):
// a route cannot forget to check it, and the read token does not authorize
// changes.
func (s *server) requireToken(token string, next http.Handler) http.Handler {
	want := sha256.Sum256([]byte(token))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet && r.URL.Path == "/v1/health" {
			next.ServeHTTP(w, r)
			return
		}
		if s.deploy != nil && changesState(r.Method) {
			s.verifySigned(w, r, next)
			return
		}
		got, ok := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
		sum := sha256.Sum256([]byte(got))
		if !ok || subtle.ConstantTimeCompare(sum[:], want[:]) != 1 {
			s.log.Warn("unauthorized request", "method", r.Method, "path", r.URL.Path, "remote", r.RemoteAddr)
			w.Header().Set("WWW-Authenticate", `Bearer realm="keelson-agent"`)
			writeError(w, http.StatusUnauthorized, "unauthorized")
			return
		}
		next.ServeHTTP(w, r)
	})
}

// changesState reports whether a method may change something: those must be signed.
func changesState(method string) bool {
	switch method {
	case http.MethodPost, http.MethodPut, http.MethodDelete, http.MethodPatch:
		return true
	}
	return false
}
