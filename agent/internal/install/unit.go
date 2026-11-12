package install

import (
	"fmt"
	"strings"
)

// ExitStopRestarting is the exit status with which `serve` ends when the dashboard will not take this machine back (it
// was removed there, or another process connected with its credential). A connected server's unit does not restart on it:
// doing so every few seconds would hammer the dashboard with a credential it refuses.
const ExitStopRestarting = 78

type unitSpec struct {
	Listen string
	Nginx  bool
	// Connected makes the agent dial out to the dashboard with /etc/keelson/relay.json: nothing listens, so there is no
	// address, no certificate and no enrolment directory.
	Connected bool
}

// renderUnit builds the systemd unit. The agent runs as an unprivileged account that is a member of the docker
// group (which is how it reaches the engine: that membership is root-equivalent on the host, and is why the agent
// is treated as root-equivalent everywhere else). Paths it must write are listed explicitly; the rest of /etc and
// /usr is read-only to it.
func renderUnit(u unitSpec) string {
	args := []string{"/usr/local/bin/keelson-agent serve"}
	if u.Connected {
		// "--listen=" with nothing after it: an empty value that needs no quoting in a unit file.
		args = append(args, "--relay-file /etc/keelson/relay.json", "--listen=")
	} else {
		args = append(args, "--listen "+u.Listen)
	}
	args = append(args,
		"--token-file /etc/keelson/token",
		"--deploy-secret-file /etc/keelson/deploy-secret",
		"--apps /etc/keelson/config/apps.yaml",
		"--data-dir /var/lib/keelson",
	)
	if !u.Connected {
		args = append(args,
			"--tls-cert /etc/keelson/tls/server.crt",
			"--tls-key /etc/keelson/tls/server.key",
			"--tls-client-ca /etc/keelson/tls/ca.crt",
			"--enroll-dir /etc/keelson/enroll",
		)
	}
	exec := strings.Join(args, " ")
	// The enrolment directory is writable so the agent can delete a code's file once it was redeemed; "-" keeps the
	// agent starting if the directory is ever missing (enrolment then simply finds no code).
	writable := "/etc/keelson/config -/etc/keelson/enroll /var/lib/keelson"
	hardening := "NoNewPrivileges=yes"
	if u.Nginx {
		// The nginx driver runs "sudo systemctl reload nginx": sudo needs privileges to be gained.
		writable += " -/etc/nginx/keelson"
		hardening = "# NoNewPrivileges is off: the nginx driver calls sudo for two commands (see /etc/sudoers.d/keelson)."
	}
	restart := "Restart=always"
	if u.Connected {
		restart += fmt.Sprintf("\nRestartPreventExitStatus=%d", ExitStopRestarting)
	}
	return fmt.Sprintf(`# Managed by keelson-agent install: changes may be overwritten when the agent is upgraded.
[Unit]
Description=Keelson agent
Documentation=https://github.com/0x2u/keelson
After=network-online.target docker.service
Wants=network-online.target

[Service]
Type=simple
User=%[1]s
Group=%[1]s
ExecStart=%[2]s
%[5]s
RestartSec=3
# The agent drains on SIGTERM (deployments, backups, jobs: up to ~150 s); systemd's default of 90 s would SIGKILL it mid-drain.
TimeoutStopSec=180
%[3]s
PrivateTmp=yes
ProtectSystem=full
ProtectHome=read-only
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
ReadWritePaths=%[4]s

[Install]
WantedBy=multi-user.target
`, ServiceUser, exec, hardening, writable, restart)
}
