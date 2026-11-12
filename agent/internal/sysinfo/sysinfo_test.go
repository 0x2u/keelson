package sysinfo

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestParseMeminfoUsesAvailableNotFree(t *testing.T) {
	m, err := parseMeminfo(strings.NewReader("MemTotal:        2048000 kB\nMemFree:           10000 kB\nMemAvailable:    1024000 kB\nSwapTotal:        512000 kB\nSwapFree:         256000 kB\n"))
	if err != nil {
		t.Fatal(err)
	}
	if m.Total != 2048000*1024 || m.Available != 1024000*1024 || m.SwapTotal != 512000*1024 || m.SwapFree != 256000*1024 {
		t.Errorf("%+v", m)
	}
}

func TestParseMeminfoRefusesAFileWithoutMemAvailable(t *testing.T) {
	if _, err := parseMeminfo(strings.NewReader("MemTotal: 100 kB\nMemFree: 50 kB\n")); err == nil {
		t.Fatal("an old kernel's file must not pass MemFree off as available memory")
	}
}

func TestParseLoadavgAndUptime(t *testing.T) {
	l, err := parseLoadavg(strings.NewReader("0.52 1.25 3.00 2/180 12345\n"))
	if err != nil || l.One != 0.52 || l.Five != 1.25 || l.Fifteen != 3 {
		t.Fatalf("%+v %v", l, err)
	}
	if _, err := parseLoadavg(strings.NewReader("0.52 x 3")); err == nil {
		t.Error("a malformed average must be an error")
	}
	u, err := parseUptime(strings.NewReader("350735.47 234388.90\n"))
	if err != nil || *u != 350735 {
		t.Fatalf("%v %v", u, err)
	}
}

func TestReadLeavesOutWhatIsNotThereAndFallsBackOnTheDisk(t *testing.T) {
	proc := t.TempDir()
	if err := os.WriteFile(filepath.Join(proc, "loadavg"), []byte("1.00 2.00 3.00 1/1 1\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	h := Read(proc, "/nonexistent/docker/root", t.TempDir())
	if h.Load == nil || h.Load.One != 1 {
		t.Errorf("load: %+v", h.Load)
	}
	if h.Memory != nil || h.UptimeSeconds != nil {
		t.Error("files that do not exist must leave their part out")
	}
	if h.Disk == nil || h.Disk.Total == 0 || h.Disk.Free > h.Disk.Total || strings.HasPrefix(h.Disk.Path, "/nonexistent") {
		t.Errorf("disk: %+v", h.Disk)
	}
	if h.CPUs < 1 {
		t.Errorf("cpus %d", h.CPUs)
	}
}

func TestProcDirIsProcUnlessTheEnvironmentNamesAnother(t *testing.T) {
	t.Setenv("KEELSON_PROC_DIR", "")
	if got := ProcDir(); got != "/proc" {
		t.Fatalf("ProcDir() = %q, want /proc", got)
	}
	t.Setenv("KEELSON_PROC_DIR", "/tmp/fake-proc")
	if got := ProcDir(); got != "/tmp/fake-proc" {
		t.Fatalf("ProcDir() = %q, want /tmp/fake-proc", got)
	}
}
