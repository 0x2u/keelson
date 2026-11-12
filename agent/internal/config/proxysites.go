package config

import (
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
)

// Site is something the Caddy proxy serves that is not an app: a directory of static files, a fixed upstream or a
// redirect. It is part of the one configuration the agent applies, so it survives every deployment.
type Site struct {
	// Hosts are the public host names. Unique across apps and sites.
	Hosts []string `yaml:"hosts"`

	// Root serves static files from this absolute path (as Caddy sees it).
	Root string `yaml:"root"`
	// NotFound is a file under root served with status 404 for everything that is not found.
	NotFound string `yaml:"not_found"`
	// Immutable are path globs answered with a one-year immutable Cache-Control, such as "/_next/static/*".
	Immutable []string `yaml:"immutable"`
	// TryFiles are tried in order for a request path; "{path}" stands for the request path. Default
	// {path} {path}.html {path}/ and then 404.
	TryFiles []string `yaml:"try_files"`
	// Index is the file served for a directory. Default index.html.
	Index string `yaml:"index"`

	// Upstream is a fixed "host:port" reverse proxy target.
	Upstream string `yaml:"upstream"`

	// Redirect answers every request with a redirect.
	Redirect *SiteRedirect `yaml:"redirect"`

	// Headers are added to every response (root and upstream sites).
	Headers map[string]string `yaml:"headers"`
}

// SiteRedirect is a redirect site.
type SiteRedirect struct {
	// To is the target URL; {uri}, {path}, {query} and {host} stand for parts of the request.
	To string `yaml:"to"`
	// Code is the HTTP status, default 301.
	Code int `yaml:"code"`
}

// Kinds of site.
const (
	SiteStatic       = "static"
	SiteUpstream     = "upstream"
	SiteRedirectKind = "redirect"
)

// Kind tells which of root, upstream and redirect the site uses ("" when none or several).
func (s Site) Kind() string {
	switch {
	case s.Root != "" && s.Upstream == "" && s.Redirect == nil:
		return SiteStatic
	case s.Upstream != "" && s.Root == "" && s.Redirect == nil:
		return SiteUpstream
	case s.Redirect != nil && s.Root == "" && s.Upstream == "":
		return SiteRedirectKind
	}
	return ""
}

// Defaults of a static site.
const (
	DefaultSiteIndex = "index.html"
	// ImmutableCacheControl is what immutable globs are answered with.
	ImmutableCacheControl = "public, max-age=31536000, immutable"
	maxSites              = 100
)

// DefaultTryFiles are tried in order for a request path before answering 404.
var DefaultTryFiles = []string{"{path}", "{path}.html", "{path}/"}

var (
	redirectPlaceholder = regexp.MustCompile(`\{(uri|path|query|host)\}`)
	// redirectCodes are the statuses that carry a Location.
	redirectCodes = map[int]bool{301: true, 302: true, 303: true, 307: true, 308: true}
	// fileNamePattern is a path relative to a static root: no leading slash, no "..", no spaces or braces.
	relPathPattern = regexp.MustCompile(`^[A-Za-z0-9._~@%+=,-]+(/[A-Za-z0-9._~@%+=,-]+)*$`)
)

// Certificate is a certificate chain and its private key, as files Caddy reads (PEM).
type Certificate struct {
	CertFile string `yaml:"cert_file"`
	KeyFile  string `yaml:"key_file"`
}

// siteIssues validates proxy.sites, trusted_proxies and client_ip_header of a Caddy proxy, one issue per site.
func (c *Config) siteIssues() []Issue {
	p := c.Proxy
	var out []Issue
	at := func(path string, err error) {
		out = append(out, Issue{Severity: SeverityError, Path: path, Message: err.Error()})
	}
	if err := validateTrustedProxies(p); err != nil {
		at("proxy", err)
	}
	if p.AccessLog != "" && !filepath.IsAbs(p.AccessLog) {
		at("proxy", errors.New("proxy access_log must be an absolute path, as Caddy sees it"))
	}
	for i, cert := range p.Certificates {
		if !filepath.IsAbs(cert.CertFile) || !filepath.IsAbs(cert.KeyFile) {
			at("proxy.certificates["+strconv.Itoa(i)+"]", errors.New("proxy certificate: cert_file and key_file are required absolute paths, as Caddy sees them"))
		}
	}
	if len(p.Sites) > maxSites {
		at("proxy", fmt.Errorf("at most %d sites", maxSites))
		return out
	}
	owner := map[string]string{}
	for _, a := range c.Apps {
		for _, d := range a.Domains {
			owner[d] = "app " + strconv.Quote(a.Name)
		}
	}
	for i := range p.Sites {
		s := &p.Sites[i]
		label := "site " + strconv.Itoa(i)
		if err := validateSite(s, owner, label); err != nil {
			at("proxy.sites["+strconv.Itoa(i)+"]", fmt.Errorf("proxy %s: %w", label, err))
		}
	}
	return out
}

func validateTrustedProxies(p *Proxy) error {
	for i, r := range p.TrustedProxies {
		r = strings.TrimSpace(r)
		if _, _, err := net.ParseCIDR(r); err != nil && net.ParseIP(r) == nil {
			return fmt.Errorf("trusted_proxies entry %q must be a CIDR range or an IP address", r)
		}
		p.TrustedProxies[i] = r
	}
	if h := p.ClientIPHeader; h != "" {
		if len(p.TrustedProxies) == 0 {
			return errors.New("client_ip_header needs trusted_proxies: the header is only believed when it comes from one of them")
		}
		if !validHeaderName(h) {
			return fmt.Errorf("client_ip_header %q is not a valid header name", h)
		}
	}
	return nil
}

