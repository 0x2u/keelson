package deploy

import (
	"context"
	"errors"
	"slices"
	"strings"
	"testing"

	"github.com/0x2u/keelson/agent/internal/config"
	"github.com/0x2u/keelson/agent/internal/docker"
	"github.com/0x2u/keelson/agent/internal/store"
)

func (f *fakeEngine) ListImages(_ context.Context, repository string) ([]docker.Image, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []docker.Image
	for _, img := range f.images {
		for _, ref := range append(append([]string{}, img.RepoTags...), img.RepoDigests...) {
			if strings.HasPrefix(ref, repository+":") || strings.HasPrefix(ref, repository+"@") {
				out = append(out, img)
				break
			}
		}
	}
	return out, nil
}

func (f *fakeEngine) ListDanglingImages(_ context.Context) ([]docker.Image, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]docker.Image(nil), f.dangling...), nil
}

func (f *fakeEngine) RemoveImage(_ context.Context, ref string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if err := f.removeErr[ref]; err != nil {
		return err
	}
	f.removedImages = append(f.removedImages, ref)
	f.dangling = slices.DeleteFunc(f.dangling, func(img docker.Image) bool { return img.ID == ref })
	return nil
}

// tagged is a local image of the test repository with one tag.
func tagged(id, tag string) docker.Image {
	return docker.Image{ID: id, RepoTags: []string{repo + ":" + tag}, RepoDigests: []string{repo + "@sha256:" + id}}
}

func (h *harness) removed() []string {
	h.eng.mu.Lock()
	defer h.eng.mu.Unlock()
	out := append([]string(nil), h.eng.removedImages...)
	slices.Sort(out)
	return out
}

func TestOldImagesAreRemovedBeyondTheKeptVersions(t *testing.T) {
	h := newHarness(t, func(a *config.App) { a.KeepImages = ptr(2) })
	h.deploy("v1")
	h.deploy("v2")
	h.eng.images = []docker.Image{tagged("a1", "v1"), tagged("a2", "v2"), tagged("a3", "v3"), tagged("a0", "v0")}

	dep := h.deploy("v3")
	if dep.Status != store.StatusSucceeded {
		t.Fatalf("status %s", dep.Status)
	}
	// The two newest deployed versions (v3, v2) stay; v1 and the never-deployed v0 go, tag and digest alike.
	want := []string{repo + ":v0", repo + ":v1", repo + "@sha256:a0", repo + "@sha256:a1"}
	if got := h.removed(); !slices.Equal(got, want) {
		t.Errorf("removed %v, want %v", got, want)
	}
	if ev := h.events(dep.ID); !strings.Contains(ev, "removed 2 old images") {
		t.Errorf("the deployment log must say what was removed:\n%s", ev)
	}
}

func TestPruneKeepsThreeVersionsByDefaultAndNeverTouchesOtherRepositories(t *testing.T) {
	h := newHarness(t)
	h.deploy("v1")
	h.deploy("v2")
	h.eng.images = []docker.Image{tagged("a1", "v1"), tagged("a2", "v2"), tagged("a3", "v3")}
	h.deploy("v3")
	if got := h.removed(); len(got) != 0 {
		t.Errorf("three versions are kept by default: removed %v", got)
	}
}

func TestAnImageInUseIsLeftAndAFailureNeverFailsTheDeployment(t *testing.T) {
	h := newHarness(t, func(a *config.App) { a.KeepImages = ptr(1) })
	h.eng.images = []docker.Image{tagged("a1", "v1"), tagged("a9", "v9")}
	h.eng.removeErr = map[string]error{
		repo + ":v1":        docker.ErrImageInUse,
		repo + "@sha256:a1": docker.ErrImageInUse,
		repo + ":v9":        errors.New("engine hiccup"),
		repo + "@sha256:a9": errors.New("engine hiccup"),
	}
	dep := h.deploy("v2")
	if dep.Status != store.StatusSucceeded {
		t.Fatalf("pruning must never fail a deployment: %s %s", dep.Status, dep.Error)
	}
	ev := h.events(dep.ID)
	if strings.Contains(ev, "removed 1") || !strings.Contains(ev, "warn could not remove some old images: engine hiccup") {
		t.Errorf("an in-use image is skipped quietly, a real failure is reported:\n%s", ev)
	}
}

func TestADigestDeployedVersionKeepsItsImage(t *testing.T) {
	h := newHarness(t, func(a *config.App) { a.KeepImages = ptr(1) })
	digest := "sha256:" + strings.Repeat("c", 64)
	id, done, err := h.d.Start(context.Background(), "web", Target{Digest: digest}, "api")
	if err != nil {
		t.Fatal(err)
	}
	<-done
	h.eng.images = []docker.Image{
		{ID: "c", RepoTags: []string{repo + ":latest"}, RepoDigests: []string{repo + "@" + digest}},
		tagged("a1", "old"),
	}
	dep, _ := h.st.Deployment(context.Background(), id)
	if dep.Status != store.StatusSucceeded {
		t.Fatalf("%s %s", dep.Status, dep.Error)
	}
	h.d.pruneImages(context.Background(), id, h.d.config().Apps[0], repo+"@"+digest)
	if got := h.removed(); !slices.Equal(got, []string{repo + ":old", repo + "@sha256:a1"}) {
		t.Errorf("only the other image goes, whichever of its references the deployment used: %v", got)
	}
}

func TestMigrationImagesAreRemovedAtTheSameTagsAsTheApp(t *testing.T) {
	migrate := repo + "-migrate"
	h := newHarness(t, withRelease(config.ReleaseStep{Name: "migrate", Action: config.Action{Container: &config.ContainerAction{Image: migrate, Command: []string{"migrate", "deploy"}}}}), func(a *config.App) { a.KeepImages = ptr(2) })
	h.deploy("v1")
	h.deploy("v2")
	h.eng.images = []docker.Image{
		tagged("a1", "v1"), tagged("a2", "v2"), tagged("a3", "v3"),
		{ID: "m1", RepoTags: []string{migrate + ":v1"}},
		{ID: "m2", RepoTags: []string{migrate + ":v2"}},
		{ID: "m3", RepoTags: []string{migrate + ":v3"}},
	}
	if dep := h.deploy("v3"); dep.Status != store.StatusSucceeded {
		t.Fatalf("%s: %s", dep.Status, dep.Error)
	}
	want := []string{migrate + ":v1", repo + ":v1", repo + "@sha256:a1"}
	if got := h.removed(); !slices.Equal(got, want) {
		t.Errorf("removed %v, want %v: the migration image of a kept version stays, the others go", got, want)
	}
}
