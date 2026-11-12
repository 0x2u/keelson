// Package history keeps a short record of what the containers use: every interval it takes one sample of each running
// container and stores it, and what is older than the retention is deleted. It is what the dashboard charts.
package history

import (
	"context"
	"log/slog"
	"sync"
	"time"

	"github.com/0x2u/keelson/agent/internal/docker"
	"github.com/0x2u/keelson/agent/internal/store"
	"github.com/0x2u/keelson/agent/internal/sysinfo"
)

const (
	// Interval is the time between two cycles: 2,880 samples a day for a container.
	Interval = 30 * time.Second
	// Retention is how long samples are kept.
	Retention = 24 * time.Hour

	sampleTimeout = 5 * time.Second
	parallel      = 8
)

// Labels that make a container short-lived or a helper of a deployment: they are not part of an app's history.
const (
	appLabel     = "keelson.app"
	jobLabel     = "keelson.job"
	releaseLabel = "keelson.release"
)

// Engine is what the recorder needs from Docker.
type Engine interface {
	ListContainers(ctx context.Context, all bool) ([]docker.Container, error)
	Stats(ctx context.Context, id string, fn func(docker.Stats) error) error
}

// Sink stores what was sampled.
type Sink interface {
	AddStats(ctx context.Context, samples []store.StatSample) error
	PruneStats(ctx context.Context, before time.Time) error
}

// HostSink stores what was sampled of the host.
type HostSink interface {
	AddHostSample(ctx context.Context, x store.HostSample) error
	PruneHostStats(ctx context.Context, before time.Time) error
}

// Recorder samples the running containers, and the host when it is given a way to.
type Recorder struct {
	eng  Engine
	out  Sink
	log  *slog.Logger
	now  func() time.Time
	host func() sysinfo.Host
	hout HostSink
}

// New returns a Recorder.
func New(eng Engine, out Sink, log *slog.Logger) *Recorder {
	if log == nil {
		log = slog.Default()
	}
	return &Recorder{eng: eng, out: out, log: log, now: time.Now}
}

// SampleHost makes every cycle also record the host's load, memory and disk, as read returns them (sysinfo.Read in
// production), into out.
func (r *Recorder) SampleHost(read func() sysinfo.Host, out HostSink) {
	r.host, r.hout = read, out
}

// Run takes a sample now and then every Interval until ctx ends.
func (r *Recorder) Run(ctx context.Context) {
	t := time.NewTicker(Interval)
	defer t.Stop()
	for {
		if err := r.Sample(ctx); err != nil && ctx.Err() == nil {
			r.log.Warn("stats sampling failed", "err", err)
		}
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
	}
}

// seriesOf is the app a container serves, or its own name. The history of an app follows it across deployments, each of
// which runs a new container; a job or a release step is a one-off and gets its own name.
func seriesOf(c docker.Container) string {
	if app := c.Labels[appLabel]; app != "" && c.Labels[jobLabel] == "" && c.Labels[releaseLabel] == "" {
		return app
	}
	return c.Name
}

// Sample takes one cycle: every running container once, all stamped with the same instant, then deletes what is past the
// retention. A container that cannot be sampled (it stopped meanwhile) is skipped: the others still count.
func (r *Recorder) Sample(ctx context.Context) error {
	at := r.now()
	// The host does not depend on the engine: its load is worth recording while the engine is down, which is when it is
	// most interesting.
	hostErr := r.sampleHost(ctx, at)
	list, err := r.eng.ListContainers(ctx, false)
	if err != nil {
		return err
	}

	var (
		mu      sync.Mutex
		samples []store.StatSample
		wg      sync.WaitGroup
		slots   = make(chan struct{}, parallel)
	)
	for _, c := range list {
		wg.Add(1)
		slots <- struct{}{}
		go func() {
			defer wg.Done()
			defer func() { <-slots }()
			st, ok := r.one(ctx, c.ID)
			if !ok {
				return
			}
			mu.Lock()
			samples = append(samples, store.StatSample{Time: at, Series: seriesOf(c), Container: c.Name, CPUPercent: st.CPUPercent, MemUsage: st.MemUsage, MemLimit: st.MemLimit})
			mu.Unlock()
		}()
	}
	wg.Wait()

	if err := r.out.AddStats(ctx, samples); err != nil {
		return err
	}
	if err := r.out.PruneStats(ctx, at.Add(-Retention)); err != nil {
		return err
	}
	return hostErr
}

// sampleHost records one cycle of the host, then deletes what is past the retention.
func (r *Recorder) sampleHost(ctx context.Context, at time.Time) error {
	if r.host == nil {
		return nil
	}
	h := r.host()
	x := store.HostSample{Time: at}
	if h.Load != nil {
		x.Load = &h.Load.One
	}
	if h.Memory != nil {
		x.MemTotal, x.MemAvailable = h.Memory.Total, h.Memory.Available
	}
	if h.Disk != nil {
		x.DiskTotal, x.DiskFree = h.Disk.Total, h.Disk.Free
	}
	if err := r.hout.AddHostSample(ctx, x); err != nil {
		return err
	}
	return r.hout.PruneHostStats(ctx, at.Add(-Retention))
}

// one returns the second sample of a container's stream: the first has no CPU baseline.
func (r *Recorder) one(ctx context.Context, id string) (docker.Stats, bool) {
	ctx, cancel := context.WithTimeout(ctx, sampleTimeout)
	defer cancel()
	var last docker.Stats
	n := 0
	_ = r.eng.Stats(ctx, id, func(s docker.Stats) error {
		last = s
		if n++; n >= 2 {
			return docker.ErrStop
		}
		return nil
	})
	return last, n >= 2
}
