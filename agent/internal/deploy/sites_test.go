package deploy

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/0x2u/keelson/agent/internal/config"
	"github.com/0x2u/keelson/agent/internal/proxy"
)

// fakeCaddy is the admin API of a Caddy that keeps what it was loaded with, and can be restarted: it then
// answers with nothing loaded, as a Caddy with its default configuration does.
type fakeCaddy struct {
	*httptest.Server
	mu     sync.Mutex
	server map[string]any
	loads  int
}

func newFakeCaddy(t *testing.T) *fakeCaddy {
	c := &fakeCaddy{}
	c.Server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c.mu.Lock()
		defer c.mu.Unlock()
		switch {
		case r.Method == http.MethodPost && r.URL.Path == "/load":
			body, _ := io.ReadAll(r.Body)
			var cfg map[string]any
			if err := json.Unmarshal(body, &cfg); err != nil {
				http.Error(w, err.Error(), 400)
				return
			}
			c.server = cfg["apps"].(map[string]any)["http"].(map[string]any)["servers"].(map[string]any)["keelson"].(map[string]any)
			c.loads++
		case r.Method == http.MethodGet && r.URL.Path == "/config/apps/http/servers/keelson" && c.server != nil:
			json.NewEncoder(w).Encode(c.server)
		default:
			http.Error(w, "unknown path", 404)
		}
	}))
	t.Cleanup(c.Close)
	return c
}

func (c *fakeCaddy) restart() {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.server = nil
}

func (c *fakeCaddy) loadCount() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.loads
}

func (c *fakeCaddy) serves() string {
	c.mu.Lock()
	defer c.mu.Unlock()
	b, _ := json.Marshal(c.server)
	return string(b)
}

// withSites gives the harness a real Caddy driver on a fake admin API and sites in its proxy section.
func withSites(h *harness, c *fakeCaddy, sites ...config.Site) {
	settings := config.Proxy{Type: config.ProxyCaddy, Admin: c.URL, Sites: sites}
	cfg := *h.d.config()
	cfg.Proxy = &settings
	h.d.cfg.Store(&cfg)
	h.d.pxMu.Lock()
	h.d.proxy = proxy.New(settings)
	h.d.pxMu.Unlock()
}

var testSites = []config.Site{
	{Hosts: []string{"www.site.example"}, Root: "/srv/site", Index: "index.html", TryFiles: config.DefaultTryFiles, NotFound: "404.html"},
	{Hosts: []string{"site.example"}, Redirect: &config.SiteRedirect{To: "https://www.site.example{uri}", Code: 301}},
	{Hosts: []string{"keelson.site.example"}, Upstream: "127.0.0.1:3100"},
}

func TestReconcileAppliesSitesWithoutAnyApp(t *testing.T) {
	h := newHarness(t)
	h.d.cfg.Store(&config.Config{Proxy: &config.Proxy{}}) // no apps at all
	c := newFakeCaddy(t)
	withSites(h, c, testSites...)

	// What the agent does at startup.
	if err := h.d.Reconcile(context.Background()); err != nil {
		t.Fatal(err)
	}
	if got := c.serves(); !strings.Contains(got, "www.site.example") || !strings.Contains(got, "127.0.0.1:3100") || !strings.Contains(got, "https://www.site.example{http.request.uri}") {
		t.Errorf("sites must be applied even with no app: %s", got)
	}
	if c.loadCount() != 1 {
		t.Errorf("loads = %d, want 1", c.loadCount())
	}
	if err := h.d.Reconcile(context.Background()); err != nil || c.loadCount() != 1 {
		t.Errorf("a proxy that serves the configuration must not be loaded again (loads %d, err %v)", c.loadCount(), err)
	}

	// Caddy restarts with an empty configuration: with zero apps there is no route change to trigger a push, and
	// the sites still come back.
	want := c.serves()
	c.restart()
	if err := h.d.Reconcile(context.Background()); err != nil {
		t.Fatal(err)
	}
	if got := c.serves(); got != want || c.loadCount() != 2 {
		t.Errorf("sites must be restored on a restarted Caddy (loads %d)\n got %s\nwant %s", c.loadCount(), got, want)
	}
}

func TestReconcileRestoresTheConfigurationOfARestartedCaddy(t *testing.T) {
	h := newProxiedHarness(t)
	c := newFakeCaddy(t)
	withSites(h, c, testSites...)
	h.deploy("v1")
	ctx := context.Background()
	before := c.serves()
	if !strings.Contains(before, "keelson.site.example") || !strings.Contains(before, "example.com") {
		t.Fatalf("a deployment applies the app routes and the sites together: %s", before)
	}
	loads := c.loadCount()

	if err := h.d.Reconcile(ctx); err != nil || c.loadCount() != loads {
		t.Fatalf("nothing changed: loads %d -> %d, %v", loads, c.loadCount(), err)
	}

	c.restart() // Caddy comes back with an empty configuration
	if got := c.serves(); got != "null" {
		t.Fatalf("restart must empty the fake: %s", got)
	}
	if err := h.d.Reconcile(ctx); err != nil {
		t.Fatal(err)
	}
	if got := c.serves(); got != before {
		t.Errorf("the reconciler must restore apps and sites\n got %s\nwant %s", got, before)
	}
	if c.loadCount() != loads+1 {
		t.Errorf("loads = %d, want %d", c.loadCount(), loads+1)
	}
}

