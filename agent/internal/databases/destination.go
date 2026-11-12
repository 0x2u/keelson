package databases

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/0x2u/keelson/agent/internal/config"
)

// Object is a stored file: its key under the destination and its size.
type Object struct {
	Key  string
	Size int64
}

// ErrExists is what Put answers when the key is already taken: a backup never replaces an object.
var ErrExists = errors.New("an object with this key already exists")

const (
	// uploadPrefix names the temporary files of a local upload, beside the final name.
	uploadPrefix = ".upload-"
	// staleUpload is how old a temporary file must be before it is taken for the leftover of a crashed run. A
	// live upload only ever grows its file, so a day without a write is far beyond any copy.
	staleUpload = 24 * time.Hour
)

// Destination is where backups are kept. Keys are "<db>/<file>"; a destination adds its own root (a directory, a
// bucket and prefix).
type Destination interface {
	// Put stores the file at src under key and checks that what is stored is what was sent. It never replaces an
	// object: when key exists it fails with an error that wraps ErrExists and leaves the old object alone.
	Put(ctx context.Context, key, src string) error
	// Get copies the object to the file dst.
	Get(ctx context.Context, key, dst string) error
	// Open streams the object. Closing the reader before its end abandons the rest: reading the start of an object costs
	// no more than the start.
	Open(ctx context.Context, key string) (io.ReadCloser, error)
	// List returns the objects whose key starts with prefix, which ends with "/".
	List(ctx context.Context, prefix string) ([]Object, error)
	Delete(ctx context.Context, key string) error
}

// newDestination builds the destination of a backup section, reading the S3 secret key now so a rotated secret is
// used by the next run.
func newDestination(d config.BackupDestination, hc *http.Client) (Destination, error) {
	if d.Local != nil {
		return &localDestination{dir: d.Local.Dir}, nil
	}
	secret, err := readSecretFile(d.S3.SecretKeyFile)
	if err != nil {
		return nil, classify(ErrSecret, fmt.Errorf("read s3 secret key: %w", err))
	}
	return newS3(*d.S3, secret, hc), nil
}

// readSecretFile returns the content of a file without its trailing newline. An empty file is an error: a secret
// that is not there is never what was meant.
func readSecretFile(path string) (string, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	s := strings.TrimRight(string(b), "\r\n")
	if s == "" {
		return "", fmt.Errorf("%s is empty", path)
	}
	return s, nil
}

// localDestination keeps backups as files under dir.
type localDestination struct{ dir string }

func (l *localDestination) path(key string) (string, error) {
	if !filepath.IsLocal(filepath.FromSlash(key)) {
		return "", fmt.Errorf("invalid key %q", key)
	}
	return filepath.Join(l.dir, filepath.FromSlash(key)), nil
}

func (l *localDestination) Put(ctx context.Context, key, src string) error {
	dst, err := l.path(key)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(dst), 0o700); err != nil {
		return err
	}
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	sweepStaleUploads(filepath.Dir(dst), staleUpload)
	// The copy is written beside its final name and linked to it: a listing never shows half a backup, and the
	// link fails if the name is taken, where a rename would silently replace the old backup. The temporary name is
	// removed whatever happens. A directory on a file system without hard links cannot be a destination.
	tmp, err := os.CreateTemp(filepath.Dir(dst), uploadPrefix+"*")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	want := sha256.New()
	if _, err := io.Copy(tmp, io.TeeReader(&ctxReader{ctx, in}, want)); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := os.Link(tmp.Name(), dst); err != nil {
		if errors.Is(err, fs.ErrExist) {
			return fmt.Errorf("%s: %w", key, ErrExists)
		}
		return err
	}

	got, err := hashFile(dst)
	if err != nil {
		return err
	}
	if string(got) != string(want.Sum(nil)) {
		_ = os.Remove(dst)
		return errors.New("the stored file does not match what was written: it was removed")
	}
	return nil
}

func (l *localDestination) Get(ctx context.Context, key, dst string) error {
	in, err := l.Open(ctx, key)
	if err != nil {
		return err
	}
	defer in.Close()
	return copyToFile(ctx, in, dst)
}

func (l *localDestination) Open(_ context.Context, key string) (io.ReadCloser, error) {
	src, err := l.path(key)
	if err != nil {
		return nil, err
	}
	return os.Open(src)
}

func (l *localDestination) List(_ context.Context, prefix string) ([]Object, error) {
	dir, err := l.path(strings.TrimSuffix(prefix, "/"))
	if err != nil {
		return nil, err
	}
	sweepStaleUploads(dir, staleUpload)
	entries, err := os.ReadDir(dir)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var out []Object
	for _, e := range entries {
		if !e.Type().IsRegular() || strings.HasPrefix(e.Name(), uploadPrefix) {
			continue
		}
		info, err := e.Info()
		if err != nil {
			return nil, err
		}
		out = append(out, Object{Key: prefix + e.Name(), Size: info.Size()})
	}
	return out, nil
}

func (l *localDestination) Delete(_ context.Context, key string) error {
	p, err := l.path(key)
	if err != nil {
		return err
	}
	return os.Remove(p)
}

// sweepStaleUploads removes the temporary files of uploads that died with their process (a kill, a power cut: the
// deferred removal of Put never ran) and that nothing has written to for longer than maxAge. Errors are ignored:
// the sweep is housekeeping and must never fail a listing or a backup.
func sweepStaleUploads(dir string, maxAge time.Duration) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return
	}
	for _, e := range entries {
		if !e.Type().IsRegular() || !strings.HasPrefix(e.Name(), uploadPrefix) {
			continue
		}
		if info, err := e.Info(); err == nil && time.Since(info.ModTime()) > maxAge {
			_ = os.Remove(filepath.Join(dir, e.Name()))
		}
	}
}

func hashFile(path string) ([]byte, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return nil, err
	}
	return h.Sum(nil), nil
}

// copyToFile writes r to a new file dst, readable by its owner only.
func copyToFile(ctx context.Context, r io.Reader, dst string) error {
	out, err := os.OpenFile(dst, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o600)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, &ctxReader{ctx, r}); err != nil {
		out.Close()
		return err
	}
	return out.Close()
}

// ctxReader stops a long copy when its context ends.
type ctxReader struct {
	ctx context.Context
	r   io.Reader
}

func (c *ctxReader) Read(p []byte) (int, error) {
	if err := c.ctx.Err(); err != nil {
		return 0, err
	}
	return c.r.Read(p)
}
