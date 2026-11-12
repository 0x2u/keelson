package store

import (
	"database/sql"
	"fmt"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"
)

func fp(f float64) *float64 { return &f }

func TestHostHistoryAveragesBucketsKeepsThePeakAndSkipsWhatWasNotMeasured(t *testing.T) {
	st := open(t)
	// Four 30 s cycles: two 1-minute buckets. Memory is 50 % then 70 % used; the disk is never readable, and the second
	// bucket has no load.
	for i, x := range []HostSample{
		{Load: fp(1), MemTotal: 1000, MemAvailable: 500},
		{Load: fp(3), MemTotal: 1000, MemAvailable: 300},
		{MemTotal: 1000, MemAvailable: 600},
		{MemTotal: 1000, MemAvailable: 400},
	} {
		x.Time = t0.Add(time.Duration(i) * 30 * time.Second)
		if err := st.AddHostSample(ctx, x); err != nil {
			t.Fatal(err)
		}
	}
	pts, err := st.HostHistory(ctx, t0, time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	if len(pts) != 2 {
		t.Fatalf("want 2 buckets, got %+v", pts)
	}
	a, b := pts[0], pts[1]
	if a.Load == nil || *a.Load != 2 || *a.LoadMax != 3 {
		t.Errorf("load average and peak of the first bucket: %+v", a)
	}
	if *a.MemPercent != 60 || *a.MemMax != 70 {
		t.Errorf("memory used in percent, averaged with its peak: %+v", a)
	}
	if b.Load != nil || b.LoadMax != nil || *b.MemPercent != 50 {
		t.Errorf("a bucket that measured no load has none, not zero: %+v", b)
	}
	if a.DiskPct != nil || a.DiskMax != nil {
		t.Errorf("an unreadable disk has no value: %+v", a)
	}

	// since cuts the beginning off; a second record of the same instant keeps the first.
	if err := st.AddHostSample(ctx, HostSample{Time: t0.Add(90 * time.Second), Load: fp(99)}); err != nil {
		t.Fatal(err)
	}
	pts, _ = st.HostHistory(ctx, t0.Add(time.Minute), time.Minute)
	if len(pts) != 1 || pts[0].Load != nil {
		t.Errorf("since / duplicate instant: %+v", pts)
	}
}

func TestPruneHostStatsDeletesOnlyOldSamples(t *testing.T) {
	st := open(t)
	for _, d := range []time.Duration{0, time.Hour, 2 * time.Hour} {
		if err := st.AddHostSample(ctx, HostSample{Time: t0.Add(d), Load: fp(1), DiskTotal: 100, DiskFree: 25}); err != nil {
			t.Fatal(err)
		}
	}
	if err := st.PruneHostStats(ctx, t0.Add(30*time.Minute)); err != nil {
		t.Fatal(err)
	}
	pts, _ := st.HostHistory(ctx, t0, time.Second)
	if len(pts) != 2 || *pts[0].DiskPct != 75 {
		t.Errorf("only the first sample goes: %+v", pts)
	}
}

// A database from before the host history and the availability record upgrades and gains both tables.
func TestMigratesADatabaseWrittenBeforeTheHostAndAvailabilityRecords(t *testing.T) {
	path := filepath.Join(t.TempDir(), "old.db")
	old, err := sql.Open("sqlite", "file:"+path)
	if err != nil {
		t.Fatal(err)
	}
	before := slices.IndexFunc(migrations, func(m string) bool { return strings.Contains(m, "CREATE TABLE host_stats") })
	for _, m := range migrations[:before] {
		if _, err := old.Exec(m); err != nil {
			t.Fatal(err)
		}
	}
	old.Exec(fmt.Sprintf("PRAGMA user_version = %d", before))
	old.Exec(`INSERT INTO stats (ts, series, container, cpu, mem, mem_limit) VALUES (1000, 'web', 'web-a', 5, 10, 100)`)
	old.Close()

	s, err := Open(path)
	if err != nil {
		t.Fatalf("a database from before the host history must upgrade: %v", err)
	}
	defer s.Close()
	if pts, err := s.StatsHistory(ctx, "web-a", time.UnixMilli(0), time.Minute); err != nil || len(pts) != 1 {
		t.Fatalf("existing stats lost in the upgrade: %+v, %v", pts, err)
	}
	if err := s.AddHostSample(ctx, HostSample{Time: t0, Load: fp(1)}); err != nil {
		t.Errorf("host_stats missing after the upgrade: %v", err)
	}
	if err := s.RecordAppState(ctx, "web", false, t0); err != nil {
		t.Errorf("app_transitions missing after the upgrade: %v", err)
	}
}
