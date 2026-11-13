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
	// Stopped marks an app the file stops (enabled: false): its container is down on purpose, so no visitor is sent
	// anywhere. Caddy answers its hosts with 503 and a short text; nginx gets the upstream its server block names, marked
	// down, as for any app nothing serves. Upstream is where the app was, for nginx's upstream block (empty: none is
	// written); Caddy does not use it.
	Stopped bool
	// Canary, when set, shares the app's visitors between Upstream (the version that has been serving) and a second one.
	// Caddy only: nginx cannot keep a visitor on one version, and the configuration refuses a canary with it.
	Canary *Canary
}

// Canary is the new version of an app while a canary deployment is under way.
type Canary struct {
	// Upstream is "host:port" of the new version.
	Upstream string
	// Percent is the share of visitors, from 1 to 99, that the new version receives.
	Percent int
	// Key makes the cookie of this step unique: a visitor is given a version by the weights of the step it arrives in and
	// keeps it until the step changes, and a cookie left by an earlier rollout never matches. The deployment id and the
	// step, such as "9f3a...-50".
	Key string
}

// StoppedBody is what Caddy answers, with status 503, for the hosts of an app that is stopped (enabled: false).
const StoppedBody = "This app is stopped."

// canaryCookie names the cookie that keeps a browser on the version it was given.
const canaryCookie = "keelson_canary"

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
		owned = append(owned, ownedRoute{r.Hosts[0], hostRoute(r.Hosts, routeHandler(settings, r))})
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

// routeHandler is the reverse proxy of an app route: one upstream, or, during a canary, both versions. The visitors who
// carry the cookie stay where it points; a visitor without one is given a version by the weights, and Caddy sets the
// cookie. Both are Caddy's own selection policies.
func routeHandler(settings config.Proxy, r Route) map[string]any {
	if r.Stopped {
		return map[string]any{
			"handler":     "static_response",
			"status_code": 503,
			"body":        StoppedBody,
			"headers":     map[string]any{"Content-Type": []any{"text/plain; charset=utf-8"}},
		}
	}
	h := reverseProxy(settings, r.Upstream)
	if r.Canary == nil {
		return h
	}
	upstreams, weights := canaryPool(r.Upstream, r.Canary.Upstream, r.Canary.Percent)
	h["upstreams"] = upstreams
	h["load_balancing"] = map[string]any{"selection_policy": map[string]any{
		"policy": "cookie",
		"name":   canaryCookie,
		"secret": r.Canary.Key,
		"fallback": map[string]any{
			"policy":  "weighted_round_robin",
			"weights": weights,
		},
	}}
	return h
}

// canaryPool lists the upstreams, and their weights, that share the visitors between the serving version and the new
// one. Caddy's weighted round robin walks a cycle of 100 draws in the order of the list: with [stable 90, canary 10] the
// first 90 visitors of every cycle go to the stable version and the next 10 to the new one, so a site with fifty visitors
// per step would never show the new version to any. The 100 draws are spread instead, the new version taking every draw
// that brings the running share over a whole number of percent (10%: nine stable, one new, ten times; 33%: a new one
// every third draw or so), then runs of the same version are listed once with their length as weight. A version listed
// several times is one upstream to Caddy: the cookie of a visitor points at its address, whichever entry it was drawn from.
func canaryPool(stable, canary string, percent int) (upstreams, weights []any) {
	last := ""
	for i := range 100 {
		dial := stable
		if (i+1)*percent/100 > i*percent/100 {
			dial = canary
		}
		if dial == last {
			weights[len(weights)-1] = weights[len(weights)-1].(int) + 1
			continue
		}
		upstreams = append(upstreams, map[string]any{"dial": dial})
		weights = append(weights, 1)
		last = dial
	}
	return upstreams, weights
}
