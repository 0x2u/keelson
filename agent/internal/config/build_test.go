package config

import (
	"slices"
	"strings"
	"testing"
	"time"
)

func buildDoc(build string) string {
	return "apps:\n  - name: shop\n    image: ghcr.io/o/shop\n" + build
}

func TestBuildParsesWithDefaults(t *testing.T) {
	c, issues := Parse([]byte(buildDoc("    build: {}\n")))
	if c == nil {
		t.Fatalf("%+v", issues)
	}
	b := c.Apps[0].Build
	if b == nil || b.Dockerfile != "Dockerfile" || b.Context != "." || b.TimeoutFor() != 15*time.Minute || b.MemoryBytes() != 2<<30 ||
		b.CPUCount() != 2 || b.MaxSourceBytes() != 512<<20 || !slices.Equal(b.SourceHosts, []string{"api.github.com", "codeload.github.com"}) {
		t.Fatalf("defaults not applied: %+v", b)
	}
	if b.MemoryBytes() != 2<<30 || b.MaxSourceBytes() != 512<<20 {
		t.Errorf("sizes: %d %d", b.MemoryBytes(), b.MaxSourceBytes())
	}

	c, issues = Parse([]byte(buildDoc(`    build:
      dockerfile: ./docker/App.Dockerfile
      context: services//web/
      target: runner
      args: {NODE_ENV: production, http_proxy: "http://p:3128"}
      timeout: 1h
      memory: 512MiB
      cpus: 0.5
      max_source: 1g
      network: host
      source_hosts: [GHE.example.com, ghe.example.com, codeload.example.com]
`)))
	if c == nil {
		t.Fatalf("%+v", issues)
	}
	b = c.Apps[0].Build
	if b.Dockerfile != "docker/App.Dockerfile" || b.Context != "services/web" || b.Target != "runner" || b.Args["NODE_ENV"] != "production" ||
		b.TimeoutFor() != time.Hour || b.MemoryBytes() != 512<<20 || b.CPUCount() != 0.5 || b.MaxSourceBytes() != 1<<30 || b.Network != BuildNetworkHost ||
		!slices.Equal(b.SourceHosts, []string{"ghe.example.com", "codeload.example.com"}) {
		t.Fatalf("%+v", b)
	}
}

func TestBuildRejectsWhatIsWrong(t *testing.T) {
	cases := map[string]struct{ build, want string }{
		"absolute dockerfile": {"dockerfile: /etc/passwd", "dockerfile must be a relative path"},
		"dockerfile up":       {"dockerfile: ../Dockerfile", "dockerfile must not leave"},
		"dockerfile sneaky":   {"dockerfile: a/../../Dockerfile", "dockerfile must not leave"},
		"dockerfile dot":      {"dockerfile: .", "dockerfile must name a file"},
		"absolute context":    {"context: /srv", "context must be a relative path"},
		"context up":          {"context: ..", "context must not leave"},
		"context backslash":   {`context: 'a\b'`, "context must be a relative path"},
		"bad target":          {"target: '-x'", "target must match"},
		"bad arg key":         {"args: {'1BAD': x}", "arg \"1BAD\" must match"},
		"dashed arg key":      {"args: {'A-B': x}", "arg \"A-B\" must match"},
		"negative timeout":    {"timeout: -1m", "timeout must be between"},
		"long timeout":        {"timeout: 2h", "timeout must be between"},
		"bad memory":          {"memory: lots", "is not a size"},
		"small memory":        {"memory: 8m", "memory must be at least 64m"},
		"cpus too many":       {"cpus: 1000", "cpus must be between"},
		"negative cpus":       {"cpus: -1", "cpus must be between"},
		"unknown network":     {"network: bridge", "network must be empty"},
		"none network":        {"network: none", "network must be empty"},
		"container network":   {"network: 'container:x'", "network must be empty"},
		"network with space":  {"network: 'a b'", "network must be empty"},
		"tiny max_source":     {"max_source: 10k", "max_source must be between"},
		"windows platform":    {"platform: windows/amd64", "platform must be"},
		"arch only platform":  {"platform: amd64", "platform must be"},
		"unsupported arch":    {"platform: linux/s390x", "platform must be"},
		"huge max_source":     {"max_source: 9g", "max_source must be between"},
		"host with scheme":    {"source_hosts: ['https://api.github.com']", "plain host name"},
		"host with port":      {"source_hosts: ['ghe.example.com:8443']", "plain host name"},
		"host with path":      {"source_hosts: ['ghe.example.com/x']", "plain host name"},
		"host ip":             {"source_hosts: ['10.0.0.5']", "plain host name"},
		"host no dot":         {"source_hosts: [localhost]", "plain host name"},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			c, issues := Parse([]byte(buildDoc("    build: {" + tc.build + "}\n")))
			if c != nil {
				t.Fatal("accepted")
			}
			found := false
			for _, is := range issues {
				found = found || (strings.Contains(is.Message, tc.want) && (is.Path == "apps[shop]" || is.Path == "yaml"))
			}
			if !found {
				t.Errorf("want %q at apps[shop], got %+v", tc.want, issues)
			}
		})
	}
}

