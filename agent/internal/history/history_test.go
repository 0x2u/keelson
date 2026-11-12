package history

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"sort"
	"sync"
	"testing"
	"time"

	"github.com/0x2u/keelson/agent/internal/docker"
	"github.com/0x2u/keelson/agent/internal/store"
	"github.com/0x2u/keelson/agent/internal/sysinfo"
)

type fakeEngine struct {
	list    []docker.Container
	listErr error
	// stats gives the CPU of the second sample of a container; a missing entry makes its stream fail.
	cpu map[string]float64
}

func (f *fakeEngine) ListContainers(_ context.Context, all bool) ([]docker.Container, error) {
	if all {
		panic("only running containers are sampled")
	}
	return f.list, f.listErr
}

func (f *fakeEngine) Stats(_ context.Context, id string, fn func(docker.Stats) error) error {
	cpu, ok := f.cpu[id]
	if !ok {
		return errors.New("no such container")
	}
	// The first sample of a stream has no CPU baseline.
	for i, c := range []float64{0, cpu} {
		if err := fn(docker.Stats{CPUPercent: c, MemUsage: uint64(100 + i), MemLimit: 1000}); err != nil {
			if errors.Is(err, docker.ErrStop) {
				return nil
			}
			return err
		}
	}
	return nil
}

type fakeSink struct {
	mu      sync.Mutex
	samples []store.StatSample
	pruned  time.Time
}

func (s *fakeSink) AddStats(_ context.Context, in []store.StatSample) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.samples = append(s.samples, in...)
	return nil
}
func (s *fakeSink) PruneStats(_ context.Context, before time.Time) error {
	s.pruned = before
	return nil
}

func ctr(id, name string, labels map[string]string) docker.Container {
	return docker.Container{ID: id, Name: name, State: "running", Labels: labels}
}

func TestSampleStampsOneCycleAndSkipsWhatCannotBeSampled(t *testing.T) {
	eng := &fakeEngine{
		list: []docker.Container{
			ctr("1", "web-aaaa", map[string]string{"keelson.app": "web"}),
			ctr("2", "plain", nil),
			ctr("3", "gone", nil), // stopped between the listing and the sample
			ctr("4", "backup-run", map[string]string{"keelson.app": "web", "keelson.job": "true"}),
			ctr("5", "migrate", map[string]string{"keelson.app": "web", "keelson.release": "true"}),
		},
		cpu: map[string]float64{"1": 12, "2": 3, "4": 50, "5": 60},
	}
	sink := &fakeSink{}
	r := New(eng, sink, slog.New(slog.NewTextHandler(io.Discard, nil)))
	at := time.Date(2026, 10, 20, 10, 0, 0, 0, time.UTC)
	r.now = func() time.Time { return at }

	if err := r.Sample(context.Background()); err != nil {
		t.Fatal(err)
	}
	sort.Slice(sink.samples, func(i, j int) bool { return sink.samples[i].Container < sink.samples[j].Container })
	var got []string
	for _, s := range sink.samples {
		if !s.Time.Equal(at) {
			t.Errorf("%s: containers of one cycle must share its instant, got %s", s.Container, s.Time)
		}
		got = append(got, s.Container+"→"+s.Series)
	}
	// An app's container is recorded under the app; a job or a release step, being one-offs, under their own names.
	want := []string{"backup-run→backup-run", "migrate→migrate", "plain→plain", "web-aaaa→web"}
	if len(got) != len(want) {
		t.Fatalf("got %v want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("got %v want %v", got, want)
		}
	}
	for _, s := range sink.samples {
		if s.Container == "web-aaaa" && (s.CPUPercent != 12 || s.MemUsage != 101) {
			t.Errorf("the second sample of the stream is the one to keep (the first has no CPU baseline): %+v", s)
		}
	}
	if want := at.Add(-Retention); !sink.pruned.Equal(want) {
		t.Errorf("must delete what is older than the retention: pruned before %s, want %s", sink.pruned, want)
	}
}

func TestSampleReportsAnEngineThatCannotBeListed(t *testing.T) {
	r := New(&fakeEngine{listErr: errors.New("socket closed")}, &fakeSink{}, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err := r.Sample(context.Background()); err == nil {
		t.Fatal("an engine that cannot be listed is an error, not an empty cycle")
	}
}

type fakeHostSink struct {
	samples []store.HostSample
	pruned  time.Time
	err     error
}

func (s *fakeHostSink) AddHostSample(_ context.Context, x store.HostSample) error {
	s.samples = append(s.samples, x)
	return s.err
}
func (s *fakeHostSink) PruneHostStats(_ context.Context, before time.Time) error {
	s.pruned = before
	return nil
}

func TestSampleRecordsTheHostInTheSameCycleEvenWhenTheEngineIsDown(t *testing.T) {
	load := 0.75
	host := sysinfo.Host{
		Load:   &sysinfo.Load{One: load},
		Memory: &sysinfo.Memory{Total: 1000, Available: 400},
		Disk:   &sysinfo.Disk{Total: 5000, Free: 1000},
	}
	hs := &fakeHostSink{}
	at := time.Date(2026, 10, 20, 10, 0, 0, 0, time.UTC)

	r := New(&fakeEngine{listErr: errors.New("socket closed")}, &fakeSink{}, slog.New(slog.NewTextHandler(io.Discard, nil)))
	r.now = func() time.Time { return at }
	r.SampleHost(func() sysinfo.Host { return host }, hs)
	if err := r.Sample(context.Background()); err == nil {
		t.Fatal("the engine error is still reported")
	}
	if len(hs.samples) != 1 {
		t.Fatalf("the host is sampled whatever the engine does: %+v", hs.samples)
	}
	x := hs.samples[0]
	if !x.Time.Equal(at) || x.Load == nil || *x.Load != load || x.MemTotal != 1000 || x.MemAvailable != 400 || x.DiskTotal != 5000 || x.DiskFree != 1000 {
		t.Errorf("unexpected sample: %+v", x)
	}
	if want := at.Add(-Retention); !hs.pruned.Equal(want) {
		t.Errorf("host samples are kept as long as the containers': pruned before %s, want %s", hs.pruned, want)
	}
}

func TestSampleLeavesOutWhatTheHostDoesNotExpose(t *testing.T) {
	hs := &fakeHostSink{}
	r := New(&fakeEngine{}, &fakeSink{}, slog.New(slog.NewTextHandler(io.Discard, nil)))
	r.SampleHost(func() sysinfo.Host { return sysinfo.Host{} }, hs)
	if err := r.Sample(context.Background()); err != nil {
		t.Fatal(err)
	}
	if x := hs.samples[0]; x.Load != nil || x.MemTotal != 0 || x.DiskTotal != 0 {
		t.Errorf("an unreadable host is recorded as nothing, not as zeros that read as a full disk: %+v", x)
	}
}

func TestSampleWithoutAHostReaderRecordsNoHost(t *testing.T) {
	r := New(&fakeEngine{}, &fakeSink{}, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err := r.Sample(context.Background()); err != nil {
		t.Fatal(err)
	}
}
