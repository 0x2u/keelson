package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"time"
	"unicode"
	"unicode/utf16"

	"github.com/0x2u/keelson/agent/internal/api"
	"github.com/0x2u/keelson/agent/internal/docker"
	"github.com/0x2u/keelson/agent/internal/relay"
)

// relayPrefix starts the connection string the dashboard shows: "ksr1." and the base64url of {"u": dashboard URL, "c": code}.
const relayPrefix = "ksr1."

// machine is what relay.json keeps: where the dashboard is and what proves this machine to it.
type machine struct {
	Dashboard  string `json:"dashboard"`
	Credential string `json:"credential"`
	ServerID   string `json:"server_id"`
	Name       string `json:"name"`
}

// machineDir is the directory `connect` keeps everything in.
type machineDir string

func (d machineDir) token() string   { return filepath.Join(string(d), "token") }
func (d machineDir) secret() string  { return filepath.Join(string(d), "deploy-secret") }
func (d machineDir) relay() string   { return filepath.Join(string(d), "relay.json") }
func (d machineDir) apps() string    { return filepath.Join(string(d), "apps.yaml") }
func (d machineDir) dataDir() string { return filepath.Join(string(d), "data") }

// connectCmd makes this machine a build machine of a dashboard: the agent opens one outbound connection to it and serves
// the dashboard's requests over it, with no listener. The first run enrols with the connection string the dashboard shows;
// the next ones just reconnect.
func connectCmd(ctx context.Context, args []string) error {
	fs := flag.NewFlagSet("connect", flag.ContinueOnError)
	dirFlag := fs.String("dir", "", "where this machine keeps its files (default $HOME/.keelson)")
	name := fs.String("name", "", "how the dashboard calls this machine (default: this machine's host name)")
	socketFlag := fs.String("docker-socket", "", "path of the Docker engine unix socket (default: $DOCKER_HOST, /var/run/docker.sock, then Docker Desktop's)")
	fs.Usage = func() {
		fmt.Fprintln(fs.Output(), "usage: keelson-agent connect [--dir DIR] [--name NAME] [--docker-socket PATH] [CONNECTION-STRING]")
		fs.PrintDefaults()
	}
	if err := fs.Parse(args); err != nil {
		return err
	}
	if fs.NArg() > 1 {
		return errors.New("one connection string at most: the one the dashboard shows")
	}
	dir, err := resolveDir(*dirFlag)
	if err != nil {
		return err
	}
	say := func(format string, a ...any) { fmt.Fprintf(os.Stderr, format+"\n", a...) }

	m, token, secret, err := openMachine(ctx, dir, fs.Arg(0), *name, &http.Client{Timeout: 30 * time.Second, CheckRedirect: noRedirect}, say)
	if err != nil {
		return err
	}

	sock := detectSocket(*socketFlag, true)
	if !sock.found {
		say("warning: no Docker engine socket found (looked at %s): builds fail until Docker runs and answers there. Pass --docker-socket to say where it is", strings.Join(sock.tried, ", "))
	}
	socket := sock.path

	log := slog.New(slog.NewTextHandler(os.Stderr, nil))
	stk, err := startStack(ctx, stackConfig{socket: socket, appsFile: dir.apps(), dataDir: dir.dataDir(), secret: secret, log: log, buildMachine: true})
	if err != nil {
		return err
	}
	defer stk.close()
	handler, err := api.New(docker.New(socket), api.Options{Token: token, Version: version, Logger: log, Deploy: stk.api})
	if err != nil {
		return err
	}

	runErr := relay.Run(ctx, relay.Options{
		Dashboard: m.Dashboard, Credential: m.Credential, Name: m.Name, Handler: handler,
		Logf: func(format string, a ...any) { say(format, a...) },
	})
	stk.beginShutdown()
	stk.drain(log)
	return runErr
}

func resolveDir(flagValue string) (machineDir, error) {
	if flagValue != "" {
		return machineDir(flagValue), nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("no home directory to keep files in: pass --dir: %w", err)
	}
	return machineDir(filepath.Join(home, ".keelson")), nil
}

