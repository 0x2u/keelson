package install

import (
	"context"
	"errors"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestDockerThatCannotBeUsedIsRefusedWithWhatToDo(t *testing.T) {
	down := errors.New("connect: connection refused")
	for name, c := range map[string]struct {
		probe *DockerProbe
		drop  bool // the machine has no docker program either
		group bool // the docker group is missing
		want  string
	}{
		"stopped":      {probe: &DockerProbe{Resolved: "/run/docker.sock", PingErr: down}, want: "sudo systemctl start docker"},
		"no socket":    {probe: &DockerProbe{PingErr: down}, want: "sudo systemctl start docker"},
		"not there":    {drop: true, want: "Docker is not installed"},
		"rootless":     {probe: &DockerProbe{Resolved: "/run/user/1000/docker.sock", Group: "alice", Server: "Docker/27"}, want: "rootless Docker is not supported"},
		"podman":       {probe: &DockerProbe{Resolved: "/run/podman/podman.sock", Group: "root", Server: "Libpod/5.2 (linux)"}, want: "podman is not supported"},
		"podman shim":  {probe: &DockerProbe{Resolved: "/var/run/docker.sock", Group: "docker", Server: "Libpod/4.9 (linux)"}, want: "podman is not supported"},
		"no group":     {group: true, want: `the "docker" group does not exist`},
		"other group":  {probe: &DockerProbe{Resolved: "/var/run/docker.sock", Group: "root", Server: "Docker/27"}, want: `belongs to the group "root"`},
		"open socket":  {probe: &DockerProbe{Resolved: "/var/run/docker.sock", Group: "root", Open: true, Server: "Docker/27"}, group: true},
		"healthy":      {},
		"newer docker": {probe: &DockerProbe{Resolved: "/var/run/docker.sock", Group: "docker", Server: "Docker/99"}},
	} {
		t.Run(name, func(t *testing.T) {
			r := newRig(t)
			r.sys.docker = c.probe
			if c.drop {
				delete(r.sys.tools, "docker")
			}
			if c.group {
				r.sys.groups = map[string]bool{}
			}
			_, err := Install(context.Background(), r.opts)
			if c.want == "" {
				if err != nil {
					t.Fatalf("a usable engine is accepted: %v", err)
				}
				return
			}
			if err == nil || !strings.Contains(err.Error(), c.want) {
				t.Fatalf("want %q, got %v", c.want, err)
			}
			if len(r.sys.users) != 0 || exists(Paths{r.root}.Unit()) {
				t.Error("nothing may be changed on a server that is refused")
			}
		})
	}
}

func TestConnectedInstallRefusesAnEngineItCannotUseBeforeTheCodeIsSpent(t *testing.T) {
	for name, probe := range map[string]DockerProbe{
		"stopped":  {Resolved: "/var/run/docker.sock", PingErr: errors.New("connection refused")},
		"rootless": {Resolved: "/run/user/1000/docker.sock", Group: "alice"},
		"podman":   {Resolved: "/run/podman/podman.sock", Group: "root", Server: "Libpod/5"},
	} {
		t.Run(name, func(t *testing.T) {
			r, g := connectRig(t)
			r.sys.docker = &probe
			if _, err := r.connect(g); err == nil || g.calls != 0 {
				t.Fatalf("calls %d, err %v", g.calls, err)
			}
			if len(r.sys.users) != 0 {
				t.Error("nothing may be changed")
			}
		})
	}
}

// The real probe, against a socket that answers like an engine and against one that does not exist.
func TestHostProbeReadsThePingOfTheEngine(t *testing.T) {
	dir, err := os.MkdirTemp("/tmp", "kdock")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })
	socket := filepath.Join(dir, "docker.sock")
	l, err := net.Listen("unix", socket)
	if err != nil {
		t.Skip("no unix sockets here:", err)
	}
	srv := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		if req.URL.Path != "/_ping" {
			http.NotFound(w, req)
			return
		}
		w.Header().Set("Server", "Docker/27.3.1 (linux)")
		w.Write([]byte("OK"))
	})}
	go srv.Serve(l)
	t.Cleanup(func() { srv.Close() })

	probe := HostSystem().DockerProbe(socket)
	if probe.PingErr != nil || probe.Server != "Docker/27.3.1 (linux)" || probe.Resolved == "" {
		t.Errorf("%+v", probe)
	}
	if probe := HostSystem().DockerProbe(filepath.Join(dir, "none.sock")); probe.PingErr == nil || probe.Resolved != "" {
		t.Errorf("a socket that is not there does not answer: %+v", probe)
	}
}
