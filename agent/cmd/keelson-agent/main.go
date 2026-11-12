// Command keelson-agent runs on a managed server. `serve` exposes the HTTP
// API, read-only unless an apps file enables deployments; `ps`, `logs` and
// `stats` query the local Docker engine directly; `deploy` and `history` work
// on the agent's own state.
package main

import (
	"context"
	"crypto/tls"
	"errors"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"text/tabwriter"
	"time"
	_ "time/tzdata" // job schedules name time zones: embed the database so a minimal host works

	"github.com/0x2u/keelson/agent/internal/api"
	"github.com/0x2u/keelson/agent/internal/appenv"
	"github.com/0x2u/keelson/agent/internal/config"
	"github.com/0x2u/keelson/agent/internal/confmgr"
	"github.com/0x2u/keelson/agent/internal/deploy"
	"github.com/0x2u/keelson/agent/internal/docker"
	"github.com/0x2u/keelson/agent/internal/enroll"
	"github.com/0x2u/keelson/agent/internal/install"
	"github.com/0x2u/keelson/agent/internal/notify"
	"github.com/0x2u/keelson/agent/internal/proxy"
	"github.com/0x2u/keelson/agent/internal/relay"
	"github.com/0x2u/keelson/agent/internal/store"
)

// configPollEvery is how often the apps file is checked for edits made by hand.
const configPollEvery = 5 * time.Second

// postgresReconcileEvery is how often the managed PostgreSQL is checked and, when it is down, brought back.
const postgresReconcileEvery = 30 * time.Second

// version is set at build time with -ldflags "-X main.version=...".
var version = "dev"

const usage = `keelson-agent: agent for Keelson

Usage:
  keelson-agent serve [flags]            run the HTTP API (read-only unless --apps is set); --relay-file also dials out to a dashboard
  keelson-agent connect [CONNECTION-STRING]
                                         connect this machine to a dashboard as a build machine (no port is opened)
  keelson-agent ps [-a]                  list containers
  keelson-agent logs [-f] [-n N] NAME    print container logs
  keelson-agent stats NAME               stream container resource usage
  keelson-agent deploy --apps FILE APP TAG|sha256:DIGEST
                                         deploy an image to an app, locally
  keelson-agent history [-n N] [APP]     list recent deployments
  keelson-agent notify-test --apps FILE  send a test message on every notification channel
  keelson-agent doctor [--apps FILE] [--data-dir DIR] [--relay-file FILE]
                                         check this machine: Docker, the configuration and the files it names, disk, Caddy, the dashboard
  keelson-agent config validate --apps FILE [--format text|json|github] [--strict]
                                         check the files offline, with the file and line of each problem (exit 1 if invalid)
  keelson-agent config split --apps FILE --project NAME [--dry-run]
                                         move a project's apps, jobs and databases into projects.d/NAME.yaml
  keelson-agent config dump --apps FILE  print what the configuration makes the agent run, as JSON with the secrets hidden
  keelson-agent config migrate --apps FILE [--dry-run] [--drop-builders] [--pin-legacy-defaults] [--no-backup] [--allow-leftovers]
                                         rewrite the files from the legacy schema to schema v1 (keeps <file>.pre-v1)
  keelson-agent install --connect STRING|--dashboard URL --code CODE [--name NAME]
                                         (root) set this server up and connect it OUT to the dashboard: systemd, no port, no certificates
  keelson-agent install --upgrade        (root) replace the installed agent with this binary, keeping how it was set up
  keelson-agent install --host HOST      set the agent up on this server for a dashboard that reaches it (systemd, TLS, secrets); prints the bundle
  keelson-agent enroll-code [--ttl 15m]  (root) print a one-time enrolment string to paste into the dashboard's Add server
  keelson-agent uninstall [--purge [--purge-operator-files]] [--dry-run]   remove the agent from this server (the apps keep running)
  keelson-agent version

Run a subcommand with -h for its flags.
`

