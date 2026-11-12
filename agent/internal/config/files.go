package config

import (
	"bytes"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// Location says where a configuration is on disk: the apps file, and the directory of project files.
type Location struct {
	File        string
	ProjectsDir string
}

// DefaultLocation is the apps file with the projects directory next to it.
func DefaultLocation(file string) Location {
	return Location{File: file, ProjectsDir: filepath.Join(filepath.Dir(file), ProjectsDirName)}
}

// ProjectPath is where the file of a project is (or would be).
func (l Location) ProjectPath(project string) string {
	return filepath.Join(l.ProjectsDir, project+ProjectFileExt)
}

// Read reads the apps file and every project file. A missing or empty projects directory is a configuration of the
// apps file alone. Files whose names begin with a dot (what the agent writes while replacing a file) are not project files.
func (l Location) Read() (Bundle, error) {
	main, err := os.ReadFile(l.File)
	if err != nil {
		return Bundle{}, err
	}
	b := Bundle{MainName: filepath.Base(l.File), Main: main}
	if l.ProjectsDir == "" {
		return b, nil
	}
	entries, err := os.ReadDir(l.ProjectsDir)
	switch {
	case os.IsNotExist(err):
		return b, nil
	case err != nil:
		return Bundle{}, err
	}
	for _, e := range entries {
		name := e.Name()
		if strings.HasPrefix(name, ".") || e.IsDir() {
			continue
		}
		switch ext := filepath.Ext(name); ext {
		case ProjectFileExt:
			content, err := os.ReadFile(filepath.Join(l.ProjectsDir, name))
			if err != nil {
				return Bundle{}, err
			}
			b.SetContent(strings.TrimSuffix(name, ext), content)
		case ".yml":
			b.Strays = append(b.Strays, name)
		}
	}
	return b, nil
}

// LoadFrom reads and validates a configuration made of the apps file and its project files, as Load does for the apps file.
func LoadFrom(l Location) (*Config, error) {
	b, err := l.Read()
	if err != nil {
		return nil, err
	}
	c, issues := ParseBundle(b)
	if c == nil {
		return nil, fmt.Errorf("%s: %w", l.File, LoadIssues(issues))
	}
	return c, nil
}

// Write puts next on disk, given what is there (old). Each file is replaced atomically, the project files first, then the
// apps file, then the removals: a crash in the middle leaves an entry defined twice (the configuration is refused as a
// whole and the agent keeps running the last good one), never one that silently disappeared. A failure puts back every
// file already written.
func (l Location) Write(old, next Bundle) (err error) {
	type undo struct {
		path    string
		prev    []byte
		existed bool
	}
	var done []undo
	defer func() {
		if err == nil {
			return
		}
		for i := len(done) - 1; i >= 0; i-- {
			u := done[i]
			if u.existed {
				_ = writeFileAtomic(u.path, u.prev, l.mode())
			} else {
				_ = os.Remove(u.path)
			}
		}
	}()
	put := func(path string, prev, content []byte, existed bool) error {
		if err := writeFileAtomic(path, content, l.mode()); err != nil {
			return fmt.Errorf("write %s: %w", path, err)
		}
		done = append(done, undo{path, prev, existed})
		return nil
	}

	for _, n := range next.ProjectNames() {
		prev, existed := old.Projects[n]
		if existed && bytes.Equal(prev, next.Projects[n]) {
			continue
		}
		if err := os.MkdirAll(l.ProjectsDir, 0o700); err != nil {
			return fmt.Errorf("create %s: %w", l.ProjectsDir, err)
		}
		if err := put(l.ProjectPath(n), prev, next.Projects[n], existed); err != nil {
			return err
		}
	}
	if !bytes.Equal(old.Main, next.Main) {
		if err := put(l.File, old.Main, next.Main, true); err != nil {
			return err
		}
	}
	for _, n := range old.ProjectNames() {
		if _, kept := next.Projects[n]; kept {
			continue
		}
		path := l.ProjectPath(n)
		if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
			return fmt.Errorf("remove %s: %w", path, err)
		}
		done = append(done, undo{path, old.Projects[n], true})
	}
	return nil
}

// mode is what a new file gets: the apps file's permissions, 0600 when they cannot be read.
func (l Location) mode() os.FileMode {
	if info, err := os.Stat(l.File); err == nil {
		return info.Mode().Perm()
	}
	return 0o600
}

// writeFileAtomic replaces the file so a reader (the agent itself after a crash, an editor) never sees half of it. An
// existing file keeps its permissions.
func writeFileAtomic(path string, data []byte, defaultMode os.FileMode) error {
	mode := defaultMode
	if info, err := os.Stat(path); err == nil {
		mode = info.Mode().Perm()
	}
	tmp, err := os.CreateTemp(filepath.Dir(path), "."+filepath.Base(path)+"-*")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Chmod(mode); err != nil {
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
	return os.Rename(tmp.Name(), path)
}
