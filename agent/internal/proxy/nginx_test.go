package proxy

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/0x2u/keelson/agent/internal/config"
)

// cmdLog records the commands the driver runs and fails the chosen ones.
type cmdLog struct {
	calls  []string
	failOn map[string]error
}

func (c *cmdLog) run(_ context.Context, argv []string) error {
	cmd := strings.Join(argv, " ")
	c.calls = append(c.calls, cmd)
	return c.failOn[cmd]
}

func newNginx(t *testing.T) (*Nginx, *cmdLog, string) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "conf.d", "keelson-upstreams.conf")
	log := &cmdLog{failOn: map[string]error{}}
	n := NewNginx(config.Proxy{
		Type: config.ProxyNginx, UpstreamsFile: path,
		Test: []string{"nginx", "-t"}, Reload: []string{"nginx", "-s", "reload"},
	})
	n.run = log.run
	return n, log, path
}

func read(t *testing.T, path string) string {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func TestRenderNginxSortsByAppAndIsDeterministic(t *testing.T) {
	routes := []Route{{App: "web", Upstream: "127.0.0.1:3001"}, {App: "api", Upstream: "127.0.0.1:4000"}}
	got := string(RenderNginx(routes))
	if strings.Index(got, "keelson_api") > strings.Index(got, "keelson_web") {
		t.Errorf("upstreams must be sorted by app:\n%s", got)
	}
	for _, want := range []string{"upstream keelson_web {\n    server 127.0.0.1:3001;\n}", "upstream keelson_api {\n    server 127.0.0.1:4000;\n}"} {
		if !strings.Contains(got, want) {
			t.Errorf("missing %q in:\n%s", want, got)
		}
	}
	if string(RenderNginx(routes)) != got || routes[0].App != "web" {
		t.Error("rendering must be repeatable and must not reorder the caller's slice")
	}
	if empty := string(RenderNginx(nil)); strings.Contains(empty, "upstream") || !strings.HasPrefix(empty, "#") {
		t.Errorf("no routes must render a comment-only file, got %q", empty)
	}
}

func TestNginxApplyWritesTestsThenReloads(t *testing.T) {
	n, log, path := newNginx(t)
	if err := n.Apply(context.Background(), []Route{{App: "web", Upstream: "127.0.0.1:3001"}}); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(read(t, path), "server 127.0.0.1:3001;") {
		t.Error("the upstream file was not written")
	}
	if got := strings.Join(log.calls, " | "); got != "nginx -t | nginx -s reload" {
		t.Errorf("want test then reload, got %s", got)
	}
	if entries, _ := os.ReadDir(filepath.Dir(path)); len(entries) != 1 {
		t.Errorf("no temporary file may be left behind: %v", entries)
	}
}

func TestNginxRejectedConfigurationRestoresTheOldFileAndSkipsReload(t *testing.T) {
	n, log, path := newNginx(t)
	if err := n.Apply(context.Background(), []Route{{App: "web", Upstream: "127.0.0.1:3000"}}); err != nil {
		t.Fatal(err)
	}
	before := read(t, path)
	log.calls = nil
	log.failOn["nginx -t"] = errors.New("syntax error")

	err := n.Apply(context.Background(), []Route{{App: "web", Upstream: "127.0.0.1:3001"}})
	if err == nil || !strings.Contains(err.Error(), "syntax error") {
		t.Fatalf("want the test failure, got %v", err)
	}
	if read(t, path) != before {
		t.Error("the previous file must be restored")
	}
	if got := strings.Join(log.calls, " | "); got != "nginx -t" {
		t.Errorf("a rejected configuration must not be reloaded, got %s", got)
	}
}

func TestNginxReloadFailureRestoresAndReloadsAgain(t *testing.T) {
	n, log, path := newNginx(t)
	n.Apply(context.Background(), []Route{{App: "web", Upstream: "127.0.0.1:3000"}})
	before := read(t, path)
	log.calls = nil
	log.failOn["nginx -s reload"] = errors.New("reload failed")

	if err := n.Apply(context.Background(), []Route{{App: "web", Upstream: "127.0.0.1:3001"}}); err == nil {
		t.Fatal("want the reload failure")
	}
	if read(t, path) != before {
		t.Error("the previous file must be restored")
	}
	if got := strings.Join(log.calls, " | "); got != "nginx -t | nginx -s reload | nginx -s reload" {
		t.Errorf("the restored file must be reloaded too, got %s", got)
	}
}

func TestNginxFailureOnFirstWriteLeavesNoFile(t *testing.T) {
	n, log, path := newNginx(t)
	log.failOn["nginx -t"] = errors.New("bad")
	if err := n.Apply(context.Background(), []Route{{App: "web", Upstream: "127.0.0.1:3000"}}); err == nil {
		t.Fatal("want an error")
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Error("a file that nginx rejected must not stay behind when none existed")
	}
}

func TestNginxReloadsEvenWhenTheFileIsUnchanged(t *testing.T) {
	n, log, _ := newNginx(t)
	routes := []Route{{App: "web", Upstream: "127.0.0.1:3000"}}
	n.Apply(context.Background(), routes)
	log.calls = nil
	if err := n.Apply(context.Background(), routes); err != nil {
		t.Fatal(err)
	}
	if got := strings.Join(log.calls, " | "); got != "nginx -t | nginx -s reload" {
		t.Errorf("a crash between write and reload must be healed by reloading again, got %s", got)
	}
}

func TestRunCommandReportsOutputAndNeedsNoShell(t *testing.T) {
	if err := runCommand(context.Background(), []string{"true"}); err != nil {
		t.Fatal(err)
	}
	err := runCommand(context.Background(), []string{"sh", "-c", "echo broken config >&2; exit 3"})
	if err == nil || !strings.Contains(err.Error(), "broken config") {
		t.Errorf("want the command's output in the error, got %v", err)
	}
	// Arguments are never interpreted by a shell.
	if err := runCommand(context.Background(), []string{"echo", "$(touch /tmp/keelson-injected)"}); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat("/tmp/keelson-injected"); err == nil {
		os.Remove("/tmp/keelson-injected")
		t.Error("shell metacharacters must not be executed")
	}
}

func TestRenderNginxMarksAPlaceholderDown(t *testing.T) {
	got := string(RenderNginx([]Route{
		{App: "web", Upstream: "127.0.0.1:3001"},
		{App: "api", Upstream: "127.0.0.1:4000", Down: true},
	}))
	for _, want := range []string{"upstream keelson_api {\n    server 127.0.0.1:4000 down;\n}", "upstream keelson_web {\n    server 127.0.0.1:3001;\n}"} {
		if !strings.Contains(got, want) {
			t.Errorf("missing %q in:\n%s", want, got)
		}
	}
}
