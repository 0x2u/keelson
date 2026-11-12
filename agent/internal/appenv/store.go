// Package appenv keeps the environment variables an operator sets through the agent's API (the dashboard's
// "Variables" page), as opposed to the ones written in the apps file.
//
// Values live only in files under the agent's data directory, never in its database, logs, audit log, events or
// errors: one file per app and scope, "<app>.<scope>.env", mode 0600 in a 0700 directory, replaced atomically. The
// metadata the API reports (when a key changed, whether it is also a build argument) sits beside each key in the same
// file, in comment lines, so a write is one atomic rename and the two can never disagree.
//
// Two scopes exist: "app" (the running app) and "preview" (every preview instance of that app).
package appenv

import (
	"bufio"
	"bytes"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/0x2u/keelson/agent/internal/config"
)

// The scopes. ScopeBuild is not one of an app's variables: it holds the variables a build for another server uses (see
// BuildVars), kept per app name beside the others and never read by a deployment, so ValidScope leaves it out.
const (
	ScopeApp     = "app"
	ScopePreview = "preview"
	ScopeBuild   = "build"
)

// ValidScope reports whether s names a scope.
func ValidScope(s string) bool { return s == ScopeApp || s == ScopePreview }

// ErrBadName is returned for an app or scope that cannot name a file: nothing outside the directory is ever touched.
var ErrBadName = errors.New("invalid app or scope name")

const (
	dirMode  = 0o700
	fileMode = 0o600
	suffix   = ".env"
	tmpMark  = ".tmp-"

	metaChanged = "#@ changed "
	metaVar     = "#@ var "
)

// Entry is one stored variable.
type Entry struct {
	Value     string
	UpdatedAt time.Time
	// Build says the variable is also passed as a build argument in builds of the app.
	Build bool
}

// Scope is the stored variables of one app and scope.
type Scope struct {
	// Changed is the last time anything in the scope changed (a key set, changed or removed). Zero when nothing was
	// ever stored.
	Changed time.Time
	Entries map[string]Entry
}

