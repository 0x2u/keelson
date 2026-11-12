package proxy

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/0x2u/keelson/agent/internal/config"
)

// server returns the generated keelson server as plain data.
func server(t *testing.T, settings config.Proxy, routes []Route) map[string]any {
	t.Helper()
	b, err := json.Marshal(BuildConfig(settings, routes))
	if err != nil {
		t.Fatal(err)
	}
	var m map[string]any
	if err := json.Unmarshal(b, &m); err != nil {
		t.Fatal(err)
	}
	return m["apps"].(map[string]any)["http"].(map[string]any)["servers"].(map[string]any)["keelson"].(map[string]any)
}

func compact(v any) string {
	b, _ := json.Marshal(v)
	return string(b)
}

func staticSite() config.Site {
	return config.Site{
		Hosts: []string{"www.example.com"}, Root: "/srv/www", Index: "index.html", NotFound: "404.html",
		TryFiles:  config.DefaultTryFiles,
		Headers:   map[string]string{"X-Frame-Options": "DENY", "X-Content-Type-Options": "nosniff"},
		Immutable: []string{"/_next/static/*"},
	}
}

func TestConfigWithoutSitesIsExactlyWhatItWas(t *testing.T) {
	got, _ := json.Marshal(BuildConfig(config.Proxy{}, []Route{{Hosts: []string{"a.example.com"}, Upstream: "127.0.0.1:1"}}))
	want := `{"apps":{"http":{"servers":{"keelson":{"listen":[":443"],"routes":[{"handle":[{"handler":"reverse_proxy","upstreams":[{"dial":"127.0.0.1:1"}]}],"match":[{"host":["a.example.com"]}],"terminal":true}]}}}}}`
	if string(got) != want {
		t.Errorf("an app-only configuration changed:\n got %s\nwant %s", got, want)
	}
}

func TestStaticSiteRoute(t *testing.T) {
	srv := server(t, config.Proxy{Sites: []config.Site{staticSite()}}, nil)
	routes := srv["routes"].([]any)
	if len(routes) != 1 {
		t.Fatalf("want one route: %s", compact(srv))
	}
	r := routes[0].(map[string]any)
	if compact(r["match"]) != `[{"host":["www.example.com"]}]` || r["terminal"] != true {
		t.Errorf("a site is a terminal route of its hosts: %s", compact(r))
	}
	sub := r["handle"].([]any)[0].(map[string]any)
	if sub["handler"] != "subroute" {
		t.Fatalf("static sites are a subroute: %s", compact(sub))
	}
	inner := sub["routes"].([]any)
	if len(inner) != 4 {
		t.Fatalf("want headers, immutable, try_files, file_server: %s", compact(inner))
	}
	for i, want := range []string{
		`{"handler":"headers","response":{"set":{"X-Content-Type-Options":["nosniff"],"X-Frame-Options":["DENY"]}}}`,
		`"match":[{"path":["/_next/static/*"]}]`,
		`"try_files":["{http.request.uri.path}","{http.request.uri.path}.html","{http.request.uri.path}/"]`,
		`{"handler":"file_server","index_names":["index.html"],"root":"/srv/www"}`,
	} {
		if got := compact(inner[i]); !strings.Contains(got, want) {
			t.Errorf("inner route %d: want %s in %s", i, want, got)
		}
	}
	if got := compact(inner[1]); !strings.Contains(got, `"Cache-Control":["public, max-age=31536000, immutable"]`) {
		t.Errorf("immutable cache control missing: %s", got)
	}
	if got := compact(inner[2]); !strings.Contains(got, `"uri":"{http.matchers.file.relative}"`) || !strings.Contains(got, `"root":"/srv/www"`) {
		t.Errorf("try_files rewrite missing: %s", got)
	}
	// The 404 page is served from the error routes, which keeps the status.
	errs := compact(srv["errors"])
	for _, want := range []string{`"host":["www.example.com"]`, `{http.error.status_code} == 404`, `"uri":"/404.html"`, `"handler":"file_server"`, `"X-Frame-Options":["DENY"]`} {
		if !strings.Contains(errs, want) {
			t.Errorf("error routes: want %s in %s", want, errs)
		}
	}
}

