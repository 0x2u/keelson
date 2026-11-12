package databases

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"filippo.io/age"

	"github.com/0x2u/keelson/agent/internal/config"
	"github.com/0x2u/keelson/agent/internal/docker"
	"github.com/0x2u/keelson/agent/internal/store"
)

// countingEngine counts the containers the service creates.
type countingEngine struct {
	*docker.Admin
	creates atomic.Int32
}

func (c *countingEngine) Create(ctx context.Context, s docker.ContainerSpec) (string, error) {
	c.creates.Add(1)
	return c.Admin.Create(ctx, s)
}

func dockerOut(t *testing.T, args ...string) string {
	t.Helper()
	out, err := exec.Command("docker", args...).CombinedOutput()
	if err != nil {
		t.Fatalf("docker %s: %v: %s", strings.Join(args, " "), err, out)
	}
	return strings.TrimSpace(string(out))
}

// danglingVolumes lists the volumes no container uses.
func danglingVolumes(t *testing.T) []string {
	t.Helper()
	out := dockerOut(t, "volume", "ls", "-q", "-f", "dangling=true")
	if out == "" {
		return nil
	}
	f := strings.Fields(out)
	slices.Sort(f)
	return f
}

// newVolumes returns the volumes in now that are not in before.
func newVolumes(before, now []string) []string {
	var out []string
	for _, v := range now {
		if !slices.Contains(before, v) {
			out = append(out, v)
		}
	}
	return out
}

