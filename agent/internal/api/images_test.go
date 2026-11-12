package api

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/0x2u/keelson/agent/internal/deploy"
	"github.com/0x2u/keelson/agent/internal/store"
)

type fakeImages struct {
	exportErr, importErr error
	exported             []string // "app:tag"
	imported             []string // "app:tag"
	received             []byte
}

func (f *fakeImages) ExportImage(_ context.Context, app, tag string) (io.ReadCloser, error) {
	f.exported = append(f.exported, app+":"+tag)
	if f.exportErr != nil {
		return nil, f.exportErr
	}
	return io.NopCloser(strings.NewReader("the-image-archive")), nil
}

func (f *fakeImages) ExportImageRef(_ context.Context, image, tag string) (io.ReadCloser, error) {
	f.exported = append(f.exported, image+":"+tag)
	if f.exportErr != nil {
		return nil, f.exportErr
	}
	return io.NopCloser(strings.NewReader("the-image-archive")), nil
}

func (f *fakeImages) ImportImage(_ context.Context, app, tag string, archive *os.File) error {
	f.imported = append(f.imported, app+":"+tag)
	if _, err := archive.Seek(0, io.SeekStart); err != nil { // as the real service does
		return err
	}
	b, err := io.ReadAll(archive)
	if err != nil {
		return err
	}
	f.received = b
	return f.importErr
}

type imageEnv struct {
	*configEnv
	images  *fakeImages
	staging string
}