func TestStaticSiteWithoutNotFoundOrExtrasHasNoErrorRoutesNorExtraRoutes(t *testing.T) {
	s := config.Site{Hosts: []string{"a.example.com"}, Root: "/srv/a", Index: "index.html", TryFiles: config.DefaultTryFiles}
	srv := server(t, config.Proxy{Sites: []config.Site{s}}, nil)
	if _, ok := srv["errors"]; ok {
		t.Errorf("no not_found, no error routes: %s", compact(srv))
	}
	inner := srv["routes"].([]any)[0].(map[string]any)["handle"].([]any)[0].(map[string]any)["routes"].([]any)
	if len(inner) != 2 {
		t.Errorf("only try_files and file_server expected: %s", compact(inner))
	}
}

func TestUpstreamSiteRoute(t *testing.T) {
	s := config.Site{Hosts: []string{"keelson.example.com"}, Upstream: "127.0.0.1:3100", Headers: map[string]string{"X-Robots-Tag": "noindex"}}
	srv := server(t, config.Proxy{Sites: []config.Site{s}}, nil)
	got := compact(srv["routes"])
	want := `[{"handle":[{"handler":"headers","response":{"set":{"X-Robots-Tag":["noindex"]}}},{"handler":"reverse_proxy","upstreams":[{"dial":"127.0.0.1:3100"}]}],"match":[{"host":["keelson.example.com"]}],"terminal":true}]`
	if got != want {
		t.Errorf("got %s\nwant %s", got, want)
	}
}

func TestRedirectSiteRoute(t *testing.T) {
	s := config.Site{Hosts: []string{"example.com", "www.example.org"}, Redirect: &config.SiteRedirect{To: "https://www.example.com{uri}", Code: 308}}
	srv := server(t, config.Proxy{Sites: []config.Site{s}}, nil)
	got := compact(srv["routes"])
	want := `[{"handle":[{"handler":"static_response","headers":{"Location":["https://www.example.com{http.request.uri}"]},"status_code":308}],"match":[{"host":["example.com","www.example.org"]}],"terminal":true}]`
	if got != want {
		t.Errorf("got %s\nwant %s", got, want)
	}
	for in, out := range map[string]string{
		"https://x{path}?{query}": "https://x{http.request.uri.path}?{http.request.uri.query}",
		"https://{host}/x":        "https://{http.request.host}/x",
	} {
		if got := redirectTarget(in); got != out {
			t.Errorf("redirectTarget(%q) = %q", in, got)
		}
	}
}

func TestSitesAndAppsShareOneSortedRouteList(t *testing.T) {
	settings := config.Proxy{Sites: []config.Site{
		{Hosts: []string{"z.example.com"}, Upstream: "127.0.0.1:9"},
		staticSite(),
		{Hosts: []string{"b.example.com"}, Redirect: &config.SiteRedirect{To: "https://x.example.com", Code: 301}},
	}}
	apps := []Route{{Hosts: []string{"m.example.com"}, Upstream: "127.0.0.1:1"}, {Hosts: []string{"a.example.com"}, Upstream: "127.0.0.1:2"}}
	var hosts []string
	for _, r := range server(t, settings, apps)["routes"].([]any) {
		hosts = append(hosts, r.(map[string]any)["match"].([]any)[0].(map[string]any)["host"].([]any)[0].(string))
	}
	if got := strings.Join(hosts, " "); got != "a.example.com b.example.com m.example.com www.example.com z.example.com" {
		t.Errorf("routes must be sorted by host across apps and sites: %s", got)
	}

	first, _ := json.Marshal(BuildConfig(settings, apps))
	for range 20 {
		again, _ := json.Marshal(BuildConfig(settings, apps))
		if string(first) != string(again) {
			t.Fatal("equal inputs must give identical configuration, headers maps included")
		}
	}
	if settings.Sites[0].Hosts[0] != "z.example.com" {
		t.Error("the caller's sites must not be reordered")
	}
}

