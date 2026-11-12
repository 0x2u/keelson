package deploy

import (
	"context"
	"errors"
	"fmt"
	"slices"

	"github.com/0x2u/keelson/agent/internal/config"
	"github.com/0x2u/keelson/agent/internal/docker"
)

// pruneImages removes the app's old images after a successful deployment: only the most recently deployed versions (keep_images,
// the one just deployed included) stay. It never fails a deployment, which has already succeeded: what it cannot do is reported.
//
// What counts as "deployed" is the history of successful deployments, so an image pulled for a failed attempt is old
// from the start. The engine refuses to remove an image a container uses, and the agent never forces it.
func (d *Deployer) pruneImages(ctx context.Context, id string, a config.App, ref string) {
	protected, err := d.keptRefs(ctx, a, ref)
	if err != nil {
		d.event(id, "warn", "could not read the history to prune old images: %v", err)
		return
	}
	// The previews of the app run images of the same repository: their versions are not this app's to remove.
	previewRefs, err := d.instanceRefs(ctx, "")
	if err != nil {
		d.event(id, "warn", "could not read the previews to prune old images: %v", err)
		return
	}
	for r := range previewRefs {
		protected[r] = true
	}

	removed := 0
	var failure error
	for _, repo := range prunedRepos(a) {
		kept := protected
		if repo != a.Image {
			kept = stepRefs(repo, protected)
		}
		n, err := d.pruneRepo(ctx, repo, kept)
		removed += n
		if err != nil {
			failure = err
		}
	}
	if removed > 0 {
		d.event(id, "info", "removed %s", plural(removed, "old image"))
	}
	if failure != nil {
		d.event(id, "warn", "could not remove some old images: %v", failure)
	}
}

// keptRefs are the references of the app's most recently deployed versions (keep_images of them, current included):
// the images that stay.
func (d *Deployer) keptRefs(ctx context.Context, a config.App, current string) (map[string]bool, error) {
	keep := a.KeepImagesOrDefault()
	if keep < 1 {
		keep = config.DefaultKeepImages
	}
	recent, err := d.store.Succeeded(ctx, a.Name, 50)
	if err != nil {
		return nil, err
	}
	// The deployment that just succeeded is not in the history yet: it is protected by name, then the newest before it.
	protected := map[string]bool{current: true}
	for _, dep := range recent {
		if len(protected) >= keep {
			break
		}
		protected[dep.Ref] = true
	}
	return protected, nil
}

// prunedRepos are the repositories an app's deployments leave images in: its own, and those of its release steps
// (a migration image is pulled at every deployment's tag).
func prunedRepos(a config.App) []string {
	repos := []string{a.Image}
	if a.Release == nil {
		return repos
	}
	for _, step := range a.Release.Steps {
		if step.Container != nil && step.Container.Image != "" && !slices.Contains(repos, step.Container.Image) {
			repos = append(repos, step.Container.Image)
		}
	}
	return repos
}

// stepRefs maps the protected deployed references to the references of a release-step repository: it runs at the same
// tag as the deployment, and never at a digest.
func stepRefs(repo string, protected map[string]bool) map[string]bool {
	out := map[string]bool{}
	for ref := range protected {
		if tag, ok := tagOfRef(ref); ok {
			out[repo+":"+tag] = true
		}
	}
	return out
}

// pruneRepo removes the local images of one repository none of whose references is protected, and returns how many
// images went. An image a container still uses is left (the engine refuses, and the agent never forces it).
func (d *Deployer) pruneRepo(ctx context.Context, repo string, protected map[string]bool) (int, error) {
	images, err := d.eng.ListImages(ctx, repo)
	if err != nil {
		return 0, err
	}
	removed := 0
	var failure error
	for _, img := range images {
		refs := append(append([]string{}, img.RepoTags...), img.RepoDigests...)
		if keepsImage(refs, protected) {
			continue
		}
		gone := false
		for _, ref := range refs {
			switch err := d.eng.RemoveImage(ctx, ref); {
			case err == nil:
				gone = true
			case errors.Is(err, docker.ErrImageInUse):
				// A container still runs it: leave it, whatever the history says.
			default:
				failure = err
			}
		}
		if gone {
			removed++
		}
	}
	return removed, failure
}

// keepsImage reports whether any reference of an image is one of the protected deployed references.
func keepsImage(refs []string, protected map[string]bool) bool {
	for _, r := range refs {
		if protected[r] {
			return true
		}
	}
	return false
}

func plural(n int, noun string) string {
	if n == 1 {
		return fmt.Sprintf("1 %s", noun)
	}
	return fmt.Sprintf("%d %ss", n, noun)
}
