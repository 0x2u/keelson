package proxy

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"reflect"
	"strings"
	"time"
)

// inspectTimeout bounds the read of what the proxy serves: an unreachable admin API must not hang the page.
const inspectTimeout = 5 * time.Second

// Inspection is what a driver generates for a set of routes, next to what the proxy serves at this moment. It is
// read-only: nothing is applied.
type Inspection struct {
	// Type is "caddy" or "nginx".
	Type string `json:"type"`
	// Where is the Caddy admin API or the nginx upstreams file.
	Where string `json:"where"`
	// Generated is the configuration the agent produces for the routes: the upstreams file, or the Caddy routes in JSON.
	Generated string `json:"generated"`
	// Config is, for Caddy, the whole configuration Apply would load (the routes above plus the listener and the certificates),
	// which is what a server about to hand its ports over needs to load the moment they are free. Empty for nginx.
	Config string `json:"config,omitempty"`
	// InSync tells whether the proxy serves exactly Generated. Nil when that could not be read; LiveError says why.
	InSync    *bool  `json:"in_sync,omitempty"`
	LiveError string `json:"live_error,omitempty"`
}

// Inspect generates the nginx upstreams file for routes and compares it with the file on disk.
func (n *Nginx) Inspect(_ context.Context, routes []Route) Inspection {
	want := RenderNginx(routes)
	out := Inspection{Type: "nginx", Where: n.settings.UpstreamsFile, Generated: string(want)}
	have, err := os.ReadFile(n.settings.UpstreamsFile)
	switch {
	case err == nil:
		same := bytes.Equal(have, want)
		out.InSync = &same
	case os.IsNotExist(err):
		same := false
		out.InSync = &same
		out.LiveError = "the upstreams file does not exist yet"
	default:
		out.LiveError = err.Error()
	}
	return out
}

// Inspect generates the Caddy routes (apps and sites) for routes and compares what the agent owns of the live server
// (routes, trusted proxies, error routes) with it, read from the admin API.
func (c *Caddy) Inspect(ctx context.Context, routes []Route) Inspection {
	want := caddyServer(c.settings, routes)
	pretty, _ := json.MarshalIndent(want["routes"], "", "  ")
	full, _ := json.MarshalIndent(BuildConfig(c.settings, routes), "", "  ")
	out := Inspection{Type: "caddy", Where: c.settings.Admin, Generated: string(pretty), Config: string(full)}

	ctx, cancel := context.WithTimeout(ctx, inspectTimeout)
	defer cancel()
	have, err := c.liveServer(ctx)
	if err != nil {
		out.LiveError = err.Error()
		return out
	}
	// Both sides are normalised through JSON: the comparison is about content, not key order or number types.
	var a, b map[string]any
	wantJSON, _ := json.Marshal(want)
	ok := json.Unmarshal(wantJSON, &a) == nil && json.Unmarshal(have, &b) == nil
	same := ok
	for _, k := range serverKeys {
		// Nothing loaded is the same as no routes: an empty list and a missing key agree.
		if !reflect.DeepEqual(emptyIsNil(a[k]), emptyIsNil(b[k])) {
			same = false
		}
	}
	out.InSync = &same
	return out
}

// Drifted tells whether Caddy answers and serves something other than what Apply would push for routes: it was
// restarted with an empty configuration, or changed behind the agent's back. False when it cannot be read.
func (c *Caddy) Drifted(ctx context.Context, routes []Route) bool {
	in := c.Inspect(ctx, routes)
	return in.InSync != nil && !*in.InSync
}

func emptyIsNil(v any) any {
	if l, ok := v.([]any); ok && len(l) == 0 {
		return nil
	}
	return v
}

func (c *Caddy) liveServer(ctx context.Context) ([]byte, error) {
	url := strings.TrimRight(c.settings.Admin, "/") + "/config/apps/http/servers/" + serverName
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	resp, err := c.hc.Do(req)
	if err != nil {
		return nil, fmt.Errorf("caddy admin API: %w", err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if resp.StatusCode/100 != 2 {
		// Caddy answers an unset path with an error: nothing of ours is being served yet.
		return []byte("null"), nil
	}
	return body, nil
}