// openMachine returns the machine's identity: read from the directory when it was enrolled before, else made by
// enrolling with the connection string. Enrolling twice on one directory is refused, never done quietly: it would leave
// a second machine in the dashboard and orphan the first.
func openMachine(ctx context.Context, dir machineDir, connection, name string, hc *http.Client, say func(string, ...any)) (m machine, token, secret string, err error) {
	raw, readErr := os.ReadFile(dir.relay())
	switch {
	case readErr == nil && connection != "":
		return m, "", "", fmt.Errorf("this machine is already connected (%s exists): to connect it again, to this or another dashboard, delete %s first. Run `keelson-agent connect` without a connection string to reconnect", dir.relay(), string(dir))
	case readErr == nil:
		if m, err = decodeMachine(raw); err != nil {
			return m, "", "", fmt.Errorf("%s is not readable: delete %s and connect again with a new code", dir.relay(), string(dir))
		}
		if token, err = readSecret(dir.token()); err != nil {
			return m, "", "", err
		}
		if secret, err = readSecret(dir.secret()); err != nil {
			return m, "", "", err
		}
		return m, token, secret, nil
	case !errors.Is(readErr, os.ErrNotExist):
		return m, "", "", readErr
	case connection == "":
		return m, "", "", errors.New("this machine is not connected yet: give the connection string the dashboard shows (keelson-agent connect ksr1...)")
	}
	r, err := register(ctx, connection, name, false, hc)
	if err != nil {
		return m, "", "", err
	}
	if err := saveMachine(dir, r); err != nil {
		return m, "", "", err
	}
	say("enrolled as %s with %s; files are in %s", r.m.Name, r.m.Dashboard, string(dir))
	return r.m, r.token, r.secret, nil
}

// decodeMachine reads relay.json.
func decodeMachine(raw []byte) (machine, error) {
	var m machine
	if err := json.Unmarshal(raw, &m); err != nil || m.Dashboard == "" || m.Credential == "" {
		return machine{}, errors.New("it needs the dashboard and the credential")
	}
	return m, nil
}

// readMachine reads the relay file `serve --relay-file` is given.
func readMachine(path string) (machine, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return machine{}, fmt.Errorf("--relay-file: %w", err)
	}
	m, err := decodeMachine(raw)
	if err != nil {
		return machine{}, fmt.Errorf("--relay-file %s is not a relay file (%w): it is the relay.json that `keelson-agent install --connect` writes", path, err)
	}
	return m, nil
}

func readSecret(path string) (string, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return "", fmt.Errorf("%w: delete its directory and connect again with a new code", err)
	}
	return strings.TrimSpace(string(b)), nil
}

// registration is what enrolling gave this machine: its identity, and the two secrets made here and handed to the
// dashboard once. The dashboard signs its requests with them, as it does for any server.
type registration struct {
	m             machine
	token, secret string
}

