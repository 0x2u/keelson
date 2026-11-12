package store

import (
	"testing"
	"time"
)

var t0 = time.Date(2026, 10, 20, 10, 0, 0, 0, time.UTC)

func sample(at time.Duration, series, container string, cpu float64, mem uint64) StatSample {
	return StatSample{Time: t0.Add(at), Series: series, Container: container, CPUPercent: cpu, MemUsage: mem, MemLimit: 1000}
}

func TestStatsHistoryFollowsTheAppAcrossContainersAndSumsTheSwitchOverlap(t *testing.T) {
	st := open(t)
	must := func(err error) {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
	}
	// web-a serves, then a deployment starts web-b: for one cycle both run, then only web-b. "db" is another series.
	must(st.AddStats(ctx, []StatSample{sample(0, "web", "web-a", 10, 100), sample(0, "db", "db", 5, 50)}))
	must(st.AddStats(ctx, []StatSample{sample(30*time.Second, "web", "web-a", 10, 100), sample(30*time.Second, "web", "web-b", 20, 200)}))
	must(st.AddStats(ctx, []StatSample{sample(60*time.Second, "web", "web-b", 30, 300)}))

	// Asked by the newest container, the history is the app's, from before this container existed.
	pts, err := st.StatsHistory(ctx, "web-b", t0, 30*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	if len(pts) != 3 {
		t.Fatalf("want 3 points, got %+v", pts)
	}
	if pts[0].CPUPercent != 10 || pts[1].CPUPercent != 30 || pts[1].MemUsage != 300 || pts[2].CPUPercent != 30 {
		t.Errorf("the overlap must add both versions up, and db must not leak in: %+v", pts)
	}
	if !pts[0].Time.Equal(t0) || pts[0].MemLimit != 1000 {
		t.Errorf("unexpected first point %+v", pts[0])
	}

	// since cuts the beginning off.
	if pts, _ := st.StatsHistory(ctx, "web-b", t0.Add(45*time.Second), 30*time.Second); len(pts) != 1 || pts[0].CPUPercent != 30 {
		t.Errorf("since: %+v", pts)
	}
	// A container never sampled has no history, and is not an error.
	if pts, err := st.StatsHistory(ctx, "nope", t0, time.Minute); pts != nil || err != nil {
		t.Errorf("unknown container: %+v %v", pts, err)
	}
}

func TestStatsHistoryAveragesBucketsButKeepsThePeak(t *testing.T) {
	st := open(t)
	var in []StatSample
	for i, cpu := range []float64{10, 90, 20, 40} { // four 30 s samples: two 1-minute buckets
		in = append(in, sample(time.Duration(i)*30*time.Second, "web", "web", cpu, uint64(100*(i+1))))
	}
	for _, s := range in {
		if err := st.AddStats(ctx, []StatSample{s}); err != nil {
			t.Fatal(err)
		}
	}
	pts, err := st.StatsHistory(ctx, "web", t0, time.Minute)
	if err != nil || len(pts) != 2 {
		t.Fatalf("%+v %v", pts, err)
	}
	if pts[0].CPUPercent != 50 || pts[0].CPUMax != 90 || pts[0].MemUsage != 150 || pts[0].MemMax != 200 {
		t.Errorf("first bucket: %+v", pts[0])
	}
	if pts[1].CPUPercent != 30 || pts[1].CPUMax != 40 {
		t.Errorf("second bucket: %+v", pts[1])
	}
}

func TestPruneStatsKeepsTheRecentSamples(t *testing.T) {
	st := open(t)
	if err := st.AddStats(ctx, []StatSample{sample(0, "web", "web", 1, 1), sample(time.Hour, "web", "web", 2, 2)}); err != nil {
		t.Fatal(err)
	}
	if err := st.PruneStats(ctx, t0.Add(30*time.Minute)); err != nil {
		t.Fatal(err)
	}
	pts, _ := st.StatsHistory(ctx, "web", t0, time.Second)
	if len(pts) != 1 || pts[0].CPUPercent != 2 {
		t.Errorf("only the newer sample must remain: %+v", pts)
	}
}
