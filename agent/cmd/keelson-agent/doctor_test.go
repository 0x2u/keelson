package main

import (
	"bytes"
	"context"
	"database/sql"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/0x2u/keelson/agent/internal/config"
	"github.com/0x2u/keelson/agent/internal/store"
	"github.com/0x2u/keelson/agent/internal/sysinfo"
)

func parsed(t *testing.T, yaml string) *config.Config {
	t.Helper()
	cfg, issues := config.Parse([]byte(yaml))
	if cfg == nil {
		t.Fatalf("%v", config.LoadIssues(issues))
	}
	return cfg
}

func levels(cs []check) []level {
	var out []level
	for _, c := range cs {
		out = append(out, c.level)
	}
	return out
}

func TestDoctorFilesFailsOnAMissingFileAndWarnsOnAnOpenSecret(t *testing.T) {
	dir := t.TempDir()
	open := filepath.Join(dir, "registry-token")
	closed := filepath.Join(dir, "env")
	if err := os.WriteFile(open, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(closed, []byte("A=1"), 0o644); err != nil { // an env_file is settings: any mode will do
		t.Fatal(err)
	}
	cfg := parsed(t, "registries:\n  - {host: ghcr.io, username: me, password_file: "+open+"}\n"+
		"apps:\n  - {name: web, image: ghcr.io/me/web, env_file: "+closed+"}\n  - {name: api, image: ghcr.io/me/api, env_file: "+filepath.Join(dir, "absent")+"}\n")

	got := checkFiles(cfg)
	want := map[string]level{
		"File registries[ghcr.io].password_file": levelWarn,
		"File apps[api].env_file":                levelFail,
	}
	if len(got) != len(want) {
		t.Fatalf("%d checks, want %d: %+v", len(got), len(want), got)
	}
	for _, c := range got {
		if l, ok := want[c.name]; !ok || l != c.level {
			t.Errorf("%s: level %d, want %v", c.name, c.level, want)
		}
	}
}

func TestDoctorFilesIsOKWhenEveryFileIsThere(t *testing.T) {
	dir := t.TempDir()
	env := filepath.Join(dir, "env")
	os.WriteFile(env, []byte("A=1"), 0o600)
	got := checkFiles(parsed(t, "apps:\n  - {name: web, image: x, env_file: "+env+"}\n"))
	if len(got) != 1 || got[0].level != levelOK || !strings.Contains(got[0].detail, "1, all readable") {
		t.Errorf("%+v", got)
	}
}

func TestDoctorRefusesADatabaseFromANewerAgentAndLeavesItAlone(t *testing.T) {
	dir := t.TempDir()
	db := filepath.Join(dir, "agent.db")
	st, err := store.Open(db)
	if err != nil {
		t.Fatal(err)
	}
	st.Close()

	got, _ := checkData(dir)
	if !slicesEqual(levels(got), []level{levelOK, levelOK}) || !strings.Contains(got[1].detail, "current") {
		t.Fatalf("a current database is fine: %+v", got)
	}

	raw, err := sql.Open("sqlite", "file:"+db)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := raw.Exec("PRAGMA user_version = 999"); err != nil {
		t.Fatal(err)
	}
	raw.Close()
	before, _ := os.ReadFile(db)

	got, _ = checkData(dir)
	if got[len(got)-1].level != levelFail || !strings.Contains(got[len(got)-1].detail, "newer agent") {
		t.Errorf("a newer schema must fail: %+v", got)
	}
	if after, _ := os.ReadFile(db); !bytes.Equal(before, after) {
		t.Error("doctor must not change the database")
	}
	if matches, _ := filepath.Glob(db + ".before-upgrade*"); len(matches) != 0 {
		t.Errorf("doctor must not make upgrade copies: %v", matches)
	}
}

func TestDoctorADataDirectoryThatDoesNotExistYetIsOnlyAWarning(t *testing.T) {
	got, disk := checkData(filepath.Join(t.TempDir(), "absent"))
	if len(got) != 1 || got[0].level != levelWarn || disk != nil {
		t.Errorf("%+v %v", got, disk)
	}
}

func TestDoctorDiskLevels(t *testing.T) {
	const gib = 1 << 30
	for name, tc := range map[string]struct {
		total, free uint64
		want        level
	}{
		"plenty":                {100 * gib, 60 * gib, levelOK},
		"nine tenths":           {100 * gib, 9 * gib, levelWarn},
		"under two gigabytes":   {20 * gib, 1 * gib, levelWarn},
		"under 1% free":         {100 * gib, 1 * gib / 2, levelFail},
		"98.5% of a big disk":   {1000 * gib, 15 * gib, levelWarn}, // a percentage alone does not fail a disk with room left
		"under 200 MiB free":    {10 * gib, 100 << 20, levelFail},
		"unknown size":          {0, 0, levelOK},
		"exactly 90 percent":    {100 * gib, 10 * gib, levelWarn},
		"just under 90 percent": {100 * gib, 11 * gib, levelOK},
	} {
		if got := diskCheck("d", &sysinfo.Disk{Total: tc.total, Free: tc.free}); got.level != tc.want {
			t.Errorf("%s: level %d, want %d (%s)", name, got.level, tc.want, got.detail)
		}
	}
}

func TestDoctorCaddyIsAFailureOnlyWhenAnAppNeedsIt(t *testing.T) {
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/config/" {
			t.Errorf("path %s", r.URL.Path)
		}
	}))
	defer up.Close()
	down := httptest.NewServer(nil)
	downURL := down.URL
	down.Close()

	withApp := func(admin string) *config.Config {
		return parsed(t, "proxy: {admin: "+admin+"}\napps:\n  - {name: web, image: x, domains: [www.example.com], port: 3000}\n")
	}
	withoutApp := func(admin string) *config.Config {
		return parsed(t, "proxy: {admin: "+admin+"}\napps:\n  - {name: web, image: x}\n")
	}
	for name, tc := range map[string]struct {
		cfg  *config.Config
		want level
	}{
		"answers":                      {withApp(up.URL), levelOK},
		"down and an app needs it":     {withApp(downURL), levelFail},
		"down and no app needs it yet": {withoutApp(downURL), levelWarn},
	} {
		c, ok := checkCaddy(context.Background(), tc.cfg)
		if !ok || c.level != tc.want {
			t.Errorf("%s: %+v (checked %v), want level %d", name, c, ok, tc.want)
		}
	}
	if _, ok := checkCaddy(context.Background(), parsed(t, "apps:\n  - {name: web, image: x}\n")); ok {
		t.Error("without a proxy section there is nothing to check")
	}
}

