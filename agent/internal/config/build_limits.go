package config

import (
	"errors"
	"fmt"
	"math"
	"slices"
	"time"
)

// BuildLimits is what a server that builds images for other servers accepts (the build_limits section). A request
// above a limit is refused, never clamped. Every key left out is its default: the ceiling the validator of a build block
// has always applied.
type BuildLimits struct {
	// Memory is the largest memory cap a build may ask for. Default: no ceiling.
	Memory *Size `yaml:"memory"`
	// CPUs is the largest CPU cap, in cores. Default 256.
	CPUs *float64 `yaml:"cpus"`
	// Timeout is the longest a build may take. Default 1h.
	Timeout *Duration `yaml:"timeout"`
	// MaxSource is the largest source archive accepted. Default 8g.
	MaxSource *Size `yaml:"max_source"`
	// SourceHosts are the hosts a source may be downloaded from. Default: GitHub's API and codeload hosts.
	SourceHosts []string `yaml:"source_hosts"`
	// HostNetwork lets a build run on the server's own network (build.network: host). Default false.
	HostNetwork bool `yaml:"host_network"`
	// KeepImages is how many images of each repository stay on the server after a build. Default 3.
	KeepImages *int `yaml:"keep_images"`
}

// BuildCeilings are the build limits with every default filled in.
type BuildCeilings struct {
	// Memory is the ceiling in bytes; 0 is none.
	Memory      int64
	CPUs        float64
	Timeout     time.Duration
	MaxSource   int64
	SourceHosts []string
	HostNetwork bool
	KeepImages  int
}

// BuildCeilings returns the limits of this server's builds with the defaults filled in.
func (c *Config) BuildCeilings() BuildCeilings {
	out := BuildCeilings{CPUs: MaxBuildCPUs, Timeout: MaxBuildTimeout, MaxSource: MaxBuildMaxSource, SourceHosts: slices.Clone(DefaultSourceHosts), KeepImages: DefaultKeepImages}
	l := c.BuildLimits
	if l == nil {
		return out
	}
	if l.Memory != nil {
		out.Memory = l.Memory.Bytes()
	}
	if l.CPUs != nil {
		out.CPUs = *l.CPUs
	}
	if l.Timeout != nil {
		out.Timeout = l.Timeout.Std()
	}
	if l.MaxSource != nil {
		out.MaxSource = l.MaxSource.Bytes()
	}
	if len(l.SourceHosts) > 0 {
		out.SourceHosts = slices.Clone(l.SourceHosts)
	}
	out.HostNetwork = l.HostNetwork
	if l.KeepImages != nil {
		out.KeepImages = *l.KeepImages
	}
	return out
}

func validateBuildLimits(l *BuildLimits) error {
	if l == nil {
		return nil
	}
	if l.Memory != nil && l.Memory.Bytes() < MinBuildMemory {
		return errors.New("build_limits: memory must be at least 64m")
	}
	if l.CPUs != nil && (math.IsNaN(*l.CPUs) || *l.CPUs < MinBuildCPUs || *l.CPUs > MaxBuildCPUs) {
		return fmt.Errorf("build_limits: cpus must be between %g and %g", MinBuildCPUs, MaxBuildCPUs)
	}
	if l.Timeout != nil && (l.Timeout.Std() <= 0 || l.Timeout.Std() > MaxBuildTimeout) {
		return fmt.Errorf("build_limits: timeout must be between 1s and %s", FormatDuration(MaxBuildTimeout))
	}
	if l.MaxSource != nil && (l.MaxSource.Bytes() < MinBuildMaxSource || l.MaxSource.Bytes() > MaxBuildMaxSource) {
		return errors.New("build_limits: max_source must be between 1m and 8g")
	}
	if l.KeepImages != nil && (*l.KeepImages < 1 || *l.KeepImages > MaxKeepImages) {
		return fmt.Errorf("build_limits: keep_images must be between 1 and %d", MaxKeepImages)
	}
	if len(l.SourceHosts) > 0 {
		b := &Build{SourceHosts: l.SourceHosts}
		if err := validateSourceHosts(b); err != nil {
			return fmt.Errorf("build_limits: %s", trimBuildPrefix(err.Error()))
		}
		l.SourceHosts = b.SourceHosts
	}
	return nil
}

func trimBuildPrefix(s string) string {
	const p = "build: "
	if len(s) > len(p) && s[:len(p)] == p {
		return s[len(p):]
	}
	return s
}
