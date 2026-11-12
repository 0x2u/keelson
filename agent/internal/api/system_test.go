package api

import (
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/0x2u/keelson/agent/internal/config"
	"github.com/0x2u/keelson/agent/internal/sysinfo"
)

func newSystemServer(t *testing.T, f *fakeDocker, asked *[]string) *httptest.Server {
	t.Helper()
	h, err := New(f, Options{Token: testToken, Logger: slog.New(slog.NewTextHandler(io.Discard, nil)),
		Host: func(paths ...string) sysinfo.Host {
			*asked = paths
			return sysinfo.Host{CPUs: 2, Load: &sysinfo.Load{One: 0.5}}
		}})
	if err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(h)
	t.Cleanup(srv.Close)
	return srv
}

func TestSystemMeasuresTheDiskWhereTheEngineKeepsItsData(t *testing.T) {
	var asked []string
	srv := newSystemServer(t, &fakeDocker{}, &asked)
	resp := do(t, "GET", srv.URL+"/v1/system", testToken)
	var out struct {
		OS, Arch string
		Host     struct{ CPUs int }
		Engine   struct{ Version string }
	}
	if resp.StatusCode != 200 || json.NewDecoder(resp.Body).Decode(&out) != nil || out.Engine.Version != "27.1.1" || out.Host.CPUs != 2 ||
		out.OS != "linux" || out.Arch != "arm64" {
		t.Fatalf("status %d, %+v", resp.StatusCode, out)
	}
	// The engine's directory first, "/" when the agent's account cannot read it.
	if len(asked) != 2 || asked[0] != "/var/lib/docker" || asked[1] != "/" {
		t.Errorf("disk paths %v", asked)
	}
}

func TestSystemReportsWhatThisServerAcceptsToBuildOnlyWhenItBuilds(t *testing.T) {
	read := func(builds BuildService) map[string]any {
		t.Helper()
		h, err := New(&fakeDocker{}, Options{Token: testToken, Logger: slog.New(slog.NewTextHandler(io.Discard, nil)),
			Host:   func(...string) sysinfo.Host { return sysinfo.Host{} },
			Deploy: &DeployOptions{Deployments: &fakeDeployments{}, Secret: testSecret, Builds: builds}})
		if err != nil {
			t.Fatal(err)
		}
		srv := httptest.NewServer(h)
		defer srv.Close()
		var out map[string]any
		if err := json.NewDecoder(do(t, "GET", srv.URL+"/v1/system", testToken).Body).Decode(&out); err != nil {
			t.Fatal(err)
		}
		return out
	}
	if _, ok := read(nil)["build"]; ok {
		t.Error("an agent that does not build has no build section")
	}
	got := read(&fakeBuilds{ceilings: config.BuildCeilings{
		Memory: 1 << 30, CPUs: 4, Timeout: 20 * time.Minute, MaxSource: 256 << 20, SourceHosts: []string{"git.example.com"}, HostNetwork: true, KeepImages: 3,
	}})["build"]
	want := map[string]any{"enabled": true, "limits": map[string]any{
		"memory": float64(1 << 30), "cpus": float64(4), "timeout_seconds": float64(1200), "max_source": float64(256 << 20),
		"source_hosts": []any{"git.example.com"}, "host_network": true, "keep_images": float64(3),
	}}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("got %v, want %v", got, want)
	}
}

func TestSystemStillAnswersWithTheHostWhenTheEngineIsDown(t *testing.T) {
	var asked []string
	srv := newSystemServer(t, &fakeDocker{infoErr: errors.New("socket: connection refused")}, &asked)
	resp := do(t, "GET", srv.URL+"/v1/system", testToken)
	b, _ := io.ReadAll(resp.Body)
	var out map[string]any
	if resp.StatusCode != 200 || json.Unmarshal(b, &out) != nil {
		t.Fatalf("status %d: %s", resp.StatusCode, b)
	}
	if out["engine_error"] != "docker engine error" || out["engine"] != nil || out["host"] == nil || out["os"] != nil || out["arch"] != nil {
		t.Errorf("unexpected answer: %s", b)
	}
	if strings.Contains(string(b), "connection refused") {
		t.Errorf("the engine's error leaked: %s", b)
	}
	if len(asked) != 2 || asked[0] != "" || asked[1] != "/" {
		t.Errorf("disk paths %v", asked)
	}
}

func TestSystemRequiresTheToken(t *testing.T) {
	var asked []string
	srv := newSystemServer(t, &fakeDocker{}, &asked)
	for _, p := range []string{"/v1/system", "/v1/system/disk"} {
		if resp := do(t, "GET", srv.URL+p, ""); resp.StatusCode != 401 {
			t.Errorf("%s without a token: %d", p, resp.StatusCode)
		}
	}
}

func TestDiskUsageIsSharedBetweenCallersAndFailuresAreNotRemembered(t *testing.T) {
	var asked []string
	f := &fakeDocker{dfErr: errors.New("df failed")}
	srv := newSystemServer(t, f, &asked)

	if resp := do(t, "GET", srv.URL+"/v1/system/disk", testToken); resp.StatusCode != 502 {
		t.Fatalf("an engine failure must be a 502, got %d", resp.StatusCode)
	}
	f.dfErr = nil
	read := func() int64 {
		resp := do(t, "GET", srv.URL+"/v1/system/disk", testToken)
		var u struct {
			Images struct{ Reclaimable int64 }
		}
		if resp.StatusCode != 200 || json.NewDecoder(resp.Body).Decode(&u) != nil {
			t.Fatalf("status %d", resp.StatusCode)
		}
		return u.Images.Reclaimable
	}
	first, second := read(), read()
	if first != second || f.dfCalls != 2 { // one failed call, one good call: the second read came from the cache
		t.Errorf("got %d then %d after %d engine calls", first, second, f.dfCalls)
	}
}
