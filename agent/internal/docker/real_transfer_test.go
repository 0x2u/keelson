package docker

import (
	"archive/tar"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"testing"
)

// A saved image can be loaded back: the archive the engine writes carries a manifest.json that names the image, which is
// what the agent checks before it loads one sent by another server. It only runs when KEELSON_DOCKER_TEST is set.
func TestRealSaveAndLoadAnImage(t *testing.T) {
	if os.Getenv("KEELSON_DOCKER_TEST") == "" {
		t.Skip("set KEELSON_DOCKER_TEST=1 to run against a real Docker engine")
	}
	socket := os.Getenv("KEELSON_DOCKER_SOCKET")
	if socket == "" {
		socket = "/var/run/docker.sock"
	}
	a := NewAdmin(socket)
	ctx := context.Background()
	const repo, tag = "alpine", "3.20"
	ref := repo + ":" + tag
	if err := a.Pull(ctx, repo, tag, "", nil); err != nil {
		t.Fatal(err)
	}

	r, err := a.SaveImage(ctx, ref)
	if err != nil {
		t.Fatal(err)
	}
	archive, err := io.ReadAll(r)
	r.Close()
	if err != nil || len(archive) == 0 {
		t.Fatalf("saved %d bytes: %v", len(archive), err)
	}

	tr := tar.NewReader(bytes.NewReader(archive))
	var tags []string
	for {
		h, err := tr.Next()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			t.Fatal(err)
		}
		if h.Name == "manifest.json" {
			var m []struct{ RepoTags []string }
			if err := json.NewDecoder(tr).Decode(&m); err != nil {
				t.Fatal(err)
			}
			for _, e := range m {
				tags = append(tags, e.RepoTags...)
			}
		}
	}
	if len(tags) != 1 || tags[0] != ref {
		t.Fatalf("the manifest of a saved image must tag exactly %s, got %v", ref, tags)
	}

	if err := a.RemoveImage(ctx, ref); err != nil {
		t.Fatal(err)
	}
	if _, err := a.ImageRepoDigests(ctx, ref); !IsNotFound(err) {
		t.Fatalf("the image must be gone before the load: %v", err)
	}
	if err := a.LoadImage(ctx, bytes.NewReader(archive)); err != nil {
		t.Fatal(err)
	}
	if _, err := a.ImageRepoDigests(ctx, ref); err != nil {
		t.Fatalf("loading the archive must bring the image back: %v", err)
	}
	if err := a.LoadImage(ctx, bytes.NewReader([]byte("not a tar archive"))); err == nil {
		t.Error("garbage must be refused")
	}
}
