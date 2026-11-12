package store

import (
	"context"
	"database/sql"
	"time"
)

// StatSample is the resource usage of one container at one sampling cycle.
type StatSample struct {
	// Time is the cycle's instant: containers sampled in one cycle share it, which is how they are summed.
	Time      time.Time
	Series    string
	Container string
	// CPUPercent is relative to one core.
	CPUPercent float64
	MemUsage   uint64
	MemLimit   uint64
}

// StatPoint is one point of a history: the average over a bucket of time, and the highest value inside it.
type StatPoint struct {
	Time       time.Time `json:"time"`
	CPUPercent float64   `json:"cpu_percent"`
	CPUMax     float64   `json:"cpu_max"`
	MemUsage   uint64    `json:"mem_usage"`
	MemMax     uint64    `json:"mem_max"`
	MemLimit   uint64    `json:"mem_limit"`
}

// AddStats records the samples of one cycle together.
func (s *Store) AddStats(ctx context.Context, samples []StatSample) error {
	if len(samples) == 0 {
		return nil
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	stmt, err := tx.PrepareContext(ctx, `INSERT INTO stats (ts, series, container, cpu, mem, mem_limit) VALUES (?,?,?,?,?,?)`)
	if err != nil {
		return err
	}
	defer stmt.Close()
	for _, x := range samples {
		if _, err := stmt.ExecContext(ctx, ms(x.Time), x.Series, x.Container, x.CPUPercent, int64(x.MemUsage), int64(x.MemLimit)); err != nil {
			return err
		}
	}
	return tx.Commit()
}

// PruneStats deletes the samples older than before: the history is a ring buffer in time.
func (s *Store) PruneStats(ctx context.Context, before time.Time) error {
	_, err := s.db.ExecContext(ctx, `DELETE FROM stats WHERE ts < ?`, ms(before))
	return err
}

// StatsHistory returns the history of the series a container belongs to, from since on, as points of at least step.
// A container that has no samples has no history (nil). Containers of one series sampled in the same cycle are summed
// (the two versions of an app during a switch), then each bucket of step is averaged, keeping its peak.
func (s *Store) StatsHistory(ctx context.Context, container string, since time.Time, step time.Duration) ([]StatPoint, error) {
	var series string
	err := s.db.QueryRowContext(ctx, `SELECT series FROM stats WHERE container = ? ORDER BY ts DESC LIMIT 1`, container).Scan(&series)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	stepMs := step.Milliseconds()
	if stepMs < 1 {
		stepMs = 1
	}
	rows, err := s.db.QueryContext(ctx, `
		SELECT (ts / ?1) * ?1 AS bucket, AVG(cpu), MAX(cpu), AVG(mem), MAX(mem), MAX(lim) FROM (
			SELECT ts, SUM(cpu) AS cpu, SUM(mem) AS mem, MAX(mem_limit) AS lim
			FROM stats WHERE series = ?2 AND ts >= ?3 GROUP BY ts
		) GROUP BY bucket ORDER BY bucket`, stepMs, series, ms(since))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []StatPoint
	for rows.Next() {
		var p StatPoint
		var bucket int64
		var mem, memMax, lim float64
		if err := rows.Scan(&bucket, &p.CPUPercent, &p.CPUMax, &mem, &memMax, &lim); err != nil {
			return nil, err
		}
		p.Time = time.UnixMilli(bucket).UTC()
		p.MemUsage, p.MemMax, p.MemLimit = uint64(mem), uint64(memMax), uint64(lim)
		out = append(out, p)
	}
	return out, rows.Err()
}
