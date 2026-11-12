package install

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strings"
	"time"
)

// Registration is what enrolling with a dashboard gave this server. The token and the deploy secret were made on this
// server and handed to the dashboard, which signs its requests with them; the dashboard's credential is in RelayJSON.
type Registration struct {
	Token, DeploySecret string
	// RelayJSON is what relay.json holds: where the dashboard is and the credential that proves this server to it.
	RelayJSON []byte
	// Name is what the dashboard calls this server.
	Name, ServerID, Dashboard string
}

// Register enrols this server with a dashboard and returns what it was given. It writes nothing: a refused code
// leaves the server as it was.
type Register func(ctx context.Context) (Registration, error)

// Connected says what a connected server is, for the person running the install. Nothing in it is secret.
type Connected struct {
	Name         string `json:"name"`
	ServerID     string `json:"server_id"`
	Dashboard    string `json:"dashboard"`
	AgentVersion string `json:"agent_version"`
}

// IsConnected tells whether the server under root is set up to connect out to a dashboard (relay.json exists).
func IsConnected(root string) bool { return fileExists(Paths{rootOrSlash(root)}.Relay()) }

func rootOrSlash(root string) string {
	if root == "" {
		return "/"
	}
	return root
}

// settleTime is how long a freshly started connected agent must stay up for the install to call it running.
const settleTime = 5 * time.Second

// InstallConnected sets this server up to connect out to a dashboard, or with o.Upgrade replaces the program of one that
// already does. The server serves apps like a directly reached one; the difference is the transport: the agent dials
// the dashboard (no port is opened, no certificate is made) and the dashboard's requests come back over that connection.
//
// The order keeps a failure harmless. The dashboard is asked first, and a refused code leaves nothing behind, not even
// the account. relay.json is written after everything it depends on, and the service starts only once it exists. An
// upgrade that does not start is put back as it was, like a direct one.
func InstallConnected(ctx context.Context, o Options, register Register) (Connected, error) {
	if err := o.commonDefaults(); err != nil {
		return Connected{}, err
	}
	p := Paths{o.Root}
	sys := o.Sys

	if _, err := sys.LookPath("systemctl"); err != nil {
		return Connected{}, errors.New("systemd is required: this server does not run it")
	}
	// The agent does not start without an engine it can use, so a server that connects "anyway" would never be heard
	// from: refuse before the dashboard spends the code, as a direct install does.
	if !o.SkipDockerCheck {
		if err := checkDocker(sys, p); err != nil {
			return Connected{}, err
		}
	}
	var reg Registration
	if o.Upgrade {
		known, err := readRelay(p)
		if err != nil {
			return Connected{}, err
		}
		for _, f := range []string{p.Token(), p.DeploySecret()} {
			if !fileExists(f) {
				return Connected{}, fmt.Errorf("%s is missing: this server's files are damaged. Uninstall it and connect it again with a new code", f)
			}
		}
		reg.Name, reg.ServerID, reg.Dashboard = known.Name, known.ServerID, known.Dashboard
	} else {
		if fileExists(p.Relay()) {
			return Connected{}, fmt.Errorf("this server is already connected to a dashboard (%s exists). To connect it again, to this or another dashboard, run `keelson-agent uninstall` (it removes that file; delete the server in the dashboard too), then install again with a new code. To upgrade it, use `keelson-agent install --upgrade`", p.Relay())
		}
		if unit, err := os.ReadFile(p.Unit()); err == nil && !strings.Contains(string(unit), "--relay-file") {
			return Connected{}, fmt.Errorf("this server already has an agent that the dashboard reaches directly (%s): uninstall it first (`keelson-agent uninstall`), then connect it", p.Unit())
		}
		o.Log("registering with the dashboard")
		var err error
		if reg, err = register(ctx); err != nil {
			return Connected{}, err
		}
	}

	o.Log("creating the %s account and its directories", ServiceUser)
	if err := sys.EnsureUser(ServiceUser, []string{"docker"}); err != nil {
		return Connected{}, fmt.Errorf("create the %s account: %w", ServiceUser, err)
	}
	if err := mkdir(sys, p.ConfDir(), 0o750, "root", ServiceUser); err != nil {
		return Connected{}, err
	}
	// The agent rewrites its apps file by renaming a new one over it, so it needs write access to the directory.
	if err := mkdir(sys, p.ConfigDir(), 0o750, ServiceUser, ServiceUser); err != nil {
		return Connected{}, err
	}
	if err := mkdir(sys, p.DataDir(), 0o700, ServiceUser, ServiceUser); err != nil {
		return Connected{}, err
	}

	o.Log("installing the agent")
	prevUnit, unitErr := os.ReadFile(p.Unit())
	hadUnit := unitErr == nil
	prevBinary := p.Binary() + ".prev"
	hadBinary := fileExists(p.Binary()) && copyBinary(p.Binary(), prevBinary) == nil
	dbBefore := snapshotsOf(p)
	if err := copyBinary(o.Binary, p.Binary()); err != nil {
		return Connected{}, fmt.Errorf("install the binary: %w", err)
	}
	if err := put(sys, p.Unit(), []byte(renderUnit(unitSpec{Connected: true})), 0o644, "", ""); err != nil {
		return Connected{}, err
	}

	if !o.Upgrade {
		// Readable by the agent's group only, and not writable by it: it reads them, nothing else needs them.
		if err := put(sys, p.Token(), []byte(reg.Token+"\n"), 0o640, "root", ServiceUser); err != nil {
			return Connected{}, err
		}
		if err := put(sys, p.DeploySecret(), []byte(reg.DeploySecret+"\n"), 0o640, "root", ServiceUser); err != nil {
			return Connected{}, err
		}
		if !fileExists(p.Apps()) {
			if err := put(sys, p.Apps(), []byte(starterApps), 0o640, ServiceUser, ServiceUser); err != nil {
				return Connected{}, err
			}
		}
		// The last of the files: a directory that has it is complete.
		if err := put(sys, p.Relay(), reg.RelayJSON, 0o640, "root", ServiceUser); err != nil {
			return Connected{}, err
		}
	}

	o.Log("starting the service")
	if err := sys.Systemctl("daemon-reload"); err != nil {
		return Connected{}, err
	}
	if err := sys.Systemctl("enable", unitName); err != nil {
		return Connected{}, err
	}
	err := sys.Systemctl("restart", unitName)
	if err != nil {
		err = fmt.Errorf("start the agent: %w", err)
	} else if err = waitRunning(ctx, sys, o.settle); err != nil {
		err = fmt.Errorf("the agent did not stay up: %w", err)
	}
	if err != nil {
		if o.Upgrade && hadUnit {
			// An upgrade that does not start must not take a working agent down: put the previous one back.
			o.Log("the new version did not start: restoring the previous one")
			_ = put(sys, p.Unit(), prevUnit, 0o644, "", "")
			if hadBinary {
				_ = os.Rename(prevBinary, p.Binary())
			}
			restoreDatabase(sys, p, dbBefore, o.Log)
			_ = sys.Systemctl("daemon-reload")
			_ = sys.Systemctl("restart", unitName)
			return Connected{}, fmt.Errorf("%w (the previous version was restored; see: journalctl -u keelson-agent)", err)
		}
		if o.Upgrade {
			return Connected{}, fmt.Errorf("%w (see: journalctl -u keelson-agent)", err)
		}
		return Connected{}, fmt.Errorf("%w: the dashboard already lists this server (see: journalctl -u keelson-agent; once the cause is fixed, `systemctl restart keelson-agent` connects it)", err)
	}
	_ = os.Remove(prevBinary)
	return Connected{Name: reg.Name, ServerID: reg.ServerID, Dashboard: reg.Dashboard, AgentVersion: o.Version}, nil
}

