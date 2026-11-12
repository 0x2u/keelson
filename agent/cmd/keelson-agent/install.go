package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/0x2u/keelson/agent/internal/enroll"
	"github.com/0x2u/keelson/agent/internal/install"
)

// installCmd sets the agent up on this server. Directly reached (the default): it prints the connection bundle (JSON) on
// stdout. Connected (--connect, or --dashboard and --code): the agent dials out to the dashboard and there is no bundle;
// stdout has a short JSON that says which server it is, and no secret. Progress goes to stderr either way, so
// `keelson-agent install ... > bundle.json` yields a clean file.
func installCmd(ctx context.Context, args []string) error {
	fs := flag.NewFlagSet("install", flag.ContinueOnError)
	listen := fs.String("listen", install.DefaultListen, "address the agent listens on")
	hosts := fs.String("host", "", "comma-separated host names or addresses the dashboard reaches this server by (required, except with --connect)")
	name := fs.String("name", "", "label of this server in the dashboard (default: the host name)")
	nginx := fs.Bool("nginx", false, "prepare for switching traffic through nginx: a directory for the upstream file and the right to test and reload nginx")
	allow := fs.String("allow-from", "", `open the agent's port in ufw for this address ("auto": the address of the SSH session running this command)`)
	root := fs.String("root", "", "install under this directory instead of / (testing)")
	upgrade := fs.Bool("upgrade", false, "replace the installed agent with this binary, keeping how it was set up (no other flag is needed)")
	noCode := fs.Bool("no-enrolment-code", false, "do not end with a one-time enrolment code (the dashboard's SSH install does not need one)")
	connect := fs.String("connect", "", "connect this server to a dashboard, outbound: the connection string the dashboard shows (ksr1...). No port is opened and no certificate is made")
	dashboard := fs.String("dashboard", "", "with --code: the dashboard's URL, instead of a connection string")
	code := fs.String("code", "", "with --dashboard: the one-time code the dashboard shows")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if fs.NArg() != 0 {
		return fmt.Errorf("install takes no argument, got %q", fs.Arg(0))
	}
	if *root == "" && os.Geteuid() != 0 {
		return errors.New("run it as root (sudo keelson-agent install ...)")
	}
	log := func(format string, a ...any) { fmt.Fprintf(os.Stderr, "keelson: "+format+"\n", a...) }

	connection, err := connectionFor(*connect, *dashboard, *code)
	if err != nil {
		return err
	}
	switch {
	case connection != "" && *upgrade:
		return errors.New("--upgrade keeps how the server was set up and needs no code: give it without --connect, --dashboard or --code")
	case connection != "":
		var direct []string
		fs.Visit(func(f *flag.Flag) {
			switch f.Name {
			case "listen", "host", "nginx", "allow-from", "no-enrolment-code":
				direct = append(direct, "--"+f.Name)
			}
		})
		if len(direct) > 0 {
			return fmt.Errorf("%s belong to a server the dashboard reaches directly: with --connect nothing listens, so they have no meaning here", strings.Join(direct, ", "))
		}
		return installConnected(ctx, install.Options{Root: *root, Name: *name, Version: version, Log: log}, func(ctx context.Context) (install.Registration, error) {
			r, err := register(ctx, connection, *name, true, &http.Client{Timeout: 30 * time.Second, CheckRedirect: noRedirect})
			if err != nil {
				return install.Registration{}, err
			}
			return install.Registration{Token: r.token, DeploySecret: r.secret, RelayJSON: r.m.relayJSON(), Name: r.m.Name, ServerID: r.m.ServerID, Dashboard: r.m.Dashboard}, nil
		})
	case *upgrade && install.IsConnected(*root):
		return installConnected(ctx, install.Options{Root: *root, Version: version, Upgrade: true, Log: log}, nil)
	}

	from := *allow
	if from == "auto" {
		// SSH_CLIENT is "<client ip> <client port> <server port>". sudo drops it: pass it through with sudo -E, or give the address.
		fields := strings.Fields(os.Getenv("SSH_CLIENT"))
		if len(fields) == 0 {
			return errors.New(`--allow-from auto needs SSH_CLIENT, which is not set: give the address explicitly`)
		}
		from = fields[0]
	}
	bundle, err := install.Install(ctx, install.Options{
		Root: *root, Listen: *listen, Hosts: strings.Split(*hosts, ","), Name: *name, Version: version,
		WithNginx: *nginx, AllowFrom: from, Upgrade: *upgrade, NoEnrolmentCode: *noCode, Log: log,
	})
	if err != nil {
		return err
	}
	if bundle.Enrolment != "" {
		// stdout is the bundle (a file or a pipe); the human reading the terminal gets the string on stderr too.
		fmt.Fprintf(os.Stderr, "keelson: to add this server in the dashboard, paste this into Add server > Enrol with a code (valid until %s, once):\n\n%s\n\n", bundle.EnrolmentExpires, bundle.Enrolment)
	}
	enc := json.NewEncoder(os.Stdout)
	enc.SetIndent("", "  ")
	return enc.Encode(bundle)
}

