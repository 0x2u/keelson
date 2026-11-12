package docker

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/url"
	"time"
)

// Stats is one resource usage sample of a container.
type Stats struct {
	Time time.Time `json:"time"`
	// CPUPercent is relative to one core (200 means two cores fully used).
	// It is 0 for the first sample of a stream, which has no predecessor.
	CPUPercent float64 `json:"cpu_percent"`
	// MemUsage excludes reclaimable page cache, like `docker stats`.
	MemUsage   uint64  `json:"mem_usage"`
	MemLimit   uint64  `json:"mem_limit"`
	MemPercent float64 `json:"mem_percent"`
	NetRx      uint64  `json:"net_rx_bytes"`
	NetTx      uint64  `json:"net_tx_bytes"`
	PIDs       uint64  `json:"pids"`
}

type rawCPU struct {
	CPUUsage struct {
		TotalUsage uint64 `json:"total_usage"`
	} `json:"cpu_usage"`
	SystemUsage uint64 `json:"system_cpu_usage"`
	OnlineCPUs  uint32 `json:"online_cpus"`
}

type rawStats struct {
	Read        time.Time `json:"read"`
	CPUStats    rawCPU    `json:"cpu_stats"`
	PreCPUStats rawCPU    `json:"precpu_stats"`
	MemoryStats struct {
		Usage uint64            `json:"usage"`
		Limit uint64            `json:"limit"`
		Stats map[string]uint64 `json:"stats"`
	} `json:"memory_stats"`
	Networks map[string]struct {
		RxBytes uint64 `json:"rx_bytes"`
		TxBytes uint64 `json:"tx_bytes"`
	} `json:"networks"`
	PidsStats struct {
		Current uint64 `json:"current"`
	} `json:"pids_stats"`
}

func (r *rawStats) toStats() Stats {
	s := Stats{
		Time:     r.Read,
		MemLimit: r.MemoryStats.Limit,
		PIDs:     r.PidsStats.Current,
	}

	cur, pre := r.CPUStats, r.PreCPUStats
	// pre.SystemUsage == 0 means no previous sample: there is no baseline.
	if pre.SystemUsage > 0 && cur.CPUUsage.TotalUsage >= pre.CPUUsage.TotalUsage && cur.SystemUsage > pre.SystemUsage {
		cpus := float64(cur.OnlineCPUs)
		if cpus == 0 {
			cpus = 1
		}
		cpuDelta := float64(cur.CPUUsage.TotalUsage - pre.CPUUsage.TotalUsage)
		sysDelta := float64(cur.SystemUsage - pre.SystemUsage)
		s.CPUPercent = cpuDelta / sysDelta * cpus * 100
	}

	usage := r.MemoryStats.Usage
	// cgroup v2 reports inactive_file, cgroup v1 total_inactive_file.
	cache := r.MemoryStats.Stats["inactive_file"]
	if cache == 0 {
		cache = r.MemoryStats.Stats["total_inactive_file"]
	}
	if cache < usage {
		usage -= cache
	}
	s.MemUsage = usage
	if s.MemLimit > 0 {
		s.MemPercent = float64(usage) / float64(s.MemLimit) * 100
	}

	for _, n := range r.Networks {
		s.NetRx += n.RxBytes
		s.NetTx += n.TxBytes
	}
	return s
}

// Stats streams resource usage samples (about one per second) to fn until
// the context ends, the container stops, or fn returns ErrStop.
func (c *Client) Stats(ctx context.Context, id string, fn func(Stats) error) error {
	if err := checkID(id); err != nil {
		return err
	}
	resp, err := c.get(ctx, "/containers/"+url.PathEscape(id)+"/stats", url.Values{"stream": {"1"}})
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	dec := json.NewDecoder(resp.Body)
	for {
		var raw rawStats
		if err := dec.Decode(&raw); err != nil {
			if err == io.EOF {
				return nil
			}
			return err
		}
		if err := fn(raw.toStats()); err != nil {
			if errors.Is(err, ErrStop) {
				return nil
			}
			return err
		}
	}
}
