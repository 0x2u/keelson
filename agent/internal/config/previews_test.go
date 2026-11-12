package config

import (
	"strings"
	"testing"
	"time"
)

const previewBase = `
proxy: {}
apps:
  - name: shop
    project: store
    image: ghcr.io/o/shop
    env_file: /etc/keelson/shop.env
    env: {STRIPE_KEY: sk_live_secret}
    volumes: ["/srv/shop:/data"]
    command: ["serve", "--fast"]
    stop_timeout: 20
    health_timeout: 2m
    stable_after: 3s
    drain: 1s
    restart: unless-stopped
    domains: [shop.example.com]
    port: 3000
    health_path: /healthz
    log: {driver: local, max_size: 5m, max_file: 2}
    release:
      steps:
        - {name: migrate, run: [migrate]}
`

func previewDoc(previews string) string { return previewBase + "previews:\n" + previews }

func TestPreviewsParseWithDefaults(t *testing.T) {
	c, issues := Parse([]byte(previewDoc("  - {app: shop, domain: 'pr-{pr}-shop.example.com'}\n")))
	if c == nil {
		t.Fatalf("%+v", issues)
	}
	p, ok := c.Previews("shop")
	if !ok || p.TTLFor() != DefaultPreviewTTL || p.MaxCount() != DefaultPreviewMax || p.Domain != "pr-{pr}-shop.example.com" {
		t.Fatalf("defaults not applied: %+v", p)
	}
	if _, ok := c.Previews("other"); ok {
		t.Error("unknown app must have no template")
	}
	if len(c.Apps) != 1 {
		t.Errorf("a template adds no app: %+v", c.Apps)
	}

	c, issues = Parse([]byte(previewDoc("  - {app: shop, domain: 'PR-{pr}-shop.example.com', ttl: 72h, max: 2, env: {A: b}, env_file: /etc/keelson/p.env}\n")))
	if c == nil {
		t.Fatalf("%+v", issues)
	}
	p, _ = c.Previews("shop")
	if p.TTLFor() != 72*time.Hour || p.MaxCount() != 2 || p.Env["A"] != "b" || p.EnvFile != "/etc/keelson/p.env" || p.Domain != "pr-{pr}-shop.example.com" {
		t.Errorf("%+v", p)
	}
}

func TestPreviewsConfigRejectsWhatIsWrong(t *testing.T) {
	ok := "'pr-{pr}-shop.example.com'"
	cases := map[string]struct{ doc, want string }{
		"unknown parent":          {previewDoc("  - {app: nope, domain: " + ok + "}\n"), "not in the apps list"},
		"no app":                  {previewDoc("  - {domain: " + ok + "}\n"), "app must match"},
		"no placeholder":          {previewDoc("  - {app: shop, domain: pr-shop.example.com}\n"), "must contain {pr}"},
		"placeholder in the base": {previewDoc("  - {app: shop, domain: 'shop.{pr}.example.com'}\n"), "first label only"},
		"placeholder twice split": {previewDoc("  - {app: shop, domain: 'pr-{pr}.{pr}.example.com'}\n"), "first label only"},
		"invalid host":            {previewDoc("  - {app: shop, domain: 'pr_{pr}-shop.example.com'}\n"), "not a valid hostname"},
		"label too long":          {previewDoc("  - {app: shop, domain: '" + strings.Repeat("a", 60) + "-{pr}.example.com'}\n"), "not a valid hostname"},
		"single label":            {previewDoc("  - {app: shop, domain: 'pr-{pr}'}\n"), "not a valid hostname"},
		"duplicate app":           {previewDoc("  - {app: shop, domain: " + ok + "}\n  - {app: shop, domain: 'x-{pr}.example.com'}\n"), "duplicate entry"},
		"negative ttl":            {previewDoc("  - {app: shop, domain: " + ok + ", ttl: -1h}\n"), "ttl must be at least"},
		"tiny ttl":                {previewDoc("  - {app: shop, domain: " + ok + ", ttl: 5s}\n"), "ttl must be at least"},
		"negative max":            {previewDoc("  - {app: shop, domain: " + ok + ", max: -1}\n"), "max must be between"},
		"huge max":                {previewDoc("  - {app: shop, domain: " + ok + ", max: 101}\n"), "max must be between"},
		"unknown field":           {previewDoc("  - {app: shop, domain: " + ok + ", volumes: [a:b]}\n"), `unknown key "volumes"`},
		"domain of an app": {strings.Replace(previewBase, "domains: [shop.example.com]", "domains: [shop.example.com, pr-12-shop.example.com]", 1) +
			"previews:\n  - {app: shop, domain: " + ok + "}\n", "belongs to the app"},
		"app named like an instance": {previewBase + "  - {name: shop-pr-7, image: ghcr.io/o/x}\npreviews:\n  - {app: shop, domain: " + ok + "}\n", "name of an instance"},
		"parent with host_ports": {`
proxy: {}
apps:
  - {name: shop, image: ghcr.io/o/shop, network: host, host_ports: [3000, 3001]}
previews:
  - {app: shop, domain: 'pr-{pr}-shop.example.com'}
`, "host_ports"},
		"parent not proxied": {`
proxy: {}
apps:
  - {name: shop, image: ghcr.io/o/shop}
previews:
  - {app: shop, domain: 'pr-{pr}-shop.example.com'}
`, "not proxied"},
		"nginx": {`
proxy: {type: nginx, upstreams_file: /etc/nginx/k.conf, reload: [nginx, -s, reload]}
apps:
  - {name: shop, image: ghcr.io/o/shop, port: 3000}
previews:
  - {app: shop, domain: 'pr-{pr}-shop.example.com'}
`, "proxy type caddy"},
		"same pattern twice": {previewBase + "  - {name: blog, image: ghcr.io/o/blog, port: 80, domains: [blog.example.com]}\npreviews:\n  - {app: shop, domain: 'pr-{pr}-x.example.com'}\n  - {app: blog, domain: 'pr-{pr}-x.example.com'}\n", "also the pattern"},
		"long parent name": {`
proxy: {}
apps:
  - {name: ` + strings.Repeat("a", 54) + `, image: ghcr.io/o/shop, port: 3000, domains: [a.example.com]}
previews:
  - {app: ` + strings.Repeat("a", 54) + `, domain: 'pr-{pr}-shop.example.com'}
`, "too long"},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			c, issues := Parse([]byte(tc.doc))
			if c != nil {
				t.Fatal("must be refused")
			}
			found := false
			for _, is := range issues {
				if strings.Contains(is.Message, tc.want) {
					found = true
				}
			}
			if !found {
				t.Errorf("want an issue mentioning %q, got %+v", tc.want, issues)
			}
		})
	}
}