func newImageEnv(t *testing.T) *imageEnv {
	t.Helper()
	st, err := store.Open(filepath.Join(t.TempDir(), "a.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	fi, staging := &fakeImages{}, t.TempDir()
	h, err := New(&fakeDocker{}, Options{
		Token: testToken, Logger: slog.New(slog.NewTextHandler(io.Discard, nil)),
		Deploy: &DeployOptions{Deployments: &fakeDeployments{}, Secret: testSecret, Replays: st, Config: &fakeConfig{}, Audit: st, Images: fi, StagingDir: staging},
	})
	if err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(h)
	t.Cleanup(srv.Close)
	return &imageEnv{configEnv: &configEnv{srv: srv, st: st}, images: fi, staging: staging}
}

// signedImport sends an archive the way the dashboard does: the signature covers the request URI (with the archive's
// SHA-256) and no body.
func (e *imageEnv) signedImport(t *testing.T, uri string, archive []byte, tamper func(uri string) string) (*http.Response, string) {
	t.Helper()
	nonce++
	ts := time.Now().Add(time.Duration(nonce) * time.Second).Unix()
	sent := uri
	if tamper != nil {
		sent = tamper(uri)
	}
	req, _ := http.NewRequest(http.MethodPut, e.srv.URL+sent, bytes.NewReader(archive))
	req.Header.Set(HeaderTimestamp, strconv.FormatInt(ts, 10))
	req.Header.Set(HeaderSignature, Sign(testSecret, ts, http.MethodPut, uri, nil))
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	b, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	return resp, string(b)
}

func shaOf(b []byte) string { s := sha256.Sum256(b); return hex.EncodeToString(s[:]) }

func TestExportStreamsTheImageToASignedRequestOnly(t *testing.T) {
	e := newImageEnv(t)
	resp, body := e.signed(t, "POST", "/v1/apps/shop/image/export", `{"tag":"abc123"}`, "dashboard")
	if resp.StatusCode != 200 || body != "the-image-archive" || resp.Header.Get("Content-Type") != "application/x-tar" {
		t.Fatalf("%d %q %s", resp.StatusCode, body, resp.Header.Get("Content-Type"))
	}
	if len(e.images.exported) != 1 || e.images.exported[0] != "shop:abc123" {
		t.Errorf("exported %v", e.images.exported)
	}
	log, _ := e.st.Audit(t.Context(), 5, 0)
	if len(log) != 1 || log[0].Action != "image.export" || log[0].Detail != "shop:abc123" || log[0].Status != 200 {
		t.Errorf("audit: %+v", log)
	}

	// The read token does not move the code of an app.
	req, _ := http.NewRequest("POST", e.srv.URL+"/v1/apps/shop/image/export", strings.NewReader(`{"tag":"abc123"}`))
	req.Header.Set("Authorization", "Bearer "+testToken)
	r, _ := http.DefaultClient.Do(req)
	r.Body.Close()
	if r.StatusCode != http.StatusUnauthorized || len(e.images.exported) != 1 {
		t.Errorf("the read token must not export: %d", r.StatusCode)
	}

	if resp, _ := e.signed(t, "POST", "/v1/apps/shop/image/export", `{"nope":1}`, ""); resp.StatusCode != 400 {
		t.Errorf("a bad body: %d", resp.StatusCode)
	}
	e.images.exportErr = deploy.ErrNoImage
	if resp, _ := e.signed(t, "POST", "/v1/apps/shop/image/export", `{"tag":"abc123"}`, ""); resp.StatusCode != 404 {
		t.Errorf("an image that is not here: %d", resp.StatusCode)
	}
	e.images.exportErr = deploy.ErrInvalidTarget
	if resp, _ := e.signed(t, "POST", "/v1/apps/shop/image/export", `{"tag":"a b"}`, ""); resp.StatusCode != 400 {
		t.Errorf("an invalid tag: %d", resp.StatusCode)
	}
}

func TestExportByRepositoryStreamsTheImageOfAnyAppName(t *testing.T) {
	e := newImageEnv(t)
	resp, body := e.signed(t, "POST", "/v1/images/export", `{"image":"keelson-local/web","tag":"abc123"}`, "dashboard")
	if resp.StatusCode != 200 || body != "the-image-archive" || resp.Header.Get("Content-Type") != "application/x-tar" {
		t.Fatalf("%d %q %s", resp.StatusCode, body, resp.Header.Get("Content-Type"))
	}
	if len(e.images.exported) != 1 || e.images.exported[0] != "keelson-local/web:abc123" {
		t.Errorf("exported %v", e.images.exported)
	}
	log, _ := e.st.Audit(t.Context(), 5, 0)
	if len(log) != 1 || log[0].Action != "image.export" || log[0].Path != "/v1/images/export" || log[0].Detail != "keelson-local/web:abc123" || log[0].Status != 200 {
		t.Errorf("audit: %+v", log)
	}
	for name, body := range map[string]string{"no image": `{"tag":"abc123"}`, "unknown field": `{"image":"a/b","tag":"t","app":"x"}`, "not json": `x`} {
		if resp, _ := e.signed(t, "POST", "/v1/images/export", body, ""); resp.StatusCode != 400 {
			t.Errorf("%s: %d", name, resp.StatusCode)
		}
	}
	e.images.exportErr = deploy.ErrNoImage
	if resp, _ := e.signed(t, "POST", "/v1/images/export", `{"image":"a/b","tag":"t"}`, ""); resp.StatusCode != 404 {
		t.Errorf("an image that was not built here: %d", resp.StatusCode)
	}
	req, _ := http.NewRequest("POST", e.srv.URL+"/v1/images/export", strings.NewReader(`{"image":"a/b","tag":"t"}`))
	req.Header.Set("Authorization", "Bearer "+testToken)
	r, _ := http.DefaultClient.Do(req)
	r.Body.Close()
	if r.StatusCode != http.StatusUnauthorized {
		t.Errorf("the read token must not export: %d", r.StatusCode)
	}
}

func TestImportLoadsAnArchiveThatMatchesTheSignedHash(t *testing.T) {
	e := newImageEnv(t)
	archive := bytes.Repeat([]byte("layer-bytes "), 5000)
	uri := "/v1/apps/shop/image/abc123?sha256=" + shaOf(archive)

	resp, body := e.signedImport(t, uri, archive, nil)
	if resp.StatusCode != http.StatusNoContent {
		t.Fatalf("%d %s", resp.StatusCode, body)
	}
	if len(e.images.imported) != 1 || e.images.imported[0] != "shop:abc123" || !bytes.Equal(e.images.received, archive) {
		t.Errorf("the service must get the archive as sent: %v", e.images.imported)
	}
	log, _ := e.st.Audit(t.Context(), 5, 0)
	if len(log) != 1 || log[0].Action != "image.import" || !strings.HasPrefix(log[0].Detail, "shop:abc123 ") || log[0].Status != 204 {
		t.Errorf("audit: %+v", log)
	}
	if left, _ := os.ReadDir(e.staging); len(left) != 0 {
		t.Errorf("the staged archive must be removed: %v", left)
	}
}

func TestImportRefusesAnArchiveThatIsNotWhatWasSigned(t *testing.T) {
	e := newImageEnv(t)
	archive := []byte("an archive")
	good := "/v1/apps/shop/image/abc123?sha256=" + shaOf(archive)

	// Another body under the same signature: the received bytes do not match the announced hash.
	if resp, _ := e.signedImport(t, good, []byte("another body"), nil); resp.StatusCode != 400 {
		t.Errorf("a body that does not match: %d", resp.StatusCode)
	}
	// The announced hash changed after signing: the signature no longer covers the request.
	if resp, _ := e.signedImport(t, good, archive, func(u string) string { return strings.Replace(u, "sha256=", "sha256=0", 1)[:len(u)] }); resp.StatusCode != 401 {
		t.Errorf("a changed query: %d", resp.StatusCode)
	}
	// Another tag than the signed one.
	if resp, _ := e.signedImport(t, good, archive, func(u string) string { return strings.Replace(u, "abc123", "abc124", 1) }); resp.StatusCode != 401 {
		t.Errorf("a changed path: %d", resp.StatusCode)
	}
	if resp, _ := e.signedImport(t, "/v1/apps/shop/image/abc123", archive, nil); resp.StatusCode != 400 {
		t.Errorf("no sha256: %d", resp.StatusCode)
	}
	if resp, _ := e.signedImport(t, "/v1/apps/shop/image/abc123?sha256=ZZ", archive, nil); resp.StatusCode != 400 {
		t.Errorf("a malformed sha256: %d", resp.StatusCode)
	}
	req, _ := http.NewRequest(http.MethodPut, e.srv.URL+good, bytes.NewReader(archive))
	req.Header.Set("Authorization", "Bearer "+testToken)
	r, _ := http.DefaultClient.Do(req)
	r.Body.Close()
	if r.StatusCode != http.StatusUnauthorized {
		t.Errorf("the read token must not import: %d", r.StatusCode)
	}
	if len(e.images.imported) != 0 {
		t.Errorf("nothing of a refused archive may reach the service: %v", e.images.imported)
	}
	if left, _ := os.ReadDir(e.staging); len(left) != 0 {
		t.Errorf("a refused archive must not stay staged: %v", left)
	}
}

func TestImportAnswersWhatTheServiceRefuses(t *testing.T) {
	e := newImageEnv(t)
	archive := []byte("an archive")
	uri := "/v1/apps/shop/image/abc123?sha256=" + shaOf(archive)
	for err, want := range map[error]int{
		deploy.ErrBadArchive:    400,
		deploy.ErrBuildOnly:     409,
		deploy.ErrBusy:          409,
		deploy.ErrUnknownApp:    404,
		deploy.ErrInvalidTarget: 400,
		&deploy.PlatformError{Image: "linux/arm64", Engine: "linux/amd64"}: 422,
	} {
		e.images.importErr = err
		if resp, _ := e.signedImport(t, uri, archive, nil); resp.StatusCode != want {
			t.Errorf("%v: want %d, got %d", err, want, resp.StatusCode)
		}
	}
	e.images.importErr = &deploy.PlatformError{Image: "linux/arm64", Engine: "linux/amd64"}
	if _, body := e.signedImport(t, uri, archive, nil); !strings.Contains(body, "image is for linux/arm64 but this server runs linux/amd64") {
		t.Errorf("the refusal must say what differs: %s", body)
	}
}