// register enrols this machine with the dashboard the connection string names and returns what it was given. It writes
// nothing, so a refused code leaves the machine as it was. serves says whether this is a full agent that can run apps
// (a server installed with `install --connect`) or a machine that only builds (`connect`).
func register(ctx context.Context, connection, name string, serves bool, hc *http.Client) (r registration, err error) {
	dashboard, code, err := parseConnection(connection)
	if err != nil {
		return r, err
	}
	if r.token, err = randomSecret(); err != nil {
		return r, err
	}
	if r.secret, err = randomSecret(); err != nil {
		return r, err
	}
	host, _ := os.Hostname()
	if name == "" {
		name = machineName(host)
	}

	body, _ := json.Marshal(map[string]any{
		"code": code, "name": name, "token": r.token, "deploy_secret": r.secret, "version": version,
		"os": runtime.GOOS, "arch": runtime.GOARCH, "hostname": host, "serves": serves,
	})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, dashboard+"/api/relay/enrol", bytes.NewReader(body))
	if err != nil {
		return r, err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := hc.Do(req)
	if err != nil {
		return r, fmt.Errorf("cannot reach the dashboard at %s: %w", dashboard, unwrapURLError(err))
	}
	defer resp.Body.Close()
	answer, _ := io.ReadAll(io.LimitReader(resp.Body, 64<<10))
	var out struct {
		Credential string `json:"credential"`
		ServerID   string `json:"server_id"`
		Name       string `json:"name"`
		Error      string `json:"error"`
	}
	_ = json.Unmarshal(answer, &out)
	switch {
	case resp.StatusCode == http.StatusUnauthorized:
		return r, errors.New("the code was refused: it is wrong, already used or expired (a code works once, for 30 minutes): get a new one in the dashboard")
	case resp.StatusCode == http.StatusTooManyRequests:
		return r, errors.New("the dashboard says too many attempts: wait a minute and try again")
	case resp.StatusCode != http.StatusOK:
		if out.Error != "" {
			return r, fmt.Errorf("the dashboard refused to enrol this machine: %s", out.Error)
		}
		return r, fmt.Errorf("the dashboard answered %s", resp.Status)
	case out.Credential == "" || out.ServerID == "":
		return r, errors.New("the dashboard's answer has no credential: is this a Keelson dashboard that supports connecting servers?")
	}

	r.m = machine{Dashboard: dashboard, Credential: out.Credential, ServerID: out.ServerID, Name: out.Name}
	if r.m.Name == "" {
		r.m.Name = name
	}
	return r, nil
}

// relayJSON is what relay.json holds for a machine.
func (m machine) relayJSON() []byte {
	enc, _ := json.MarshalIndent(m, "", "  ")
	return append(enc, '\n')
}

// saveMachine writes the files of an enrolled machine into its directory, all private. relay.json is written last, so a
// directory that has it is complete.
func saveMachine(dir machineDir, r registration) error {
	if err := os.MkdirAll(dir.dataDir(), 0o700); err != nil {
		return err
	}
	if err := writePrivate(dir.token(), []byte(r.token+"\n")); err != nil {
		return err
	}
	if err := writePrivate(dir.secret(), []byte(r.secret+"\n")); err != nil {
		return err
	}
	// What the dashboard edits through the config API; kept when the directory already has one.
	if _, err := os.Stat(dir.apps()); errors.Is(err, os.ErrNotExist) {
		if err := writePrivate(dir.apps(), []byte("apps: []\n")); err != nil {
			return err
		}
	}
	return writePrivate(dir.relay(), r.m.relayJSON())
}

// connectionString is what the dashboard shows, made from a dashboard's URL and a code: "ksr1." and the base64url of
// {"u": URL, "c": code}. `install --dashboard URL --code CODE` builds it so that the URL goes through the same checks.
func connectionString(dashboard, code string) string {
	b, _ := json.Marshal(map[string]string{"u": dashboard, "c": code})
	return relayPrefix + base64.RawURLEncoding.EncodeToString(b)
}

// parseConnection reads the string the dashboard shows: "ksr1." and the base64url of {"u": dashboard URL, "c": code}.
func parseConnection(s string) (dashboard, code string, err error) {
	s = strings.TrimSpace(s)
	bad := errors.New("that is not a connection string: copy the whole command the dashboard shows (it ends with ksr1...)")
	if !strings.HasPrefix(s, relayPrefix) {
		return "", "", bad
	}
	raw, err := base64.RawURLEncoding.DecodeString(strings.TrimRight(strings.TrimPrefix(s, relayPrefix), "="))
	if err != nil {
		return "", "", bad
	}
	var v struct {
		U string `json:"u"`
		C string `json:"c"`
	}
	if json.Unmarshal(raw, &v) != nil || v.U == "" || v.C == "" {
		return "", "", bad
	}
	u, err := url.Parse(v.U)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return "", "", fmt.Errorf("the connection string names %q, which is not the URL of a dashboard", v.U)
	}
	// The code, the token and the deploy secret go to this URL, and every later request is signed for it: in the clear, anyone
	// on the way could read them. Plain http is for a dashboard on this very machine, to try things out.
	if u.Scheme != "https" && !loopbackHost(u.Hostname()) {
		return "", "", fmt.Errorf("the dashboard %q is not https: the machine would send it its secrets in the clear. Set the dashboard's public URL to an https one", v.U)
	}
	return strings.TrimRight(v.U, "/"), v.C, nil
}