func TestSitesSurviveADeployment(t *testing.T) {
	h := newProxiedHarness(t)
	c := newFakeCaddy(t)
	withSites(h, c, testSites...)
	h.deploy("v1")
	h.deploy("v2")
	if got := c.serves(); strings.Count(got, "keelson.site.example") != 1 || !strings.Contains(got, "127.0.0.1:") {
		t.Errorf("a deployment must keep the sites in the one configuration: %s", got)
	}
}

func TestReconcileRestoresARestartedCaddyAfterAConfigChangeToo(t *testing.T) {
	h := newHarness(t)
	h.d.cfg.Store(&config.Config{Proxy: &config.Proxy{}})
	c := newFakeCaddy(t)
	withSites(h, c, testSites[2])
	ctx := context.Background()
	if err := h.d.Reconcile(ctx); err != nil {
		t.Fatal(err)
	}
	// A reload that adds a site swaps the driver and forgets what was applied, as Prepare does.
	next := *h.d.config()
	next.Proxy = &config.Proxy{Type: config.ProxyCaddy, Admin: c.URL, Sites: testSites}
	h.d.SetProxyFactory(func(p *config.Proxy) Proxy { return proxy.New(*p) })
	apply, err := h.d.Prepare(h.d.config(), &next)
	if err != nil {
		t.Fatal(err)
	}
	apply()
	if err := h.d.Reconcile(ctx); err != nil {
		t.Fatal(err)
	}
	if got := c.serves(); !strings.Contains(got, "www.site.example") {
		t.Errorf("the new site must be applied: %s", got)
	}
}

func TestProxyViewListsSitesAsRoutesOfKindSite(t *testing.T) {
	h := newProxiedHarness(t)
	c := newFakeCaddy(t)
	withSites(h, c, testSites...)
	h.deploy("v1")

	v, err := h.d.Proxy(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if v.InSync == nil || !*v.InSync {
		t.Errorf("sites must not make the proxy look out of sync: %+v", v.Inspection)
	}
	byHost := map[string]RouteView{}
	for _, r := range v.Routes {
		byHost[r.Domains[0]] = r
	}
	if len(v.Routes) != 4 {
		t.Fatalf("one app and three sites: %+v", v.Routes)
	}
	if r := byHost["example.com"]; r.Kind != RouteApp || r.App != "web" || !r.Running {
		t.Errorf("the app keeps its route: %+v", r)
	}
	for host, want := range map[string]RouteView{
		"www.site.example":     {Kind: RouteSite, SiteKind: config.SiteStatic, Target: "/srv/site"},
		"site.example":         {Kind: RouteSite, SiteKind: config.SiteRedirectKind, Target: "301 https://www.site.example{uri}"},
		"keelson.site.example": {Kind: RouteSite, SiteKind: config.SiteUpstream, Target: "127.0.0.1:3100", Upstream: "127.0.0.1:3100"},
	} {
		got := byHost[host]
		if got.Kind != want.Kind || got.SiteKind != want.SiteKind || got.Target != want.Target || got.Upstream != want.Upstream || got.App != "" || got.Container != "" {
			t.Errorf("%s: got %+v, want %+v", host, got, want)
		}
	}
	// Clients that predate sites read every field of a route: they are always present.
	b, _ := json.Marshal(byHost["site.example"])
	for _, key := range []string{`"app":""`, `"container":""`, `"ref":""`, `"upstream":""`, `"updated_at"`, `"running":false`} {
		if !strings.Contains(string(b), key) {
			t.Errorf("a site route must carry %s: %s", key, b)
		}
	}

	c.restart()
	v, _ = h.d.Proxy(context.Background())
	if v.InSync == nil || *v.InSync {
		t.Errorf("an emptied Caddy is out of sync: %+v", v.Inspection)
	}
}

func TestProxyViewWithOnlySitesIsNotEmpty(t *testing.T) {
	h := newHarness(t)
	h.d.cfg.Store(&config.Config{Proxy: &config.Proxy{}})
	c := newFakeCaddy(t)
	withSites(h, c, testSites[2])
	v, err := h.d.Proxy(context.Background())
	if err != nil || v == nil || len(v.Routes) != 1 || v.Routes[0].Kind != RouteSite {
		t.Errorf("sites show up without any app: %+v %v", v, err)
	}
}