// validateSite checks one site and fills its defaults. owner maps the hosts taken so far to who has them.
func validateSite(s *Site, owner map[string]string, label string) error {
	if len(s.Hosts) == 0 {
		return errors.New("hosts is required")
	}
	for i, h := range s.Hosts {
		h = strings.ToLower(strings.TrimSpace(h))
		if len(h) > 253 || !domainPattern.MatchString(h) {
			return fmt.Errorf("host %q is not a valid hostname", s.Hosts[i])
		}
		if other, dup := owner[h]; dup {
			return fmt.Errorf("host %q is already used by %s", h, other)
		}
		owner[h] = label
		s.Hosts[i] = h
	}

	kinds := 0
	for _, set := range []bool{s.Root != "", s.Upstream != "", s.Redirect != nil} {
		if set {
			kinds++
		}
	}
	if kinds != 1 {
		return errors.New("exactly one of root, upstream and redirect is required")
	}

	staticOnly := s.NotFound != "" || len(s.Immutable) > 0 || len(s.TryFiles) > 0 || s.Index != ""
	if err := validateSiteHeaders(s.Headers); err != nil {
		return err
	}
	switch s.Kind() {
	case SiteStatic:
		return validateStaticSite(s)
	case SiteUpstream:
		if staticOnly {
			return errors.New("not_found, immutable, try_files and index only apply to a root site")
		}
		host, port, err := net.SplitHostPort(s.Upstream)
		if n, perr := strconv.Atoi(port); err != nil || host == "" || perr != nil || n < 1 || n > 65535 || strings.ContainsAny(host, " /{}") {
			return fmt.Errorf("upstream %q must be host:port", s.Upstream)
		}
	default:
		if staticOnly || len(s.Headers) > 0 {
			return errors.New("not_found, immutable, try_files, index and headers do not apply to a redirect")
		}
		return validateRedirect(s.Redirect)
	}
	return nil
}

func validateStaticSite(s *Site) error {
	if !filepath.IsAbs(s.Root) {
		return fmt.Errorf("root %q must be an absolute path", s.Root)
	}
	s.Root = filepath.Clean(s.Root)
	if s.Index == "" {
		s.Index = DefaultSiteIndex
	}
	if strings.Contains(s.Index, "/") || !relativeFile(s.Index) {
		return fmt.Errorf("index %q must be a file name", s.Index)
	}
	if s.NotFound != "" && !relativeFile(s.NotFound) {
		return fmt.Errorf("not_found %q must be a file path relative to root, such as 404.html", s.NotFound)
	}
	if len(s.TryFiles) == 0 {
		s.TryFiles = append([]string(nil), DefaultTryFiles...)
	}
	for _, t := range s.TryFiles {
		if (!strings.HasPrefix(t, "{path}") && !strings.HasPrefix(t, "/")) || strings.ContainsAny(strings.ReplaceAll(t, "{path}", ""), " {}?#*\\") || strings.Contains(t, "..") {
			return fmt.Errorf("try_files entry %q must be a path starting with {path} or /", t)
		}
	}
	for _, g := range s.Immutable {
		if (!strings.HasPrefix(g, "/") && !strings.HasPrefix(g, "*")) || strings.ContainsAny(g, " {}\"\\") {
			return fmt.Errorf("immutable entry %q must be a path glob such as /_next/static/* or *.png", g)
		}
	}
	return nil
}

var headerNamePattern = regexp.MustCompile("^[!#$%&'*+.^_`|~0-9A-Za-z-]+$")

// relativeFile reports whether s is a plain relative file path: no "." or ".." segment, no spaces or braces.
func relativeFile(s string) bool {
	if !relPathPattern.MatchString(s) {
		return false
	}
	for _, seg := range strings.Split(s, "/") {
		if seg == "." || seg == ".." {
			return false
		}
	}
	return true
}

func validHeaderName(s string) bool { return headerNamePattern.MatchString(s) }

// validHeaderValue accepts visible characters, spaces and tabs: no line breaks or other control characters.
func validHeaderValue(s string) bool {
	for _, r := range s {
		if (r < 0x20 && r != '\t') || r == 0x7f {
			return false
		}
	}
	return true
}

func validateSiteHeaders(h map[string]string) error {
	if len(h) > 50 {
		return errors.New("at most 50 headers")
	}
	for k, v := range h {
		if !validHeaderName(k) {
			return fmt.Errorf("header name %q is not valid", k)
		}
		if !validHeaderValue(v) {
			return fmt.Errorf("value of header %q is not valid", k)
		}
		switch http.CanonicalHeaderKey(k) {
		case "Content-Length", "Transfer-Encoding", "Connection", "Host":
			return fmt.Errorf("header %q cannot be set", k)
		}
	}
	return nil
}

func validateRedirect(r *SiteRedirect) error {
	if r.Code == 0 {
		r.Code = 301
	}
	if !redirectCodes[r.Code] {
		return fmt.Errorf("redirect code %d must be 301, 302, 303, 307 or 308", r.Code)
	}
	if r.To == "" {
		return errors.New("redirect to is required")
	}
	// The placeholders are replaced before the URL is checked, and any other brace is a typo.
	probe := redirectPlaceholder.ReplaceAllString(r.To, "x")
	if strings.ContainsAny(probe, "{}") || strings.ContainsAny(probe, " \r\n") {
		return fmt.Errorf("redirect to %q may only use the placeholders {uri}, {path}, {query} and {host}", r.To)
	}
	u, err := url.Parse(probe)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return fmt.Errorf("redirect to %q must be an absolute http(s) URL", r.To)
	}
	return nil
}
