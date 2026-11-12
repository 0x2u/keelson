package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"unicode/utf16"
)

// enrolServer is a dashboard that implements POST /api/relay/enrol as the contract says and records what it was sent.
type enrolServer struct {
	*httptest.Server
	got    map[string]any
	status int // 0: 200
	// body, when set, is the whole answer (with status)
	body string
}

func newEnrolServer(t *testing.T) *enrolServer {
	s := &enrolServer{}
	s.Server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "POST" || r.URL.Path != "/api/relay/enrol" {
			http.NotFound(w, r)
			return
		}
		s.got = map[string]any{}
		json.NewDecoder(r.Body).Decode(&s.got)
		if s.body != "" {
			if s.status != 0 {
				w.WriteHeader(s.status)
			}
			w.Write([]byte(s.body))
			return
		}
		json.NewEncoder(w).Encode(map[string]string{"credential": "cred-123", "server_id": "srv-1", "name": fmt.Sprint(s.got["name"]) + "-2"})
	}))
	t.Cleanup(s.Close)
	return s
}

func mode(t *testing.T, path string) os.FileMode {
	t.Helper()
	fi, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	return fi.Mode().Perm()
}

func quiet(string, ...any) {}

func TestEnrolmentWritesTheFilesPrivatelyAndRegistersTheSecrets(t *testing.T) {
	srv := newEnrolServer(t)
	dir := machineDir(filepath.Join(t.TempDir(), "keelson"))
	m, token, secret, err := openMachine(context.Background(), dir, connectionString(srv.URL+"/", "the-code"), "marc-mac", srv.Client(), quiet)
	if err != nil {
		t.Fatal(err)
	}

	if srv.got["code"] != "the-code" || srv.got["name"] != "marc-mac" || srv.got["token"] != token || srv.got["deploy_secret"] != secret ||
		srv.got["os"] == "" || srv.got["arch"] == "" || srv.got["version"] == "" {
		t.Errorf("the dashboard was sent %v", srv.got)
	}
	if len(token) < 32 || len(secret) < 32 || token == secret {
		t.Errorf("token %q, secret %q: at least 32 characters each, and different", token, secret)
	}
	if m.Dashboard != srv.URL || m.Credential != "cred-123" || m.ServerID != "srv-1" || m.Name != "marc-mac-2" {
		t.Errorf("the machine is what the dashboard answered, with the final name: %+v", m)
	}

	// Every file is private; the directories too.
	for _, f := range []string{dir.token(), dir.secret(), dir.relay(), dir.apps()} {
		if got := mode(t, f); got != 0o600 {
			t.Errorf("%s has mode %o, want 600", f, got)
		}
	}
	for _, d := range []string{string(dir), dir.dataDir()} {
		if got := mode(t, d); got != 0o700 {
			t.Errorf("%s has mode %o, want 700", d, got)
		}
	}
	if b, _ := os.ReadFile(dir.apps()); string(b) != "apps: []\n" {
		t.Errorf("apps.yaml: %q", b)
	}
	var saved map[string]string
	b, _ := os.ReadFile(dir.relay())
	if json.Unmarshal(b, &saved) != nil || saved["dashboard"] != srv.URL || saved["credential"] != "cred-123" || saved["server_id"] != "srv-1" || saved["name"] != "marc-mac-2" {
		t.Errorf("relay.json: %s", b)
	}
	if b, _ := os.ReadFile(dir.token()); strings.TrimSpace(string(b)) != token {
		t.Errorf("the token file does not hold the token that was registered")
	}
	if left, _ := filepath.Glob(filepath.Join(string(dir), ".tmp-*")); len(left) != 0 {
		t.Errorf("temporary files left: %v", left)
	}
}

