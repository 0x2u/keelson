package postgres

import (
	"crypto/hmac"
	"crypto/pbkdf2"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"io/fs"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"

	"github.com/0x2u/keelson/agent/internal/config"
)

// ---- SCRAM verifier: the password never reaches PostgreSQL itself ----

func TestScramVerifierHasPostgresForm(t *testing.T) {
	salt := []byte("0123456789abcdef")
	v, err := scramVerifierWith("correct horse", salt, 4096)
	if err != nil {
		t.Fatal(err)
	}
	// SCRAM-SHA-256$<iterations>:<salt>$<StoredKey>:<ServerKey>
	head, rest, ok := strings.Cut(v, "$")
	if !ok || head != "SCRAM-SHA-256" {
		t.Fatalf("prefix: %q", v)
	}
	iterSalt, keys, ok := strings.Cut(rest, "$")
	if !ok {
		t.Fatalf("shape: %q", v)
	}
	if !strings.HasPrefix(iterSalt, "4096:") || strings.TrimPrefix(iterSalt, "4096:") != base64.StdEncoding.EncodeToString(salt) {
		t.Errorf("iterations and salt: %q", iterSalt)
	}
	stored, server, ok := strings.Cut(keys, ":")
	if !ok {
		t.Fatalf("keys: %q", keys)
	}
	// Recompute the way RFC 5802 defines them, with the primitives written out here.
	salted, err := pbkdf2.Key(sha256.New, "correct horse", salt, 4096, sha256.Size)
	if err != nil {
		t.Fatal(err)
	}
	mac := func(key []byte, msg string) []byte {
		h := hmac.New(sha256.New, key)
		h.Write([]byte(msg))
		return h.Sum(nil)
	}
	sum := sha256.Sum256(mac(salted, "Client Key"))
	if want := base64.StdEncoding.EncodeToString(sum[:]); stored != want {
		t.Errorf("StoredKey %s, want %s", stored, want)
	}
	if want := base64.StdEncoding.EncodeToString(mac(salted, "Server Key")); server != want {
		t.Errorf("ServerKey %s, want %s", server, want)
	}
	if strings.Contains(v, "correct horse") {
		t.Error("the verifier carries the password")
	}
}

func TestScramVerifierIsSaltedAndRefusesWhatTheServerWouldNormalise(t *testing.T) {
	a, _ := scramVerifier("same")
	b, _ := scramVerifier("same")
	if a == b {
		t.Error("two verifiers of one password are identical: the salt is not random")
	}
	for _, bad := range []string{"caf\u00e9", "tab\there", "nul\x00", "line\nbreak"} {
		if _, err := scramVerifier(bad); err == nil {
			t.Errorf("%q was accepted: a verifier no client would match", bad)
		}
	}
}

// ---- URLs ----

func TestConnectionURLKeepsAnyPasswordInsideItsOwnField(t *testing.T) {
	for _, pw := range []string{"plain", "p@ss:w/rd#?x=y&z", "50% off", "a b", "über", "[::1]"} {
		raw := connectionURL("keelson-postgres", 5432, "shop", pw, "shop")
		u, err := url.Parse(raw)
		if err != nil {
			t.Fatalf("%q: %v", pw, err)
		}
		got, _ := u.User.Password()
		if u.Host != "keelson-postgres:5432" || u.User.Username() != "shop" || got != pw || u.Path != "/shop" || u.RawQuery != "" || u.Fragment != "" {
			t.Errorf("password %q: host %q user %q password %q path %q query %q fragment %q (%s)", pw, u.Host, u.User.Username(), got, u.Path, u.RawQuery, u.Fragment, raw)
		}
	}
}

