package appenv

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/0x2u/keelson/agent/internal/config"
)

var t0 = time.Date(2026, 10, 23, 10, 0, 0, 0, time.UTC)

func openStore(t *testing.T) *Store {
	t.Helper()
	s, err := Open(filepath.Join(t.TempDir(), "env"))
	if err != nil {
		t.Fatal(err)
	}
	return s
}

func put(t *testing.T, s *Store, app, scope string, now time.Time, kv map[string]string) {
	t.Helper()
	err := s.Update(app, scope, now, func(sc *Scope) (bool, error) {
		for k, v := range kv {
			sc.Entries[k] = Entry{Value: v, UpdatedAt: now}
		}
		return true, nil
	})
	if err != nil {
		t.Fatal(err)
	}
}

func TestValuesRoundTripThroughTheFileAndThroughReadEnvFile(t *testing.T) {
	s := openStore(t)
	values := map[string]string{
		"PLAIN":     "value",
		"EMPTY":     "",
		"SPACES":    "  padded  ",
		"MULTILINE": "-----BEGIN KEY-----\nline two\r\nline three\n-----END KEY-----\n",
		"QUOTES":    `he said "hi" and 'bye'`,
		"BACKSLASH": `C:\path\n and \u0041`,
		"EQUALS":    "a=b=c",
		"HASH":      "# not a comment",
		"EXPORT":    "export X=1",
		"HTML":      "<a href=\"x\">&amp;</a>",
		"UNICODE":   "héllo — 日本語 \u2028 end",
		"DOLLAR":    "$HOME ${X} `cmd`",
		"BIG":       strings.Repeat("x", MaxValueBytes),
	}
	put(t, s, "web", ScopeApp, t0, values)

	got, err := s.Read("web", ScopeApp)
	if err != nil {
		t.Fatal(err)
	}
	for k, want := range values {
		if got.Entries[k].Value != want {
			t.Errorf("%s: got %q, want %q", k, got.Entries[k].Value, want)
		}
	}
	// The agent's own dotenv reader parses the file back to the same values, in key order.
	pairs, err := config.ReadEnvFile(filepath.Join(s.Dir(), "web.app.env"))
	if err != nil {
		t.Fatal(err)
	}
	if len(pairs) != len(values) {
		t.Fatalf("%d pairs for %d values", len(pairs), len(values))
	}
	for _, kv := range pairs {
		if values[kv[0]] != kv[1] {
			t.Errorf("ReadEnvFile %s: got %q", kv[0], kv[1])
		}
	}
	// One physical line per value: a multi-line value never spreads over lines.
	raw, _ := os.ReadFile(filepath.Join(s.Dir(), "web.app.env"))
	for i, line := range strings.Split(strings.TrimSuffix(string(raw), "\n"), "\n") {
		if !strings.HasPrefix(line, "#") && !strings.Contains(line, "=") {
			t.Errorf("line %d is not an assignment: %.40q", i+1, line)
		}
	}
}

func TestFilesAndDirectoryArePrivate(t *testing.T) {
	s := openStore(t)
	put(t, s, "web", ScopeApp, t0, map[string]string{"A": "1"})
	put(t, s, "web", ScopePreview, t0, map[string]string{"A": "1"})
	assertMode(t, s.Dir(), 0o700)
	assertMode(t, filepath.Join(s.Dir(), "web.app.env"), 0o600)
	assertMode(t, filepath.Join(s.Dir(), "web.preview.env"), 0o600)
	entries, _ := os.ReadDir(s.Dir())
	if len(entries) != 2 {
		t.Errorf("only the two scope files may remain, got %v", entries)
	}
}

func assertMode(t *testing.T, path string, want os.FileMode) {
	t.Helper()
	fi, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if fi.Mode().Perm() != want {
		t.Errorf("%s: mode %v, want %v", path, fi.Mode().Perm(), want)
	}
}

