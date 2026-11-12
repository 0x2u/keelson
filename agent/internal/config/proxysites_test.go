package config

import (
	"reflect"
	"strings"
	"testing"
)

const goodSites = `proxy:
  trusted_proxies: [173.245.48.0/20, 2400:cb00::/32, 127.0.0.1]
  client_ip_header: CF-Connecting-IP
  sites:
    - hosts: [WWW.Example.com]
      root: /srv/www/
      not_found: 404.html
      headers: {X-Frame-Options: DENY}
      immutable: ["/_next/static/*", "*.png"]
    - hosts: [example.com]
      redirect: {to: "https://www.example.com{uri}"}
    - hosts: [app.example.com]
      upstream: 127.0.0.1:3100
      headers: {X-Robots-Tag: noindex}
apps:
  - {name: web, image: o/web, port: 3000, domains: [web.example.com]}
`

func TestSitesAreValidatedAndGetTheirDefaults(t *testing.T) {
	c, issues := Parse([]byte(goodSites))
	if len(issues) > 0 {
		t.Fatalf("unexpected issues: %+v", issues)
	}
	s := c.Proxy.Sites
	if len(s) != 3 || s[0].Kind() != SiteStatic || s[1].Kind() != SiteRedirectKind || s[2].Kind() != SiteUpstream {
		t.Fatalf("unexpected sites: %+v", s)
	}
	if s[0].Hosts[0] != "www.example.com" || s[0].Root != "/srv/www" || s[0].Index != "index.html" || !reflect.DeepEqual(s[0].TryFiles, DefaultTryFiles) {
		t.Errorf("static defaults not applied: %+v", s[0])
	}
	if s[1].Redirect.Code != 301 {
		t.Errorf("redirect code defaults to 301: %+v", s[1].Redirect)
	}
	if c.Proxy.TrustedProxies[2] != "127.0.0.1" {
		t.Errorf("trusted proxies: %v", c.Proxy.TrustedProxies)
	}
}

func TestSitesWithoutAppsAreValid(t *testing.T) {
	if _, issues := Parse([]byte("proxy:\n  sites:\n    - {hosts: [a.example.com], root: /srv/a}\n")); len(issues) > 0 {
		t.Errorf("a proxy with sites only must be valid: %+v", issues)
	}
}