func TestReconnectingUsesTheSavedFilesAndNeverEnrolsAgain(t *testing.T) {
	srv := newEnrolServer(t)
	dir := machineDir(filepath.Join(t.TempDir(), "keelson"))
	m1, token1, secret1, err := openMachine(context.Background(), dir, connectionString(srv.URL, "c"), "m", srv.Client(), quiet)
	if err != nil {
		t.Fatal(err)
	}
	srv.got = nil

	m2, token2, secret2, err := openMachine(context.Background(), dir, "", "", srv.Client(), quiet)
	if err != nil {
		t.Fatal(err)
	}
	if m2 != m1 || token2 != token1 || secret2 != secret1 {
		t.Errorf("a restart must come back as the same machine: %+v vs %+v", m2, m1)
	}
	if srv.got != nil {
		t.Error("a restart must not contact the enrolment endpoint")
	}

	// With a connection string and a machine already there: refused, and nothing changes.
	before, _ := os.ReadFile(dir.relay())
	_, _, _, err = openMachine(context.Background(), dir, connectionString(srv.URL, "another"), "", srv.Client(), quiet)
	if err == nil || !strings.Contains(err.Error(), "already connected") || !strings.Contains(err.Error(), "delete") {
		t.Errorf("must refuse and say how to forget: %v", err)
	}
	if srv.got != nil {
		t.Error("a refused re-enrolment must not contact the dashboard")
	}
	if after, _ := os.ReadFile(dir.relay()); string(after) != string(before) {
		t.Error("relay.json changed")
	}
}

func TestConnectingWithNothingToConnectToSaysWhatIsNeeded(t *testing.T) {
	dir := machineDir(filepath.Join(t.TempDir(), "keelson"))
	_, _, _, err := openMachine(context.Background(), dir, "", "", http.DefaultClient, quiet)
	if err == nil || !strings.Contains(err.Error(), "connection string") {
		t.Errorf("got %v", err)
	}
	if _, statErr := os.Stat(string(dir)); statErr == nil {
		t.Error("nothing is created when there is nothing to do")
	}
}

func TestEnrolmentFailuresAreExplainedAndLeaveNoMachine(t *testing.T) {
	cases := map[string]struct {
		status int
		body   string
		want   string
	}{
		"bad code":  {401, `{"error":"invalid or expired code"}`, "wrong, already used or expired"},
		"throttled": {429, `{"error":"slow down"}`, "too many attempts"},
		"bad name":  {400, `{"error":"bad name"}`, "bad name"},
		"old dash":  {404, `<html>not found</html>`, "404"},
		"no creds":  {0, `{}`, "no credential"},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			srv := newEnrolServer(t)
			srv.status, srv.body = tc.status, tc.body
			dir := machineDir(filepath.Join(t.TempDir(), "keelson"))
			_, _, _, err := openMachine(context.Background(), dir, connectionString(srv.URL, "c"), "m", srv.Client(), quiet)
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("got %v, want %q", err, tc.want)
			}
			if _, statErr := os.Stat(dir.relay()); statErr == nil {
				t.Error("a failed enrolment must not leave relay.json: the directory would pass for a connected machine")
			}
		})
	}

	// A dashboard that does not answer at all.
	srv := newEnrolServer(t)
	url := srv.URL
	srv.Close()
	dir := machineDir(filepath.Join(t.TempDir(), "keelson"))
	if _, _, _, err := openMachine(context.Background(), dir, connectionString(url, "c"), "m", http.DefaultClient, quiet); err == nil || !strings.Contains(err.Error(), "cannot reach the dashboard") {
		t.Errorf("got %v", err)
	}
}

func TestAnExistingAppsFileIsKept(t *testing.T) {
	srv := newEnrolServer(t)
	dir := machineDir(filepath.Join(t.TempDir(), "keelson"))
	os.MkdirAll(string(dir), 0o700)
	os.WriteFile(dir.apps(), []byte("apps: [] # mine\n"), 0o600)
	if _, _, _, err := openMachine(context.Background(), dir, connectionString(srv.URL, "c"), "m", srv.Client(), quiet); err != nil {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(dir.apps()); string(b) != "apps: [] # mine\n" {
		t.Errorf("apps.yaml was overwritten: %q", b)
	}
}

func TestAnHttpDashboardIsRefusedExceptOnTheMachineItself(t *testing.T) {
	if _, _, err := parseConnection(connectionString("http://keelson.example.com", "c")); err == nil || !strings.Contains(err.Error(), "not https") {
		t.Errorf("secrets must not travel in the clear: %v", err)
	}
	for _, loopback := range []string{"http://localhost:3000", "http://127.0.0.1:3000", "http://[::1]:3000"} {
		if _, _, err := parseConnection(connectionString(loopback, "c")); err != nil {
			t.Errorf("%s is the machine itself: %v", loopback, err)
		}
	}
}

func TestEnrolDoesNotFollowARedirectWithItsSecrets(t *testing.T) {
	var leaked bool
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { leaked = true }))
	defer target.Close()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, target.URL+"/steal", http.StatusTemporaryRedirect)
	}))
	defer srv.Close()
	dir := machineDir(filepath.Join(t.TempDir(), "keelson"))
	hc := &http.Client{CheckRedirect: noRedirect}
	if _, _, _, err := openMachine(context.Background(), dir, connectionString(srv.URL, "c"), "m", hc, quiet); err == nil {
		t.Error("a redirect is not an enrolment")
	}
	if leaked {
		t.Error("the enrolment body was sent to the redirect target")
	}
}