func TestAppURLFollowsTheNetworkModeOfTheApp(t *testing.T) {
	bridge := config.App{Name: "web"}
	host := config.App{Name: "web", Network: "host"}
	got, err := appURL(bridge, 0, "shop", "pw")
	if err != nil || got != "postgresql://shop:pw@"+config.ManagedPostgresContainer+":5432/shop" {
		t.Errorf("network mode: %q %v", got, err)
	}
	// The bridge app does not need the published port: it is unaffected by it.
	if again, _ := appURL(bridge, 5442, "shop", "pw"); again != got {
		t.Errorf("published port leaked into a network URL: %q", again)
	}
	got, err = appURL(host, 5442, "shop", "pw")
	if err != nil || got != "postgresql://shop:pw@127.0.0.1:5442/shop" {
		t.Errorf("host mode: %q %v", got, err)
	}
	var ie *InstanceError
	if _, err := appURL(host, 0, "shop", "pw"); !errors.As(err, &ie) {
		t.Errorf("a host-network app with no published port must be refused, got %v", err)
	}
	if mode(bridge) != "network" || mode(host) != "host" {
		t.Error("mode names")
	}
}

// ---- text that may carry a secret ----

func TestScrubRemovesSecretsVerifiersAndLineBreaks(t *testing.T) {
	m := New(Options{})
	v, _ := scramVerifier("hunter2hunter2")
	in := "ERROR: password hunter2hunter2 rejected\nDETAIL: ALTER ROLE shop PASSWORD '" + v + "';\n\n   done"
	out := m.scrub(in, "hunter2hunter2")
	for _, leak := range []string{"hunter2hunter2", "SCRAM-SHA-256$", "\n"} {
		if strings.Contains(out, leak) {
			t.Errorf("%q survives in %q", leak, out)
		}
	}
	if long := m.scrub(strings.Repeat("x ", 500)); len(long) > 303 {
		t.Errorf("not bounded: %d", len(long))
	}
	if m.scrub("nothing here", "") != "nothing here" {
		t.Error("an empty secret must not replace everything")
	}
}

func TestFailureLinePrefersTheFirstErrorOverTheEchoedStatement(t *testing.T) {
	got := failureLine([]string{"", "ERROR:  role \"x\" already exists", "STATEMENT:  CREATE ROLE \"x\" PASSWORD 'SCRAM-SHA-256$...'"})
	if got != `ERROR:  role "x" already exists` {
		t.Errorf("%q", got)
	}
	if failureLine(nil) == "" || failureLine([]string{"  ", "last words"}) != "last words" {
		t.Error("fallbacks")
	}
	if got := failureLine([]string{"psql: error: connection refused"}); !strings.Contains(got, "connection refused") {
		t.Errorf("%q", got)
	}
}

func TestIdentifiersAndLiteralsCannotBreakOutOfTheirQuotes(t *testing.T) {
	if got := ident(`a"; DROP DATABASE x; --`); got != `"a""; DROP DATABASE x; --"` {
		t.Errorf("%s", got)
	}
	if got := literal(`o'brien'); --`); got != `'o''brien''); --'` {
		t.Errorf("%s", got)
	}
}

// ---- the instance's settings ----

func TestMajorOfReadsTheTag(t *testing.T) {
	for in, want := range map[string]int{"postgres:16-alpine": 16, "postgres:17.2-alpine": 17, "postgres:alpine": 0, "postgres": 0, "reg.example:5000/pg:15": 15} {
		if got := majorOf(in); got != want {
			t.Errorf("%s: %d, want %d", in, got, want)
		}
	}
}

func TestServerSettingsScaleWithTheMemoryCapAndNeverLogStatements(t *testing.T) {
	has := func(args []string, want string) bool {
		for i, a := range args {
			if a == "-c" && i+1 < len(args) && args[i+1] == want {
				return true
			}
		}
		return false
	}
	small, def, big := serverArgs(128<<20), serverArgs(512<<20), serverArgs(64<<30)
	if !has(small, "max_connections=50") || !has(def, "max_connections=100") {
		t.Errorf("connections: %v / %v", small, def)
	}
	if !has(def, "shared_buffers=128MB") || !has(big, "shared_buffers=2048MB") || !has(small, "shared_buffers=32MB") {
		t.Errorf("shared_buffers: %v / %v / %v", small, def, big)
	}
	for _, a := range [][]string{small, def, big} {
		if a[0] != "postgres" || !has(a, "password_encryption=scram-sha-256") || !has(a, "log_min_error_statement=panic") {
			t.Errorf("invariants: %v", a)
		}
	}
}

