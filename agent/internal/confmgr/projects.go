package confmgr

import (
	"fmt"
	"time"

	"github.com/0x2u/keelson/agent/internal/config"
	"github.com/0x2u/keelson/agent/internal/store"
)

// ProjectInfo is one project file as the listing shows it.
type ProjectInfo struct {
	Name string `json:"name"`
	// Path is "projects.d/<name>.yaml".
	Path string `json:"path"`
	// Hash is the hash of the file on disk; AppliedHash the one of the file in force (empty when the file is not in force yet).
	Hash        string    `json:"hash"`
	AppliedHash string    `json:"applied_hash"`
	ModifiedAt  time.Time `json:"modified_at"`
	Apps        int       `json:"apps"`
	Jobs        int       `json:"jobs"`
	Databases   int       `json:"databases"`
	Previews    int       `json:"previews"`
}

// ProjectDocument is the file of one project as the API shows it.
type ProjectDocument struct {
	Project string
	Path    string
	// Content is the file's text with secrets hidden.
	Content string
	// Hash is the file's hash on disk and what the next PUT is based on; AppliedHash the hash of the file in force.
	Hash        string
	AppliedHash string
	ModifiedAt  time.Time
	Model       map[string]any
	// Error says why the file on disk is not the one in force, when it is not.
	Error string
	// ConfigHash is the hash of the whole configuration on disk.
	ConfigHash string
}

// Projects lists the project files on disk.
func (m *Manager) Projects() ([]ProjectInfo, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	disk, err := m.loc.Read()
	if err != nil {
		return nil, err
	}
	files := m.files(disk)
	out := make([]ProjectInfo, 0, len(files))
	for _, f := range files[1:] {
		info := ProjectInfo{Name: f.Project, Path: f.Path, Hash: f.Hash, ModifiedAt: f.ModifiedAt}
		if content, ok := m.applied.Projects[f.Project]; ok {
			info.AppliedHash = config.Hash(content)
		}
		info.Apps, info.Jobs, info.Databases, info.Previews = config.Counts(disk.Projects[f.Project])
		out = append(out, info)
	}
	return out, nil
}

// ProjectDocument returns the file of a project for display, secrets hidden. store.ErrNotFound when there is no such file.
func (m *Manager) ProjectDocument(name string) (ProjectDocument, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	disk, err := m.loc.Read()
	if err != nil {
		return ProjectDocument{}, err
	}
	content, ok := disk.Projects[name]
	if !ok || !config.ValidName(name) {
		return ProjectDocument{}, store.ErrNotFound
	}
	var fi FileInfo
	for _, f := range m.files(disk) {
		if f.Project == name {
			fi = f
		}
	}
	doc := ProjectDocument{Project: name, Path: fi.Path, Hash: fi.Hash, ModifiedAt: fi.ModifiedAt, ConfigHash: disk.Hash()}
	applied, inForce := m.applied.Projects[name]
	if inForce {
		doc.AppliedHash = config.Hash(applied)
	}
	shown := content
	if !inForce || doc.AppliedHash != doc.Hash {
		doc.Error = m.fileErr
		if _, issues := config.ParseBundle(disk); hasErrors(issues) {
			// A document that does not parse cannot be redacted safely: show the one in force, if there is one.
			shown = applied
			if doc.Error == "" {
				doc.Error = errorText(issues)
			}
		}
	}
	red, err := config.Redact(shown)
	if err != nil {
		return ProjectDocument{}, fmt.Errorf("hide secrets: %w", err)
	}
	model, err := config.Bundle{Projects: map[string][]byte{name: red}}.Model()
	if err != nil {
		return ProjectDocument{}, err
	}
	doc.Content, doc.Model = string(red), model
	return doc, nil
}

// invalidName is the refusal of a project name that cannot name a file.
func invalidName(name string) error {
	return &InvalidError{Issues: []config.Issue{{Severity: config.SeverityError, Path: "project", Message: fmt.Sprintf("project %q must match %s", name, "[a-z0-9][a-z0-9_-]{0,62}")}}}
}

// ValidateProject checks a submitted (redacted) project file in the context of the configuration on disk, without
// writing anything: the errors, and the warnings the change would carry.
func (m *Manager) ValidateProject(name string, content []byte) ([]config.Issue, error) {
	if !config.ValidName(name) {
		return nil, invalidName(name)
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	disk, err := m.loc.Read()
	if err != nil {
		return nil, err
	}
	final, issues := config.Restore(content, disk.Projects[name])
	next := disk.Clone()
	next.SetContent(name, final)
	return m.check(issues, next), nil
}

// SaveProject writes a project's file (secrets as Hidden or as new values), creating it when it does not exist, validates the
// configuration it makes with the other files and applies it. baseHash is the hash of the project's file; empty checks nothing.
func (m *Manager) SaveProject(name string, content []byte, baseHash string, force bool, meta Meta) (Outcome, error) {
	if !config.ValidName(name) {
		return Outcome{}, invalidName(name)
	}
	return m.change(fileBase(name, baseHash), name, force, meta, func(cur config.Bundle) (config.Bundle, []config.Issue, error) {
		final, issues := config.Restore(content, cur.Projects[name])
		next := cur.Clone()
		next.SetContent(name, final)
		return next, issues, nil
	})
}

// DeleteProject removes a project's file. Its apps, jobs and databases leave the configuration, which the apps guard
// asks to acknowledge (force) like any removal. store.ErrNotFound when there is no such file.
func (m *Manager) DeleteProject(name, baseHash string, force bool, meta Meta) (Outcome, error) {
	if !config.ValidName(name) {
		return Outcome{}, store.ErrNotFound
	}
	return m.change(fileBase(name, baseHash), name, force, meta, func(cur config.Bundle) (config.Bundle, []config.Issue, error) {
		if _, ok := cur.Projects[name]; !ok {
			return config.Bundle{}, nil, store.ErrNotFound
		}
		next := cur.Clone()
		delete(next.Projects, name)
		return next, nil, nil
	})
}

// SplitProject moves what belongs to a project out of the apps file into projects.d/<name>.yaml, as one new version
// (see config.Bundle.SplitProject). With dryRun nothing is written and the plan is returned. baseHash is the hash of the
// whole configuration.
func (m *Manager) SplitProject(name, baseHash string, force, dryRun bool, meta Meta) (Outcome, config.SplitPlan, error) {
	var plan config.SplitPlan
	build := func(cur config.Bundle) (config.Bundle, []config.Issue, error) {
		next, p, err := cur.SplitProject(name)
		plan = p
		return next, nil, err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if dryRun {
		disk, err := m.loc.Read()
		if err != nil {
			return Outcome{}, plan, err
		}
		if current, conflict := bundleBase(baseHash)(disk); conflict {
			return Outcome{}, plan, &ConflictError{Hash: current}
		}
		if _, _, err := build(disk); err != nil {
			return Outcome{}, plan, &InvalidError{Issues: []config.Issue{{Severity: config.SeverityError, Path: "yaml", Message: err.Error()}}}
		}
		return Outcome{Hash: disk.Hash()}, plan, nil
	}
	out, _, err := m.changeLocked(bundleBase(baseHash), name, force, meta, build)
	return out, plan, err
}