// Keys returns the keys, sorted.
func (s Scope) Keys() []string {
	keys := make([]string, 0, len(s.Entries))
	for k := range s.Entries {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

func (s Scope) clone() Scope {
	c := Scope{Changed: s.Changed, Entries: make(map[string]Entry, len(s.Entries))}
	for k, e := range s.Entries {
		c.Entries[k] = e
	}
	return c
}

// Store is the directory of stored scopes. It is safe for concurrent use; readers never see a half-written scope.
type Store struct {
	dir string
	mu  sync.Mutex // serializes the writers: a change reads, edits and replaces one file
}

// Open prepares dir (created 0700) and puts it back in the state the agent expects: a directory restored from a
// backup or copied with another umask is made private again, and the leftovers of an interrupted write are removed.
func Open(dir string) (*Store, error) {
	if err := os.MkdirAll(dir, dirMode); err != nil {
		return nil, err
	}
	if err := os.Chmod(dir, dirMode); err != nil {
		return nil, err
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
	}
	for _, e := range entries {
		p := filepath.Join(dir, e.Name())
		switch {
		case strings.Contains(e.Name(), tmpMark):
			_ = os.Remove(p)
		case strings.HasSuffix(e.Name(), suffix) && e.Type().IsRegular():
			if err := os.Chmod(p, fileMode); err != nil {
				return nil, err
			}
		}
	}
	return &Store{dir: dir}, nil
}

// Dir is the directory of the store.
func (s *Store) Dir() string { return s.dir }

func (s *Store) path(app, scope string) (string, error) {
	if !config.ValidName(app) || !(ValidScope(scope) || scope == ScopeBuild) {
		return "", ErrBadName
	}
	return filepath.Join(s.dir, app+"."+scope+suffix), nil
}

// Read returns the stored scope; a scope never written is empty, not an error.
func (s *Store) Read(app, scope string) (Scope, error) {
	p, err := s.path(app, scope)
	if err != nil {
		return Scope{}, err
	}
	f, err := os.Open(p)
	if errors.Is(err, os.ErrNotExist) {
		return Scope{Entries: map[string]Entry{}}, nil
	}
	if err != nil {
		return Scope{}, err
	}
	defer f.Close()
	fi, err := f.Stat()
	if err != nil {
		return Scope{}, err
	}
	if fi.Mode().Perm() != fileMode {
		_ = f.Chmod(fileMode) // a file copied in by hand is not left readable by others
	}
	data, err := io.ReadAll(io.LimitReader(f, maxFileBytes))
	if err != nil {
		return Scope{}, err
	}
	return parse(data, fi.ModTime(), filepath.Base(p))
}

// maxFileBytes bounds what is read of a scope file: the limits of a scope (MaxScopeBytes) plus the quoting and the
// metadata lines, with room to spare.
const maxFileBytes = 4 << 20

// parse reads a scope file. A file without the header (written by hand) still works: its keys take the file's
// modification time.
func parse(data []byte, mod time.Time, name string) (Scope, error) {
	pairs, err := config.ParseEnv(bytes.NewReader(data), name)
	if err != nil {
		return Scope{}, err
	}
	sc := Scope{Entries: make(map[string]Entry, len(pairs))}
	meta := map[string]Entry{}
	br := bufio.NewScanner(bytes.NewReader(data))
	br.Buffer(make([]byte, 64<<10), 1<<20)
	for br.Scan() {
		line := br.Text()
		switch {
		case strings.HasPrefix(line, metaChanged):
			if t, err := time.Parse(time.RFC3339, strings.TrimSpace(line[len(metaChanged):])); err == nil {
				sc.Changed = t.UTC()
			}
		case strings.HasPrefix(line, metaVar):
			f := strings.Fields(line[len(metaVar):])
			if len(f) < 2 {
				continue
			}
			t, err := time.Parse(time.RFC3339, f[1])
			if err != nil {
				continue
			}
			meta[f[0]] = Entry{UpdatedAt: t.UTC(), Build: len(f) > 2 && f[2] == "build"}
		}
	}
	for _, kv := range pairs {
		e, ok := meta[kv[0]]
		if !ok {
			e.UpdatedAt = mod.UTC()
		}
		e.Value = kv[1]
		sc.Entries[kv[0]] = e // a duplicate key: the last one wins, as in every dotenv reader
	}
	if sc.Changed.IsZero() && len(sc.Entries) > 0 {
		sc.Changed = mod.UTC()
		for _, e := range sc.Entries {
			if e.UpdatedAt.After(sc.Changed) {
				sc.Changed = e.UpdatedAt
			}
		}
	}
	return sc, nil
}

// Changed reads only the head of a scope file: when it last changed, zero when it never did. It is what the app
// listing calls for every app, so it does not parse the values.
func (s *Store) Changed(app, scope string) (time.Time, error) {
	p, err := s.path(app, scope)
	if err != nil {
		return time.Time{}, err
	}
	f, err := os.Open(p)
	if errors.Is(err, os.ErrNotExist) {
		return time.Time{}, nil
	}
	if err != nil {
		return time.Time{}, err
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	for i := 0; i < 4 && sc.Scan(); i++ {
		if line := sc.Text(); strings.HasPrefix(line, metaChanged) {
			if t, err := time.Parse(time.RFC3339, strings.TrimSpace(line[len(metaChanged):])); err == nil {
				return t.UTC(), nil
			}
		}
	}
	// A hand-written file: it changed when it was last written.
	fi, err := f.Stat()
	if err != nil {
		return time.Time{}, err
	}
	return fi.ModTime().UTC(), nil
}

// Scopes lists the scopes that have a file for app.
func (s *Store) Scopes(app string) ([]string, error) {
	if !config.ValidName(app) {
		return nil, ErrBadName
	}
	var out []string
	for _, scope := range []string{ScopeApp, ScopePreview} {
		p, _ := s.path(app, scope)
		if _, err := os.Stat(p); err == nil {
			out = append(out, scope)
		} else if !errors.Is(err, os.ErrNotExist) {
			return nil, err
		}
	}
	return out, nil
}

// Update reads the scope, lets fn edit a copy and, when fn reports a change, replaces the file atomically with the
// copy stamped now. If fn fails, or reports no change, nothing is written. Changes are serialized, and a reader sees the
// old scope or the new one, never a mixture.
func (s *Store) Update(app, scope string, now time.Time, fn func(sc *Scope) (changed bool, err error)) error {
	p, err := s.path(app, scope)
	if err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	cur, err := s.Read(app, scope)
	if err != nil {
		return fmt.Errorf("read the stored variables of %s (%s): %w", app, scope, err)
	}
	next := cur.clone()
	changed, err := fn(&next)
	if err != nil || !changed {
		return err
	}
	next.Changed = now.UTC().Truncate(time.Second)
	return s.write(p, next)
}

// Remove deletes a scope's file, reporting whether there was one.
func (s *Store) Remove(app, scope string) (bool, error) {
	p, err := s.path(app, scope)
	if err != nil {
		return false, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	err = os.Remove(p)
	if errors.Is(err, os.ErrNotExist) {
		return false, nil
	}
	return err == nil, err
}

// encode writes a scope in the file format.
func encode(sc Scope) []byte {
	var b bytes.Buffer
	b.WriteString(config.ManagedEnvHeader + "\n")
	b.WriteString("# Written by keelson-agent from its API: change it there, not here. Values are JSON strings.\n")
	b.WriteString(metaChanged + sc.Changed.UTC().Format(time.RFC3339) + "\n")
	for _, k := range sc.Keys() {
		e := sc.Entries[k]
		b.WriteString(metaVar + k + " " + e.UpdatedAt.UTC().Format(time.RFC3339))
		if e.Build {
			b.WriteString(" build")
		}
		b.WriteString("\n" + k + "=" + config.QuoteEnvValue(e.Value) + "\n")
	}
	return b.Bytes()
}

// write replaces the file at path with sc: a temporary file in the same directory (created 0600), flushed, then renamed
// over the target, so a crash leaves the old file or the new one.
func (s *Store) write(path string, sc Scope) error {
	tmp, err := os.CreateTemp(s.dir, filepath.Base(path)+tmpMark+"*")
	if err != nil {
		return err
	}
	name := tmp.Name()
	ok := false
	defer func() {
		if !ok {
			tmp.Close()
			_ = os.Remove(name)
		}
	}()
	if err := tmp.Chmod(fileMode); err != nil {
		return err
	}
	if _, err := tmp.Write(encode(sc)); err != nil {
		return err
	}
	if err := tmp.Sync(); err != nil {
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := os.Rename(name, path); err != nil {
		return err
	}
	ok = true
	if d, err := os.Open(s.dir); err == nil { // make the rename itself durable
		_ = d.Sync()
		d.Close()
	}
	return nil
}
