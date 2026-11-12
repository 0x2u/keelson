package build

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"errors"
	"io"
	"slices"
	"strings"
	"testing"
	"time"
)

// entry is one member of a test archive.
type entry struct {
	name string
	typ  byte // 0 means a regular file
	body string
	link string
	mode int64
	uid  int
}

func file(name, body string) entry { return entry{name: name, body: body} }
func dir(name string) entry        { return entry{name: name, typ: tar.TypeDir} }
func sym(name, to string) entry    { return entry{name: name, typ: tar.TypeSymlink, link: to} }

// archive builds a gzip tar the way GitHub does: a pax global header, then everything below "o-r-<sha>/".
func archive(t testing.TB, entries ...entry) []byte {
	t.Helper()
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gz)
	if err := tw.WriteHeader(&tar.Header{Typeflag: tar.TypeXGlobalHeader, Name: "pax_global_header", PAXRecords: map[string]string{"comment": "0123"}}); err != nil {
		t.Fatal(err)
	}
	for _, e := range entries {
		typ := e.typ
		if typ == 0 {
			typ = tar.TypeReg
		}
		mode := e.mode
		if mode == 0 {
			mode = 0o644
		}
		h := &tar.Header{Typeflag: typ, Name: e.name, Mode: mode, Linkname: e.link, ModTime: time.Unix(1700000000, 0), Uid: e.uid, Gid: e.uid, Uname: "root"}
		if typ == tar.TypeReg {
			h.Size = int64(len(e.body))
		}
		if err := tw.WriteHeader(h); err != nil {
			t.Fatal(err)
		}
		if typ == tar.TypeReg {
			if _, err := io.WriteString(tw, e.body); err != nil {
				t.Fatal(err)
			}
		}
	}
	if err := tw.Close(); err != nil {
		t.Fatal(err)
	}
	if err := gz.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

// extracted is what a context tar holds.
type extracted struct {
	names []string
	files map[string]string
	hdrs  map[string]*tar.Header
}

func readContext(t testing.TB, data []byte) extracted {
	t.Helper()
	out := extracted{files: map[string]string{}, hdrs: map[string]*tar.Header{}}
	tr := tar.NewReader(bytes.NewReader(data))
	for {
		h, err := tr.Next()
		if err == io.EOF {
			return out
		}
		if err != nil {
			t.Fatalf("the context is not a tar: %v", err)
		}
		b, _ := io.ReadAll(tr)
		out.names = append(out.names, h.Name)
		out.files[h.Name] = string(b)
		out.hdrs[h.Name] = h
	}
}

func run(t testing.TB, ctx string, src []byte, mutate ...func(*archiveOptions)) (extracted, []byte, error) {
	t.Helper()
	o := archiveOptions{Context: ctx, Dockerfile: "Dockerfile", MaxUnpacked: 1 << 20}
	for _, m := range mutate {
		m(&o)
	}
	var out bytes.Buffer
	err := buildContext(&out, bytes.NewReader(src), o)
	if err != nil {
		return extracted{}, out.Bytes(), err
	}
	return readContext(t, out.Bytes()), out.Bytes(), nil
}

func TestArchiveStripsTheTopLevelDirectoryAndCleansHeaders(t *testing.T) {
	src := archive(t,
		dir("o-r-abc/"),
		file("o-r-abc/Dockerfile", "FROM scratch\n"),
		entry{name: "o-r-abc/run.sh", body: "#!/bin/sh\n", mode: 0o4755, uid: 1234},
		dir("o-r-abc/src/"),
		file("o-r-abc/src/main.go", "package main\n"),
		sym("o-r-abc/src/latest", "main.go"),
	)
	got, _, err := run(t, ".", src)
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"Dockerfile", "run.sh", "src/", "src/main.go", "src/latest"}
	if !slices.Equal(got.names, want) {
		t.Fatalf("names = %v, want %v", got.names, want)
	}
	if got.files["Dockerfile"] != "FROM scratch\n" || got.files["src/main.go"] != "package main\n" {
		t.Errorf("contents: %v", got.files)
	}
	if h := got.hdrs["run.sh"]; h.Mode != 0o755 || h.Uid != 0 || h.Gid != 0 || h.Uname != "" {
		t.Errorf("mode, owner and setuid must be cleaned: %+v", h)
	}
	if h := got.hdrs["src/latest"]; h.Typeflag != tar.TypeSymlink || h.Linkname != "main.go" {
		t.Errorf("an inside symlink is kept: %+v", h)
	}
}

