package proxy

import (
	"bytes"
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/0x2u/keelson/agent/internal/config"
)

const commandTimeout = 30 * time.Second

// Nginx switches traffic by rewriting one file of upstream blocks and
// reloading nginx. The server blocks (hosts, TLS, headers) stay the operator's
// own: they only point proxy_pass at "keelson_<app>".
//
// A reload starts new workers on the new configuration and lets the old ones
// finish their requests, so a switch drops no connection.
type Nginx struct {
	settings config.Proxy
	run      func(ctx context.Context, argv []string) error
}

// NewNginx returns a driver for the nginx described by settings.
func NewNginx(settings config.Proxy) *Nginx {
	return &Nginx{settings: settings, run: runCommand}
}

// UpstreamName is the name of the upstream block of an app.
func UpstreamName(app string) string { return "keelson_" + app }

// RenderNginx returns the content of the upstreams file for routes, sorted by
// app so equal inputs give identical bytes.
func RenderNginx(routes []Route) []byte {
	sorted := append([]Route(nil), routes...)
	sort.Slice(sorted, func(i, j int) bool { return sorted[i].App < sorted[j].App })

	var b bytes.Buffer
	b.WriteString("# Managed by keelson-agent. Changes are overwritten.\n")
	for _, r := range sorted {
		down := ""
		if r.Down {
			down = " down"
		}
		fmt.Fprintf(&b, "\nupstream %s {\n    server %s%s;\n}\n", UpstreamName(r.App), r.Upstream, down)
	}
	return b.Bytes()
}

// Apply writes the upstreams file and reloads nginx. If the optional test
// command or the reload fails, the previous file is put back, so a bad switch
// never leaves nginx with a configuration it cannot load.
func (n *Nginx) Apply(ctx context.Context, routes []Route) error {
	path := n.settings.UpstreamsFile
	old, err := os.ReadFile(path)
	existed := err == nil
	if err != nil && !os.IsNotExist(err) {
		return err
	}

	if err := writeAtomic(path, RenderNginx(routes)); err != nil {
		return err
	}
	restore := func() {
		if existed {
			_ = writeAtomic(path, old)
		} else {
			_ = os.Remove(path)
		}
	}

	if len(n.settings.Test) > 0 {
		if err := n.run(ctx, n.settings.Test); err != nil {
			restore()
			return fmt.Errorf("nginx rejected the configuration: %w", err)
		}
	}
	// The reload runs even when the file is unchanged: a previous run may have
	// died between writing the file and reloading.
	if err := n.run(ctx, n.settings.Reload); err != nil {
		restore()
		_ = n.run(ctx, n.settings.Reload) // best effort: load the restored file
		return fmt.Errorf("nginx reload failed: %w", err)
	}
	return nil
}

// writeAtomic replaces path in one step, so nginx never reads a half-written file.
func writeAtomic(path string, content []byte) error {
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(dir, ".keelson-*.tmp")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name()) // a no-op once renamed
	if _, err := tmp.Write(content); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Chmod(0o644); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), path)
}

// runCommand runs argv without a shell and reports its output on failure.
func runCommand(ctx context.Context, argv []string) error {
	ctx, cancel := context.WithTimeout(ctx, commandTimeout)
	defer cancel()
	out, err := exec.CommandContext(ctx, argv[0], argv[1:]...).CombinedOutput()
	if err != nil {
		msg := strings.TrimSpace(string(out))
		if len(msg) > 2048 {
			msg = msg[:2048] + "..."
		}
		return fmt.Errorf("%s: %w: %s", strings.Join(argv, " "), err, msg)
	}
	return nil
}