func TestDoctorDashboardReachability(t *testing.T) {
	status := http.StatusOK
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/health" {
			t.Errorf("path %s", r.URL.Path)
		}
		w.WriteHeader(status)
	}))
	relay := func(url string) string {
		p := filepath.Join(t.TempDir(), "relay.json")
		os.WriteFile(p, []byte(`{"dashboard":"`+url+`","credential":"c","server_id":"s","name":"n"}`), 0o600)
		return p
	}
	if c := checkDashboard(context.Background(), relay(srv.URL)); c.level != levelOK {
		t.Errorf("reachable: %+v", c)
	}
	status = http.StatusBadGateway
	if c := checkDashboard(context.Background(), relay(srv.URL)); c.level != levelWarn {
		t.Errorf("a dashboard that fails is a warning: %+v", c)
	}
	srv.Close()
	if c := checkDashboard(context.Background(), relay(srv.URL)); c.level != levelFail {
		t.Errorf("unreachable: %+v", c)
	}
	if c := checkDashboard(context.Background(), filepath.Join(t.TempDir(), "absent.json")); c.level != levelFail {
		t.Errorf("no relay file: %+v", c)
	}
}

func TestDoctorExitsOneWhenACheckFails(t *testing.T) {
	var out bytes.Buffer
	err := runDoctor(context.Background(), &out, doctorOptions{socket: filepath.Join(t.TempDir(), "no.sock"), dataDir: t.TempDir()})
	if exitCode(err) != 1 || !strings.Contains(out.String(), "FAIL  Docker engine") || !strings.Contains(out.String(), "1 failures") {
		t.Fatalf("exit %d:\n%s", exitCode(err), out.String())
	}
}

func slicesEqual(a, b []level) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}