// waitRunning checks the service is active now and stays so for the settle time (a crash makes systemd restart it after
// a pause, which shows as "activating", not "active").
func waitRunning(ctx context.Context, sys System, settle time.Duration) error {
	if settle == 0 {
		settle = settleTime
	}
	deadline := time.Now().Add(settle)
	for {
		if err := sys.Systemctl("is-active", "--quiet", unitName); err != nil {
			return fmt.Errorf("the service is not running: %w", err)
		}
		if !time.Now().Before(deadline) {
			return nil
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(500 * time.Millisecond):
		}
	}
}

// relayFile is the part of relay.json the installer reads, to say which server an upgrade was for.
type relayFile struct {
	Dashboard string `json:"dashboard"`
	ServerID  string `json:"server_id"`
	Name      string `json:"name"`
}

func readRelay(p Paths) (relayFile, error) {
	b, err := os.ReadFile(p.Relay())
	if errors.Is(err, os.ErrNotExist) {
		return relayFile{}, fmt.Errorf("this server is not connected to a dashboard (%s does not exist): connect it first, without --upgrade", p.Relay())
	}
	if err != nil {
		return relayFile{}, err
	}
	var r relayFile
	if json.Unmarshal(b, &r) != nil || r.Dashboard == "" {
		return relayFile{}, fmt.Errorf("%s is not readable: uninstall this server and connect it again with a new code", p.Relay())
	}
	return r, nil
}
