package deploy

import (
	"archive/tar"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/0x2u/keelson/agent/internal/config"
	"github.com/0x2u/keelson/agent/internal/docker"
	"github.com/0x2u/keelson/agent/internal/store"
)

func (f *fakeEngine) SaveImage(_ context.Context, ref string) (io.ReadCloser, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.log("save %s", ref)
	data, ok := f.saved[ref]
	if !ok {
		return nil, &docker.Error{Status: 404, Message: "no such image"}
	}
	return io.NopCloser(bytes.NewReader(data)), nil
}

func (f *fakeEngine) LoadImage(_ context.Context, r io.Reader) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	data, err := io.ReadAll(r)
	if err != nil {
		return err
	}
	f.log("load %d bytes", len(data))
	f.loaded = append(f.loaded, data)
	return f.loadErr
}

// Info is the engine's platform: linux/amd64 unless a test sets platform.
func (f *fakeEngine) Info(context.Context) (*docker.EngineInfo, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.infoErr != nil {
		return nil, f.infoErr
	}
	if f.platform != nil {
		return f.platform, nil
	}
	return &docker.EngineInfo{OSType: "linux", Arch: "amd64"}, nil
}

// configPath is where archiveOf puts the image config that tags() entries name.
const configPath = "blobs/sha256/cfg"

// archiveOf writes the tar docker save would for an image built for linux/amd64.
func archiveOf(t *testing.T, manifest any) *os.File {
	t.Helper()
	return archiveWithConfig(t, manifest, `{"architecture":"amd64","os":"linux"}`)
}

