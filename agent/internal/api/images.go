package api

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"net/http"
	"os"
	"regexp"
	"strconv"
	"strings"

	"github.com/0x2u/keelson/agent/internal/deploy"
)

// ImageService moves the images of an app between servers (see deploy.ExportImage and deploy.ImportImage). ExportImageRef
// exports an image by its repository, for the builds another server asked for, whose app is not in the apps file.
type ImageService interface {
	ExportImage(ctx context.Context, app, tag string) (io.ReadCloser, error)
	ExportImageRef(ctx context.Context, image, tag string) (io.ReadCloser, error)
	ImportImage(ctx context.Context, app, tag string, archive *os.File) error
}

// maxImageImport bounds an imported archive: an image of a web app is hundreds of megabytes, never tens of gigabytes.
const maxImageImport = 8 << 30

var sha256Hex = regexp.MustCompile(`^[0-9a-f]{64}$`)

func (s *server) imageRoutes(mux *http.ServeMux) {
	mux.HandleFunc("POST /v1/apps/{app}/image/export", s.exportImage)
	mux.HandleFunc("POST /v1/images/export", s.exportImageRef)
	mux.HandleFunc("PUT /v1/apps/{app}/image/{tag}", s.importImage)
}

// isImageImport reports whether r is PUT /v1/apps/{app}/image/{tag}: its body is an image archive, far too large to read
// into memory to sign. The signature covers the request without a body, and the archive's SHA-256 is in the signed query,
// which the handler checks against what it received before it loads anything.
func isImageImport(r *http.Request) bool {
	rest, ok := strings.CutPrefix(r.URL.Path, "/v1/apps/")
	if !ok || r.Method != http.MethodPut {
		return false
	}
	parts := strings.Split(rest, "/")
	return len(parts) == 3 && parts[0] != "" && parts[1] == "image" && parts[2] != ""
}

type exportRequest struct {
	Tag string `json:"tag"`
}

// exportImage streams the image of an app that this server built or received, as a tar archive. Signed, like everything
// that moves data: the archive holds the app's code.
func (s *server) exportImage(w http.ResponseWriter, r *http.Request) {
	var req exportRequest
	if err := decode(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, `body must be {"tag": "<tag>"}`)
		return
	}
	app := r.PathValue("app")
	noteAudit(r, app+":"+req.Tag)
	rc, err := s.deploy.Images.ExportImage(r.Context(), app, req.Tag)
	s.streamExport(w, r, rc, err)
}

type exportRefRequest struct {
	Image string `json:"image"`
	Tag   string `json:"tag"`
}

// exportImageRef streams an image by its repository and tag, whatever app name it was built or received under (see
// ImageService): the way to take a build another server asked for.
func (s *server) exportImageRef(w http.ResponseWriter, r *http.Request) {
	var req exportRefRequest
	if err := decode(r, &req); err != nil || req.Image == "" {
		writeError(w, http.StatusBadRequest, `body must be {"image": "<repository>", "tag": "<tag>"}`)
		return
	}
	noteAudit(r, req.Image+":"+req.Tag)
	rc, err := s.deploy.Images.ExportImageRef(r.Context(), req.Image, req.Tag)
	s.streamExport(w, r, rc, err)
}

// streamExport answers an export: the error of opening the image, or the image as a tar archive.
func (s *server) streamExport(w http.ResponseWriter, r *http.Request, rc io.ReadCloser, err error) {
	if err != nil {
		s.failImage(w, r, err)
		return
	}
	defer rc.Close()
	w.Header().Set("Content-Type", "application/x-tar")
	w.WriteHeader(http.StatusOK)
	// The status is sent: a failure from here on can only cut the stream, which the receiver sees as a short archive.
	if _, err := io.Copy(w, rc); err != nil {
		s.log.Warn("image export interrupted", "path", r.URL.Path, "err", err)
	}
}

// importImage receives an archive in the body, checks it against the SHA-256 the signed query announced, and loads it as
// the image of the app at that tag.
func (s *server) importImage(w http.ResponseWriter, r *http.Request) {
	app, tag := r.PathValue("app"), r.PathValue("tag")
	want := r.URL.Query().Get("sha256")
	if !sha256Hex.MatchString(want) {
		writeError(w, http.StatusBadRequest, "the query must carry sha256=<hex sha256 of the archive>")
		return
	}
	f, err := os.CreateTemp(s.deploy.StagingDir, "import-*.tar")
	if err != nil {
		s.log.Error("stage an image import", "err", err)
		writeError(w, http.StatusInternalServerError, "internal error")
		return
	}
	defer os.Remove(f.Name())
	defer f.Close()

	sum := sha256.New()
	n, err := io.Copy(io.MultiWriter(f, sum), http.MaxBytesReader(w, r.Body, maxImageImport))
	if err != nil {
		var tooBig *http.MaxBytesError
		if errors.As(err, &tooBig) {
			writeError(w, http.StatusRequestEntityTooLarge, "the archive is too large")
			return
		}
		writeError(w, http.StatusBadRequest, "the archive was not received completely")
		return
	}
	noteAudit(r, app+":"+tag+" "+strconv.FormatInt(n>>20, 10)+" MiB")
	if hex.EncodeToString(sum.Sum(nil)) != want {
		writeError(w, http.StatusBadRequest, "the archive does not match its announced sha256")
		return
	}
	if err := s.deploy.Images.ImportImage(r.Context(), app, tag, f); err != nil {
		s.failImage(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *server) failImage(w http.ResponseWriter, r *http.Request, err error) {
	var platform *deploy.PlatformError
	switch {
	case errors.Is(err, deploy.ErrUnknownApp), errors.Is(err, deploy.ErrNoImage):
		writeError(w, http.StatusNotFound, "not found: "+err.Error())
	case errors.Is(err, deploy.ErrInvalidTarget):
		writeError(w, http.StatusBadRequest, "that is not a valid image tag")
	case errors.Is(err, deploy.ErrBadArchive):
		writeError(w, http.StatusBadRequest, err.Error())
	case errors.As(err, &platform):
		writeError(w, http.StatusUnprocessableEntity, err.Error())
	case errors.Is(err, deploy.ErrBuildOnly), errors.Is(err, deploy.ErrBusy):
		writeError(w, http.StatusConflict, err.Error())
	default:
		s.log.Error("image request failed", "path", r.URL.Path, "err", err)
		writeError(w, http.StatusInternalServerError, "internal error")
	}
}