func TestPreviewIssueCarriesItsPathAndLine(t *testing.T) {
	_, issues := Parse([]byte(previewDoc("  - {app: nope, domain: 'pr-{pr}-shop.example.com'}\n")))
	if errs := errorsOnly(issues); len(errs) != 1 || errs[0].Path != "previews[nope]" || errs[0].Line == 0 {
		t.Fatalf("%+v", issues)
	}
}

func TestPreviewInstanceInheritsOnlyTheRuntimeSettings(t *testing.T) {
	c, issues := Parse([]byte(previewDoc("  - {app: shop, domain: 'pr-{pr}-shop.example.com', env: {NODE_ENV: production}, env_file: /etc/keelson/p.env}\n")))
	if c == nil {
		t.Fatalf("%+v", issues)
	}
	parent, _ := c.App("shop")
	tpl, _ := c.Previews("shop")
	inst := tpl.Instance(parent, 12)

	if inst.Name != "shop-pr-12" || inst.Project != "store" || inst.Stage != "pr-12" || inst.Image != "ghcr.io/o/shop" {
		t.Errorf("identity: %+v", inst)
	}
	if len(inst.Domains) != 1 || inst.Domains[0] != "pr-12-shop.example.com" || inst.ContainerPort != 3000 {
		t.Errorf("routing: %+v", inst)
	}
	if inst.HealthPath != "/healthz" || inst.Stop() != 20*time.Second || inst.HealthWait() != 2*time.Minute || inst.StableWait() != 3*time.Second ||
		inst.Restart != "unless-stopped" || len(inst.Command) != 2 || inst.Log == nil || inst.Log.Driver != "local" || inst.Drain == nil || inst.Drain.Std() != time.Second {
		t.Errorf("inherited settings: %+v", inst)
	}
	if inst.EnvFile != "/etc/keelson/p.env" || len(inst.Env) != 1 || inst.Env["NODE_ENV"] != "production" {
		t.Errorf("the environment is the template's own: %+v", inst)
	}
	if len(inst.Volumes) != 0 || inst.Release != nil || len(inst.Publish) != 0 || len(inst.HostPorts) != 0 {
		t.Errorf("volumes, release steps and ports must not be inherited: %+v", inst)
	}
	if !inst.Proxied() {
		t.Error("an instance is proxied")
	}
	// The copy must not alias the parent's or the template's values.
	inst.Env["X"] = "1"
	inst.Command[0] = "x"
	inst.Log.Driver = "x"
	*inst.Drain = Duration(time.Hour)
	if _, leaked := tpl.Env["X"]; leaked || parent.Command[0] != "serve" || parent.Log.Driver != "local" || parent.Drain.Std() != time.Second {
		t.Error("an instance must own its copies")
	}

	// Without a template env the instance has none: the parent's secrets stay behind.
	bare := Previews{Domain: "pr-{pr}-shop.example.com"}.Instance(parent, 3)
	if bare.EnvFile != "" || len(bare.Env) != 0 {
		t.Errorf("parent environment inherited: %+v", bare)
	}
	if env, err := bare.Environment(); err != nil || len(env) != 0 {
		t.Errorf("%v %v", env, err)
	}
	parent.Project = ""
	if got := tpl.Instance(parent, 1).Project; got != "shop" {
		t.Errorf("a parent without a project gives its name: %q", got)
	}
}