func main() {
	if len(os.Args) < 2 {
		fmt.Fprint(os.Stderr, usage)
		os.Exit(2)
	}
	cmd, args := os.Args[1], os.Args[2:]

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	var err error
	switch cmd {
	case "serve":
		err = serve(ctx, args)
	case "connect":
		err = connectCmd(ctx, args)
	case "ps":
		err = ps(ctx, args)
	case "logs":
		err = logs(ctx, args)
	case "stats":
		err = stats(ctx, args)
	case "deploy":
		err = deployCmd(ctx, args)
	case "history":
		err = history(ctx, args)
	case "notify-test":
		err = notifyTest(ctx, args)
	case "doctor":
		err = doctorCmd(ctx, args)
	case "config":
		err = configCmd(ctx, args)
	case "install":
		err = installCmd(ctx, args)
	case "enroll-code":
		err = enrollCodeCmd(ctx, args)
	case "uninstall":
		err = uninstallCmd(ctx, args)
	case "version":
		fmt.Println(version)
	case "-h", "--help", "help":
		fmt.Print(usage)
	default:
		fmt.Fprintf(os.Stderr, "unknown command %q\n\n%s", cmd, usage)
		os.Exit(2)
	}
	if err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return
		}
		var exit *exitError
		if errors.As(err, &exit) {
			if exit.err != nil {
				fmt.Fprintln(os.Stderr, "error:", exit.err)
			}
			os.Exit(exit.code)
		}
		fmt.Fprintln(os.Stderr, "error:", err)
		os.Exit(1)
	}
}