func TestArchiveSelectsTheContext(t *testing.T) {
	src := archive(t,
		dir("o-r-abc/"),
		file("o-r-abc/Dockerfile", "root dockerfile"),
		dir("o-r-abc/services/"),
		dir("o-r-abc/services/web/"),
		file("o-r-abc/services/web/Dockerfile", "web dockerfile"),
		file("o-r-abc/services/web/app.js", "x"),
		dir("o-r-abc/services/web/lib/"),
		file("o-r-abc/services/web/lib/a.js", "y"),
		file("o-r-abc/services/webextra/Dockerfile", "must not match the prefix"),
		file("o-r-abc/services/api/Dockerfile", "other service"),
		file("o-r-abc/README.md", "outside"),
	)
	got, _, err := run(t, "services/web", src)
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(got.names, []string{"Dockerfile", "app.js", "lib/", "lib/a.js"}) || got.files["Dockerfile"] != "web dockerfile" {
		t.Fatalf("%v %v", got.names, got.files)
	}

	// The Dockerfile path is relative to the context.
	src = archive(t, file("o-r-abc/app/docker/prod.Dockerfile", "FROM scratch"), file("o-r-abc/app/main.c", "int main;"))
	got, _, err = run(t, "app", src, func(o *archiveOptions) { o.Dockerfile = "docker/prod.Dockerfile" })
	if err != nil || !slices.Equal(got.names, []string{"docker/prod.Dockerfile", "main.c"}) {
		t.Fatalf("%v %v", got.names, err)
	}
}

func TestArchiveRefusals(t *testing.T) {
	ok := file("o-r-abc/Dockerfile", "FROM scratch")
	cases := map[string]struct {
		src     []byte
		want    string
		mutate  func(*archiveOptions)
		context string
	}{
		"absolute path":          {src: archive(t, ok, file("/etc/cron.d/x", "x")), want: "absolute path"},
		"dot dot":                {src: archive(t, ok, file("o-r-abc/../../etc/passwd", "x")), want: "leaves the archive"},
		"dot dot inside":         {src: archive(t, ok, file("o-r-abc/a/../b", "x")), want: "leaves the archive"},
		"two top-level dirs":     {src: archive(t, ok, file("other/x", "x")), want: "one top-level directory"},
		"top-level file":         {src: archive(t, file("Dockerfile", "x")), want: "one top-level directory"},
		"symlink absolute":       {src: archive(t, ok, sym("o-r-abc/a", "/etc/passwd")), want: "absolute path"},
		"symlink up":             {src: archive(t, ok, sym("o-r-abc/a", "../../x")), want: "outside the build context"},
		"symlink up from a dir":  {src: archive(t, ok, sym("o-r-abc/d/a", "../../x")), want: "outside the build context"},
		"symlink empty":          {src: archive(t, ok, sym("o-r-abc/a", "")), want: "no valid target"},
		"symlink out of context": {src: archive(t, file("o-r-abc/app/Dockerfile", "x"), sym("o-r-abc/app/shared", "../lib")), want: "outside the build context", context: "app"},
		"below a symlink":        {src: archive(t, ok, sym("o-r-abc/d", "."), file("o-r-abc/d/evil", "x")), want: "below the symlink"},
		"hard link out":          {src: archive(t, ok, entry{name: "o-r-abc/h", typ: tar.TypeLink, link: "/etc/passwd"}), want: "absolute path"},
		"hard link elsewhere":    {src: archive(t, ok, entry{name: "o-r-abc/h", typ: tar.TypeLink, link: "other/x"}), want: "outside the repository"},
		"hard link out of ctx":   {src: archive(t, file("o-r-abc/app/Dockerfile", "x"), entry{name: "o-r-abc/app/h", typ: tar.TypeLink, link: "o-r-abc/secret"}), want: "outside the build context", context: "app"},
		"device":                 {src: archive(t, ok, entry{name: "o-r-abc/dev", typ: tar.TypeChar}), want: "special file"},
		"fifo":                   {src: archive(t, ok, entry{name: "o-r-abc/p", typ: tar.TypeFifo}), want: "special file"},
		"not gzip":               {src: []byte("this is not an archive"), want: "not a gzip archive"},
		"gzip of garbage":        {src: gz(t, []byte("garbage garbage garbage")), want: "not a valid tar archive"},
		"empty archive":          {src: archive(t), want: "empty"},
		"no dockerfile":          {src: archive(t, file("o-r-abc/main.go", "x")), want: "Dockerfile \"Dockerfile\" is not in the build context"},
		"dockerfile outside ctx": {src: archive(t, file("o-r-abc/Dockerfile", "x"), file("o-r-abc/app/main.go", "x")), want: "is not in the build context", context: "app"},
		"missing context":        {src: archive(t, ok), want: "does not exist", context: "nope"},
		"context is a file":      {src: archive(t, ok, file("o-r-abc/app", "x")), want: "not a directory", context: "app"},
		"too many files":         {src: archive(t, ok, file("o-r-abc/a", ""), file("o-r-abc/b", "")), want: "more than 2 entries", mutate: func(o *archiveOptions) { o.MaxEntries = 2 }},
		"too big unpacked":       {src: archive(t, ok, file("o-r-abc/big", strings.Repeat("0", 5000))), want: "add up to more than", mutate: func(o *archiveOptions) { o.MaxUnpacked = 1000 }},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			ctx := tc.context
			if ctx == "" {
				ctx = "."
			}
			var mutate []func(*archiveOptions)
			if tc.mutate != nil {
				mutate = append(mutate, tc.mutate)
			}
			_, raw, err := run(t, ctx, tc.src, mutate...)
			if err == nil {
				t.Fatal("accepted")
			}
			if !errors.Is(err, ErrArchive) || !strings.Contains(err.Error(), tc.want) {
				t.Errorf("got %v, want %q", err, tc.want)
			}
			// A refused archive must never look like a complete context: no tar trailer was written.
			if bytes.HasSuffix(raw, make([]byte, 1024)) {
				t.Error("the output of a refused archive ends with a tar trailer")
			}
		})
	}
}

