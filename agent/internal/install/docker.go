package install

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/user"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"
)

// DockerProbe is what the installer learns about the engine's socket. It is gathered before anything is changed, so that
// an engine the agent cannot use is refused while a one-time code is still unspent.
type DockerProbe struct {
	// Socket is the path asked about; Resolved is where it leads once links are followed (empty when it does not exist).
	Socket, Resolved string
	// Group is the name of the group that owns the socket, and Open tells that any account may use it anyway.
	Group string
	Open  bool
	// Server is the Server header of the engine's /_ping answer; PingErr is why there was none.
	Server  string
	PingErr error
}

// DockerProbe asks the engine at socket whether it answers, and looks at who may use the socket.
func (hostSystem) DockerProbe(socket string) DockerProbe {
	probe := DockerProbe{Socket: socket}
	if resolved, err := filepath.EvalSymlinks(socket); err == nil {
		probe.Resolved = resolved
	}
	if info, err := os.Stat(socket); err == nil {
		probe.Open = info.Mode().Perm()&0o006 == 0o006
		if st, ok := info.Sys().(*syscall.Stat_t); ok {
			if g, err := user.LookupGroupId(strconv.Itoa(int(st.Gid))); err == nil {
				probe.Group = g.Name
			}
		}
	}
	probe.Server, probe.PingErr = pingDocker(socket)
	return probe
}

// pingDocker calls the engine's /_ping and returns the Server header it answered with.
func pingDocker(socket string) (string, error) {
	hc := &http.Client{
		Timeout: 5 * time.Second,
		Transport: &http.Transport{DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			return (&net.Dialer{}).DialContext(ctx, "unix", socket)
		}},
	}
	defer hc.CloseIdleConnections()
	resp, err := hc.Get("http://docker/_ping")
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("the engine answered %d", resp.StatusCode)
	}
	return resp.Header.Get("Server"), nil
}

// dockerGroup is the group the agent's account is given to reach the engine.
const dockerGroup = "docker"

// checkDocker refuses a server whose Docker engine the agent could not use: not installed, stopped, rootless, podman,
// or reachable by no group the agent's account can be put in. Every refusal says what to do.
func checkDocker(sys System, p Paths) error {
	_, lookErr := sys.LookPath("docker")
	socket := p.at("var/run/docker.sock")
	probe := sys.DockerProbe(socket)
	if lookErr != nil && probe.Resolved == "" && !fileExists(socket) {
		return errors.New("Docker is not installed on this server: install it first (https://docs.docker.com/engine/install/)")
	}
	where := probe.Resolved
	if where == "" {
		where = probe.Socket
	}
	if rootlessSocket(where) {
		return fmt.Errorf("rootless Docker is not supported: the agent needs the system-wide Docker engine, and %s belongs to one user's session. Install Docker Engine normally (https://docs.docker.com/engine/install/)", where)
	}
	if podmanEngine(where, probe.Server) {
		return errors.New("podman is not supported: the agent needs Docker Engine (https://docs.docker.com/engine/install/)")
	}
	if probe.PingErr != nil {
		return fmt.Errorf("Docker is installed but not running (nothing answers on %s: %v): start it with `sudo systemctl start docker`, then run this again", probe.Socket, probe.PingErr)
	}
	if !probe.Open {
		if !sys.GroupExists(dockerGroup) {
			return fmt.Errorf("the %q group does not exist, so the %s account could not be given access to Docker: create it (`sudo groupadd docker`), make it own %s (`sudo chgrp docker %s`), then run this again", dockerGroup, ServiceUser, probe.Socket, probe.Socket)
		}
		if probe.Group != dockerGroup {
			return fmt.Errorf("the Docker socket %s belongs to the group %q, not %q, so the %s account could not use it: make the %s group own it (`sudo chgrp docker %s`), then run this again", probe.Socket, probe.Group, dockerGroup, ServiceUser, dockerGroup, probe.Socket)
		}
	}
	return nil
}

// rootlessSocket tells a socket of a user's own engine: those live under the user's runtime directory.
func rootlessSocket(path string) bool {
	for _, prefix := range []string{"/run/user/", "/var/run/user/"} {
		if strings.HasPrefix(path, prefix) {
			return true
		}
	}
	return false
}

// podmanEngine tells podman answering where Docker is expected (the podman-docker package does that on purpose).
func podmanEngine(path, server string) bool {
	s := strings.ToLower(path + " " + server)
	return strings.Contains(s, "podman") || strings.Contains(s, "libpod")
}