func TestBuildPlatformIsKeptOrEmpty(t *testing.T) {
	for in, want := range map[string]string{"": "", "platform: linux/amd64": "linux/amd64", "platform: linux/arm64": "linux/arm64"} {
		c, issues := Parse([]byte(buildDoc("    build: {" + in + "}\n")))
		if c == nil {
			t.Fatalf("%q: %+v", in, issues)
		}
		if got := c.Apps[0].Build.Platform; got != want {
			t.Errorf("%q: platform %q, want %q", in, got, want)
		}
	}
}

func TestBuildUnknownKeyIsRefused(t *testing.T) {
	if c, _ := Parse([]byte(buildDoc("    build: {secrets: {a: b}}\n"))); c != nil {
		t.Fatal("a build block takes no secrets: an unknown key must be refused")
	}
}

func TestParseSize(t *testing.T) {
	ok := map[string]int64{"1024": 1024, "1k": 1 << 10, "512m": 512 << 20, "2g": 2 << 30, "2GB": 2 << 30, "2gib": 2 << 30, "64MiB": 64 << 20, "5b": 5}
	for in, want := range ok {
		if got, err := ParseSize(in); err != nil || got != want {
			t.Errorf("%q: %d %v", in, got, err)
		}
	}
	for _, in := range []string{"", "m", "-1m", "1.5g", "2 g", "2t", "2ib", "99999999999999999999g", "9000000000000g"} {
		if _, err := ParseSize(in); err == nil {
			t.Errorf("%q accepted", in)
		}
	}
}

func TestPreviewInstanceInheritsBuildAsACopy(t *testing.T) {
	doc := previewDoc("  - {app: shop, domain: 'pr-{pr}-shop.example.com'}\n")
	doc = strings.Replace(doc, "    domains: [shop.example.com]\n", "    domains: [shop.example.com]\n    build: {args: {A: b}}\n", 1)
	c, issues := Parse([]byte(doc))
	if c == nil {
		t.Fatalf("%+v", issues)
	}
	tpl, _ := c.Previews("shop")
	inst := tpl.Instance(c.Apps[0], 7)
	if inst.Build == nil || inst.Build.Args["A"] != "b" || inst.Image != "ghcr.io/o/shop" {
		t.Fatalf("%+v", inst.Build)
	}
	inst.Build.Args["A"] = "changed"
	inst.Build.SourceHosts[0] = "evil.example.com"
	if c.Apps[0].Build.Args["A"] != "b" || c.Apps[0].Build.SourceHosts[0] != "api.github.com" {
		t.Error("the instance shares the parent's build block")
	}
}

