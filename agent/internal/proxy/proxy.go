// Package proxy drives a Caddy instance through its admin API. The agent owns
// the whole Caddy configuration: every change is a full, atomic replacement
// generated from the routes of the apps it manages and the sites of the proxy section.
package proxy

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/0x2u/keelson/agent/internal/config"
)

// Route sends the traffic of one app to its upstream. Hosts are used by Caddy;
// nginx routes by the server blocks of its own configuration and only needs
// the app name to name the upstream.
type Route struct {
	App   string
	Hosts []string
	// Upstream is "host:port".
	Upstream string
	// Down marks a placeholder (nginx only): the app declares host ports but nothing serves it now. nginx still needs
	// the upstream its server block names, or the whole configuration is invalid ("host not found in upstream") and no
	// reload, restart or boot can load it; a server marked down answers 502 and keeps the configuration valid.
	Down bool
}

// Caddy applies routes to a Caddy admin API.
type Caddy struct {
	settings config.Proxy
	hc       *http.Client
}

// New returns a driver for the Caddy described by settings.
func New(settings config.Proxy) *Caddy {
	if settings.Admin == "" {
		settings.Admin = config.DefaultProxyAdmin
	}
	return &Caddy{settings: settings, hc: &http.Client{Timeout: 15 * time.Second}}
}

// Apply replaces Caddy's configuration with one serving routes. Caddy loads it
// atomically and drains in-flight requests, so switching an upstream drops
// no connection.
func (c *Caddy) Apply(ctx context.Context, routes []Route) error {
	body, err := json.Marshal(BuildConfig(c.settings, routes))
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, strings.TrimRight(c.settings.Admin, "/")+"/load", bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := c.hc.Do(req)
	if err != nil {
		return fmt.Errorf("caddy admin API: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode/100 != 2 {
		b, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		return fmt.Errorf("caddy rejected the configuration: status %d: %s", resp.StatusCode, strings.TrimSpace(string(b)))
	}
	return nil
}

// BuildConfig returns the Caddy JSON configuration for the app routes and for the sites of settings. Everything is
// sorted so equal inputs give byte-identical output.
func BuildConfig(settings config.Proxy, routes []Route) map[string]any {
	server := caddyServer(settings, routes)
	server["listen"] = []any{":443"}

	apps := map[string]any{
		"http": map[string]any{
			"servers": map[string]any{
				// Without "listen" a JSON-configured server binds nothing. Listening
				// on :443 also makes Caddy add its automatic :80 redirect.
				serverName: server,
			},
		},
	}

	// Without an issuer Caddy uses its defaults (public ACME CA, no contact).
	var issuer map[string]any
	switch {
	case settings.TLS == "internal":
		issuer = map[string]any{"module": "internal"}
	case settings.ACMEEmail != "":
		issuer = map[string]any{"module": "acme", "email": settings.ACMEEmail}
	}
	tls := map[string]any{}
	if issuer != nil {
		tls["automation"] = map[string]any{"policies": []any{map[string]any{"issuers": []any{issuer}}}}
	}
	if len(settings.Certificates) > 0 {
		files := make([]any, len(settings.Certificates))
		for i, c := range settings.Certificates {
			files[i] = map[string]any{"certificate": c.CertFile, "key": c.KeyFile}
		}
		tls["certificates"] = map[string]any{"load_files": files}
	}
	if len(tls) > 0 {
		apps["tls"] = tls
	}
	out := map[string]any{"apps": apps}
	if settings.AccessLog != "" {
		// The logger the server names below: its name decides where its entries go. Caddy's default logger takes whatever no
		// other one claims, so the access entries are excluded from it: otherwise every request is also written to Caddy's
		// own output (the container's log, which Docker keeps).
		out["logging"] = map[string]any{"logs": map[string]any{
			"default": map[string]any{"exclude": []any{"http.log.access." + accessLogger}},
			accessLogger: map[string]any{
				"writer":  map[string]any{"output": "file", "filename": settings.AccessLog},
				"encoder": map[string]any{"format": "json"},
				"include": []any{"http.log.access." + accessLogger},
			},
		}}
	}
	return out
}

// serverName is the Caddy HTTP server the agent owns.
const serverName = "keelson"

// caddyServer is the server without its listeners: the routes, the trusted proxies and the error routes. It is
// what the agent compares with the live server.
func caddyServer(settings config.Proxy, routes []Route) map[string]any {
	server := map[string]any{"routes": caddyRoutes(settings, routes)}
	if len(settings.TrustedProxies) > 0 {
		server["trusted_proxies"] = map[string]any{"source": "static", "ranges": settings.TrustedProxies}
		if settings.ClientIPHeader != "" {
			server["client_ip_headers"] = []any{settings.ClientIPHeader}
		}
	}
	if settings.AccessLog != "" {
		server["logs"] = map[string]any{"default_logger_name": accessLogger}
	}
	if errs := siteErrorRoutes(settings); len(errs) > 0 {
		server["errors"] = map[string]any{"routes": errs}
	}
	return server
}

// serverKeys are the keys of the server the agent generates and compares.
var serverKeys = []string{"routes", "trusted_proxies", "client_ip_headers", "errors", "logs"}

// accessLogger is the name of the access logger (and so of the entries' destination) when proxy.access_log is set.
const accessLogger = "access"

// ownedRoute is one entry of the routes array with the host it sorts by.
type ownedRoute struct {
	host  string
	route map[string]any
}

// caddyRoutes is the "routes" array of the keelson server: one terminal route per app and per site, sorted by
// their first host (hosts are unique, so no two routes can match the same request).
func caddyRoutes(settings config.Proxy, routes []Route) []any {
	owned := make([]ownedRoute, 0, len(routes)+len(settings.Sites))
	for _, r := range routes {
		owned = append(owned, ownedRoute{r.Hosts[0], hostRoute(r.Hosts, reverseProxy(settings, r.Upstream))})
	}
	for _, s := range settings.Sites {
		if h := siteHandlers(settings, s); h != nil {
			owned = append(owned, ownedRoute{s.Hosts[0], hostRoute(s.Hosts, h...)})
		}
	}
	sort.SliceStable(owned, func(i, j int) bool { return owned[i].host < owned[j].host })

	out := make([]any, 0, len(owned))
	for _, o := range owned {
		out = append(out, o.route)
	}
	return out
}

// hostRoute is a terminal route for hosts.
func hostRoute(hosts []string, handle ...any) map[string]any {
	return map[string]any{
		"match":    []any{map[string]any{"host": hosts}},
		"handle":   handle,
		"terminal": true,
	}
}

// reverseProxy sends the request to upstream. Behind trusted proxies, X-Forwarded-For is set to the client address
// Caddy worked out, whatever the request carried: an untrusted client cannot choose what the upstream sees.
func reverseProxy(settings config.Proxy, upstream string) map[string]any {
	h := map[string]any{
		"handler":   "reverse_proxy",
		"upstreams": []any{map[string]any{"dial": upstream}},
	}
	if len(settings.TrustedProxies) > 0 {
		h["headers"] = map[string]any{"request": map[string]any{"set": map[string]any{"X-Forwarded-For": []any{"{http.vars.client_ip}"}}}}
	}
	return h
}
