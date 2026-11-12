package confmgr

import (
	"bytes"
	"errors"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/0x2u/keelson/agent/internal/config"
	"github.com/0x2u/keelson/agent/internal/store"
)

// logged makes the manager write its log into the returned buffer.
func logged(r *rig) *bytes.Buffer {
	var buf bytes.Buffer
	r.m.log = slog.New(slog.NewTextHandler(&buf, nil))
	return &buf
}

// A hand edit that drops the production app (a typo in the apps list) must not take its route away: it waits for an
// acknowledgement that names this exact version of the file.
func TestHandEditDroppingAnAppIsRefusedUntilAcknowledged(t *testing.T) {
	r := newRig(t, base)
	buf := logged(r)
	dropped := strings.Replace(base, "  - name: shop\n    image: ghcr.io/me/shop\n    env:\n      DATABASE_URL: postgres://u:pw@db/shop\n", "", 1)
	if dropped == base {
		t.Fatal("the test document does not hold the app it drops")
	}
	os.WriteFile(r.path, []byte(dropped), 0o640)
	r.m.checkFile()
	r.m.checkFile()
	if _, ok := r.m.Config().App("shop"); !ok || r.a.applied != 0 {
		t.Fatal("the dropped app must stay in the running configuration")
	}
	d := r.document()
	hash := config.Hash([]byte(dropped))
	if !strings.Contains(d.Error, "app shop is removed") || !strings.Contains(d.Error, hash) || !strings.Contains(d.Error, ".force") || d.AppliedHash == hash {
		t.Errorf("the status says why and how to acknowledge: %+v", d)
	}
	if n := strings.Count(buf.String(), "needs an acknowledgement"); n != 1 {
		t.Errorf("the refusal is logged once, got %d:\n%s", n, buf.String())
	}

	// An acknowledgement of another version of the file does not count.
	marker := r.path + ForceSuffix
	os.WriteFile(marker, []byte(config.Hash([]byte(base))+"\n"), 0o600)
	r.m.checkFile()
	if _, ok := r.m.Config().App("shop"); !ok {
		t.Fatal("a marker holding another hash must not apply the file")
	}

	// The marker for this version applies it, once.
	os.WriteFile(marker, []byte(strings.ToUpper(hash)+"\n"), 0o600)
	r.m.checkFile()
	if _, ok := r.m.Config().App("shop"); ok || r.a.applied != 1 {
		t.Fatal("an acknowledged edit is applied")
	}
	if d := r.document(); d.Error != "" || d.AppliedHash != hash {
		t.Errorf("the refusal clears once applied: %+v", d)
	}
	if _, err := os.Stat(marker); !errors.Is(err, os.ErrNotExist) {
		t.Error("the marker is consumed")
	}
	if v, _ := r.m.Versions(10); v[0].Source != store.SourceFile || v[0].Hash != hash {
		t.Errorf("recorded as a file edit: %+v", v[0])
	}
}

// Writing the file back as it was clears the refusal without any marker.
func TestRefusedHandEditIsClearedByFixingTheFile(t *testing.T) {
	r := newRig(t, base)
	os.WriteFile(r.path, []byte(strings.Replace(base, "  - name: web\n    image: ghcr.io/me/web\n", "", 1)), 0o640)
	r.m.checkFile()
	if r.document().Error == "" {
		t.Fatal("the edit must be refused")
	}
	os.WriteFile(r.path, []byte(base), 0o640)
	r.m.checkFile()
	if d := r.document(); d.Error != "" || d.Hash != d.AppliedHash {
		t.Errorf("%+v", d)
	}
}

func TestHandEditChangingTheProxyOrDroppingAJobNeedsTheSameAcknowledgement(t *testing.T) {
	for name, edit := range map[string]string{
		"job":   strings.Replace(base, "jobs:\n  - name: backup\n    schedule: \"@daily\"\n    run: [/bin/true]\n", "", 1),
		"proxy": "proxy: {admin: 'http://127.0.0.1:2999'}\n" + base,
	} {
		r := newRig(t, base)
		os.WriteFile(r.path, []byte(edit), 0o640)
		r.m.checkFile()
		if r.a.applied != 0 || !strings.Contains(r.document().Error, "was not applied") {
			t.Errorf("%s: must be refused: %+v", name, r.document())
		}
	}
}