func TestTrustedProxiesSetTheServerAndTheForwardedFor(t *testing.T) {
	settings := config.Proxy{
		TrustedProxies: []string{"173.245.48.0/20", "2400:cb00::/32"},
		ClientIPHeader: "CF-Connecting-IP",
		Sites:          []config.Site{{Hosts: []string{"keelson.example.com"}, Upstream: "127.0.0.1:3100"}},
	}
	srv := server(t, settings, []Route{{Hosts: []string{"a.example.com"}, Upstream: "127.0.0.1:1"}})
	if got := compact(srv["trusted_proxies"]); got != `{"ranges":["173.245.48.0/20","2400:cb00::/32"],"source":"static"}` {
		t.Errorf("trusted_proxies = %s", got)
	}
	if got := compact(srv["client_ip_headers"]); got != `["CF-Connecting-IP"]` {
		t.Errorf("client_ip_headers = %s", got)
	}
	const xff = `"headers":{"request":{"set":{"X-Forwarded-For":["{http.vars.client_ip}"]}}}`
	for _, r := range srv["routes"].([]any) {
		if got := compact(r); !strings.Contains(got, xff) {
			t.Errorf("every reverse proxy must overwrite X-Forwarded-For with the client address: %s", got)
		}
	}

	settings.ClientIPHeader = ""
	srv = server(t, settings, nil)
	if _, ok := srv["client_ip_headers"]; ok {
		t.Errorf("no client_ip_header, no client_ip_headers: %s", compact(srv))
	}
	srv = server(t, config.Proxy{Sites: settings.Sites}, nil)
	if _, ok := srv["trusted_proxies"]; ok || strings.Contains(compact(srv), "X-Forwarded-For") {
		t.Errorf("without trusted proxies Caddy's defaults stand: %s", compact(srv))
	}
}

func TestApplyPostsSitesWithTheApps(t *testing.T) {
	var body []byte
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { body, _ = io.ReadAll(r.Body) }))
	defer srv.Close()
	c := New(config.Proxy{Admin: srv.URL, Sites: []config.Site{{Hosts: []string{"s.example.com"}, Upstream: "127.0.0.1:3100"}}})
	// Even with no app at all, the sites are applied: they are part of the same configuration.
	if err := c.Apply(context.Background(), nil); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(body), "127.0.0.1:3100") || !strings.Contains(string(body), "s.example.com") {
		t.Errorf("the sites must be in the applied configuration: %s", body)
	}
}

func TestCaddyInspectCoversSitesTrustedProxiesAndErrorRoutes(t *testing.T) {
	settings := config.Proxy{
		TrustedProxies: []string{"10.0.0.0/8"},
		Sites:          []config.Site{staticSite()},
	}
	serving := caddyServer(settings, inspectRoutes)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		s := map[string]any{"listen": []any{":443"}}
		for k, v := range serving {
			s[k] = v
		}
		json.NewEncoder(w).Encode(s)
	}))
	defer srv.Close()
	settings.Admin = srv.URL
	c := New(settings)

	if got := c.Inspect(context.Background(), inspectRoutes); got.InSync == nil || !*got.InSync {
		t.Fatalf("what Caddy serves is what is generated: %+v", got)
	}
	if got := c.Inspect(context.Background(), inspectRoutes); !strings.Contains(got.Generated, "www.example.com") {
		t.Errorf("the generated routes list the sites: %s", got.Generated)
	}
	for name, mutate := range map[string]func(map[string]any){
		"site missing":         func(m map[string]any) { m["routes"] = caddyRoutes(config.Proxy{}, inspectRoutes) },
		"trusted proxies gone": func(m map[string]any) { delete(m, "trusted_proxies") },
		"error routes gone":    func(m map[string]any) { delete(m, "errors") },
	} {
		serving = caddyServer(settings, inspectRoutes)
		mutate(serving)
		if got := c.Inspect(context.Background(), inspectRoutes); got.InSync == nil || *got.InSync {
			t.Errorf("%s must be reported as different: %+v", name, got)
		}
	}
}