func TestBuildSurvivesAnEntityEditAndKeepsArgsVisible(t *testing.T) {
	doc := []byte(buildDoc("    env: {SECRET: s3cr3t}\n    build: {args: {NODE_ENV: production}}\n"))
	out, err := Redact(doc)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(out), "s3cr3t") || !strings.Contains(string(out), "NODE_ENV: production") {
		t.Errorf("env must be hidden and build args shown:\n%s", out)
	}
	edited, issues, err := SetApp(doc, "shop", map[string]any{
		"name": "shop", "image": "ghcr.io/o/shop", "env": map[string]any{"SECRET": Hidden},
		"build": map[string]any{"target": "runner", "dockerfile": "Dockerfile"},
	})
	if err != nil || len(issues) > 0 {
		t.Fatalf("%v %+v", err, issues)
	}
	c, issues := Parse(edited)
	if c == nil || c.Apps[0].Build == nil || c.Apps[0].Build.Target != "runner" || c.Apps[0].Env["SECRET"] != "s3cr3t" {
		t.Fatalf("%+v\n%s", issues, edited)
	}
	if b, e := strings.Index(string(edited), "build:"), strings.Index(string(edited), "env:"); b < 0 || e < 0 || b > e {
		t.Errorf("build is written after image and before env:\n%s", edited)
	}
}

func TestTheBuildExampleInTheDocsParses(t *testing.T) {
	c, err := Load("../../../docs/examples/build.apps.yaml")
	if err != nil {
		t.Fatal(err)
	}
	shop, ok := c.App("shop")
	if !ok || shop.Build == nil || shop.Build.Target != "runner" || shop.Build.Args["NODE_ENV"] != "production" ||
		shop.Build.TimeoutFor() != 15*time.Minute || shop.Build.MaxSourceBytes() != 512<<20 {
		t.Fatalf("%+v", shop.Build)
	}
	tpl, _ := c.Previews("shop")
	if inst := tpl.Instance(shop, 3); inst.Build == nil || inst.Build.Target != "runner" {
		t.Errorf("the previews inherit the block: %+v", inst.Build)
	}
}

func TestBuildAcceptsANamedNetworkAndTheDatabaseOption(t *testing.T) {
	c, issues := Parse([]byte(buildDoc("    build: {network: keelson, database: true}\n")))
	if c == nil {
		t.Fatalf("%+v", issues)
	}
	if b := c.Apps[0].Build; b.Network != "keelson" || !b.Database {
		t.Fatalf("%+v", b)
	}
	for _, bad := range []string{"none", "bridge", "default", "'container:x'", "'a b'", "'-x'", "../x"} {
		if c, _ := Parse([]byte(buildDoc("    build: {network: " + bad + "}\n"))); c != nil {
			t.Errorf("network %s must be refused", bad)
		}
	}
}

func TestTheBuildNetworkOfAnApp(t *testing.T) {
	build := func(network string, database bool) *Build { return &Build{Network: network, Database: database} }
	cases := []struct {
		name string
		app  App
		want string
	}{
		{"no build block", App{}, ""},
		{"nothing asked: the default bridge", App{Build: build("", false)}, ""},
		{"a network named", App{Build: build("host", false)}, "host"},
		{"the block's own network wins over the database", App{Build: build("custom", true)}, "custom"},
		{"database, app on the default bridge: the managed network", App{Build: build("", true)}, ManagedPostgresNetwork},
		{"database, app on a user-defined network: the managed network", App{Network: "shop-net", Build: build("", true)}, ManagedPostgresNetwork},
		{"database, app on the managed network itself", App{Network: ManagedPostgresNetwork, Build: build("", true)}, ManagedPostgresNetwork},
		{"database, app on the host network: the host network (the URL is on loopback)", App{Network: "host", Build: build("", true)}, BuildNetworkHost},
		{"database, app that cannot join a network: the bridge", App{Network: "none", Build: build("", true)}, ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := tc.app.BuildNetwork(); got != tc.want {
				t.Errorf("BuildNetwork() = %q, want %q", got, tc.want)
			}
		})
	}
}