// TestRealDockerThrowawayContainersLeaveNoVolumeBehind runs the database service against a real PostgreSQL and a
// real engine, and counts the dangling volumes after many probes of the live server, a backup and a restore. The
// postgres image declares a VOLUME: without the removal of anonymous volumes each of those runs leaks one. It needs
// Docker with postgres:16-alpine and only runs when KEELSON_DOCKER_TEST is set.
func TestRealDockerThrowawayContainersLeaveNoVolumeBehind(t *testing.T) {
	if os.Getenv("KEELSON_DOCKER_TEST") == "" {
		t.Skip("set KEELSON_DOCKER_TEST=1 to run against a real Docker engine")
	}
	const image = "postgres:16-alpine"
	suffix := fmt.Sprintf("%d", os.Getpid())
	network, server := "kv-dbvol-net-"+suffix, "kv-dbvol-pg-"+suffix

	dockerOut(t, "network", "create", network)
	t.Cleanup(func() { exec.Command("docker", "network", "rm", network).Run() })
	dockerOut(t, "run", "-d", "--name", server, "--network", network,
		"-e", "POSTGRES_PASSWORD=kv-secret", "-e", "POSTGRES_USER=shop", "-e", "POSTGRES_DB=shop", image)
	// -v: the server's own anonymous volume goes with it.
	t.Cleanup(func() { exec.Command("docker", "rm", "-f", "-v", server).Run() })
	ready := false
	for i := 0; i < 60 && !ready; i++ {
		// The entrypoint starts a temporary server first: ask twice, a second apart.
		if exec.Command("docker", "exec", server, "pg_isready", "-U", "shop", "-d", "shop").Run() == nil {
			time.Sleep(2 * time.Second)
			ready = exec.Command("docker", "exec", server, "pg_isready", "-U", "shop", "-d", "shop").Run() == nil
		}
		if !ready {
			time.Sleep(time.Second)
		}
	}
	if !ready {
		t.Fatal("the PostgreSQL server did not come up")
	}
	dockerOut(t, "exec", server, "psql", "-U", "shop", "-d", "shop", "-c", "create table users (id int); insert into users select generate_series(1, 42)")

	dir := t.TempDir()
	if err := os.Chmod(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	pass := filepath.Join(dir, "pw")
	if err := os.WriteFile(pass, []byte("kv-secret\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	backups := filepath.Join(dir, "backups")
	if err := os.MkdirAll(backups, 0o755); err != nil {
		t.Fatal(err)
	}
	id, err := age.GenerateX25519Identity()
	if err != nil {
		t.Fatal(err)
	}
	cfg, issues := config.Parse([]byte(fmt.Sprintf(`
databases:
  - name: shop
    host: %s
    database: shop
    user: shop
    password_file: %s
    network: %s
    version: 16
    backup:
      schedule: "0 3 * * *"
      recipients: ["%s"]
      destination: {local: {dir: %s}}
`, server, pass, network, id.Recipient(), backups)))
	if cfg == nil {
		t.Fatalf("config: %+v", issues)
	}
	st, err := store.Open(filepath.Join(dir, "a.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	eng := &countingEngine{Admin: docker.NewAdmin("/var/run/docker.sock")}
	svc := New(Options{Config: cfg, Store: st, Engine: eng, DataDir: filepath.Join(dir, "data"), Log: slog.New(slog.NewTextHandler(io.Discard, nil))})
	defer svc.Shutdown(time.Minute)
	ctx := context.Background()
	if err := svc.ensureImage(ctx, image, nil); err != nil {
		t.Fatal(err)
	}

	// The control: a throwaway container removed the old way leaks its anonymous volume. If it did not, this test
	// would prove nothing.
	before := danglingVolumes(t)
	if _, err := eng.Create(ctx, docker.ContainerSpec{Name: "kv-dbvol-control-" + suffix, Image: image, RestartPolicy: "no", StopTimeout: 1}); err != nil {
		t.Fatal(err)
	}
	if err := eng.Remove(ctx, "kv-dbvol-control-"+suffix); err != nil {
		t.Fatal(err)
	}
	leaked := newVolumes(before, danglingVolumes(t))
	if len(leaked) != 1 {
		t.Fatalf("the control must leak exactly one anonymous volume, got %v", leaked)
	}
	dockerOut(t, "volume", "rm", leaked[0]) // the test's own mess
	before = danglingVolumes(t)
	eng.creates.Store(0)

	// Opening the page many times, at once and one after the other: one container for the minute the answer is kept.
	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if live, err := svc.Live(ctx, "shop"); err != nil || live.ServerVersion == "" || live.SizeBytes == 0 {
				t.Errorf("live: %+v %v", live, err)
			}
		}()
	}
	wg.Wait()
	for i := 0; i < 20; i++ {
		if _, err := svc.Live(ctx, "shop"); err != nil {
			t.Fatal(err)
		}
	}
	t.Logf("28 calls to Live started %d container(s)", eng.creates.Load())
	if n := eng.creates.Load(); n != 1 {
		t.Errorf("28 calls to Live started %d containers, want 1", n)
	}
	// And the probe itself, forced to run again and again (the cache expired).
	for i := 0; i < 6; i++ {
		svc.mu.Lock()
		clear(svc.lives)
		svc.mu.Unlock()
		if _, err := svc.Live(ctx, "shop"); err != nil {
			t.Fatal(err)
		}
	}
	t.Logf("dangling volumes: %d at the start, %d after 7 real probes", len(before), len(danglingVolumes(t)))
	if got := newVolumes(before, danglingVolumes(t)); len(got) != 0 {
		t.Errorf("%d probes leaked volumes: %v", 7, got)
	}

	// A backup: dump, verify, encrypt.
	if err := svc.Backup(ctx, "shop", func(string) {}); err != nil {
		t.Fatal(err)
	}
	t.Logf("dangling volumes after a backup: %d", len(danglingVolumes(t)))
	if got := newVolumes(before, danglingVolumes(t)); len(got) != 0 {
		t.Errorf("a backup leaked volumes: %v", got)
	}

	// A restore into a new database: verify, create, restore, count the rows.
	list, err := svc.Backups(ctx, "shop")
	if err != nil || len(list) != 1 {
		t.Fatalf("backups: %+v %v", list, err)
	}
	started, err := svc.Restore(ctx, RestoreRequest{Database: "shop", Backup: list[0].Key, Identity: id.String(), Target: "shop_copy"})
	if err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(2 * time.Minute)
	for {
		runs, err := svc.Restores(ctx, "shop", 1)
		if err != nil {
			t.Fatal(err)
		}
		if len(runs) == 1 && runs[0].Status != store.JobRunning {
			if runs[0].Status != store.JobSucceeded {
				t.Fatalf("the restore %s ended %s: %s", started.RunID, runs[0].Status, runs[0].Output)
			}
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("the restore did not end")
		}
		time.Sleep(200 * time.Millisecond)
	}
	if got := dockerOut(t, "exec", server, "psql", "-U", "shop", "-d", "shop_copy", "-At", "-c", "select count(*) from users"); got != "42" {
		t.Errorf("the restored database has %q rows, want 42", got)
	}
	t.Logf("dangling volumes after a restore: %d", len(danglingVolumes(t)))
	if got := newVolumes(before, danglingVolumes(t)); len(got) != 0 {
		t.Errorf("a restore leaked volumes: %v", got)
	}
	// No throwaway container is left either.
	if left := dockerOut(t, "ps", "-a", "-q", "--filter", "label=keelson.job=true"); left != "" {
		t.Errorf("throwaway containers left: %s", left)
	}
}