func gz(t testing.TB, b []byte) []byte {
	t.Helper()
	var buf bytes.Buffer
	w := gzip.NewWriter(&buf)
	w.Write(b)
	w.Close()
	return buf.Bytes()
}

func TestArchiveKeepsLinksThatStayInsideTheContext(t *testing.T) {
	src := archive(t,
		file("o-r-abc/app/Dockerfile", "x"),
		file("o-r-abc/app/shared/a", "a"),
		sym("o-r-abc/app/b/link", "../shared/a"),
		entry{name: "o-r-abc/app/hard", typ: tar.TypeLink, link: "o-r-abc/app/shared/a"},
	)
	got, _, err := run(t, "app", src)
	if err != nil {
		t.Fatal(err)
	}
	if h := got.hdrs["hard"]; h == nil || h.Typeflag != tar.TypeLink || h.Linkname != "shared/a" {
		t.Errorf("the hard link must be rewritten relative to the context: %+v", h)
	}
	if h := got.hdrs["b/link"]; h == nil || h.Linkname != "../shared/a" {
		t.Errorf("%+v", h)
	}
}

func TestArchiveSizeLimitIsEnforcedWhileStreaming(t *testing.T) {
	src := archive(t, file("o-r-abc/Dockerfile", "FROM scratch"), file("o-r-abc/big", strings.Repeat("A", 1<<16)))
	body := &limitedBody{rc: io.NopCloser(bytes.NewReader(src)), left: int64(len(src) / 2)}
	var out bytes.Buffer
	err := buildContext(&out, body, archiveOptions{Context: ".", Dockerfile: "Dockerfile", MaxUnpacked: 1 << 20})
	if !errors.Is(err, ErrSourceTooLarge) {
		t.Fatalf("got %v", err)
	}
}

func TestArchiveGenerateAddsFilesAndRefusesAnyEntryOfThatName(t *testing.T) {
	gen := func(o *archiveOptions) {
		o.Dockerfile = ""
		o.Generate = func(root map[string]bool) ([]contextFile, error) {
			return []contextFile{{Name: ".gen", Data: []byte("generated")}}, nil
		}
	}
	got, _, err := run(t, ".", archive(t, file("o-r-abc/a.txt", "a"), dir("o-r-abc/d/"), file("o-r-abc/d/b.txt", "b")), gen)
	if err != nil || !slices.Equal(got.names, []string{"a.txt", "d/", "d/b.txt", ".gen"}) || got.files[".gen"] != "generated" {
		t.Fatalf("%v %v", got.names, err)
	}
	// The generator sees the names at the top of the context: files and directories, not nested ones.
	var seen map[string]bool
	_, _, err = run(t, ".", archive(t, file("o-r-abc/a.txt", "a"), file("o-r-abc/d/b.txt", "b")), func(o *archiveOptions) {
		gen(o)
		o.Generate = func(root map[string]bool) ([]contextFile, error) { seen = root; return nil, nil }
	})
	if err != nil || !seen["a.txt"] || !seen["d"] || seen["b.txt"] || seen["d/b.txt"] {
		t.Fatalf("%v %v", seen, err)
	}
	// A file, a directory or a symlink of that name is refused, never replaced.
	for _, e := range []entry{file("o-r-abc/.gen", "mine"), dir("o-r-abc/.gen/"), sym("o-r-abc/.gen", "a.txt"), file("o-r-abc/.gen/x", "y")} {
		if _, _, err := run(t, ".", archive(t, file("o-r-abc/a.txt", "a"), e), gen); !errors.Is(err, ErrArchive) || !strings.Contains(err.Error(), ".gen") {
			t.Errorf("%+v: %v", e, err)
		}
	}
	// The context subdirectory is what is looked at.
	if _, _, err := run(t, "app", archive(t, file("o-r-abc/.gen", "outside"), file("o-r-abc/app/a.txt", "a")), gen); err != nil {
		t.Errorf("a file outside the context is no conflict: %v", err)
	}
}
