package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/0x2u/keelson/agent/internal/confmgr"
	"github.com/0x2u/keelson/agent/internal/store"
)

const goodApps = "apps:\n  - {name: web, image: ghcr.io/me/web}\n"

func startState(t *testing.T, apps string) (string, *store.Store) {
	t.Helper()
	dir := t.TempDir()
	path := filepath.Join(dir, "apps.yaml")
	if err := os.WriteFile(path, []byte(apps), 0o600); err != nil {
		t.Fatal(err)
	}
	st, err := store.Open(filepath.Join(dir, "agent.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	return path, st
}

// serve must not exit (and be restarted by systemd every 3 seconds) on an edit made while it was down.
func TestServeStartsOnTheLastGoodVersionWhenTheFileIsBroken(t *testing.T) {
	path, st := startState(t, goodApps)
	cfg, fb, err := startConfig(path, st, true)
	if err != nil || fb != nil {
		t.Fatal(fb, err)
	}
	if _, err := confmgr.New(path, st, cfg, nil); err != nil {
		t.Fatal(err)
	}
	os.WriteFile(path, []byte("apps:\n  - {name: web, image: ghcr.io/me/web, bogus: 1}\n"), 0o600)
	cfg, fb, err = startConfig(path, st, true)
	if err != nil || fb == nil {
		t.Fatalf("want the fallback: %v", err)
	}
	if _, ok := cfg.App("web"); !ok || !strings.Contains(fb.Reason, "bogus") {
		t.Errorf("%+v %+v", cfg, fb)
	}
	// A local `deploy` borrowing the state wants the file as it is.
	if _, fb, err := startConfig(path, st, false); err == nil || fb != nil {
		t.Error("without fallback a broken file is an error")
	}
}

func TestServeFallsBackWhenANotificationSecretFileIsMissing(t *testing.T) {
	path, st := startState(t, goodApps)
	cfg, _, _ := startConfig(path, st, true)
	if _, err := confmgr.New(path, st, cfg, nil); err != nil {
		t.Fatal(err)
	}
	os.WriteFile(path, []byte(goodApps+"notifications:\n  telegram: {bot_token_file: "+filepath.Join(t.TempDir(), "gone")+", chat_id: '1'}\n"), 0o600)
	_, fb, err := startConfig(path, st, true)
	if err != nil || fb == nil || !strings.Contains(fb.Reason, "telegram bot token") {
		t.Fatalf("%+v %v", fb, err)
	}
	// With the secret in place the same file is the one that runs.
	tok := filepath.Join(t.TempDir(), "tg")
	os.WriteFile(tok, []byte("123:abc\n"), 0o600)
	os.WriteFile(path, []byte(goodApps+"notifications:\n  telegram: {bot_token_file: "+tok+", chat_id: '1'}\n"), 0o600)
	if _, fb, err := startConfig(path, st, true); err != nil || fb != nil {
		t.Fatalf("%+v %v", fb, err)
	}
}