// connectionFor returns the connection string the flags name: --connect as given, or one made of --dashboard and --code
// (so that the URL goes through the same https-or-loopback check). It is empty when none of them was given.
func connectionFor(connect, dashboard, code string) (string, error) {
	switch {
	case connect != "" && (dashboard != "" || code != ""):
		return "", errors.New("give either --connect STRING, or --dashboard URL with --code CODE, not both")
	case connect != "":
		if _, _, err := parseConnection(connect); err != nil {
			return "", err
		}
		return connect, nil
	case dashboard == "" && code == "":
		return "", nil
	case dashboard == "" || code == "":
		return "", errors.New("--dashboard and --code go together: the dashboard's URL and the one-time code it shows")
	}
	s := connectionString(dashboard, code)
	if _, _, err := parseConnection(s); err != nil {
		return "", err
	}
	return s, nil
}

// installConnected runs the connected install or upgrade and prints who the server is on stdout.
func installConnected(ctx context.Context, o install.Options, reg install.Register) error {
	c, err := install.InstallConnected(ctx, o, reg)
	if err != nil {
		return err
	}
	if o.Upgrade {
		o.Log("upgraded to %s; %s stays connected to %s", c.AgentVersion, c.Name, c.Dashboard)
	} else {
		o.Log("connected as %s to %s: it shows up in the dashboard in a few seconds", c.Name, c.Dashboard)
	}
	enc := json.NewEncoder(os.Stdout)
	enc.SetIndent("", "  ")
	return enc.Encode(c)
}

// enrollCodeCmd makes a one-time enrolment code for this server and prints the enrolment string, and only that, on
// stdout: `keelson-agent enroll-code | pbcopy` works. When it expires goes to stderr.
func enrollCodeCmd(_ context.Context, args []string) error {
	fs := flag.NewFlagSet("enroll-code", flag.ContinueOnError)
	ttl := fs.Duration("ttl", enroll.DefaultTTL, "how long the code works (at most 24h)")
	addr := fs.String("url", "", "address the dashboard reaches this agent at, https://HOST[:PORT] (default: the host and port recorded by install)")
	root := fs.String("root", "", "read the installation under this directory instead of / (testing)")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if fs.NArg() != 0 {
		return errors.New("enroll-code takes no argument")
	}
	if *root == "" && os.Geteuid() != 0 {
		return errors.New("run it as root (sudo keelson-agent enroll-code): it signs a certificate with the CA key, which only root can read")
	}
	e, err := install.CreateEnrolment(install.EnrolOptions{Root: *root, TTL: *ttl, URL: *addr})
	if err != nil {
		return err
	}
	fmt.Fprintf(os.Stderr, "keelson: this code works once, until %s (%s from now). Paste the line below into the dashboard's Add server > Enrol with a code.\n", e.Expires.UTC().Format(time.RFC3339), time.Until(e.Expires).Round(time.Second))
	fmt.Println(e.String)
	return nil
}

// uninstallCmd removes the agent from this server and prints what it did (JSON) on stdout, progress on stderr. The apps'
// containers are left running; see install.Uninstall for what is kept and why.
func uninstallCmd(_ context.Context, args []string) error {
	fs := flag.NewFlagSet("uninstall", flag.ContinueOnError)
	purge := fs.Bool("purge", false, "also delete the apps file, secrets, certificates, data and the account")
	purgeOperator := fs.Bool("purge-operator-files", false, "with --purge, also delete the files under /etc/keelson the installer did not write (database password files, tokens); without it they are kept and listed")
	dryRun := fs.Bool("dry-run", false, "change nothing: print what would be removed and what would stay")
	root := fs.String("root", "", "uninstall from under this directory instead of / (testing)")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if *purgeOperator && !*purge {
		return errors.New("--purge-operator-files only means something with --purge")
	}
	if *root == "" && !*dryRun && os.Geteuid() != 0 {
		return errors.New("run it as root (sudo keelson-agent uninstall)")
	}
	rep, err := install.Uninstall(install.Options{
		Root: *root,
		Log:  func(format string, a ...any) { fmt.Fprintf(os.Stderr, "keelson: "+format+"\n", a...) },
	}, install.UninstallOptions{Purge: *purge, PurgeOperatorFiles: *purgeOperator, DryRun: *dryRun})
	// The report is printed even when a step failed: it says which ones did not.
	enc := json.NewEncoder(os.Stdout)
	enc.SetIndent("", "  ")
	if encErr := enc.Encode(rep); encErr != nil && err == nil {
		err = encErr
	}
	return err
}