func randomSecret() (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}

// writePrivate writes a file only its owner can read, by writing a sibling and renaming it over the target: a crash
// leaves the old file or the new one, and the secret is never readable by others, not even for a moment.
func writePrivate(path string, data []byte) error {
	f, err := os.CreateTemp(filepath.Dir(path), ".tmp-*")
	if err != nil {
		return err
	}
	_, err = f.Write(data)
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err == nil {
		err = os.Rename(f.Name(), path)
	}
	if err != nil {
		os.Remove(f.Name())
	}
	return err
}

func unwrapURLError(err error) error {
	var ue *url.Error
	if errors.As(err, &ue) {
		return ue.Err
	}
	return err
}

// machineNameIllegal matches what a server name may not contain in the dashboard (letters, digits, space, ".", "_", "-").
var machineNameIllegal = regexp.MustCompile(`[^\p{L}\p{N} ._-]`)

// machineName makes a name the dashboard accepts out of a host name such as "Marc's MacBook.local": illegal characters
// become "-", it starts with a letter or digit, and it is at most 60 characters.
func machineName(host string) string {
	n := machineNameIllegal.ReplaceAllString(host, "-")
	n = strings.TrimLeftFunc(n, func(r rune) bool { return !unicode.IsLetter(r) && !unicode.IsNumber(r) })
	var b strings.Builder
	units := 0
	for _, r := range n {
		units += len(utf16.Encode([]rune{r})) // the dashboard counts UTF-16 units, as JavaScript does
		if units > 60 {
			break
		}
		b.WriteRune(r)
	}
	if name := strings.TrimSpace(b.String()); name != "" {
		return name
	}
	return "build-machine"
}

// dockerSocket is where the Docker engine's socket was looked for.
type dockerSocket struct {
	// path is the socket found or, when there is none, where Docker is expected to create it.
	path  string
	found bool
	tried []string
}

// detectSocket finds the Docker engine's socket. An explicit path wins. Otherwise it takes the first that exists of
// $DOCKER_HOST (a unix:// address), /var/run/docker.sock and Docker Desktop's $HOME/.docker/run/docker.sock; hostFirst
// puts $DOCKER_HOST ahead of /var/run/docker.sock. When none exists the path is the one the engine is expected to
// create on this system, so that an engine started later is found without a restart.
func detectSocket(explicit string, hostFirst bool) dockerSocket {
	if explicit != "" {
		_, err := os.Stat(explicit)
		return dockerSocket{path: explicit, found: err == nil, tried: []string{explicit}}
	}
	var candidates []string
	host := ""
	if h, ok := strings.CutPrefix(os.Getenv("DOCKER_HOST"), "unix://"); ok {
		host = h
	}
	if host != "" && hostFirst {
		candidates = append(candidates, host)
	}
	candidates = append(candidates, "/var/run/docker.sock")
	if host != "" && !hostFirst {
		candidates = append(candidates, host)
	}
	desktop := ""
	if home, err := os.UserHomeDir(); err == nil {
		desktop = filepath.Join(home, ".docker", "run", "docker.sock")
		candidates = append(candidates, desktop)
	}
	for _, c := range candidates {
		if fi, err := os.Stat(c); err == nil && fi.Mode()&os.ModeSocket != 0 {
			return dockerSocket{path: c, found: true, tried: candidates}
		}
	}
	expected := "/var/run/docker.sock"
	if runtime.GOOS == "darwin" && desktop != "" {
		expected = desktop
	}
	return dockerSocket{path: expected, tried: candidates}
}

func loopbackHost(host string) bool {
	ip := net.ParseIP(host)
	return host == "localhost" || (ip != nil && ip.IsLoopback())
}

// noRedirect makes a redirect an answer like any other: the dashboard's relay API never redirects, and following one would
// send the secrets of the enrolment (or the credential) wherever the answer points.
func noRedirect(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
