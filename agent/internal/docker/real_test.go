package docker

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"slices"
	"strings"
	"testing"
)

func realDocker(t *testing.T, args ...string) string {
	t.Helper()
	out, err := exec.Command("docker", args...).CombinedOutput()
	if err != nil {
		t.Fatalf("docker %s: %v: %s", strings.Join(args, " "), err, out)
	}
	return strings.TrimSpace(string(out))
}

func volumes(t *testing.T) []string {
	t.Helper()
	return strings.Fields(realDocker(t, "volume", "ls", "-q"))
}

// anonymousVolumes returns the volumes of a container that are not the named one: what its image's VOLUME made. It
// reads the container, not the engine's whole list, so that another test creating volumes at the same time cannot
// disturb the count.
func anonymousVolumes(t *testing.T, container, named string) []string {
	t.Helper()
	var out []string
	for _, v := range strings.Fields(realDocker(t, "inspect", "-f", `{{range .Mounts}}{{if eq .Type "volume"}}{{.Name}} {{end}}{{end}}`, container)) {
		if v != named {
			out = append(out, v)
		}
	}
	return out
}

// TestRealRemoveThrowawayKeepsNamedVolumesAndBindsButNotAppVolumes runs against a real engine with an image that
// declares a VOLUME (postgres:16-alpine): RemoveThrowaway deletes the anonymous volume and only that, Remove (an
// app's container) keeps it. It only runs when KEELSON_DOCKER_TEST is set.
func TestRealRemoveThrowawayKeepsNamedVolumesAndBindsButNotAppVolumes(t *testing.T) {
	if os.Getenv("KEELSON_DOCKER_TEST") == "" {
		t.Skip("set KEELSON_DOCKER_TEST=1 to run against a real Docker engine")
	}
	const image = "postgres:16-alpine"
	a := NewAdmin("/var/run/docker.sock")
	ctx := context.Background()
	sfx := fmt.Sprintf("%d", os.Getpid())
	named, throwaway, app, bindDir := "kv-rm-named-"+sfx, "kv-rm-throwaway-"+sfx, "kv-rm-app-"+sfx, t.TempDir()
	realDocker(t, "volume", "create", named)
	t.Cleanup(func() { exec.Command("docker", "volume", "rm", named).Run() })

	// A throwaway with the image's anonymous volume on /var/lib/postgresql/data, a named volume and a bind.
	if _, err := a.Create(ctx, ContainerSpec{Name: throwaway, Image: image, RestartPolicy: "no", StopTimeout: 1,
		Binds: []string{named + ":/named", bindDir + ":/bind"}}); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { exec.Command("docker", "rm", "-f", "-v", throwaway).Run() })
	made := anonymousVolumes(t, throwaway, named)
	if len(made) != 1 {
		t.Fatalf("the image's VOLUME must have made one anonymous volume, got %v", made)
	}
	if err := a.RemoveThrowaway(ctx, throwaway); err != nil {
		t.Fatal(err)
	}
	if slices.Contains(volumes(t), made[0]) {
		t.Error("the anonymous volume must go with a throwaway container")
	}
	if !slices.Contains(volumes(t), named) {
		t.Error("a named volume must survive")
	}
	if _, err := os.Stat(bindDir); err != nil {
		t.Error("a bind mount must survive")
	}

	// An app's container keeps what it holds.
	if _, err := a.Create(ctx, ContainerSpec{Name: app, Image: image, RestartPolicy: "no", StopTimeout: 1}); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { exec.Command("docker", "rm", "-f", "-v", app).Run() })
	anon := anonymousVolumes(t, app, "")
	if len(anon) != 1 {
		t.Fatalf("anonymous volume of the app's container: %v", anon)
	}
	t.Cleanup(func() { exec.Command("docker", "volume", "rm", anon[0]).Run() })
	if err := a.Remove(ctx, app); err != nil {
		t.Fatal(err)
	}
	if !slices.Contains(volumes(t), anon[0]) {
		t.Error("removing an app's container must keep its volumes")
	}
	// Unknown container: not found, as before.
	if err := a.RemoveThrowaway(ctx, throwaway); !IsNotFound(err) {
		t.Errorf("want not found, got %v", err)
	}
}
