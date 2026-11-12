package deploy

import (
	"context"
	"sort"
	"strconv"
	"time"

	"github.com/0x2u/keelson/agent/internal/config"
	"github.com/0x2u/keelson/agent/internal/docker"
	"github.com/0x2u/keelson/agent/internal/proxy"
	"github.com/0x2u/keelson/agent/internal/store"
)

// ProxyInspector is implemented by proxy drivers that can show what they generate and what the proxy serves.
type ProxyInspector interface {
	Inspect(ctx context.Context, routes []proxy.Route) proxy.Inspection
}

// Kinds of route.
const (
	RouteApp  = "app"
	RouteSite = "site"
)

// RouteView is one app's or one site's place in the proxy. A site (kind "site") has no app, container, image or
// deployment: it is a directory, a fixed upstream or a redirect of the proxy section. Its container, ref and
// updated_at are empty (zero) and Running is false, so that a client written before sites existed still reads every field.
type RouteView struct {
	// Kind is "app" or "site".
	Kind string `json:"kind"`
	// App is empty for a site.
	App     string   `json:"app"`
	Domains []string `json:"domains"`
	// SiteKind is "static", "upstream" or "redirect" for a site.
	SiteKind string `json:"site_kind,omitempty"`
	// Target is what a site serves: the root directory, or the redirect as "301 https://...".
	Target string `json:"target,omitempty"`
	// Upstream is "host:port", the container the proxy sends the app's traffic to; the fixed upstream of an upstream site.
	Upstream string `json:"upstream"`
	// UpstreamName is the nginx upstream block to point proxy_pass at; empty with Caddy, which routes by host.
	UpstreamName string `json:"upstream_name,omitempty"`
	Container    string `json:"container"`
	// Ref is the image the serving version was deployed from.
	Ref       string    `json:"ref"`
	UpdatedAt time.Time `json:"updated_at"`
	// Running tells whether the serving container is up right now.
	Running bool `json:"running"`
}

// UnroutedApp is an app declared behind the proxy that has no route: it was never deployed, or its container is gone.
type UnroutedApp struct {
	App     string   `json:"app"`
	Domains []string `json:"domains"`
	Reason  string   `json:"reason"`
}

// ProxyView is the read-only answer to "what is exposed, and where does it go".
type ProxyView struct {
	proxy.Inspection
	Routes   []RouteView   `json:"routes"`
	Unrouted []UnroutedApp `json:"unrouted"`
}

// Proxy describes the reverse proxy: every route with the version it serves, what the agent generates for them, and
// whether the proxy serves exactly that. It returns nil when no app is deployed behind a proxy. Nothing is applied.
func (d *Deployer) Proxy(ctx context.Context) (*ProxyView, error) {
	drv := d.proxyDriver()
	if drv == nil {
		return nil, nil
	}
	states, err := d.store.AppStates(ctx)
	if err != nil {
		return nil, err
	}

	byApp := map[string]store.AppState{}
	for _, s := range states {
		byApp[s.App] = s
	}

	view := &ProxyView{Routes: []RouteView{}, Unrouted: []UnroutedApp{}}
	var routes []proxy.Route
	instances, err := d.instances(ctx)
	if err != nil {
		return nil, err
	}
	isInstance := make(map[string]bool, len(instances))
	for _, a := range instances {
		isInstance[a.Name] = true
	}
	for _, a := range append(append([]config.App(nil), d.config().Apps...), instances...) {
		if !a.Proxied() {
			continue
		}
		st, ok := byApp[a.Name]
		if !ok || st.HostPort == 0 {
			// An instance that never came up is not "declared behind the proxy": it is only listed with the previews.
			if isInstance[a.Name] {
				continue
			}
			view.Unrouted = append(view.Unrouted, UnroutedApp{App: a.Name, Domains: nonNil(a.Domains), Reason: "never deployed"})
			continue
		}
		upstream := "127.0.0.1:" + strconv.Itoa(st.HostPort)
		routes = append(routes, proxy.Route{App: a.Name, Hosts: a.Domains, Upstream: upstream})

		rv := RouteView{Kind: RouteApp, App: a.Name, Domains: nonNil(a.Domains), Upstream: upstream, Container: st.Container, Ref: st.Ref, UpdatedAt: st.UpdatedAt}
		det, err := d.eng.Inspect(ctx, st.Container)
		switch {
		case err == nil:
			rv.Running = det.State.Running
		case docker.IsNotFound(err):
			// The container is gone: the reconciler drops the route, and the view says so meanwhile.
		default:
			return nil, err
		}
		view.Routes = append(view.Routes, rv)
	}
	sortRoutes(routes)
	view.Routes = append(view.Routes, d.siteViews()...)

	if in, ok := drv.(ProxyInspector); ok {
		view.Inspection = in.Inspect(ctx, d.withPlaceholders(routes, d.config().Apps))
	}
	if view.Type == config.ProxyNginx {
		for i := range view.Routes {
			view.Routes[i].UpstreamName = proxy.UpstreamName(view.Routes[i].App)
		}
	}
	return view, nil
}

// siteViews lists the sites of the Caddy proxy section, sorted by their first host.
func (d *Deployer) siteViews() []RouteView {
	px := d.config().Proxy
	if px == nil || px.Type == config.ProxyNginx {
		return nil
	}
	out := make([]RouteView, 0, len(px.Sites))
	for _, s := range px.Sites {
		rv := RouteView{Kind: RouteSite, Domains: nonNil(s.Hosts), SiteKind: s.Kind()}
		switch rv.SiteKind {
		case config.SiteStatic:
			rv.Target = s.Root
		case config.SiteUpstream:
			rv.Upstream = s.Upstream
			rv.Target = s.Upstream
		case config.SiteRedirectKind:
			rv.Target = strconv.Itoa(s.Redirect.Code) + " " + s.Redirect.To
		}
		out = append(out, rv)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Domains[0] < out[j].Domains[0] })
	return out
}

func nonNil(s []string) []string {
	if s == nil {
		return []string{}
	}
	return s
}
