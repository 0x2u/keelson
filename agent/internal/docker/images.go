package docker

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"regexp"
)

// Image is a local image as the engine lists it.
type Image struct {
	ID          string   `json:"Id"`
	RepoTags    []string `json:"RepoTags"`
	RepoDigests []string `json:"RepoDigests"`
	Created     int64    `json:"Created"`
}

// ListImages lists the local images of one repository (the name without tag or digest).
func (c *Client) ListImages(ctx context.Context, repo string) ([]Image, error) {
	filters, err := json.Marshal(map[string][]string{"reference": {repo}})
	if err != nil {
		return nil, err
	}
	var out []Image
	if err := c.getJSON(ctx, "/images/json", url.Values{"filters": {string(filters)}}, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// ListDanglingImages lists the images that have no tag and no child image: what a multi-stage build leaves behind (each
// stage but the last) and what a re-tagged image becomes. The engine's own "image prune" removes the same set.
func (c *Client) ListDanglingImages(ctx context.Context) ([]Image, error) {
	filters, err := json.Marshal(map[string][]string{"dangling": {"true"}})
	if err != nil {
		return nil, err
	}
	var out []Image
	if err := c.getJSON(ctx, "/images/json", url.Values{"filters": {string(filters)}}, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// ImageRepoDigests returns the registry digests an image is known by ("repo@sha256:..."): what a deployment must be given
// to run exactly this image elsewhere, whatever its tag says later. A locally built image has none.
func (c *Client) ImageRepoDigests(ctx context.Context, id string) ([]string, error) {
	if !imageRef.MatchString(id) {
		return nil, ErrInvalidImageRef
	}
	var out struct {
		RepoDigests []string `json:"RepoDigests"`
	}
	if err := c.getJSON(ctx, "/images/"+id+"/json", nil, &out); err != nil {
		return nil, err
	}
	return out.RepoDigests, nil
}

var imageRef = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,254}$`)

// ErrInvalidImageRef is returned for an image reference that could not be one.
var ErrInvalidImageRef = errors.New("docker: invalid image reference")

// ErrImageInUse is returned when the engine refuses to remove an image a container uses.
var ErrImageInUse = errors.New("docker: image is in use")

// RemoveImage removes a tag or a digest reference (repo:tag or repo@sha256:...). The engine deletes the image itself
// only when no other reference and no container uses it, and never forces: an image in use is reported, not removed.
func (a *Admin) RemoveImage(ctx context.Context, ref string) error {
	if !imageRef.MatchString(ref) {
		return ErrInvalidImageRef
	}
	resp, err := request(ctx, a.hc, http.MethodDelete, "/images/"+ref, url.Values{"force": {"0"}}, nil, nil)
	if err != nil {
		var de *Error
		if errors.As(err, &de) && de.Status == http.StatusConflict {
			return ErrImageInUse
		}
		if IsNotFound(err) {
			return nil
		}
		return err
	}
	return resp.Body.Close()
}
