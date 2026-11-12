package config

import (
	"strings"
	"testing"
)

func TestBuildMachineIssues(t *testing.T) {
	builder := "apps:\n  - name: shop-build\n    image: keelson-local/shop\n    build: {only: true}\n"
	for name, tc := range map[string]struct {
		doc  string
		want string // a message fragment; empty: no issue
	}{
		"nothing":            {"apps: []\n", ""},
		"build limits":       {"build_limits: {memory: 4g, cpus: 4, timeout: 30m, host_network: true}\n", ""},
		"a builder app":      {builder, "runs no apps"},
		"an app that serves": {"apps:\n  - name: web\n    image: x\n    publish: ['127.0.0.1:8080:80']\n", "runs no apps"},
		"a job":              {"jobs:\n  - name: j\n    schedule: '* * * * *'\n    host: [sh, -c, id]\n", "runs no jobs"},
		"a proxy":            {"proxy: {}\n", "no reverse proxy"},
		"managed postgres":   {"managed_postgres: {memory: 1g}\n", "no managed PostgreSQL"},
		"notifications":      {"notifications: {name: x}\n", "sends no notifications"},
		"registries":         {"registries: [{host: ghcr.io, username: u, password_file: /p}]\n", "pulls no images"},
		"a database":         {"databases:\n  - {name: d, host: h, database: d, user: u}\n", "no databases"},
	} {
		c, issues := Parse([]byte(tc.doc))
		if c == nil {
			t.Fatalf("%s: does not parse: %+v", name, issues)
		}
		got := BuildMachineIssues(c)
		switch {
		case tc.want == "" && len(got) != 0, tc.want != "" && (len(got) == 0 || !strings.Contains(got[0].Message, tc.want)):
			t.Errorf("%s: want %q, got %+v", name, tc.want, got)
		}
	}
}