func TestSiteRulesEachFail(t *testing.T) {
	site := func(s string) string { return "proxy:\n  sites:\n    - " + s + "\n" }
	cases := map[string]struct{ doc, want string }{
		"no hosts":               {site("{root: /srv/a}"), "hosts is required"},
		"bad host":               {site("{hosts: ['a b.com'], root: /srv/a}"), "not a valid hostname"},
		"wildcard host":          {site("{hosts: ['*.example.com'], root: /srv/a}"), "not a valid hostname"},
		"host used by app":       {"proxy:\n  sites:\n    - {hosts: [web.example.com], root: /srv/a}\napps:\n  - {name: web, image: o/web, port: 1, domains: [web.example.com]}\n", `already used by app "web"`},
		"host used by site":      {"proxy:\n  sites:\n    - {hosts: [a.example.com], root: /srv/a}\n    - {hosts: [A.example.com], upstream: '127.0.0.1:1'}\n", "already used by site 0"},
		"host twice in a site":   {site("{hosts: [a.example.com, a.example.com], root: /srv/a}"), "already used by site 0"},
		"no kind":                {site("{hosts: [a.example.com]}"), "exactly one of root"},
		"two kinds":              {site("{hosts: [a.example.com], root: /srv/a, upstream: '127.0.0.1:1'}"), "exactly one of root"},
		"relative root":          {site("{hosts: [a.example.com], root: srv/a}"), "absolute path"},
		"absolute not_found":     {site("{hosts: [a.example.com], root: /srv/a, not_found: /404.html}"), "not_found"},
		"escaping not_found":     {site("{hosts: [a.example.com], root: /srv/a, not_found: ../404.html}"), "not_found"},
		"index with a slash":     {site("{hosts: [a.example.com], root: /srv/a, index: a/b.html}"), "index"},
		"try_files off path":     {site("{hosts: [a.example.com], root: /srv/a, try_files: ['x.html']}"), "try_files"},
		"try_files traversal":    {site("{hosts: [a.example.com], root: /srv/a, try_files: ['/../x']}"), "try_files"},
		"immutable not a glob":   {site("{hosts: [a.example.com], root: /srv/a, immutable: [static]}"), "immutable"},
		"static key on upstream": {site("{hosts: [a.example.com], upstream: '127.0.0.1:1', not_found: 404.html}"), "only apply to a root site"},
		"upstream no port":       {site("{hosts: [a.example.com], upstream: localhost}"), "host:port"},
		"upstream bad port":      {site("{hosts: [a.example.com], upstream: 'localhost:99999'}"), "host:port"},
		"upstream a url":         {site("{hosts: [a.example.com], upstream: 'http://localhost:1'}"), "host:port"},
		"redirect no target":     {site("{hosts: [a.example.com], redirect: {code: 301}}"), "to is required"},
		"redirect relative":      {site("{hosts: [a.example.com], redirect: {to: /x}}"), "absolute http(s) URL"},
		"redirect bad scheme":    {site("{hosts: [a.example.com], redirect: {to: 'ftp://x.example.com'}}"), "absolute http(s) URL"},
		"redirect unknown var":   {site("{hosts: [a.example.com], redirect: {to: 'https://x.example.com{foo}'}}"), "placeholders"},
		"redirect bad code":      {site("{hosts: [a.example.com], redirect: {to: 'https://x.example.com', code: 200}}"), "redirect code"},
		"redirect with headers":  {site("{hosts: [a.example.com], redirect: {to: 'https://x.example.com'}, headers: {A: b}}"), "do not apply to a redirect"},
		"bad header name":        {site("{hosts: [a.example.com], root: /srv/a, headers: {'Bad Name': x}}"), "header name"},
		"header injection":       {site("{hosts: [a.example.com], root: /srv/a, headers: {X-A: \"a\\r\\nSet-Cookie: b\"}}"), "not valid"},
		"forbidden header":       {site("{hosts: [a.example.com], root: /srv/a, headers: {Content-Length: '1'}}"), "cannot be set"},
		"bad trusted proxy":      {"proxy:\n  trusted_proxies: [not-an-ip]\n", "trusted_proxies"},
		"header without proxies": {"proxy:\n  client_ip_header: CF-Connecting-IP\n", "needs trusted_proxies"},
		"bad client ip header":   {"proxy:\n  trusted_proxies: [10.0.0.0/8]\n  client_ip_header: 'Bad Header'\n", "client_ip_header"},
		"access log relative":    {"proxy:\n  access_log: access.log\n", "absolute path"},
		"access log on nginx":    {"proxy: {type: nginx, upstreams_file: /etc/nginx/u.conf, reload: [x], access_log: /var/log/a.log}\n", "only apply to proxy type caddy"},
		"certificate relative":   {"proxy:\n  certificates:\n    - {cert_file: cert.pem, key_file: /etc/ssl/key.pem}\n", "absolute paths"},
		"certificate no key":     {"proxy:\n  certificates:\n    - {cert_file: /etc/ssl/cert.pem}\n", "absolute paths"},
		"certificates on nginx":  {"proxy: {type: nginx, upstreams_file: /etc/nginx/u.conf, reload: [x], certificates: [{cert_file: /a, key_file: /b}]}\n", "only apply to proxy type caddy"},
		"sites with nginx":       {"proxy: {type: nginx, upstreams_file: /etc/nginx/u.conf, reload: [x], sites: [{hosts: [a.example.com], root: /srv/a}]}\n", "only apply to proxy type caddy"},
		"trusted with nginx":     {"proxy: {type: nginx, upstreams_file: /etc/nginx/u.conf, reload: [x], trusted_proxies: [10.0.0.0/8]}\n", "only apply to proxy type caddy"},
	}
	for name, tc := range cases {
		_, issues := Parse([]byte(tc.doc))
		if len(issues) == 0 {
			t.Errorf("%s: want an issue", name)
			continue
		}
		found := false
		for _, is := range issues {
			if strings.Contains(is.Message, tc.want) {
				found = true
			}
		}
		if !found {
			t.Errorf("%s: want a message containing %q, got %+v", name, tc.want, issues)
		}
	}
}

func TestSiteIssuesPointAtTheSiteAndItsLine(t *testing.T) {
	doc := "proxy:\n  sites:\n    - {hosts: [ok.example.com], root: /srv/a}\n    - {hosts: [b.example.com]}\n"
	_, issues := Parse([]byte(doc))
	if len(issues) != 1 || issues[0].Path != "proxy.sites[1]" || issues[0].Line != 4 {
		t.Errorf("want one issue at proxy.sites[1], line 4: %+v", issues)
	}
	_, issues = Parse([]byte("proxy:\n  trusted_proxies: [x]\n"))
	if len(issues) != 1 || issues[0].Path != "proxy" || issues[0].Line != 1 {
		t.Errorf("want one issue at proxy, line 1: %+v", issues)
	}
}

func TestConfigsWithoutSitesKeepTheirProxySettings(t *testing.T) {
	c, issues := Parse([]byte("proxy: {}\napps: []\n"))
	if len(issues) > 0 || len(c.Proxy.Sites) != 0 || len(c.Proxy.TrustedProxies) != 0 {
		t.Errorf("unexpected: %+v %+v", c, issues)
	}
}

func TestTheProxySitesExampleLoads(t *testing.T) {
	c, err := Load("../../../docs/examples/proxy-sites.apps.yaml")
	if err != nil {
		t.Fatal(err)
	}
	kinds := map[string]int{}
	for _, s := range c.Proxy.Sites {
		kinds[s.Kind()]++
	}
	if kinds[SiteStatic] != 2 || kinds[SiteRedirectKind] != 2 || kinds[SiteUpstream] != 1 || len(c.Proxy.TrustedProxies) != 22 || c.Proxy.ClientIPHeader != "CF-Connecting-IP" {
		t.Errorf("unexpected example: %v, %d trusted ranges", kinds, len(c.Proxy.TrustedProxies))
	}
}