// archiveWithConfig writes the tar docker save would: a manifest.json naming the images, the image config at configPath
// (none when config is empty), and a stand-in for the layers.
func archiveWithConfig(t *testing.T, manifest any, config string) *os.File {
	t.Helper()
	var buf bytes.Buffer
	tw := tar.NewWriter(&buf)
	put := func(name string, body []byte) {
		if err := tw.WriteHeader(&tar.Header{Name: name, Mode: 0o644, Size: int64(len(body))}); err != nil {
			t.Fatal(err)
		}
		if _, err := tw.Write(body); err != nil {
			t.Fatal(err)
		}
	}
	put("blobs/sha256/aaaa", []byte("layer"))
	if config != "" {
		put(configPath, []byte(config))
	}
	if manifest != nil {
		b, err := json.Marshal(manifest)
		if err != nil {
			t.Fatal(err)
		}
		put("manifest.json", b)
	}
	if err := tw.Close(); err != nil {
		t.Fatal(err)
	}
	f, err := os.Create(filepath.Join(t.TempDir(), "image.tar"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.Write(buf.Bytes()); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { f.Close() })
	return f
}

func tags(refs ...string) []map[string]any {
	var out []map[string]any
	for _, r := range refs {
		out = append(out, map[string]any{"Config": configPath, "RepoTags": []string{r}})
	}
	return out
}

func builderOf(h *buildHarness) {
	app := h.app
	app.Build = app.Build.Clone()
	app.Build.Only = true
	h.d.cfg.Store(&config.Config{Apps: []config.App{app}, Proxy: &config.Proxy{}})
}

func TestABuildOnlyAppBuildsKeepsTheImageAndRunsNothing(t *testing.T) {
	h := newBuildHarness(t)
	builderOf(h)

	dep, err := h.startBuild("web", 1)
	if err != nil || dep.Status != store.StatusSucceeded || dep.Ref != repo+":"+sha(1) || dep.Trigger != TriggerBuild {
		t.Fatalf("%v %+v", err, dep)
	}
	if h.eng.container("web") != nil || len(h.eng.snapshot()) != 0 {
		t.Errorf("nothing runs on a builder: %v", h.eng.opsList())
	}
	var said bool
	for _, e := range h.events(dep.ID) {
		said = said || strings.Contains(e, "runs elsewhere: nothing is deployed on this server")
	}
	if !said {
		t.Errorf("the log must say why nothing was deployed: %v", h.events(dep.ID))
	}
	if _, _, err := h.d.Start(context.Background(), "web", Target{Tag: sha(1)}, "api"); !errors.Is(err, ErrBuildOnly) {
		t.Errorf("a builder cannot be deployed: %v", err)
	}
	if _, _, err := h.d.Rollback(context.Background(), "web"); !errors.Is(err, ErrBuildOnly) {
		t.Errorf("a builder cannot be rolled back: %v", err)
	}
}

func TestExportOnlyGivesAnImageThisServerBuilt(t *testing.T) {
	h := newBuildHarness(t)
	builderOf(h)
	h.eng.saved = map[string][]byte{repo + ":" + sha(1): []byte("the archive"), repo + ":" + sha(9): []byte("never built here")}
	if dep, err := h.startBuild("web", 1); err != nil || dep.Status != store.StatusSucceeded {
		t.Fatalf("%v %+v", err, dep)
	}

	r, err := h.d.ExportImage(context.Background(), "web", sha(1))
	if err != nil {
		t.Fatal(err)
	}
	if got, _ := io.ReadAll(r); string(got) != "the archive" {
		t.Errorf("got %q", got)
	}
	r.Close()

	if _, err := h.d.ExportImage(context.Background(), "web", sha(9)); !errors.Is(err, ErrNoImage) {
		t.Errorf("an image the engine holds but this server did not build must not be exported: %v", err)
	}
	if _, err := h.d.ExportImage(context.Background(), "web", "bad tag!"); !errors.Is(err, ErrInvalidTarget) {
		t.Errorf("got %v", err)
	}
	if _, err := h.d.ExportImage(context.Background(), "nope", sha(1)); !errors.Is(err, ErrUnknownApp) {
		t.Errorf("got %v", err)
	}
	h.eng.mu.Lock()
	delete(h.eng.saved, repo+":"+sha(1))
	h.eng.mu.Unlock()
	if _, err := h.d.ExportImage(context.Background(), "web", sha(1)); !errors.Is(err, ErrNoImage) {
		t.Errorf("an image that was pruned: %v", err)
	}
}

func TestAnImportedImageIsDeployedWithoutPulling(t *testing.T) {
	h := newBuildHarness(t)
	ref := repo + ":" + sha(5)
	if err := h.d.ImportImage(context.Background(), "web", sha(5), archiveOf(t, tags(ref))); err != nil {
		t.Fatal(err)
	}
	if len(h.eng.loaded) != 1 {
		t.Fatalf("the archive must be loaded once: %d", len(h.eng.loaded))
	}
	if local, err := h.st.BuiltHere(context.Background(), "web", ref); err != nil || !local {
		t.Fatalf("an imported image exists nowhere else: %v %v", local, err)
	}

	id, done, err := h.d.Start(context.Background(), "web", Target{Tag: sha(5)}, "api")
	if err != nil {
		t.Fatal(err)
	}
	<-done
	dep, _ := h.st.Deployment(context.Background(), id)
	if dep.Status != store.StatusSucceeded || dep.Ref != ref {
		t.Fatalf("%+v", dep)
	}
	if p := h.pulls(); len(p) != 0 {
		t.Errorf("an image received from another server is not in a registry: %v", p)
	}
}

func TestImportRefusesAnArchiveThatIsNotExactlyTheAnnouncedImage(t *testing.T) {
	h := newBuildHarness(t)
	ref := repo + ":" + sha(5)
	cases := map[string]*os.File{
		"another tag":            archiveOf(t, tags(repo+":"+sha(6))),
		"another app's image":    archiveOf(t, tags("ghcr.io/o/api:"+sha(5))),
		"two images":             archiveOf(t, tags(ref, "ghcr.io/o/api:latest")),
		"no manifest":            archiveOf(t, nil),
		"an untagged image":      archiveOf(t, []map[string]any{{"Config": configPath, "RepoTags": []string{}}}),
		"two tags on one image":  archiveOf(t, []map[string]any{{"Config": configPath, "RepoTags": []string{ref, "ghcr.io/o/web:latest"}}}),
		"a manifest that is not": archiveOf(t, "not a list"),
	}
	for name, f := range cases {
		if err := h.d.ImportImage(context.Background(), "web", sha(5), f); !errors.Is(err, ErrBadArchive) {
			t.Errorf("%s: want ErrBadArchive, got %v", name, err)
		}
	}
	if len(h.eng.loaded) != 0 {
		t.Errorf("nothing of a refused archive may be loaded: %d", len(h.eng.loaded))
	}
	if local, _ := h.st.BuiltHere(context.Background(), "web", ref); local {
		t.Error("a refused archive must not be recorded")
	}
}

func TestImportFailureModes(t *testing.T) {
	h := newBuildHarness(t)
	ref := repo + ":" + sha(5)

	if err := h.d.ImportImage(context.Background(), "nope", sha(5), archiveOf(t, tags(ref))); !errors.Is(err, ErrUnknownApp) {
		t.Errorf("got %v", err)
	}
	if err := h.d.ImportImage(context.Background(), "web", "bad tag!", archiveOf(t, tags(ref))); !errors.Is(err, ErrInvalidTarget) {
		t.Errorf("got %v", err)
	}

	h.eng.loadErr = errors.New("engine: no space left")
	if err := h.d.ImportImage(context.Background(), "web", sha(5), archiveOf(t, tags(ref))); err == nil || !strings.Contains(err.Error(), "no space left") {
		t.Errorf("a failing load must say why: %v", err)
	}
	if local, _ := h.st.BuiltHere(context.Background(), "web", ref); local {
		t.Error("a failed load must not be recorded")
	}
	h.eng.loadErr = nil

	h.eng.missingImages = map[string]bool{ref: true}
	if err := h.d.ImportImage(context.Background(), "web", sha(5), archiveOf(t, tags(ref))); !errors.Is(err, ErrBadArchive) {
		t.Errorf("a load that did not create the image: %v", err)
	}
	h.eng.missingImages = nil

	if !h.d.reserve("web") {
		t.Fatal("reserve")
	}
	if err := h.d.ImportImage(context.Background(), "web", sha(5), archiveOf(t, tags(ref))); !errors.Is(err, ErrBusy) {
		t.Errorf("an app that is deploying cannot be given an image: %v", err)
	}
	h.d.release("web")

	builderOf(h)
	if err := h.d.ImportImage(context.Background(), "web", sha(5), archiveOf(t, tags(ref))); !errors.Is(err, ErrBuildOnly) {
		t.Errorf("a builder runs nothing: %v", err)
	}
}

func TestImportRefusesAnImageForAnotherPlatformBeforeLoadingAnything(t *testing.T) {
	ref := repo + ":" + sha(5)
	cases := map[string]struct {
		engine  *docker.EngineInfo
		archive string
		want    string // the refusal; empty: the archive loads
	}{
		"same platform":             {&docker.EngineInfo{OSType: "linux", Arch: "amd64"}, `{"architecture":"amd64","os":"linux"}`, ""},
		"arm image, arm engine":     {&docker.EngineInfo{OSType: "linux", Arch: "arm64"}, `{"architecture":"arm64","os":"linux","variant":"v8"}`, ""},
		"arm image, amd64 host":     {&docker.EngineInfo{OSType: "linux", Arch: "amd64"}, `{"architecture":"arm64","os":"linux"}`, "image is for linux/arm64 but this server runs linux/amd64"},
		"amd64 image, arm host":     {&docker.EngineInfo{OSType: "linux", Arch: "arm64"}, `{"architecture":"amd64","os":"linux"}`, "image is for linux/amd64 but this server runs linux/arm64"},
		"windows image":             {&docker.EngineInfo{OSType: "linux", Arch: "amd64"}, `{"architecture":"amd64","os":"windows"}`, "image is for windows/amd64 but this server runs linux/amd64"},
		"engine that is silent":     {&docker.EngineInfo{}, `{"architecture":"arm64","os":"linux"}`, ""},
		"config without a platform": {&docker.EngineInfo{OSType: "linux", Arch: "amd64"}, `{"config":{}}`, "does not say which platform"},
		"config that is not json":   {&docker.EngineInfo{OSType: "linux", Arch: "amd64"}, `not json`, "unreadable image config"},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			h := newBuildHarness(t)
			h.eng.platform = tc.engine
			err := h.d.ImportImage(context.Background(), "web", sha(5), archiveWithConfig(t, tags(ref), tc.archive))
			if tc.want == "" {
				if err != nil || len(h.eng.loaded) != 1 {
					t.Fatalf("err %v, %d loaded", err, len(h.eng.loaded))
				}
				return
			}
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("got %v, want %q", err, tc.want)
			}
			var pe *PlatformError
			if isPlatform := errors.As(err, &pe); isPlatform != strings.HasPrefix(tc.want, "image is for") {
				t.Errorf("PlatformError = %v for %v", isPlatform, err)
			}
			if len(h.eng.loaded) != 0 {
				t.Errorf("nothing of a refused archive may be loaded: %d", len(h.eng.loaded))
			}
			if local, _ := h.st.BuiltHere(context.Background(), "web", ref); local {
				t.Error("a refused archive must not be recorded")
			}
		})
	}
}

