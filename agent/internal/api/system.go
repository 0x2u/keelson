package api

import (
	"context"
	"net/http"
	"time"

	"github.com/0x2u/keelson/agent/internal/docker"
	"github.com/0x2u/keelson/agent/internal/sysinfo"
)

const (
	// The engine measures every layer and volume for /system/df: give it more than an ordinary request.
	diskUsageTimeout = 30 * time.Second
	diskUsageTTL     = 30 * time.Second
)

// systemAnswer is GET /v1/system: the machine and the engine, both cheap to read. A broken engine does not hide the
// machine: it is reported as engine_error next to the host's own numbers.
type systemAnswer struct {
	Time time.Time    `json:"time"`
	Host sysinfo.Host `json:"host"`
	// OS and Arch are the platform the engine runs images for ("linux", "amd64"), which is what an image must be built
	// for to run here. They are not the host's: Docker Desktop runs linux in a VM on a Mac.
	OS          string             `json:"os,omitempty"`
	Arch        string             `json:"arch,omitempty"`
	Engine      *docker.EngineInfo `json:"engine,omitempty"`
	EngineError string             `json:"engine_error,omitempty"`
	// Build is present on an agent that builds images for other servers (POST /v1/builds), with what it accepts.
	Build *systemBuild `json:"build,omitempty"`
}

// systemBuild is the "build" section of GET /v1/system: the server's build_limits with every default filled in.
type systemBuild struct {
	Enabled bool              `json:"enabled"`
	Limits  systemBuildLimits `json:"limits"`
}

type systemBuildLimits struct {
	// Memory is the largest memory cap in bytes; 0 is no ceiling.
	Memory         int64    `json:"memory"`
	CPUs           float64  `json:"cpus"`
	TimeoutSeconds int64    `json:"timeout_seconds"`
	MaxSource      int64    `json:"max_source"`
	SourceHosts    []string `json:"source_hosts"`
	HostNetwork    bool     `json:"host_network"`
	KeepImages     int      `json:"keep_images"`
}

func (s *server) system(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), requestTimeout)
	defer cancel()
	out := systemAnswer{Time: s.now().UTC()}
	info, err := s.d.Info(ctx)
	var root string
	if err != nil {
		s.log.Error("docker info failed", "err", err)
		out.EngineError = "docker engine error"
	} else {
		out.Engine = info
		out.OS, out.Arch = info.OSType, info.Arch
		root = info.RootDir
	}
	if s.deploy != nil && s.deploy.Builds != nil {
		c := s.deploy.Builds.BuildCeilings()
		out.Build = &systemBuild{Enabled: true, Limits: systemBuildLimits{
			Memory: c.Memory, CPUs: c.CPUs, TimeoutSeconds: int64(c.Timeout.Seconds()), MaxSource: c.MaxSource,
			SourceHosts: c.SourceHosts, HostNetwork: c.HostNetwork, KeepImages: c.KeepImages,
		}}
	}
	out.Host = s.host(root, "/")
	writeJSON(w, http.StatusOK, out)
}

// systemDisk is GET /v1/system/disk: the engine's disk accounting, shared between callers for a short while.
func (s *server) systemDisk(w http.ResponseWriter, r *http.Request) {
	s.dfMu.Lock()
	defer s.dfMu.Unlock()
	if s.dfData != nil && s.now().Sub(s.dfAt) < diskUsageTTL {
		writeJSON(w, http.StatusOK, s.dfData)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), diskUsageTimeout)
	defer cancel()
	du, err := s.d.DiskUsage(ctx)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	s.dfData, s.dfAt = du, s.now()
	writeJSON(w, http.StatusOK, du)
}
