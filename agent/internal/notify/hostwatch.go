package notify

import (
	"context"
	"fmt"
	"log/slog"
	"time"

	"github.com/0x2u/keelson/agent/internal/config"
	"github.com/0x2u/keelson/agent/internal/sysinfo"
)

const (
	engineEvery     = 15 * time.Second
	engineThreshold = 3 // observations in a row, so a restart of the engine (an upgrade) stays quiet
	engineTimeout   = 10 * time.Second
	hostEvery       = time.Minute
)

// EngineProbe asks the container engine whether it answers. It returns the directory where the engine keeps its
// data ("/var/lib/docker"), which the disk check measures.
type EngineProbe func(ctx context.Context) (rootDir string, err error)

// EngineWatcher turns an engine that stops answering into engine.down and engine.recovered. Nothing else the agent
// does works without the engine, and nothing else says so: the app watcher only fails to observe.
type EngineWatcher struct {
	probe     EngineProbe
	emit      func(Event)
	threshold int
	log       *slog.Logger
	now       func() time.Time
	// onRoot receives the engine's data directory whenever the engine answers.
	onRoot func(string)

	bad   int
	down  bool
	since time.Time
}

// NewEngineWatcher returns a watcher: threshold failed probes in a row make the engine "down".
func NewEngineWatcher(probe EngineProbe, emit func(Event), threshold int, onRoot func(string), log *slog.Logger) *EngineWatcher {
	if log == nil {
		log = slog.Default()
	}
	return &EngineWatcher{probe: probe, emit: emit, threshold: threshold, onRoot: onRoot, log: log, now: time.Now}
}

// Check makes one observation.
func (w *EngineWatcher) Check(ctx context.Context) {
	ctx, cancel := context.WithTimeout(ctx, engineTimeout)
	defer cancel()
	root, err := w.probe(ctx)
	if err != nil {
		if ctx.Err() != nil && ctx.Err() != context.DeadlineExceeded {
			return // the agent is stopping: that says nothing about the engine
		}
		w.bad++
		if w.bad >= w.threshold && !w.down {
			w.down, w.since = true, w.now()
			w.emit(Event{
				Type: config.EventEngineDown, Severity: SeverityCritical,
				Title:   "The Docker engine does not answer",
				Message: fmt.Sprintf("%d probes in a row failed. Apps keep running but nothing can be deployed, restarted or watched until it is back.", w.bad),
			})
		}
		return
	}
	w.bad = 0
	if w.onRoot != nil && root != "" {
		w.onRoot(root)
	}
	if w.down {
		w.down = false
		w.emit(Event{
			Type: config.EventEngineRecovered, Severity: SeverityInfo,
			Title:   "The Docker engine answers again",
			Message: fmt.Sprintf("It did not answer for %s.", w.now().Sub(w.since).Round(time.Second)),
		})
	}
}

// Run checks every 15 seconds until ctx ends, starting at once.
func (w *EngineWatcher) Run(ctx context.Context) {
	t := time.NewTicker(engineEvery)
	defer t.Stop()
	for {
		w.Check(ctx)
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
	}
}

// HostReader reads the machine's memory and the disks under the given paths; sysinfo.Read in production.
type HostReader func(diskPaths ...string) sysinfo.Host

// HostMonitor raises disk.high and memory.low. Each alert has hysteresis: it ends (and disk.recovered is sent) only
// AlertHysteresis points away from the threshold, so a value hovering around it does not alert every minute.
type HostMonitor struct {
	read        HostReader
	paths       func() []string
	emit        func(Event)
	diskPercent int
	memPercent  int
	log         *slog.Logger

	diskHigh map[uint64]bool // by filesystem
	memLow   bool
}

// NewHostMonitor returns a monitor. paths lists what to measure on each check: the filesystems holding the engine's
// data and the agent's data, which are often the same one (it is then measured once).
func NewHostMonitor(read HostReader, paths func() []string, emit func(Event), diskPercent, memPercent int, log *slog.Logger) *HostMonitor {
	if log == nil {
		log = slog.Default()
	}
	return &HostMonitor{read: read, paths: paths, emit: emit, diskPercent: diskPercent, memPercent: memPercent, log: log, diskHigh: map[uint64]bool{}}
}

// Check makes one pass.
func (m *HostMonitor) Check() {
	seen := map[uint64]bool{}
	for _, p := range m.paths() {
		d := m.read(p).Disk
		if d == nil || d.Total == 0 || seen[d.Dev] {
			continue // not measurable here, or the same filesystem as a path already measured
		}
		seen[d.Dev] = true
		m.checkDisk(p, d)
	}
	if mem := m.read().Memory; mem != nil && mem.Total > 0 {
		m.checkMemory(mem)
	}
}

func (m *HostMonitor) checkDisk(path string, d *sysinfo.Disk) {
	used := float64(d.Total-min(d.Free, d.Total)) / float64(d.Total) * 100
	switch high := m.diskHigh[d.Dev]; {
	case !high && used >= float64(m.diskPercent):
		m.diskHigh[d.Dev] = true
		m.emit(Event{
			Type: config.EventDiskHigh, Severity: SeverityWarning,
			Title:   fmt.Sprintf("The disk of %s is %.0f%% full", path, used),
			Message: fmt.Sprintf("%s free of %s. Alert threshold: %d%%. Old images, build cache and logs are the usual suspects.", bytesText(d.Free), bytesText(d.Total), m.diskPercent),
		})
	case high && used <= float64(m.diskPercent-config.AlertHysteresis):
		m.diskHigh[d.Dev] = false
		m.emit(Event{
			Type: config.EventDiskRecovered, Severity: SeverityInfo,
			Title:   fmt.Sprintf("The disk of %s is down to %.0f%%", path, used),
			Message: fmt.Sprintf("%s free of %s.", bytesText(d.Free), bytesText(d.Total)),
		})
	}
}

func (m *HostMonitor) checkMemory(mem *sysinfo.Memory) {
	avail := float64(min(mem.Available, mem.Total)) / float64(mem.Total) * 100
	switch {
	case !m.memLow && avail < float64(m.memPercent):
		m.memLow = true
		m.emit(Event{
			Type: config.EventMemoryLow, Severity: SeverityWarning,
			Title:   fmt.Sprintf("Memory is low: %.0f%% available", avail),
			Message: fmt.Sprintf("%s available of %s. Alert threshold: %d%%. The kernel may start killing containers.", bytesText(mem.Available), bytesText(mem.Total), m.memPercent),
		})
	case m.memLow && avail >= float64(m.memPercent+config.AlertHysteresis):
		m.memLow = false // armed again, without a message of its own
	}
}

// Run checks every minute until ctx ends, starting at once.
func (m *HostMonitor) Run(ctx context.Context) {
	t := time.NewTicker(hostEvery)
	defer t.Stop()
	for {
		m.Check()
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
	}
}

func bytesText(n uint64) string {
	const unit = 1024
	if n < unit {
		return fmt.Sprintf("%d B", n)
	}
	div, exp := uint64(unit), 0
	for v := n / unit; v >= unit; v /= unit {
		div *= unit
		exp++
	}
	return fmt.Sprintf("%.1f %ciB", float64(n)/float64(div), "KMGTPE"[exp])
}
