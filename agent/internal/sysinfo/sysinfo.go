// Package sysinfo reads the host's own load, memory and disk usage. Everything is optional: a part the machine does not
// expose (another OS than Linux, an unreadable path) is left out rather than guessed.
package sysinfo

import (
	"bufio"
	"fmt"
	"io"
	"os"
	"runtime"
	"strconv"
	"strings"
	"syscall"
)

// Load is the 1, 5 and 15 minute load averages.
type Load struct {
	One     float64 `json:"one"`
	Five    float64 `json:"five"`
	Fifteen float64 `json:"fifteen"`
}

// Memory is in bytes. Available is what a new process can get without swapping (MemAvailable), not just what is free.
type Memory struct {
	Total     uint64 `json:"total"`
	Available uint64 `json:"available"`
	SwapTotal uint64 `json:"swap_total"`
	SwapFree  uint64 `json:"swap_free"`
}

// Disk is a filesystem's size in bytes; Free is what an unprivileged process can still use. Dev identifies the
// filesystem, so two paths on the same one are not counted twice; it is not part of the API answer.
type Disk struct {
	Path  string `json:"path"`
	Total uint64 `json:"total"`
	Free  uint64 `json:"free"`
	Dev   uint64 `json:"-"`
}

// Host is what could be read about the machine.
type Host struct {
	Hostname      string  `json:"hostname,omitempty"`
	CPUs          int     `json:"cpus"`
	UptimeSeconds *int64  `json:"uptime_seconds,omitempty"`
	Load          *Load   `json:"load,omitempty"`
	Memory        *Memory `json:"memory,omitempty"`
	Disk          *Disk   `json:"disk,omitempty"`
}

// ProcDir is the /proc directory to read: the host's, unless KEELSON_PROC_DIR names another (scripts/capture-contract.sh
// points it at fixed files, so that what the agent reports is the same on every machine).
func ProcDir() string {
	if dir := os.Getenv("KEELSON_PROC_DIR"); dir != "" {
		return dir
	}
	return "/proc"
}

// Read gathers the host's state. proc is the /proc directory; the disk is measured at the first of diskPaths that can
// be measured (the engine's data directory is often unreadable to the agent's account: "/" then answers for it).
func Read(proc string, diskPaths ...string) Host {
	h := Host{CPUs: runtime.NumCPU()}
	h.Hostname, _ = os.Hostname()
	if f, err := os.Open(proc + "/loadavg"); err == nil {
		h.Load, _ = parseLoadavg(f)
		f.Close()
	}
	if f, err := os.Open(proc + "/meminfo"); err == nil {
		h.Memory, _ = parseMeminfo(f)
		f.Close()
	}
	if f, err := os.Open(proc + "/uptime"); err == nil {
		h.UptimeSeconds, _ = parseUptime(f)
		f.Close()
	}
	for _, p := range diskPaths {
		if p == "" {
			continue
		}
		if d, err := statDisk(p); err == nil {
			h.Disk = d
			break
		}
	}
	return h
}

func statDisk(path string) (*Disk, error) {
	var st syscall.Statfs_t
	if err := syscall.Statfs(path, &st); err != nil {
		return nil, err
	}
	var fi syscall.Stat_t
	if err := syscall.Stat(path, &fi); err != nil {
		return nil, err
	}
	bs := uint64(st.Bsize)
	return &Disk{Path: path, Total: uint64(st.Blocks) * bs, Free: uint64(st.Bavail) * bs, Dev: uint64(fi.Dev)}, nil
}

func parseLoadavg(r io.Reader) (*Load, error) {
	data, err := io.ReadAll(io.LimitReader(r, 1024))
	if err != nil {
		return nil, err
	}
	f := strings.Fields(string(data))
	if len(f) < 3 {
		return nil, fmt.Errorf("loadavg: %d fields", len(f))
	}
	var l Load
	for i, dst := range []*float64{&l.One, &l.Five, &l.Fifteen} {
		if *dst, err = strconv.ParseFloat(f[i], 64); err != nil {
			return nil, fmt.Errorf("loadavg: %w", err)
		}
	}
	return &l, nil
}

func parseUptime(r io.Reader) (*int64, error) {
	data, err := io.ReadAll(io.LimitReader(r, 1024))
	if err != nil {
		return nil, err
	}
	f := strings.Fields(string(data))
	if len(f) < 1 {
		return nil, fmt.Errorf("uptime: empty")
	}
	s, err := strconv.ParseFloat(f[0], 64)
	if err != nil {
		return nil, fmt.Errorf("uptime: %w", err)
	}
	n := int64(s)
	return &n, nil
}

// parseMeminfo reads /proc/meminfo, whose values are in kB. MemAvailable (kernel 3.14 and later) is required: without it
// "free" would be a misleading number.
func parseMeminfo(r io.Reader) (*Memory, error) {
	var m Memory
	seen := map[string]bool{}
	sc := bufio.NewScanner(r)
	for sc.Scan() {
		name, rest, ok := strings.Cut(sc.Text(), ":")
		if !ok {
			continue
		}
		var dst *uint64
		switch name {
		case "MemTotal":
			dst = &m.Total
		case "MemAvailable":
			dst = &m.Available
		case "SwapTotal":
			dst = &m.SwapTotal
		case "SwapFree":
			dst = &m.SwapFree
		default:
			continue
		}
		f := strings.Fields(rest)
		if len(f) == 0 {
			continue
		}
		kb, err := strconv.ParseUint(f[0], 10, 64)
		if err != nil {
			return nil, fmt.Errorf("meminfo %s: %w", name, err)
		}
		*dst = kb * 1024
		seen[name] = true
	}
	if err := sc.Err(); err != nil {
		return nil, err
	}
	if !seen["MemTotal"] || !seen["MemAvailable"] {
		return nil, fmt.Errorf("meminfo: MemTotal or MemAvailable missing")
	}
	return &m, nil
}