func TestPreviewNames(t *testing.T) {
	if PreviewName("shop", 12) != "shop-pr-12" {
		t.Error("name")
	}
	for name, want := range map[string]struct {
		app string
		pr  int
		ok  bool
	}{
		"shop-pr-12":                 {"shop", 12, true},
		"my-pr-app-pr-3":             {"my-pr-app", 3, true},
		"shop-pr-0":                  {"", 0, false},
		"shop-pr-012":                {"", 0, false},
		"shop-pr-1000000":            {"", 0, false},
		"shop-pr-x":                  {"", 0, false},
		"-pr-5":                      {"", 0, false},
		"shop":                       {"", 0, false},
		"shop-pr-5-abcdef0123456789": {"", 0, false},
	} {
		app, pr, ok := ParsePreviewName(name)
		if app != want.app || pr != want.pr || ok != want.ok {
			t.Errorf("%s: got %q %d %v", name, app, pr, ok)
		}
	}
	if !ValidPreviewNumber(1) || !ValidPreviewNumber(999999) || ValidPreviewNumber(0) || ValidPreviewNumber(1000000) {
		t.Error("bounds")
	}
}

func TestSetAndDeletePreview(t *testing.T) {
	b := Bundle{Main: []byte(previewBase)}
	pv := map[string]any{"app": "shop", "domain": "pr-{pr}-shop.example.com", "max": 3, "env": map[string]any{"A": "b"}, "ttl": "24h"}
	issues, err := b.SetPreview("shop", pv)
	if err != nil || len(issues) != 0 {
		t.Fatalf("%v %+v", err, issues)
	}
	out := b.Main
	c, iss := Parse(out)
	if c == nil {
		t.Fatalf("%+v\n%s", iss, out)
	}
	if p, ok := c.Previews("shop"); !ok || p.MaxCount() != 3 || p.TTLFor() != 24*time.Hour {
		t.Errorf("%+v\n%s", p, out)
	}
	if strings.Contains(string(out), "app: shop") {
		t.Errorf("the template is a key of its app, with no app key:\n%s", out)
	}
	if i, j := strings.Index(string(out), "domain:"), strings.Index(string(out), "ttl:"); i < 0 || j < i {
		t.Errorf("keys are in a tidy order:\n%s", out)
	}
	if _, err := b.SetPreview("other", pv); err == nil {
		t.Error("an app that is not in the document has no previews")
	}
	// Replacing keeps one entry.
	pv["max"] = 4
	if _, err = b.SetPreview("shop", pv); err != nil || strings.Count(string(b.Main), "previews:") != 1 {
		t.Fatalf("%v\n%s", err, b.Main)
	}

	if err = b.DeletePreview("shop"); err != nil || strings.Contains(string(b.Main), "previews:") {
		t.Fatalf("%v\n%s", err, b.Main)
	}
	if err := b.DeletePreview("shop"); err == nil {
		t.Error("deleting what is not there is an error")
	}
}

func TestPreviewEnvValuesAreSecrets(t *testing.T) {
	doc := previewDoc("  - app: shop\n    domain: 'pr-{pr}-shop.example.com'\n    env:\n      TOKEN: preview-secret-value\n")
	red, err := Redact([]byte(doc))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(red), "preview-secret-value") || !strings.Contains(string(red), Hidden) {
		t.Fatalf("a preview env value must be hidden:\n%s", red)
	}
	if strings.Contains(string(red), "sk_live_secret") {
		t.Fatalf("the parent's secret must be hidden too:\n%s", red)
	}
	back, issues := Restore(red, []byte(doc))
	c, parsed := Parse(back)
	if len(issues) != 0 || c == nil {
		t.Fatalf("%+v %+v\n%s", issues, parsed, back)
	}
	if p, _ := c.Previews("shop"); p.Env["TOKEN"] != "preview-secret-value" {
		t.Errorf("the stored value comes back: %+v", p.Env)
	}
}

func TestThePreviewsExampleInTheDocsParses(t *testing.T) {
	c, err := Load("../../../docs/examples/previews.apps.yaml")
	if err != nil {
		t.Fatal(err)
	}
	if p, ok := c.Previews("shop"); !ok || p.TTLFor() != 72*time.Hour || p.MaxCount() != 5 {
		t.Errorf("%+v", p)
	}
}

func TestTheDevEnvironmentExampleInTheDocsParses(t *testing.T) {
	c, err := Load("../../../docs/examples/dev-environment.apps.yaml")
	if err != nil {
		t.Fatal(err)
	}
	dev, ok := c.App("shop-dev")
	if !ok || dev.Stage != "dev" || dev.Project != "shop" || dev.HealthWait() != 5*time.Minute {
		t.Errorf("%+v", dev)
	}
}

func TestAnInstanceNamesItsParentButTheFileCannotSetIt(t *testing.T) {
	parent := App{Name: "web", Image: "o/web", ContainerPort: 3000}
	inst := Previews{Domain: "pr-{pr}.example.com"}.Instance(parent, 7)
	if inst.Parent != "web" || parent.Parent != "" {
		t.Errorf("%q %q", inst.Parent, parent.Parent)
	}
	_, issues := Parse([]byte("apps:\n  - {name: web, image: o/web, parent: other}\n"))
	if len(issues) == 0 {
		t.Error("parent is not a key of the apps file")
	}
}
