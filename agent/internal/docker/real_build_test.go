package docker

import (
	"archive/tar"
	"bytes"
	"context"
	"fmt"
	"os"
	"os/exec"
	"testing"
)

// scratchContext is a build context of a Dockerfile that needs no base image and no network. It has a layer on purpose:
// the engine gives an image with none its own platform, whatever the build asked for.
func scratchContext(t *testing.T) []byte {
	t.Helper()
	var buf bytes.Buffer
	tw := tar.NewWriter(&buf)
	for name, body := range map[string]string{"Dockerfile": "FROM scratch\nCOPY hello /hello\n", "hello": "hi\n"} {
		if err := tw.WriteHeader(&tar.Header{Name: name, Mode: 0o644, Size: int64(len(body))}); err != nil {
			t.Fatal(err)
		}
		if _, err := tw.Write([]byte(body)); err != nil {
			t.Fatal(err)
		}
	}
	if err := tw.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

// TestRealBuildForAnotherPlatform builds the same context for linux/amd64 and for linux/arm64 on a real engine and reads
// the architecture of each resulting image: a Mac builds what a server of the other architecture runs. It only runs when
// KEELSON_DOCKER_TEST is set.
func TestRealBuildForAnotherPlatform(t *testing.T) {
	if os.Getenv("KEELSON_DOCKER_TEST") == "" {
		t.Skip("set KEELSON_DOCKER_TEST=1 to run against a real Docker engine")
	}
	socket := os.Getenv("KEELSON_DOCKER_SOCKET")
	if socket == "" {
		socket = "/var/run/docker.sock"
	}
	a := NewAdmin(socket)
	ctx := context.Background()
	for _, arch := range []string{"amd64", "arm64"} {
		tag := fmt.Sprintf("keelson-real-platform-%d:%s", os.Getpid(), arch)
		t.Cleanup(func() { exec.Command("docker", "rmi", "-f", tag).Run() })
		err := a.Build(ctx, BuildOptions{Tag: tag, Platform: "linux/" + arch}, bytes.NewReader(scratchContext(t)), func(string) {})
		if err != nil {
			t.Fatalf("build for %s: %v", arch, err)
		}
		if got := realDocker(t, "image", "inspect", "-f", "{{.Os}}/{{.Architecture}}", tag); got != "linux/"+arch {
			t.Errorf("built for %s, the image is for %s", arch, got)
		}
	}
}