func TestOpenRestoresPermissionsAndRemovesLeftovers(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "env")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	scope := filepath.Join(dir, "web.app.env")
	leftover := filepath.Join(dir, "web.app.env.tmp-123")
	other := filepath.Join(dir, "README")
	for _, p := range []string{scope, leftover, other} {
		if err := os.WriteFile(p, []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	// WriteFile is subject to the umask: make the test independent of it.
	for _, p := range []string{dir, scope} {
		if err := os.Chmod(p, map[bool]os.FileMode{true: 0o755, false: 0o644}[p == dir]); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := Open(dir); err != nil {
		t.Fatal(err)
	}
	assertMode(t, dir, 0o700)
	assertMode(t, scope, 0o600)
	if _, err := os.Stat(leftover); !os.IsNotExist(err) {
		t.Error("the leftover of an interrupted write must be removed")
	}
	if _, err := os.Stat(other); err != nil {
		t.Error("a file that is not a scope is none of the store's business")
	}
}

func TestReadFixesAFileCopiedInWithOpenPermissions(t *testing.T) {
	s := openStore(t)
	p := filepath.Join(s.Dir(), "web.app.env")
	if err := os.WriteFile(p, []byte("A=1\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	_ = os.Chmod(p, 0o644)
	sc, err := s.Read("web", ScopeApp)
	if err != nil || sc.Entries["A"].Value != "1" {
		t.Fatalf("%+v %v", sc, err)
	}
	assertMode(t, p, 0o600)
}

func TestAHandWrittenFileWithoutTheHeaderStillWorks(t *testing.T) {
	s := openStore(t)
	p := filepath.Join(s.Dir(), "web.app.env")
	if err := os.WriteFile(p, []byte("# mine\nA=1\nB=\"two words\"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	mod := t0.Add(-time.Hour)
	if err := os.Chtimes(p, mod, mod); err != nil {
		t.Fatal(err)
	}
	sc, err := s.Read("web", ScopeApp)
	if err != nil {
		t.Fatal(err)
	}
	if sc.Entries["B"].Value != "two words" || !sc.Entries["A"].UpdatedAt.Equal(mod) || !sc.Changed.Equal(mod) {
		t.Errorf("%+v", sc)
	}
	if at, err := s.Changed("web", ScopeApp); err != nil || !at.Equal(mod) {
		t.Errorf("Changed: %v %v", at, err)
	}
}

func TestACorruptFileIsAnErrorThatNeverContainsAValue(t *testing.T) {
	s := openStore(t)
	p := filepath.Join(s.Dir(), "web.app.env")
	body := config.ManagedEnvHeader + "\nSECRET=hunter2hunter2\n"
	if err := os.WriteFile(p, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	_, err := s.Read("web", ScopeApp)
	if err == nil {
		t.Fatal("an unquoted value in a managed file is corrupt")
	}
	if strings.Contains(err.Error(), "hunter2") {
		t.Errorf("the error leaks a value: %v", err)
	}
}

func TestNamesThatCouldEscapeTheDirectoryAreRefused(t *testing.T) {
	s := openStore(t)
	outside := filepath.Join(filepath.Dir(s.Dir()), "x.app.env")
	for _, app := range []string{"../x", "a/b", "", "UPPER", "a.b", "x\x00y", ".."} {
		if _, err := s.Read(app, ScopeApp); err != ErrBadName {
			t.Errorf("Read(%q): %v", app, err)
		}
		err := s.Update(app, ScopeApp, t0, func(sc *Scope) (bool, error) { sc.Entries["A"] = Entry{}; return true, nil })
		if err != ErrBadName {
			t.Errorf("Update(%q): %v", app, err)
		}
		if _, err := s.Remove(app, ScopeApp); err != ErrBadName {
			t.Errorf("Remove(%q): %v", app, err)
		}
	}
	if _, err := s.Read("web", "../app"); err != ErrBadName {
		t.Errorf("a scope that is not one: %v", err)
	}
	if _, err := os.Stat(outside); !os.IsNotExist(err) {
		t.Error("a file was written outside the store")
	}
}

func TestAFailedOrUnchangedUpdateWritesNothing(t *testing.T) {
	s := openStore(t)
	err := s.Update("web", ScopeApp, t0, func(sc *Scope) (bool, error) { sc.Entries["A"] = Entry{Value: "1"}; return true, fmt.Errorf("boom") })
	if err == nil {
		t.Fatal("the error must come back")
	}
	_ = s.Update("web", ScopeApp, t0, func(sc *Scope) (bool, error) { sc.Entries["A"] = Entry{Value: "1"}; return false, nil })
	if entries, _ := os.ReadDir(s.Dir()); len(entries) != 0 {
		t.Errorf("nothing may be written: %v", entries)
	}
	if sc, _ := s.Read("web", ScopeApp); len(sc.Entries) != 0 || !sc.Changed.IsZero() {
		t.Errorf("%+v", sc)
	}
}

// A reader running while writers replace the scope sees one generation or the next, never a mixture; the writers are
// serialized so no change is lost.
func TestConcurrentReadsSeeAWholeScopeAndNoChangeIsLost(t *testing.T) {
	s := openStore(t)
	const keys, writers, rounds = 40, 4, 25
	put(t, s, "web", ScopeApp, t0, func() map[string]string {
		m := map[string]string{}
		for i := 0; i < keys; i++ {
			m[fmt.Sprintf("K%02d", i)] = "g0"
		}
		return m
	}())

	stop := make(chan struct{})
	var readers sync.WaitGroup
	for r := 0; r < 4; r++ {
		readers.Add(1)
		go func() {
			defer readers.Done()
			for {
				select {
				case <-stop:
					return
				default:
				}
				sc, err := s.Read("web", ScopeApp)
				if err != nil {
					t.Error(err)
					return
				}
				if len(sc.Entries) < keys {
					t.Errorf("a read saw %d keys", len(sc.Entries))
					return
				}
				first := sc.Entries["K00"].Value
				for i := 0; i < keys; i++ {
					if v := sc.Entries[fmt.Sprintf("K%02d", i)].Value; v != first {
						t.Errorf("mixed generations: K00=%s K%02d=%s", first, i, v)
						return
					}
				}
			}
		}()
	}
	var w sync.WaitGroup
	for i := 0; i < writers; i++ {
		w.Add(1)
		go func() {
			defer w.Done()
			for n := 0; n < rounds; n++ {
				err := s.Update("web", ScopeApp, t0, func(sc *Scope) (bool, error) {
					gen := fmt.Sprintf("g%d", len(sc.Entries["EXTRA"].Value)+1)
					for k := range sc.Entries {
						if strings.HasPrefix(k, "K") {
							sc.Entries[k] = Entry{Value: gen}
						}
					}
					sc.Entries["EXTRA"] = Entry{Value: sc.Entries["EXTRA"].Value + "x"}
					return true, nil
				})
				if err != nil {
					t.Error(err)
					return
				}
			}
		}()
	}
	w.Wait()
	close(stop)
	readers.Wait()
	sc, _ := s.Read("web", ScopeApp)
	if n := len(sc.Entries["EXTRA"].Value); n != writers*rounds {
		t.Errorf("%d of %d changes survived", n, writers*rounds)
	}
}
