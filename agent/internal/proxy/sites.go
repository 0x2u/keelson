package proxy

import (
	"sort"
	"strconv"
	"strings"

	"github.com/0x2u/keelson/agent/internal/config"
)

// siteHandlers is the handler chain of one site; nil for a site that is none of the three kinds (validation
// refuses it before it gets here).
func siteHandlers(settings config.Proxy, s config.Site) []any {
	switch s.Kind() {
	case config.SiteStatic:
		return []any{staticHandler(s)}
	case config.SiteUpstream:
		h := []any{}
		if len(s.Headers) > 0 {
			h = append(h, responseHeaders(s.Headers))
		}
		return append(h, reverseProxy(settings, s.Upstream))
	case config.SiteRedirectKind:
		return []any{map[string]any{
			"handler":     "static_response",
			"status_code": s.Redirect.Code,
			"headers":     map[string]any{"Location": []any{redirectTarget(s.Redirect.To)}},
		}}
	}
	return nil
}

// responseHeaders sets headers on every response. Caddy applies them when the response is written, so they also
// reach what a later handler produces.
func responseHeaders(h map[string]string) map[string]any {
	set := make(map[string]any, len(h))
	for k, v := range h {
		set[k] = []any{v}
	}
	return map[string]any{"handler": "headers", "response": map[string]any{"set": set}}
}

var redirectReplacer = strings.NewReplacer(
	"{uri}", "{http.request.uri}",
	"{path}", "{http.request.uri.path}",
	"{query}", "{http.request.uri.query}",
	"{host}", "{http.request.host}",
)

// redirectTarget turns the short placeholders of a redirect into Caddy's.
func redirectTarget(to string) string { return redirectReplacer.Replace(to) }

// staticHandler serves a directory: the site's headers, the immutable cache rule, the try_files rewrite and the
// file server, as one subroute so the site is a single terminal route.
func staticHandler(s config.Site) map[string]any {
	routes := []any{}
	if len(s.Headers) > 0 {
		routes = append(routes, map[string]any{"handle": []any{responseHeaders(s.Headers)}})
	}
	if len(s.Immutable) > 0 {
		routes = append(routes, map[string]any{
			"match":  []any{map[string]any{"path": s.Immutable}},
			"handle": []any{responseHeaders(map[string]string{"Cache-Control": config.ImmutableCacheControl})},
		})
	}
	routes = append(routes,
		map[string]any{
			"match": []any{map[string]any{"file": map[string]any{
				"root":       s.Root,
				"try_files":  tryFiles(s.TryFiles),
				"try_policy": "first_exist",
			}}},
			"handle": []any{map[string]any{"handler": "rewrite", "uri": "{http.matchers.file.relative}"}},
		},
		map[string]any{"handle": []any{fileServer(s)}},
	)
	return map[string]any{"handler": "subroute", "routes": routes}
}

func fileServer(s config.Site) map[string]any {
	return map[string]any{"handler": "file_server", "root": s.Root, "index_names": []any{s.Index}}
}

func tryFiles(in []string) []any {
	out := make([]any, len(in))
	for i, t := range in {
		out[i] = strings.ReplaceAll(t, "{path}", "{http.request.uri.path}")
	}
	return out
}

// siteErrorRoutes serve the not_found page of the static sites that have one. Caddy keeps the status of the
// error (404) when the error route answers with a file.
func siteErrorRoutes(settings config.Proxy) []any {
	var sites []config.Site
	for _, s := range settings.Sites {
		if s.Kind() == config.SiteStatic && s.NotFound != "" {
			sites = append(sites, s)
		}
	}
	sort.Slice(sites, func(i, j int) bool { return sites[i].Hosts[0] < sites[j].Hosts[0] })

	out := make([]any, 0, len(sites))
	for _, s := range sites {
		handle := []any{}
		if len(s.Headers) > 0 {
			handle = append(handle, responseHeaders(s.Headers))
		}
		handle = append(handle,
			map[string]any{"handler": "rewrite", "uri": "/" + s.NotFound},
			fileServer(s),
		)
		out = append(out, map[string]any{
			"match": []any{map[string]any{
				"host":       s.Hosts,
				"expression": "{http.error.status_code} == " + strconv.Itoa(404),
			}},
			"handle":   handle,
			"terminal": true,
		})
	}
	return out
}
