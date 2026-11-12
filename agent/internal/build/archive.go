package build

import (
	"archive/tar"
	"compress/gzip"
	"errors"
	"fmt"
	"io"
	"path"
	"strings"
)

// ErrArchive wraps every refusal of a source archive, so callers can tell them from engine failures.
var ErrArchive = errors.New("invalid source archive")

func archiveErr(format string, args ...any) error {
	return fmt.Errorf("%w: %s", ErrArchive, fmt.Sprintf(format, args...))
}

// maxEntries bounds the number of entries of a source archive.
const maxEntries = 200_000

// archiveOptions says what to extract from a GitHub-style source archive and how much of it to accept.
type archiveOptions struct {
	// Context is the subdirectory of the repository that becomes the build context ("." for all of it).
	Context string
	// Dockerfile is the path, inside the context, that must exist.
	Dockerfile string
	// MaxUnpacked bounds the total size of the files.
	MaxUnpacked int64
	// MaxEntries bounds the number of entries; zero means the default.
	MaxEntries int
	// Generate, when set, is called with the names at the top of the context once all of it was read, and returns the
	// files to add (a preset's Dockerfile). The context then needs no Dockerfile of its own, and one of the returned
	// names already being in the context is refused: a repository file is never overwritten.
	Generate func(root map[string]bool) ([]contextFile, error)
}

func (o archiveOptions) maxEntries() int {
	if o.MaxEntries > 0 {
		return o.MaxEntries
	}
	return maxEntries
}

// buildContext reads a gzip tar of a repository (GitHub's layout: everything under one top-level directory) from r and
// writes a tar of the build context to w: the top-level directory stripped, only the context subdirectory kept and its
// path removed, ownership cleared, setuid and setgid bits dropped. It refuses what could escape the context or
// surprise the engine's extractor: absolute paths, "..", symlinks and hard links pointing outside the context, entries
// below a symlink, devices and pipes, an archive with several top-level entries, one with too many entries or bytes. A
// refused archive leaves w without the tar trailer, so the engine cannot take a partial context for a complete one.
func buildContext(w io.Writer, r io.Reader, o archiveOptions) error {
	gz, err := gzip.NewReader(r)
	if err != nil {
		if errors.Is(err, ErrSourceTooLarge) {
			return err
		}
		return archiveErr("not a gzip archive")
	}
	defer gz.Close()

	tr := tar.NewReader(gz)
	tw := tar.NewWriter(w)
	ctx := o.Context
	if ctx == "." {
		ctx = ""
	}

	var (
		top        string
		topSeen    bool
		ctxFound   = ctx == ""
		dockerfile bool
		entries    int
		unpacked   int64
		symlinks   = map[string]bool{}
		root       = map[string]bool{} // the names at the top of the context, filled when Generate is set
	)
	for {
		hdr, err := tr.Next()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			if errors.Is(err, ErrSourceTooLarge) {
				return err
			}
			return archiveErr("not a valid tar archive")
		}
		if hdr.Typeflag == tar.TypeXGlobalHeader {
			continue // GitHub records the commit in one: metadata, not content
		}
		if entries++; entries > o.maxEntries() {
			return archiveErr("more than %d entries", o.maxEntries())
		}

		clean, err := cleanEntryName(hdr.Name)
		if err != nil {
			return err
		}
		if clean == "" { // "./"
			continue
		}
		first, rel, _ := strings.Cut(clean, "/")
		switch {
		case !topSeen:
			if rel == "" && hdr.Typeflag != tar.TypeDir {
				return archiveErr("the archive must hold one top-level directory, found the file %q", first)
			}
			top, topSeen = first, true
		case first != top:
			return archiveErr("the archive must hold one top-level directory, found %q and %q", top, first)
		}

		// Select the context.
		inside := rel
		if ctx != "" {
			switch {
			case rel == ctx:
				if hdr.Typeflag != tar.TypeDir {
					return archiveErr("the build context %q is not a directory", ctx)
				}
				ctxFound = true
				continue
			case strings.HasPrefix(rel, ctx+"/"):
				inside = rel[len(ctx)+1:]
			default:
				continue // outside the context
			}
		}
		if inside == "" { // the root directory itself
			continue
		}
		ctxFound = true
		if o.Generate != nil {
			name, _, _ := strings.Cut(inside, "/")
			root[name] = true
		}
		if err := refuseBelowSymlink(inside, symlinks); err != nil {
			return err
		}

		out := tar.Header{Name: inside, Mode: hdr.Mode & 0o777, ModTime: hdr.ModTime}
		switch hdr.Typeflag {
		case tar.TypeDir:
			out.Typeflag = tar.TypeDir
			out.Name += "/"
			if err := tw.WriteHeader(&out); err != nil {
				return err
			}
		case tar.TypeReg: // TypeRegA is read as TypeReg
			if hdr.Size < 0 {
				return archiveErr("negative size for %q", clean)
			}
			if unpacked += hdr.Size; unpacked > o.MaxUnpacked {
				return archiveErr("the files add up to more than %d bytes", o.MaxUnpacked)
			}
			out.Typeflag, out.Size = tar.TypeReg, hdr.Size
			if err := tw.WriteHeader(&out); err != nil {
				return err
			}
			if _, err := io.Copy(tw, tr); err != nil {
				if errors.Is(err, ErrSourceTooLarge) || errors.Is(err, io.ErrClosedPipe) {
					return err
				}
				return archiveErr("truncated file %q", clean)
			}
			if inside == o.Dockerfile {
				dockerfile = true
			}
		case tar.TypeSymlink:
			if err := checkSymlink(inside, hdr.Linkname); err != nil {
				return err
			}
			out.Typeflag, out.Linkname = tar.TypeSymlink, hdr.Linkname
			symlinks[inside] = true
			if err := tw.WriteHeader(&out); err != nil {
				return err
			}
			if inside == o.Dockerfile {
				dockerfile = true
			}
		case tar.TypeLink:
			target, err := hardLinkTarget(hdr.Linkname, top, ctx)
			if err != nil {
				return err
			}
			out.Typeflag, out.Linkname = tar.TypeLink, target
			if err := tw.WriteHeader(&out); err != nil {
				return err
			}
			if inside == o.Dockerfile {
				dockerfile = true
			}
		default:
			return archiveErr("%q is a device, pipe or other special file", clean)
		}
	}

	switch {
	case !topSeen:
		return archiveErr("the archive is empty")
	case !ctxFound:
		return archiveErr("the build context %q does not exist in the repository", o.Context)
	case !dockerfile && o.Generate == nil:
		return archiveErr("the Dockerfile %q is not in the build context", o.Dockerfile)
	}
	if o.Generate != nil {
		files, err := o.Generate(root)
		if err != nil {
			return err
		}
		for _, f := range files {
			if root[f.Name] {
				return archiveErr("the repository already has a file named %q, which the preset needs for itself: rename or remove it", f.Name)
			}
			if err := tw.WriteHeader(&tar.Header{Typeflag: tar.TypeReg, Name: f.Name, Mode: 0o644, Size: int64(len(f.Data))}); err != nil {
				return err
			}
			if _, err := tw.Write(f.Data); err != nil {
				return err
			}
		}
	}
	return tw.Close()
}