func TestParseConnection(t *testing.T) {
	ok := map[string]string{
		connectionString("https://keelson.example.com", "abc"):         "https://keelson.example.com",
		connectionString("https://keelson.example.com/", "abc"):        "https://keelson.example.com",
		"  " + connectionString("http://localhost:3000", "abc") + "\n": "http://localhost:3000",
		connectionString("https://example.com/keelson", "abc"):         "https://example.com/keelson",
		connectionString("https://k.example.com", "abc") + "==":        "https://k.example.com", // padding is tolerated
	}
	for in, want := range ok {
		url, code, err := parseConnection(in)
		if err != nil || url != want || code != "abc" {
			t.Errorf("%q: %q %q %v", in, url, code, err)
		}
	}
	for name, in := range map[string]string{
		"empty":        "",
		"no prefix":    "abc",
		"other prefix": "kse1.abc",
		"not base64":   relayPrefix + "!!!",
		"not json":     relayPrefix + base64.RawURLEncoding.EncodeToString([]byte("nope")),
		"no code":      connectionString("https://x.example", ""),
		"no url":       connectionString("", "c"),
		"file url":     connectionString("file:///etc/passwd", "c"),
		"userinfo":     connectionString("https://u:p@x.example", "c"),
		"query":        connectionString("https://x.example?a=b", "c"),
	} {
		if _, _, err := parseConnection(in); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
}

// The dashboard refuses a name that does not match this: the default one made from a host name must always pass.
var dashboardName = regexp.MustCompile(`^[\p{L}\p{N}][\p{L}\p{N} ._-]{0,59}$`)

func TestMachineNameIsAlwaysOneTheDashboardAccepts(t *testing.T) {
	for host, want := range map[string]string{
		"marc-mac":              "marc-mac",
		"Marc's MacBook.local":  "Marc-s MacBook.local",
		"  --weird:name!  ":     "weird-name-",
		"":                      "build-machine",
		"...":                   "build-machine",
		"ünï.local":             "ünï.local",
		strings.Repeat("a", 90): strings.Repeat("a", 60),
	} {
		got := machineName(host)
		if got != want || !dashboardName.MatchString(got) {
			t.Errorf("%q -> %q, want %q", host, got, want)
		}
	}
	// 60 UTF-16 units, not 60 characters: a letter outside the BMP counts for two.
	long := machineName(strings.Repeat("𝒜", 40))
	if n := len(utf16.Encode([]rune(long))); n > 60 || !dashboardName.MatchString(long) {
		t.Errorf("%d units: %q", n, long)
	}
}

func shortTempDir(t *testing.T) string {
	t.Helper()
	d, err := os.MkdirTemp("/tmp", "ks")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(d) })
	return d
}

func listenUnix(t *testing.T, path string) {
	t.Helper()
	os.MkdirAll(filepath.Dir(path), 0o755)
	ln, err := net.Listen("unix", path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })
}

