package deploy

import (
	"archive/tar"
	"bytes"
	"context"
	"fmt"
	"io"
	"os"
	"os/exec"
	"testing"

	"github.com/0x2u/keelson/agent/internal/docker"
)

// TestRealArchiveSaysWhichPlatformItIsFor reads the platform of archives a real engine saves, for each architecture: the
// manifest of a real `docker save` points at the image config the check reads. It only runs when KEELSON_DOCKER_TEST is set.
func TestRealArchiveSaysWhichPlatformItIsFor(t *testing.T) {
	if os.Getenv("KEELSON_DOCKER_TEST") == "" {
		t.Skip("set KEELSON_DOCKER_TEST=1 to run against a real Docker engine")
	}
	socket := os.Getenv("KEELSON_DOCKER_SOCKET")
	if socket == "" {
		socket = "/var/run/docker.sock"
	}
	a := docker.NewAdmin(socket)
	ctx := context.Background()
	for _, arch := range []string{"amd64", "arm64"} {
		ref := fmt.Sprintf("keelson-real-archive-%d:%s", os.Getpid(), arch)
		t.Cleanup(func() { exec.Command("docker", "rmi", "-f", ref).Run() })
		// A layer is needed: the engine gives an image with none its own platform, whatever the build asked for.
		var buf bytes.Buffer
		tw := tar.NewWriter(&buf)
		for name, body := range map[string]string{"Dockerfile": "FROM scratch\nCOPY hello /hello\n", "hello": "hi\n"} {
			if err := tw.WriteHeader(&tar.Header{Name: name, Mode: 0o644, Size: int64(len(body))}); err != nil {
				t.Fatal(err)
			}
			tw.Write([]byte(body))
		}
		tw.Close()
		if err := a.Build(ctx, docker.BuildOptions{Tag: ref, Platform: "linux/" + arch}, &buf, func(string) {}); err != nil {
			t.Fatal(err)
		}
		r, err := a.SaveImage(ctx, ref)
		if err != nil {
			t.Fatal(err)
		}
		file, err := os.CreateTemp(t.TempDir(), "image-*.tar")
		if err != nil {
			t.Fatal(err)
		}
		if _, err := io.Copy(file, r); err != nil {
			t.Fatal(err)
		}
		r.Close()
		if _, err := file.Seek(0, io.SeekStart); err != nil {
			t.Fatal(err)
		}
		path, err := manifestConfig(file, ref)
		if err != nil {
			t.Fatalf("%s: %v", arch, err)
		}
		if _, err := file.Seek(0, io.SeekStart); err != nil {
			t.Fatal(err)
		}
		osName, got, err := imagePlatform(file, path)
		if err != nil || osName != "linux" || got != arch {
			t.Errorf("an image built for %s reads as %s/%s: %v", arch, osName, got, err)
		}
	}
}
