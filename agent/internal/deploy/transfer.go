package deploy

import (
	"archive/tar"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"

	"github.com/0x2u/keelson/agent/internal/docker"
)

// ExportImage streams the image "<app image>:<tag>" as a tar archive, for the server that will run it. Only an image
// this server built or received can be exported (never an arbitrary one the engine happens to hold). The caller closes
// the stream.
func (d *Deployer) ExportImage(ctx context.Context, app, tag string) (io.ReadCloser, error) {
	a, ok := d.config().App(app)
	if !ok {
		return nil, ErrUnknownApp
	}
	ref, err := Target{Tag: tag}.Ref(a.Image)
	if err != nil {
		return nil, err
	}
	local, err := d.store.BuiltHere(ctx, a.Name, ref)
	if err != nil {
		return nil, err
	}
	return d.saveLocal(ctx, ref, local)
}

// ExportImageRef streams the image "<image>:<tag>" as ExportImage does, for an image of any app name: one that a
// build requested by another server (StartBuildRequest) left here, or that was received here. The same rule holds: only
// an image this server built or received can be exported.
func (d *Deployer) ExportImageRef(ctx context.Context, image, tag string) (io.ReadCloser, error) {
	ref, err := Target{Tag: tag}.Ref(image)
	if err != nil {
		return nil, err
	}
	local, err := d.store.BuiltAnywhere(ctx, ref)
	if err != nil {
		return nil, err
	}
	return d.saveLocal(ctx, ref, local)
}

// saveLocal streams ref when local says it was built or received here.
func (d *Deployer) saveLocal(ctx context.Context, ref string, local bool) (io.ReadCloser, error) {
	if !local {
		return nil, ErrNoImage
	}
	r, err := d.eng.SaveImage(ctx, ref)
	if docker.IsNotFound(err) {
		return nil, ErrNoImage
	}
	return r, err
}

// ImportImage loads the archive in file as the image "<app image>:<tag>" and records that it exists nowhere but here,
// so that deploying it does not pull. The archive must hold exactly that one image under exactly that name (its
// manifest is read before anything is loaded): a sender cannot give this server another app's image, nor replace a
// registry image of the same repository under another tag. It holds the app's lock while it loads, so that a
// deployment's image pruning cannot remove it in between.
func (d *Deployer) ImportImage(ctx context.Context, app, tag string, file *os.File) error {
	a, ok := d.config().App(app)
	if !ok {
		return ErrUnknownApp
	}
	if a.BuildOnly() {
		return ErrBuildOnly
	}
	ref, err := Target{Tag: tag}.Ref(a.Image)
	if err != nil {
		return err
	}
	if _, err := file.Seek(0, io.SeekStart); err != nil {
		return err
	}
	if err := d.checkArchive(ctx, file, ref); err != nil {
		return err
	}
	if _, err := file.Seek(0, io.SeekStart); err != nil {
		return err
	}
	if !d.reserve(a.Name) {
		return ErrBusy
	}
	defer d.release(a.Name)
	if err := d.eng.LoadImage(ctx, file); err != nil {
		return fmt.Errorf("load the image: %w", err)
	}
	if _, err := d.eng.ImageRepoDigests(ctx, ref); err != nil {
		if docker.IsNotFound(err) {
			return fmt.Errorf("%w: loading it did not create %s", ErrBadArchive, ref)
		}
		return err
	}
	return d.store.RecordImport(ctx, a.Name, ref, d.now())
}

// maxManifest bounds what is read of an archive's manifest.json and of its image config: they name a few layers and
// settings, never megabytes.
const maxManifest = 1 << 20

// checkArchive reads the archive's manifest.json (docker save writes one, also with the containerd image store) and
// requires it to tag exactly one image, with exactly ref. Then it reads the image config the manifest points at, and
// requires the image to be for the platform the engine runs: an image for another architecture loads fine and then
// fails to start, far from the cause. It reads the file twice because tar gives no order between the manifest and the
// config.
func (d *Deployer) checkArchive(ctx context.Context, file *os.File, ref string) error {
	configPath, err := manifestConfig(file, ref)
	if err != nil {
		return err
	}
	if _, err := file.Seek(0, io.SeekStart); err != nil {
		return err
	}
	osName, arch, err := imagePlatform(file, configPath)
	if err != nil {
		return err
	}
	info, err := d.eng.Info(ctx)
	if err != nil {
		return fmt.Errorf("read the engine's platform: %w", err)
	}
	if info.OSType == "" || info.Arch == "" {
		return nil // an engine that does not say what it runs cannot be checked against
	}
	if osName != info.OSType || arch != info.Arch {
		return &PlatformError{Image: osName + "/" + arch, Engine: info.OSType + "/" + info.Arch}
	}
	return nil
}

// manifestConfig returns the path, inside the archive, of the image config the manifest.json names for ref.
func manifestConfig(r io.Reader, ref string) (string, error) {
	tr := tar.NewReader(r)
	for {
		h, err := tr.Next()
		if errors.Is(err, io.EOF) {
			return "", fmt.Errorf("%w: no manifest.json in it", ErrBadArchive)
		}
		if err != nil {
			return "", fmt.Errorf("%w: %v", ErrBadArchive, err)
		}
		if h.Name != "manifest.json" {
			continue
		}
		var m []struct {
			Config   string   `json:"Config"`
			RepoTags []string `json:"RepoTags"`
		}
		if err := json.NewDecoder(io.LimitReader(tr, maxManifest)).Decode(&m); err != nil {
			return "", fmt.Errorf("%w: unreadable manifest.json", ErrBadArchive)
		}
		if len(m) != 1 || len(m[0].RepoTags) != 1 || m[0].RepoTags[0] != ref {
			return "", fmt.Errorf("%w: it must hold exactly the image %s", ErrBadArchive, ref)
		}
		if m[0].Config == "" {
			return "", fmt.Errorf("%w: its manifest.json names no image config", ErrBadArchive)
		}
		return m[0].Config, nil
	}
}

// imagePlatform reads the os and architecture of the image config stored at path in the archive. The archive is
// untrusted: the entry may be missing or not JSON, and a platform the config does not state is refused rather than
// guessed.
func imagePlatform(r io.Reader, path string) (osName, arch string, err error) {
	tr := tar.NewReader(r)
	for {
		h, err := tr.Next()
		if errors.Is(err, io.EOF) {
			return "", "", fmt.Errorf("%w: the image config %s is not in it", ErrBadArchive, path)
		}
		if err != nil {
			return "", "", fmt.Errorf("%w: %v", ErrBadArchive, err)
		}
		if h.Name != path {
			continue
		}
		var c struct {
			OS           string `json:"os"`
			Architecture string `json:"architecture"`
		}
		if err := json.NewDecoder(io.LimitReader(tr, maxManifest)).Decode(&c); err != nil {
			return "", "", fmt.Errorf("%w: unreadable image config", ErrBadArchive)
		}
		if c.OS == "" || c.Architecture == "" {
			return "", "", fmt.Errorf("%w: its image config does not say which platform it is for", ErrBadArchive)
		}
		return c.OS, c.Architecture, nil
	}
}
