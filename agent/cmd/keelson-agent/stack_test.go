package main

import (
	"context"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// An engine that cannot be reached fails the start-up after the state was opened: the failure must come back as an error
// (it once panicked while cleaning up, and hid why the agent could not start).
func TestStartStackReportsAnEngineItCannotReach(t *testing.T) {
	dir := t.TempDir()
	apps := filepath.Join(dir, "apps.yaml")
	if err := os.WriteFile(apps, []byte("apps: []\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	s, err := startStack(ctx, stackConfig{
		socket: filepath.Join(dir, "no-engine.sock"), appsFile: apps, dataDir: filepath.Join(dir, "data"), secret: "s",
		log: slog.New(slog.NewTextHandler(os.Stderr, nil)),
	})
	if err == nil || s != nil || !strings.Contains(err.Error(), "no-engine.sock") {
		t.Fatalf("got stack %v, error %v", s, err)
	}
}
