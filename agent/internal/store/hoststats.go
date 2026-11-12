package store

import (
	"context"
	"database/sql"
	"math"
	"time"
)

// HostSample is the host's own state at one sampling cycle. A part the machine does not expose is left out: no Load, or
// a zero total.
type HostSample struct {
	Time time.Time
	Load *float64 // the 1 minute load average
	// MemTotal and MemAvailable are bytes; Available is what a new process can get without swapping.
	MemTotal, MemAvailable uint64
	DiskTotal, DiskFree    uint64
}

// HostPoint is one point of the host's history: the average over a bucket of time and the highest value inside it. A
// field is nil when nothing in the bucket measured it.
type HostPoint struct {
	Time       time.Time `json:"time"`
	Load       *float64  `json:"load,omitempty"`
	LoadMax    *float64  `json:"load_max,omitempty"`
	MemPercent *float64  `json:"mem_percent,omitempty"`
	MemMax     *float64  `json:"mem_percent_max,omitempty"`
	DiskPct    *float64  `json:"disk_percent,omitempty"`
	DiskMax    *float64  `json:"disk_percent_max,omitempty"`
}

// AddHostSample records one cycle of the host. The cycle's instant is the key: recording it twice keeps the first.
func (s *Store) AddHostSample(ctx context.Context, x HostSample) error {
	var load, memTotal, memAvail, diskTotal, diskFree any
	if x.Load != nil {
		load = *x.Load
	}
	if x.MemTotal > 0 {
		memTotal, memAvail = int64(x.MemTotal), int64(min(x.MemAvailable, x.MemTotal))
	}
	if x.DiskTotal > 0 {
		diskTotal, diskFree = int64(x.DiskTotal), int64(min(x.DiskFree, x.DiskTotal))
	}
	_, err := s.db.ExecContext(ctx, `INSERT OR IGNORE INTO host_stats (ts, load1, mem_total, mem_avail, disk_total, disk_free) VALUES (?,?,?,?,?,?)`,
		ms(x.Time), load, memTotal, memAvail, diskTotal, diskFree)
	return err
}

// PruneHostStats deletes the samples older than before.
func (s *Store) PruneHostStats(ctx context.Context, before time.Time) error {
	_, err := s.db.ExecContext(ctx, `DELETE FROM host_stats WHERE ts < ?`, ms(before))
	return err
}

// HostHistory returns the host's history from since on, as points of at least step: load, memory used and disk used (the
// last two in percent of their total), each averaged over its bucket with its peak.
func (s *Store) HostHistory(ctx context.Context, since time.Time, step time.Duration) ([]HostPoint, error) {
	stepMs := step.Milliseconds()
	if stepMs < 1 {
		stepMs = 1
	}
	const mem = `CASE WHEN mem_total > 0 THEN 100.0 * (mem_total - mem_avail) / mem_total END`
	const disk = `CASE WHEN disk_total > 0 THEN 100.0 * (disk_total - disk_free) / disk_total END`
	rows, err := s.db.QueryContext(ctx, `
		SELECT (ts / ?1) * ?1 AS bucket, AVG(load1), MAX(load1), AVG(`+mem+`), MAX(`+mem+`), AVG(`+disk+`), MAX(`+disk+`)
		FROM host_stats WHERE ts >= ?2 GROUP BY bucket ORDER BY bucket`, stepMs, ms(since))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []HostPoint
	for rows.Next() {
		var bucket int64
		var v [6]sql.NullFloat64
		if err := rows.Scan(&bucket, &v[0], &v[1], &v[2], &v[3], &v[4], &v[5]); err != nil {
			return nil, err
		}
		p := HostPoint{Time: time.UnixMilli(bucket).UTC()}
		for i, dst := range []**float64{&p.Load, &p.LoadMax, &p.MemPercent, &p.MemMax, &p.DiskPct, &p.DiskMax} {
			if v[i].Valid {
				r := round2(v[i].Float64)
				if i >= 2 {
					r = math.Min(math.Max(r, 0), 100)
				}
				*dst = &r
			}
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

func round2(f float64) float64 { return math.Round(f*100) / 100 }