func TestSpecHashChangesOnlyWithWhatTheOperatorChooses(t *testing.T) {
	base := config.PostgresSettings{}
	if specHash(base) != specHash(config.PostgresSettings{}) {
		t.Error("not stable")
	}
	other := base
	other.Port = 5499
	if specHash(base) == specHash(other) {
		t.Error("a different port must be a different spec")
	}
	other = base
	other.Memory = config.Size(1 << 30)
	if specHash(base) == specHash(other) {
		t.Error("a different memory cap must be a different spec")
	}
}

// ---- secret files ----

func TestWriteSecretIsPrivateWhateverTheUmask(t *testing.T) {
	old := syscall.Umask(0)
	defer syscall.Umask(old)
	dir := filepath.Join(t.TempDir(), "postgres", "roles")
	path := filepath.Join(dir, "shop.pw")
	if err := writeSecret(path, "s3cret-value"); err != nil {
		t.Fatal(err)
	}
	fi, _ := os.Stat(path)
	di, _ := os.Stat(dir)
	if fi.Mode().Perm() != 0o600 || di.Mode().Perm() != 0o700 {
		t.Errorf("file %v, directory %v", fi.Mode().Perm(), di.Mode().Perm())
	}
	if got, err := readSecret(path); err != nil || got != "s3cret-value" {
		t.Errorf("%q %v", got, err)
	}
	// A rewrite replaces the file whole and leaves nothing behind.
	if err := writeSecret(path, "second"); err != nil {
		t.Fatal(err)
	}
	entries, _ := os.ReadDir(dir)
	if len(entries) != 1 {
		t.Errorf("leftovers: %v", entries)
	}
	if got, _ := readSecret(path); got != "second" {
		t.Errorf("%q", got)
	}
}