func TestDockerSocketIsFoundWhereTheEngineIs(t *testing.T) {
	home := shortTempDir(t)
	t.Setenv("HOME", home)
	desktop := filepath.Join(home, ".docker", "run", "docker.sock")
	hosted := filepath.Join(home, "colima.sock")

	if got := detectSocket("/custom.sock", true); got.path != "/custom.sock" || got.found {
		t.Errorf("an explicit path is used even when absent: %+v", got)
	}

	// Nothing but Docker Desktop's.
	t.Setenv("DOCKER_HOST", "")
	listenUnix(t, desktop)
	if got := detectSocket("", true); got.path != desktop || !got.found {
		// /var/run/docker.sock may exist on the machine running the test: then it rightly wins.
		if _, err := os.Stat("/var/run/docker.sock"); err != nil {
			t.Errorf("%+v", got)
		}
	}

	// DOCKER_HOST first for connect, after /var/run/docker.sock for serve (whose behaviour must not change).
	listenUnix(t, hosted)
	t.Setenv("DOCKER_HOST", "unix://"+hosted)
	if got := detectSocket("", true); got.path != hosted || !got.found {
		t.Errorf("DOCKER_HOST first: %+v", got)
	}
	if got := detectSocket("", false); got.path != "/var/run/docker.sock" && got.path != hosted {
		t.Errorf("serve: %+v", got)
	}
	// A DOCKER_HOST that is not a unix socket is ignored.
	t.Setenv("DOCKER_HOST", "tcp://10.0.0.1:2375")
	if got := detectSocket("", true); got.path == "tcp://10.0.0.1:2375" || strings.Contains(strings.Join(got.tried, ","), "tcp:") {
		t.Errorf("%+v", got)
	}
}

// `connect` is a build machine, `install --connect` a server that serves apps: the dashboard is told which, and
// registering writes nothing (a refused or abandoned install leaves the machine as it was).
func TestEnrolmentSaysWhetherTheMachineServes(t *testing.T) {
	srv := newEnrolServer(t)
	dir := machineDir(filepath.Join(t.TempDir(), "keelson"))
	if _, _, _, err := openMachine(context.Background(), dir, connectionString(srv.URL, "c"), "m", srv.Client(), quiet); err != nil {
		t.Fatal(err)
	}
	if srv.got["serves"] != false {
		t.Errorf("connect enrols a build machine: serves = %v", srv.got["serves"])
	}

	before, _ := os.ReadDir(t.TempDir())
	r, err := register(context.Background(), connectionString(srv.URL, "c2"), "vps", true, srv.Client())
	if err != nil {
		t.Fatal(err)
	}
	if srv.got["serves"] != true || srv.got["code"] != "c2" || srv.got["token"] != r.token || srv.got["deploy_secret"] != r.secret {
		t.Errorf("install --connect enrols a server that serves: %v", srv.got)
	}
	if r.m.ServerID != "srv-1" || r.m.Credential != "cred-123" || r.m.Dashboard != srv.URL {
		t.Errorf("registration: %+v", r.m)
	}
	if len(before) != 0 {
		t.Fatal("fixture")
	}
}

func TestInstallConnectFlagsNameExactlyOneWayToConnect(t *testing.T) {
	str := connectionString("https://keelson.example.com", "abc")
	if got, err := connectionFor(str, "", ""); err != nil || got != str {
		t.Errorf("a connection string is taken as given: %q %v", got, err)
	}
	got, err := connectionFor("", "https://keelson.example.com/", "abc")
	if err != nil {
		t.Fatal(err)
	}
	if d, c, err := parseConnection(got); err != nil || d != "https://keelson.example.com" || c != "abc" {
		t.Errorf("--dashboard and --code make the same connection: %q %q %v", d, c, err)
	}
	if got, err := connectionFor("", "", ""); err != nil || got != "" {
		t.Errorf("no flag is a direct install: %q %v", got, err)
	}
	for name, tc := range map[string]struct{ connect, dashboard, code, want string }{
		"both ways":        {str, "https://keelson.example.com", "abc", "not both"},
		"url without code": {"", "https://keelson.example.com", "", "go together"},
		"code without url": {"", "", "abc", "go together"},
		"plain http":       {"", "http://keelson.example.com", "abc", "not https"},
		"not a URL":        {"", "keelson.example.com", "abc", "not the URL of a dashboard"},
		"garbage string":   {"ksr1.@@@", "", "", "not a connection string"},
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := connectionFor(tc.connect, tc.dashboard, tc.code); err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Errorf("got %v, want %q", err, tc.want)
			}
		})
	}
}