func TestImportRefusesAnArchiveWhoseImageConfigIsMissing(t *testing.T) {
	h := newBuildHarness(t)
	ref := repo + ":" + sha(5)
	cases := map[string]*os.File{
		"config not in the archive": archiveWithConfig(t, tags(ref), ""),
		"manifest names no config":  archiveWithConfig(t, []map[string]any{{"RepoTags": []string{ref}}}, `{"architecture":"amd64","os":"linux"}`),
		"manifest names another":    archiveWithConfig(t, []map[string]any{{"Config": "blobs/sha256/other", "RepoTags": []string{ref}}}, `{"architecture":"amd64","os":"linux"}`),
	}
	for name, f := range cases {
		if err := h.d.ImportImage(context.Background(), "web", sha(5), f); !errors.Is(err, ErrBadArchive) {
			t.Errorf("%s: want ErrBadArchive, got %v", name, err)
		}
	}
	if len(h.eng.loaded) != 0 {
		t.Errorf("nothing of a refused archive may be loaded: %d", len(h.eng.loaded))
	}
}

func TestImportReportsAnEngineThatCannotBeAsked(t *testing.T) {
	h := newBuildHarness(t)
	h.eng.infoErr = errors.New("engine: connection refused")
	err := h.d.ImportImage(context.Background(), "web", sha(5), archiveOf(t, tags(repo+":"+sha(5))))
	if err == nil || !strings.Contains(err.Error(), "connection refused") || len(h.eng.loaded) != 0 {
		t.Errorf("%v, %d loaded", err, len(h.eng.loaded))
	}
}
