// Package docker is a minimal client for the Docker Engine API.
//
// It talks HTTP over the engine's unix socket using only the standard library.
// Client is read-only by construction: its single request path issues GET
// requests. Admin (admin.go) embeds Client and adds the mutating calls; the
// agent only constructs one when deployments are enabled.
package docker

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"
)

const baseURL = "http://docker"

// ErrInvalidID is returned for container identifiers that cannot be a valid
// Docker ID or name. Identifiers end up in a URL path sent to the engine, so
// they are validated before any request is made.
var ErrInvalidID = errors.New("invalid container id or name")

// ErrStop can be returned by a stream callback to end the stream early
// without it being reported as an error.
var ErrStop = errors.New("stop stream")

var idPattern = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$`)

// Error is a non-2xx answer from the Docker engine.
type Error struct {
	Status  int
	Message string
}

func (e *Error) Error() string { return fmt.Sprintf("docker: status %d: %s", e.Status, e.Message) }

// IsNotFound reports whether err is a 404 from the engine.
func IsNotFound(err error) bool {
	var de *Error
	return errors.As(err, &de) && de.Status == http.StatusNotFound
}

// Client is a read-only Docker Engine API client.
type Client struct {
	hc *http.Client
}

// New returns a client that dials the engine on the given unix socket.
func New(socketPath string) *Client {
	return &Client{hc: newHTTP(socketPath)}
}

func newHTTP(socketPath string) *http.Client {
	tr := &http.Transport{
		DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			var d net.Dialer
			return d.DialContext(ctx, "unix", socketPath)
		},
		MaxIdleConns:    4,
		IdleConnTimeout: 30 * time.Second,
	}
	return &http.Client{Transport: tr}
}

func checkID(id string) error {
	if !idPattern.MatchString(id) {
		return ErrInvalidID
	}
	return nil
}

// get performs a GET and returns the open response for 2xx answers. The
// caller must close the body. It is the only request path of Client, which is
// what makes Client read-only; mutations live in Admin.
func (c *Client) get(ctx context.Context, path string, q url.Values) (*http.Response, error) {
	return request(ctx, c.hc, http.MethodGet, path, q, nil, nil)
}

// request sends one request and turns non-2xx answers into *Error.
func request(ctx context.Context, hc *http.Client, method, path string, q url.Values, body io.Reader, header map[string]string) (*http.Response, error) {
	u := baseURL + path
	if len(q) > 0 {
		u += "?" + q.Encode()
	}
	req, err := http.NewRequestWithContext(ctx, method, u, body)
	if err != nil {
		return nil, err
	}
	for k, v := range header {
		req.Header.Set(k, v)
	}
	resp, err := hc.Do(req)
	if err != nil {
		// The URL of a failed request is not part of the error: a build's query holds its build arguments.
		var ue *url.Error
		if errors.As(err, &ue) {
			return nil, fmt.Errorf("%s %s: %w", method, path, ue.Err)
		}
		return nil, err
	}
	if resp.StatusCode/100 != 2 {
		defer resp.Body.Close()
		b, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		msg := strings.TrimSpace(string(b))
		var m struct {
			Message string `json:"message"`
		}
		if json.Unmarshal(b, &m) == nil && m.Message != "" {
			msg = m.Message
		}
		return nil, &Error{Status: resp.StatusCode, Message: msg}
	}
	return resp, nil
}

func (c *Client) getJSON(ctx context.Context, path string, q url.Values, out any) error {
	resp, err := c.get(ctx, path, q)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	return json.NewDecoder(resp.Body).Decode(out)
}

// Ping checks that the engine answers.
func (c *Client) Ping(ctx context.Context) error {
	resp, err := c.get(ctx, "/_ping", nil)
	if err != nil {
		return err
	}
	_, _ = io.Copy(io.Discard, resp.Body)
	return resp.Body.Close()
}