func TestReadSecretRefusesAnEmptyFileAndNamesNothingElse(t *testing.T) {
	path := filepath.Join(t.TempDir(), "x.pw")
	if err := os.WriteFile(path, []byte("\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := readSecret(path); err == nil {
		t.Error("an empty secret is not a secret")
	}
	if _, err := readSecret(path + ".missing"); !errors.Is(err, fs.ErrNotExist) {
		t.Errorf("%v", err)
	}
}

func TestGeneratedPasswordsAreLongURLSafeAndDistinct(t *testing.T) {
	seen := map[string]bool{}
	for range 50 {
		p, err := generatePassword()
		if err != nil {
			t.Fatal(err)
		}
		if len(p) < 40 || strings.ContainsAny(p, "+/=@:#?& '\"") || seen[p] {
			t.Fatalf("%q", p)
		}
		seen[p] = true
	}
}

func TestTheSuperuserPasswordIsNeverReplacedWhenTheDataExists(t *testing.T) {
	m := New(Options{DataDir: t.TempDir()})
	// Data without the file: a new password would not match the data, so the agent must say so instead.
	if _, err := m.superuserPassword(true); !errors.Is(err, ErrPasswordLost) {
		t.Fatalf("%v", err)
	}
	first, err := m.superuserPassword(false)
	if err != nil {
		t.Fatal(err)
	}
	again, err := m.superuserPassword(true)
	if err != nil || again != first {
		t.Errorf("the password changed: %q -> %q (%v)", first, again, err)
	}
}

// ---- what a request may ask for ----

func parseApps(t *testing.T, doc string) *config.Config {
	t.Helper()
	c, issues := config.Parse([]byte(doc))
	if c == nil {
		t.Fatalf("%+v", issues)
	}
	return c
}

const appsDoc = `apps:
  - name: web
    image: ghcr.io/me/web
  - name: hostapp
    image: ghcr.io/me/hostapp
    network: host
  - name: isolated
    image: ghcr.io/me/isolated
    network: none
databases:
  - name: legacy
    engine: postgres
    host: 127.0.0.1
    port: 5432
    database: legacy
    user: legacy
    password_file: /etc/keelson/legacy.pw
`

func TestCheckCreateRefusesWhatCannotWork(t *testing.T) {
	cfg := parseApps(t, appsDoc)
	m := New(Options{})
	good := CreateRequest{App: "web", Name: "shop", EnvKey: "DATABASE_URL"}
	if _, _, err := m.checkCreate(cfg, good); err != nil {
		t.Fatalf("a good request: %v", err)
	}
	if _, _, err := m.checkCreate(cfg, CreateRequest{App: "hostapp", Name: "shop", EnvKey: "DATABASE_URL"}); err != nil {
		t.Errorf("an app on the host network is allowed: %v", err)
	}
	for name, tc := range map[string]struct {
		req  CreateRequest
		want string // error type
	}{
		"unknown app":        {CreateRequest{App: "ghost", Name: "shop", EnvKey: "DATABASE_URL"}, "unknown"},
		"app is not a name":  {CreateRequest{App: "../etc", Name: "shop", EnvKey: "DATABASE_URL"}, "request"},
		"bad database name":  {CreateRequest{App: "web", Name: "Shop; DROP", EnvKey: "DATABASE_URL"}, "request"},
		"bad key":            {CreateRequest{App: "web", Name: "shop", EnvKey: "1BAD"}, "request"},
		"keelson key":        {CreateRequest{App: "web", Name: "shop", EnvKey: "KEELSON_URL"}, "request"},
		"reserved key":       {CreateRequest{App: "web", Name: "shop", EnvKey: "PATH"}, "request"},
		"cannot reach":       {CreateRequest{App: "isolated", Name: "shop", EnvKey: "DATABASE_URL"}, "request"},
		"hand-declared name": {CreateRequest{App: "web", Name: "legacy", EnvKey: "DATABASE_URL"}, "conflict"},
	} {
		_, _, err := m.checkCreate(cfg, tc.req)
		var re *RequestError
		var ce *ConflictError
		switch {
		case err == nil:
			t.Errorf("%s: accepted", name)
		case tc.want == "unknown" && !errors.Is(err, ErrUnknownApp):
			t.Errorf("%s: %v", name, err)
		case tc.want == "request" && !errors.As(err, &re):
			t.Errorf("%s: %T %v", name, err, err)
		case tc.want == "conflict" && !errors.As(err, &ce):
			t.Errorf("%s: %T %v", name, err, err)
		}
	}
}

func TestCheckCreateKeepsOneDatabasePerVariableAndNeverStealsAName(t *testing.T) {
	cfg := parseApps(t, appsDoc+`  - name: shop
    managed: true
    app: web
    env_key: DATABASE_URL
    engine: postgres
    host: keelson-postgres
    port: 5432
    database: shop
    user: shop
    password_file: /var/lib/keelson/postgres/roles/shop.pw
    network: keelson
`)
	m := New(Options{})
	// The same request again is a retry: it finds the entry and goes on.
	if _, existing, err := m.checkCreate(cfg, CreateRequest{App: "web", Name: "shop", EnvKey: "DATABASE_URL"}); err != nil || existing == nil {
		t.Fatalf("retry: %v %v", existing, err)
	}
	var ce *ConflictError
	for name, req := range map[string]CreateRequest{
		"another app's database": {App: "hostapp", Name: "shop", EnvKey: "DATABASE_URL"},
		"another variable":       {App: "web", Name: "shop", EnvKey: "OTHER_URL"},
		"variable already used":  {App: "web", Name: "second", EnvKey: "DATABASE_URL"},
	} {
		if _, _, err := m.checkCreate(cfg, req); !errors.As(err, &ce) {
			t.Errorf("%s: %T %v", name, err, err)
		}
	}
}