func env(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func newFlags(name string) (*flag.FlagSet, *string) {
	fs := flag.NewFlagSet(name, flag.ContinueOnError)
	socket := fs.String("docker-socket", env("KEELSON_DOCKER_SOCKET", detectSocket("", false).path), "path of the Docker engine unix socket (default /var/run/docker.sock; when it does not exist, the one $DOCKER_HOST or Docker Desktop names)")
	return fs, socket
}

func serve(ctx context.Context, args []string) error {
	fs, socket := newFlags("serve")
	listen := fs.String("listen", env("KEELSON_LISTEN", "127.0.0.1:7070"), "address to listen on")
	tokenFile := fs.String("token-file", env("KEELSON_TOKEN_FILE", ""), "file holding the API token (or set KEELSON_TOKEN)")
	certFile := fs.String("tls-cert", env("KEELSON_TLS_CERT", ""), "TLS certificate (PEM)")
	keyFile := fs.String("tls-key", env("KEELSON_TLS_KEY", ""), "TLS private key (PEM)")
	clientCA := fs.String("tls-client-ca", env("KEELSON_TLS_CLIENT_CA", ""), "CA (PEM) that must have signed client certificates: enables mTLS")
	insecure := fs.Bool("allow-insecure-http", false, "allow a non-loopback listen address without TLS")
	appsFile := fs.String("apps", env("KEELSON_APPS", ""), "apps file: enables deployments")
	projectsDir := fs.String("projects-dir", env("KEELSON_PROJECTS_DIR", ""), "directory of the per-project files (default: projects.d next to the apps file)")
	dataDir := fs.String("data-dir", env("KEELSON_DATA_DIR", "/var/lib/keelson"), "directory for the agent's database")
	secretFile := fs.String("deploy-secret-file", env("KEELSON_DEPLOY_SECRET_FILE", ""), "file holding the HMAC secret that signs deployment requests (or set KEELSON_DEPLOY_SECRET)")
	enrollDir := fs.String("enroll-dir", env("KEELSON_ENROLL_DIR", "/etc/keelson/enroll"), "directory of pending enrolment codes (see enroll-code): enrolment is on whenever mutual TLS and --apps are; empty turns it off")
	relayFile := fs.String("relay-file", env("KEELSON_RELAY_FILE", ""), "relay.json (see install --connect): also connect out to the dashboard and serve it, over that connection, what the listener serves. With --listen=\"\" the agent has no listener at all")
	if err := fs.Parse(args); err != nil {
		return err
	}

	log := slog.New(slog.NewTextHandler(os.Stderr, nil))

	token, err := loadSecret(*tokenFile, "KEELSON_TOKEN", "API token", "--token-file", log)
	if err != nil {
		return err
	}

	useTLS := *certFile != "" || *keyFile != ""
	if useTLS && (*certFile == "" || *keyFile == "") {
		return errors.New("--tls-cert and --tls-key must be set together")
	}
	if *clientCA != "" && !useTLS {
		return errors.New("--tls-client-ca requires --tls-cert and --tls-key")
	}
	switch {
	case *listen == "" && *relayFile == "":
		return errors.New(`--listen "" turns the listener off, which leaves the agent unreachable unless it dials out: give --relay-file as well`)
	case *listen == "" && useTLS:
		return errors.New(`--tls-cert and --tls-key are for a listener: there is none with --listen ""`)
	case *listen != "" && !useTLS && !isLoopback(*listen) && !*insecure:
		return fmt.Errorf("refusing to serve plain HTTP on %s: use TLS, listen on a loopback address, or pass --allow-insecure-http", *listen)
	}
	// The file is read before anything starts, so that one that cannot be used stops the agent with its name.
	var dash machine
	if *relayFile != "" {
		if dash, err = readMachine(*relayFile); err != nil {
			return err
		}
	}

	opts := api.Options{Token: token, Version: version, Logger: log}
	var stk *stack
	var st *store.Store
	if *appsFile != "" {
		secret, err := loadSecret(*secretFile, "KEELSON_DEPLOY_SECRET", "deploy secret", "--deploy-secret-file", log)
		if err != nil {
			return err
		}
		if stk, err = startStack(ctx, stackConfig{socket: *socket, appsFile: *appsFile, projectsDir: *projectsDir, dataDir: *dataDir, secret: secret, log: log}); err != nil {
			return err
		}
		defer stk.close()
		opts.Deploy, st = stk.api, stk.st
		go snapshotLoop(ctx, stk.st, filepath.Join(*dataDir, "snapshots"), log)
	}

	// The client CA is read once: it verifies client certificates and is what a redeemed enrolment code hands out.
	var clientCAPEM []byte
	if *clientCA != "" {
		if clientCAPEM, err = os.ReadFile(*clientCA); err != nil {
			return err
		}
		opts.RequireClientCert = true
		if *enrollDir != "" {
			switch {
			case st == nil:
				log.Info("enrolment is off: it needs an apps file, because redeemed codes are recorded in the agent's database")
			default:
				svc, err := enroll.New(enroll.Options{
					Dir: *enrollDir, CAPEM: string(clientCAPEM), Token: token, DeploySecret: opts.Deploy.Secret, Ledger: st, Log: log,
				})
				if err != nil {
					return err
				}
				opts.Enroller = svc
				go svc.Run(ctx, time.Minute)
				log.Info("enrolment is on: codes are read from", "dir", *enrollDir)
			}
		}
	}

	handler, err := api.New(docker.New(*socket), opts)
	if err != nil {
		return err
	}

	// Whatever ends first, a listener that failed or a dashboard that will not take this server back, ends the process
	// the same way: the relay stops first (it lets the requests it is answering finish), then the rest drains as ever.
	errc := make(chan error, 2)

	var srv *http.Server
	if *listen != "" {
		srv = &http.Server{
			Handler:           handler,
			ReadHeaderTimeout: 10 * time.Second,
			IdleTimeout:       60 * time.Second,
			// Streams end with the process: request contexts derive from ctx.
			BaseContext: func(net.Listener) context.Context { return ctx },
		}
		if useTLS {
			srv.TLSConfig = &tls.Config{MinVersion: tls.VersionTLS13}
			if *clientCA != "" {
				// With enrolment the handshake accepts a client without a certificate so that it can redeem a code;
				// the API refuses it everywhere else.
				if srv.TLSConfig, err = api.ServerTLSConfig(clientCAPEM, opts.Enroller != nil); err != nil {
					return fmt.Errorf("%s: %w", *clientCA, err)
				}
			}
		}

		ln, err := net.Listen("tcp", *listen)
		if err != nil {
			return err
		}
		// Idle sockets must not starve the API: a cap on open connections and, for TLS, a deadline on the handshake.
		ln = capListener(ln, maxConns)
		if useTLS {
			srv.ConnState = handshakeDeadline(tlsHandshakeTimeout)
		}
		log.Info("keelson-agent listening", "addr", ln.Addr().String(), "tls", useTLS, "mtls", *clientCA != "", "enrolment", opts.Enroller != nil, "version", version, "read_only", stk == nil)
		go func() {
			if useTLS {
				errc <- srv.ServeTLS(ln, *certFile, *keyFile)
			} else {
				errc <- srv.Serve(ln)
			}
		}()
	}

	// The same handler answers the dashboard's requests over the outbound connection: same paths, same authentication,
	// the whole stack. The audit log records "relay" as the peer.
	relayCtx, stopRelay := context.WithCancel(ctx)
	defer stopRelay()
	relayDone := make(chan struct{})
	if *relayFile != "" {
		log.Info("keelson-agent connecting out", "dashboard", dash.Dashboard, "name", dash.Name, "version", version, "read_only", stk == nil, "listener", srv != nil)
		// A link that stays down is an event like any other: the agent keeps its channels when the dashboard is away.
		var link *notify.LinkWatcher
		if stk != nil {
			link = notify.NewLinkWatcher(config.DashboardDownAfter, stk.notifier.Emit, log)
			defer link.Stop()
		}
		go func() {
			defer close(relayDone)
			err := relay.Run(relayCtx, relay.Options{
				Dashboard: dash.Dashboard, Credential: dash.Credential, Name: dash.Name, Handler: handler,
				Logf:   func(format string, a ...any) { log.Info(fmt.Sprintf(format, a...), "relay", dash.Dashboard) },
				OnUp:   func() { link.Connected() },
				OnDown: func(reason string) { link.Disconnected(reason) },
			})
			if err != nil {
				errc <- relayStopped(err)
			}
		}()
	} else {
		close(relayDone)
	}

	var runErr error
	select {
	case runErr = <-errc:
	case <-ctx.Done():
	}
	log.Info("shutting down")
	stopRelay()
	<-relayDone
	if stk != nil {
		stk.beginShutdown()
	}
	if srv != nil {
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := srv.Shutdown(shutdownCtx); err != nil {
			_ = srv.Close()
		}
	}
	if stk != nil {
		stk.drain(log)
	}
	return runErr
}

// relayStopped says what an end of the relay that is not a shutdown means for the process. When the dashboard does not
// know this server any more, or another process took its place, starting again would be refused again: the exit status
// tells the connected unit not to restart (see install.ExitStopRestarting) instead of hammering the dashboard.
func relayStopped(err error) error {
	if errors.Is(err, relay.ErrRevoked) {
		err = fmt.Errorf("%w. A server installed with `install --connect` is removed with `keelson-agent uninstall` and connected again with a new code", err)
	}
	return &exitError{install.ExitStopRestarting, err}
}

// loadSecret reads a secret from a file, or from an environment variable. A
// file is preferred: environment variables show up in process listings.
func loadSecret(file, envName, what, flagName string, log *slog.Logger) (string, error) {
	if file == "" {
		if t := strings.TrimSpace(os.Getenv(envName)); t != "" {
			return t, nil
		}
		return "", fmt.Errorf("no %s: set %s or %s", what, flagName, envName)
	}
	if fi, err := os.Stat(file); err == nil && fi.Mode().Perm()&0o077 != 0 {
		log.Warn("secret file is accessible by other users; chmod 600 it", "what", what, "file", file, "mode", fi.Mode().Perm().String())
	}
	b, err := os.ReadFile(file)
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(string(b)), nil
}

// openDeploy builds the deployer for an apps file. It takes an exclusive lock
// on the data directory: two processes deploying at once (a CLI deploy beside
// a running agent) would not see each other's per-app locks, and the second
// start would mistake the first one's live deployments for interrupted ones.
// With fallback set, an apps file that cannot be used makes it run the newest recorded version that can (see
// confmgr.Choose) and say so in the returned Fallback; without it that is an error.
func openDeploy(eng *docker.Admin, loc config.Location, dataDir string, log *slog.Logger, fallback bool) (*deploy.Deployer, *store.Store, *confmgr.Fallback, func(), error) {
	if err := os.MkdirAll(dataDir, 0o700); err != nil {
		return nil, nil, nil, nil, err
	}
	lock, err := os.OpenFile(filepath.Join(dataDir, "agent.lock"), os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return nil, nil, nil, nil, err
	}
	if err := syscall.Flock(int(lock.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		lock.Close()
		return nil, nil, nil, nil, fmt.Errorf("another keelson-agent is using %s: stop it, or deploy through its API", dataDir)
	}
	st, err := store.Open(filepath.Join(dataDir, "agent.db"))
	if err != nil {
		lock.Close()
		return nil, nil, nil, nil, fmt.Errorf("open database: %w", err)
	}
	cfg, fb, err := startConfigAt(loc, st, fallback)
	if err != nil {
		st.Close()
		lock.Close()
		return nil, nil, nil, nil, err
	}
	// The variables set through the API: files beside the database, never in it.
	envs, err := appenv.Open(filepath.Join(dataDir, "env"))
	if err != nil {
		st.Close()
		lock.Close()
		return nil, nil, nil, nil, fmt.Errorf("open the stored variables: %w", err)
	}
	d := deploy.New(eng, st, cfg, newProxy(cfg.Proxy), log)
	d.SetEnvStore(envs)
	return d, st, fb, func() { st.Close(); lock.Close() }, nil
}

// newProxy builds the driver for a proxy section. It returns a nil interface when there is none.
func newProxy(p *config.Proxy) deploy.Proxy {
	switch {
	case p == nil:
		return nil
	case p.Type == config.ProxyNginx:
		return proxy.NewNginx(*p)
	default:
		return proxy.New(*p)
	}
}

func isLoopback(addr string) bool {
	host, _, err := net.SplitHostPort(addr)
	if err != nil {
		return false
	}
	if host == "localhost" {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

func ps(ctx context.Context, args []string) error {
	fs, socket := newFlags("ps")
	all := fs.Bool("a", false, "include stopped containers")
	if err := fs.Parse(args); err != nil {
		return err
	}
	list, err := docker.New(*socket).ListContainers(ctx, *all)
	if err != nil {
		return err
	}
	tw := tabwriter.NewWriter(os.Stdout, 0, 4, 2, ' ', 0)
	fmt.Fprintln(tw, "ID\tNAME\tIMAGE\tSTATE\tSTATUS")
	for _, c := range list {
		fmt.Fprintf(tw, "%s\t%s\t%s\t%s\t%s\n", short(c.ID), c.Name, c.Image, c.State, c.Status)
	}
	return tw.Flush()
}

func short(id string) string {
	if len(id) > 12 {
		return id[:12]
	}
	return id
}

func logs(ctx context.Context, args []string) error {
	fs, socket := newFlags("logs")
	follow := fs.Bool("f", false, "follow new output")
	tail := fs.String("n", "100", `number of lines from the end, or "all"`)
	if err := fs.Parse(args); err != nil {
		return err
	}
	if fs.NArg() != 1 {
		return errors.New("usage: keelson-agent logs [-f] [-n N] NAME")
	}
	err := docker.New(*socket).Logs(ctx, fs.Arg(0), docker.LogOptions{Follow: *follow, Tail: *tail},
		func(l docker.LogLine) error {
			var out io.Writer = os.Stdout
			if l.Stream == "stderr" {
				out = os.Stderr
			}
			_, err := fmt.Fprintf(out, "%s %s\n", l.Time.Format(time.RFC3339), l.Line)
			return err
		})
	if ctx.Err() != nil {
		return nil // interrupted by the user
	}
	return err
}

func stats(ctx context.Context, args []string) error {
	fs, socket := newFlags("stats")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if fs.NArg() != 1 {
		return errors.New("usage: keelson-agent stats NAME")
	}
	fmt.Printf("%-10s %8s %22s %8s\n", "TIME", "CPU%", "MEM", "MEM%")
	err := docker.New(*socket).Stats(ctx, fs.Arg(0), func(s docker.Stats) error {
		fmt.Printf("%-10s %7.1f%% %10s / %-9s %7.1f%%\n", s.Time.Format("15:04:05"), s.CPUPercent, human(s.MemUsage), human(s.MemLimit), s.MemPercent)
		return nil
	})
	if ctx.Err() != nil {
		return nil
	}
	return err
}

func human(b uint64) string {
	const unit = 1024
	if b < unit {
		return fmt.Sprintf("%dB", b)
	}
	div, exp := uint64(unit), 0
	for n := b / unit; n >= unit; n /= unit {
		div *= unit
		exp++
	}
	return fmt.Sprintf("%.1f%ciB", float64(b)/float64(div), "KMGTPE"[exp])
}

func parseTarget(s string) deploy.Target {
	if strings.HasPrefix(s, "sha256:") {
		return deploy.Target{Digest: s}
	}
	return deploy.Target{Tag: s}
}

func deployCmd(ctx context.Context, args []string) error {
	fs, socket := newFlags("deploy")
	appsFile := fs.String("apps", env("KEELSON_APPS", ""), "apps file")
	projectsDir := fs.String("projects-dir", env("KEELSON_PROJECTS_DIR", ""), "directory of the per-project files (default: projects.d next to the apps file)")
	dataDir := fs.String("data-dir", env("KEELSON_DATA_DIR", "/var/lib/keelson"), "directory for the agent's database")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if *appsFile == "" || fs.NArg() != 2 {
		return errors.New("usage: keelson-agent deploy --apps FILE APP TAG|sha256:DIGEST")
	}

	d, st, _, closeDeploy, err := openDeploy(docker.NewAdmin(*socket), location(*appsFile, *projectsDir), *dataDir, slog.New(slog.NewTextHandler(io.Discard, nil)), false)
	if err != nil {
		return err
	}
	defer closeDeploy()
	// Reconcile first, exactly as `serve` does: a deployment cut short earlier
	// must be resolved before a new one starts.
	if err := d.Recover(ctx); err != nil {
		return fmt.Errorf("recover interrupted deployments: %w", err)
	}

	id, done, err := d.Start(ctx, fs.Arg(0), parseTarget(fs.Arg(1)), "cli")
	if err != nil {
		return err
	}

	var after int64
	printEvents := func() {
		events, err := st.Events(context.Background(), id, after)
		if err != nil {
			return
		}
		for _, e := range events {
			fmt.Printf("%s %-5s %s\n", e.Time.Local().Format("15:04:05"), e.Level, e.Message)
			after = e.Seq
		}
	}
	// An interrupt must not abandon a half-finished swap: keep waiting.
	interrupted := ctx.Done()
	tick := time.NewTicker(300 * time.Millisecond)
	defer tick.Stop()
wait:
	for {
		select {
		case <-done:
			break wait
		case <-tick.C:
			printEvents()
		case <-interrupted:
			fmt.Fprintln(os.Stderr, "interrupted: waiting for the deployment to finish so the server is not left half-swapped")
			interrupted = nil
		}
	}
	printEvents()

	dep, err := st.Deployment(context.Background(), id)
	if err != nil {
		return err
	}
	if dep.Status != store.StatusSucceeded {
		return fmt.Errorf("deployment %s: %s", dep.Status, dep.Error)
	}
	return nil
}

func history(ctx context.Context, args []string) error {
	fs := flag.NewFlagSet("history", flag.ContinueOnError)
	dataDir := fs.String("data-dir", env("KEELSON_DATA_DIR", "/var/lib/keelson"), "directory for the agent's database")
	n := fs.Int("n", 20, "number of deployments to show")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if fs.NArg() > 1 || *n < 1 {
		return errors.New("usage: keelson-agent history [-n N] [APP]")
	}
	if _, err := os.Stat(filepath.Join(*dataDir, "agent.db")); err != nil {
		return fmt.Errorf("no database in %s: %w", *dataDir, err)
	}
	st, err := store.Open(filepath.Join(*dataDir, "agent.db"))
	if err != nil {
		return err
	}
	defer st.Close()
	app := ""
	if fs.NArg() == 1 {
		app = fs.Arg(0)
	}
	list, err := st.ListDeployments(ctx, app, *n)
	if err != nil {
		return err
	}
	tw := tabwriter.NewWriter(os.Stdout, 0, 4, 2, ' ', 0)
	fmt.Fprintln(tw, "ID\tAPP\tIMAGE\tSTATUS\tTRIGGER\tSTARTED")
	for _, d := range list {
		fmt.Fprintf(tw, "%s\t%s\t%s\t%s\t%s\t%s\n", d.ID, d.App, d.Ref, d.Status, d.Trigger, d.StartedAt.Local().Format("2006-01-02 15:04:05"))
	}
	return tw.Flush()
}

// notifyTest sends a test message on every configured channel and says which
// ones worked, so a mistyped token is found now and not during an incident.
func notifyTest(ctx context.Context, args []string) error {
	fs := flag.NewFlagSet("notify-test", flag.ContinueOnError)
	appsFile := fs.String("apps", env("KEELSON_APPS", ""), "apps file")
	projectsDir := fs.String("projects-dir", env("KEELSON_PROJECTS_DIR", ""), "directory of the per-project files (default: projects.d next to the apps file)")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if *appsFile == "" {
		return errors.New("usage: keelson-agent notify-test --apps FILE")
	}
	cfg, err := config.LoadFrom(location(*appsFile, *projectsDir))
	if err != nil {
		return err
	}
	if cfg.Notifications == nil {
		return errors.New("the apps file has no notifications section")
	}
	n, err := notify.New(cfg.Notifications, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err != nil {
		return err
	}
	if len(n.Channels()) == 0 {
		return errors.New("no webhook or telegram channel is configured")
	}
	failed := 0
	for _, r := range n.Test(ctx) {
		if r.Err != nil {
			failed++
			fmt.Printf("FAIL  %s: %v\n", r.Channel, r.Err)
		} else {
			fmt.Printf("ok    %s\n", r.Channel)
		}
	}
	if failed > 0 {
		return fmt.Errorf("%d channel(s) failed", failed)
	}
	return nil
}

// imageStaging is where an image archive sent by another server waits to be checked before it is loaded. The directory
// is private to the agent and emptied of what an interrupted import left behind.
func imageStaging(dataDir string) string {
	dir := filepath.Join(dataDir, "image-staging")
	_ = os.RemoveAll(dir)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return os.TempDir()
	}
	return dir
}

// snapshotLoop keeps a copy of agent.db a day: the deployment history, what serves, the previews and the ledgers. Seven
// copies stay, in the data directory (the same disk: they are for a corrupted or replaced file, not for the loss of the
// machine, which is what the dashboard's own backup and the server's are for). A copy is skipped when a recent one exists.
func snapshotLoop(ctx context.Context, st *store.Store, dir string, log *slog.Logger) {
	const every, keep = 20 * time.Hour, 7
	for {
		if path, err := st.SnapshotInto(ctx, dir, time.Now(), every, keep); err != nil && ctx.Err() == nil {
			log.Warn("could not copy the agent database", "dir", dir, "err", err)
		} else if path != "" {
			log.Info("copied the agent database", "to", path)
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(time.Hour):
		}
	}
}