func startup(t *testing.T, content string) (path string, st *store.Store) {
	t.Helper()
	dir := t.TempDir()
	path = filepath.Join(dir, "apps.yaml")
	if err := os.WriteFile(path, []byte(content), 0o640); err != nil {
		t.Fatal(err)
	}
	st, err := store.Open(filepath.Join(dir, "agent.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	return path, st
}

// A typo in the file while the agent was down must not become a restart loop: the newest version that loads runs, and
// the status says so.
func TestStartFallsBackToTheLastGoodVersion(t *testing.T) {
	path, st := startup(t, base)
	cfg, fb, err := Choose(path, st, nil)
	if err != nil || fb != nil {
		t.Fatalf("a valid file starts as it is: %v %v", fb, err)
	}
	m, err := New(path, st, cfg, nil)
	if err != nil {
		t.Fatal(err)
	}
	good, _ := m.Versions(1)

	os.WriteFile(path, []byte("apps:\n  - name: BAD\n"), 0o640)
	cfg, fb, err = Choose(path, st, nil)
	if err != nil || fb == nil || fb.Version.ID != good[0].ID {
		t.Fatalf("the last good version runs: %+v %v", fb, err)
	}
	if _, ok := cfg.App("shop"); !ok {
		t.Fatal("the configuration is the version's")
	}
	fm, err := NewFallback(path, st, fb, cfg, nil)
	if err != nil {
		t.Fatal(err)
	}
	d, err := fm.Document()
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(d.Error, "using version ") || !strings.Contains(d.Error, "the file on disk is invalid because") || d.AppliedHash != config.Hash([]byte(base)) {
		t.Errorf("the status says what runs and why: %+v", d)
	}
	if v, _ := st.ConfigVersions(t.Context(), 10); len(v) != 1 {
		t.Errorf("the broken file is not recorded as a version: %d", len(v))
	}
	// The broken file is not rewritten.
	if b, _ := os.ReadFile(path); string(b) != "apps:\n  - name: BAD\n" {
		t.Errorf("the file on disk must stay: %q", b)
	}
	fm.checkFile() // not re-reported, not applied
	if fm.Config() != cfg {
		t.Error("still the fallback")
	}
	// Fixing the file switches over by itself.
	os.WriteFile(path, []byte(base+"# fixed\n"), 0o640)
	fm.checkFile()
	if d, _ := fm.Document(); d.Error != "" || d.Hash != d.AppliedHash {
		t.Errorf("the problem clears once the file is valid again: %+v", d)
	}
}

func TestStartFallsBackWhenWhatTheFileReferencesIsMissing(t *testing.T) {
	path, st := startup(t, base)
	cfg, _, _ := Choose(path, st, nil)
	if _, err := New(path, st, cfg, nil); err != nil {
		t.Fatal(err)
	}
	// The newest version needs a secret file that is gone; the one before it does not.
	withSecret := base + "notifications:\n  telegram: {bot_token_file: /nonexistent/tg, chat_id: '1'}\n"
	os.WriteFile(path, []byte(withSecret), 0o640)
	usable := func(c *config.Config) error {
		if c.Notifications != nil && c.Notifications.Telegram != nil {
			if _, err := os.ReadFile(c.Notifications.Telegram.BotTokenFile); err != nil {
				return err
			}
		}
		return nil
	}
	if _, fb, err := Choose(path, st, usable); err != nil || fb == nil || fb.Version.Hash != config.Hash([]byte(base)) || !strings.Contains(fb.Reason, "no such file") {
		t.Fatalf("%+v %v", fb, err)
	}
	if _, fb, err := Choose(path, st, nil); err != nil || fb != nil {
		t.Fatalf("without the check the file starts: %+v %v", fb, err)
	}
}

func TestStartFailsWhenNoVersionLoads(t *testing.T) {
	path, st := startup(t, "apps:\n  - name: BAD\n")
	_, fb, err := Choose(path, st, nil)
	if err == nil || fb != nil || !strings.Contains(err.Error(), path) {
		t.Errorf("an invalid file with no history exits as before: %+v %v", fb, err)
	}
	if _, _, err := Choose(filepath.Join(t.TempDir(), "absent.yaml"), st, nil); err == nil {
		t.Error("a missing file exits")
	}
}
