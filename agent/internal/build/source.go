package build

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"slices"
	"strings"
	"time"
)

// Source says where to download the source archive of a build from, and with which bearer token. The token is a
// short-lived GitHub installation token the dashboard hands over for this one build: it lives in memory only, is
// sent to the allowed source host only, and is never logged, stored, recorded in events or audit, put in an error,
// a command line or the environment of a container. Every way of printing a Source leaves it out.
type Source struct {
	URL   string `json:"url"`
	Token string `json:"token"`
}

const redacted = "[redacted]"

func (s Source) String() string   { return "source(" + s.Host() + ")" }
func (s Source) GoString() string { return s.String() }

// LogValue keeps the token out of structured logs.
func (s Source) LogValue() slog.Value { return slog.StringValue(s.String()) }

// MarshalJSON keeps the token out of any JSON the agent writes (the request is decoded, never re-encoded).
func (s Source) MarshalJSON() ([]byte, error) {
	return json.Marshal(struct {
		URL   string `json:"url"`
		Token string `json:"token"`
	}{s.URL, redacted})
}

// Host is the host name of the source URL, for messages ("" when the URL does not parse).
func (s Source) Host() string {
	u, err := url.Parse(s.URL)
	if err != nil {
		return ""
	}
	return u.Hostname()
}

// Errors of the source download.
var (
	ErrSourceHost     = errors.New("the source URL is not allowed: it must be https on a host listed in the build's source_hosts")
	ErrSourceToken    = errors.New("the source token is missing or malformed")
	ErrSourceTooLarge = errors.New("the source archive is larger than the build's max_source")
)

// codeloadHost is where GitHub redirects its tarball API to.
const codeloadHost = "codeload.github.com"

const maxRedirects = 5

// validateSource checks a request's source before anything is downloaded: https, no credentials in the URL, a host
// on the allow-list, a plausible token.
func (b *Builder) validateSource(src Source, hosts []string) (*url.URL, error) {
	u, err := url.Parse(src.URL)
	if err != nil || !b.hostAllowed(u, hosts) {
		return nil, ErrSourceHost
	}
	if src.Token != "" && !validToken(src.Token) {
		return nil, ErrSourceToken
	}
	return u, nil
}

// hostAllowed reports whether u is an https URL without credentials whose host (an exact match, no wildcard) is one
// of hosts, on the default port.
func (b *Builder) hostAllowed(u *url.URL, hosts []string) bool {
	if u.Scheme != "https" || u.User != nil || u.Opaque != "" || u.Hostname() == "" {
		return false
	}
	if p := u.Port(); p != "" && p != "443" {
		return false
	}
	return slices.Contains(hosts, strings.ToLower(u.Hostname()))
}

// validToken accepts what a bearer token can be: printable ASCII without spaces, so it can never add a header line.
func validToken(t string) bool {
	if len(t) == 0 || len(t) > 4096 {
		return false
	}
	for _, c := range []byte(t) {
		if c <= ' ' || c >= 0x7f {
			return false
		}
	}
	return true
}

// fetch opens the source archive. Redirects are followed only to https hosts of the allow-list (and GitHub's codeload
// host), and the Authorization header is dropped as soon as the host changes: the redirect target is a pre-signed
// address, and the token belongs to the host that issued it.
func (b *Builder) fetch(ctx context.Context, src Source, hosts []string, maxBytes int64) (io.ReadCloser, error) {
	u, err := b.validateSource(src, hosts)
	if err != nil {
		return nil, err
	}
	allowed := append(slices.Clone(hosts), codeloadHost)
	client := *b.http
	client.Timeout = 0 // the build's context bounds the download
	client.CheckRedirect = func(req *http.Request, via []*http.Request) error {
		if len(via) > maxRedirects {
			return errors.New("too many redirects")
		}
		if !b.hostAllowed(req.URL, allowed) {
			return fmt.Errorf("the source redirects to %s, which is not allowed", describeHost(req.URL))
		}
		if req.URL.Host != via[len(via)-1].URL.Host {
			req.Header.Del("Authorization")
		}
		return nil
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return nil, ErrSourceHost
	}
	req.Header.Set("User-Agent", "keelson-agent")
	if src.Token != "" {
		req.Header.Set("Authorization", "Bearer "+src.Token)
	}
	resp, err := client.Do(req)
	if err != nil {
		// A *url.Error carries the URL: say what failed without it.
		var ue *url.Error
		if errors.As(err, &ue) {
			err = ue.Err
		}
		return nil, fmt.Errorf("download source from %s: %w", u.Hostname(), err)
	}
	if resp.StatusCode != http.StatusOK {
		_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 4096))
		resp.Body.Close()
		return nil, fmt.Errorf("download source from %s: HTTP %d", u.Hostname(), resp.StatusCode)
	}
	if resp.ContentLength > maxBytes {
		resp.Body.Close()
		return nil, ErrSourceTooLarge
	}
	return &limitedBody{rc: resp.Body, left: maxBytes}, nil
}

func describeHost(u *url.URL) string {
	if u.Scheme != "https" {
		return u.Scheme + " URLs"
	}
	return u.Hostname()
}

// limitedBody fails, instead of truncating, when more than the allowed bytes arrive.
type limitedBody struct {
	rc   io.ReadCloser
	left int64
}

func (l *limitedBody) Read(p []byte) (int, error) {
	if l.left < 0 {
		return 0, ErrSourceTooLarge
	}
	if int64(len(p)) > l.left+1 {
		p = p[:l.left+1]
	}
	n, err := l.rc.Read(p)
	l.left -= int64(n)
	if l.left < 0 {
		return n, ErrSourceTooLarge
	}
	return n, err
}

func (l *limitedBody) Close() error { return l.rc.Close() }

// defaultHTTPClient is the client of downloads: no proxy tricks, TLS verification on, bounded connection setup.
func defaultHTTPClient() *http.Client {
	tr := http.DefaultTransport.(*http.Transport).Clone()
	tr.TLSHandshakeTimeout = 15 * time.Second
	tr.ResponseHeaderTimeout = 60 * time.Second
	return &http.Client{Transport: tr}
}