// cleanEntryName normalizes an entry name and refuses a path that is absolute or has a ".." element. "" stands for
// the archive root ("./").
func cleanEntryName(name string) (string, error) {
	if name == "" || strings.ContainsRune(name, 0) {
		return "", archiveErr("an entry has an empty or invalid name")
	}
	if strings.HasPrefix(name, "/") {
		return "", archiveErr("%q is an absolute path", name)
	}
	for _, el := range strings.Split(name, "/") {
		if el == ".." {
			return "", archiveErr("%q leaves the archive (..)", name)
		}
	}
	c := path.Clean(name)
	if c == "." {
		return "", nil
	}
	return c, nil
}

// checkSymlink refuses a link whose target is absolute or resolves outside the context. link is the path of the
// symlink inside the context.
func checkSymlink(link, target string) error {
	if target == "" || strings.ContainsRune(target, 0) {
		return archiveErr("the symlink %q has no valid target", link)
	}
	if strings.HasPrefix(target, "/") {
		return archiveErr("the symlink %q points to the absolute path %q", link, target)
	}
	resolved := path.Join(path.Dir(link), target)
	if resolved == ".." || strings.HasPrefix(resolved, "../") {
		return archiveErr("the symlink %q points outside the build context", link)
	}
	return nil
}

// hardLinkTarget maps the target of a hard link (a path from the archive root) to a path inside the context, or
// refuses it.
func hardLinkTarget(target, top, ctx string) (string, error) {
	clean, err := cleanEntryName(target)
	if err != nil {
		return "", err
	}
	rel, ok := strings.CutPrefix(clean, top+"/")
	if !ok {
		return "", archiveErr("the hard link to %q points outside the repository", target)
	}
	if ctx == "" {
		return rel, nil
	}
	inside, ok := strings.CutPrefix(rel, ctx+"/")
	if !ok {
		return "", archiveErr("the hard link to %q points outside the build context", target)
	}
	return inside, nil
}

// refuseBelowSymlink refuses an entry whose parent directory is a symlink seen before: such an entry would be written
// through the link.
func refuseBelowSymlink(name string, symlinks map[string]bool) error {
	for i := range len(name) {
		if name[i] == '/' && symlinks[name[:i]] {
			return archiveErr("%q lies below the symlink %q", name, name[:i])
		}
	}
	return nil
}
