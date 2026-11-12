package confmgr

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"time"

	"github.com/0x2u/keelson/agent/internal/config"
	"github.com/0x2u/keelson/agent/internal/store"
)

// Warning codes that must be acknowledged (force) before the change is applied.
const (
	CodeAppRemoved   = "app_removed"
	CodeJobRemoved   = "job_removed"
	CodeProxyChanged = "proxy_changed"
	// CodePreviewsRemoved: a previews template is gone, and its live instances are removed with it.
	CodePreviewsRemoved = "previews_removed"
	// CodeSecretRemoved is informational: it never blocks.
	CodeSecretRemoved = "secret_removed"
)

var blocking = map[string]bool{CodeAppRemoved: true, CodeJobRemoved: true, CodeProxyChanged: true, CodePreviewsRemoved: true}

// InvalidError: the document has errors. Nothing was written.
type InvalidError struct{ Issues []config.Issue }

func (e *InvalidError) Error() string { return "the configuration is invalid" }

// ConflictError: the file is not the one the change was based on. Hash is the file's current hash.
type ConflictError struct{ Hash string }

func (e *ConflictError) Error() string { return "the configuration was changed elsewhere" }

// NeedsAckError: the change is valid but does something that must be confirmed.
type NeedsAckError struct{ Issues []config.Issue }

func (e *NeedsAckError) Error() string { return "the change must be acknowledged" }

// Meta says where a change comes from.
type Meta struct {
	Source  string
	Actor   string
	Comment string
}

// Outcome is the result of an applied change.
type Outcome struct {
	// Hash is the hash of the whole configuration (the apps file alone when there are no project files).
	Hash    string
	Version int64
	// FileHash is the hash of the project file the change was about, when it was about one and the file still exists.
	FileHash string
	// Issues are warnings that did not block the change.
	Issues []config.Issue
}

// FileInfo describes one file of the configuration.
type FileInfo struct {
	// Path is the apps file's name, or "projects.d/<project>.yaml".
	Path string `json:"path"`
	// Project is empty for the apps file.
	Project    string    `json:"project"`
	Hash       string    `json:"hash"`
	ModifiedAt time.Time `json:"modified_at"`
}

// Document is the configuration as the API shows it.
type Document struct {
	// Content is the apps file's text; the project files are in Files and in each project's own document.
	Content string
	// Hash identifies the whole configuration on disk: the hash of the apps file when there are no project files.
	Hash       string
	ModifiedAt time.Time
	// Model is the apps file's model with the apps, jobs, databases and previews of every project file added.
	Model map[string]any
	// Error is set when the file on disk is invalid: the agent keeps running the last good configuration.
	Error       string
	AppliedHash string
	// Files lists the apps file and the project files on disk.
	Files []FileInfo
	// Deprecations are the keys of the files that have a new spelling (the warnings with the code "deprecated"); the
	// model above is already in the current schema. Empty when the files are the current schema.
	Deprecations []config.Issue
}

// Manager keeps the apps file (and the project files next to it) and the running configuration in step.
type Manager struct {
	loc      config.Location
	store    *store.Store
	log      *slog.Logger
	appliers []Applier
	now      func() time.Time

	mu          sync.Mutex
	cfg         *config.Config
	applied     config.Bundle
	appliedHash string
	fileErr     string
	rejected    string // hash of a disk version already reported invalid
	// awaitingAck says rejected was refused only because it needs an acknowledgement: writing the .force marker lifts it.
	awaitingAck bool

	// restrict, when set, adds errors to every document submitted through the API: what this agent's configuration may hold.
	restrict func(*config.Config) []config.Issue
}

// Restrict limits what documents submitted through the API (Save, Edit, RestoreVersion, Validate) may hold. A document that
// breaks the limit is refused with the issues; the file on disk is its owner's own and is not held to it.
func (m *Manager) Restrict(f func(*config.Config) []config.Issue) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.restrict = f
}

// New adopts the configuration the agent started with, the apps file with the projects directory next to it. The
// files are read again to record their exact text as the first version (or as a "file" version when they were edited
// while the agent was down).
func New(path string, st *store.Store, initial *config.Config, log *slog.Logger, appliers ...Applier) (*Manager, error) {
	return NewAt(config.DefaultLocation(path), st, initial, log, appliers...)
}

// NewAt is New for a configuration at a given location.
func NewAt(loc config.Location, st *store.Store, initial *config.Config, log *slog.Logger, appliers ...Applier) (*Manager, error) {
	if log == nil {
		log = slog.Default()
	}
	disk, err := loc.Read()
	if err != nil {
		return nil, err
	}
	m := &Manager{loc: loc, store: st, log: log, appliers: appliers, now: time.Now, cfg: initial, applied: disk, appliedHash: disk.Hash()}
	ctx := context.Background()
	latest, err := st.LatestConfigVersion(ctx)
	switch {
	case errors.Is(err, store.ErrNotFound):
		_, err = st.AddConfigVersion(ctx, store.ConfigVersion{At: m.now(), Hash: m.appliedHash, Source: store.SourceStartup, Content: disk.Encode()})
	case err == nil && latest.Hash != m.appliedHash:
		_, err = st.AddConfigVersion(ctx, store.ConfigVersion{At: m.now(), Hash: m.appliedHash, Source: store.SourceFile, Content: disk.Encode()})
	}
	if err != nil {
		return nil, fmt.Errorf("record the configuration version: %w", err)
	}
	return m, nil
}

// Config is the configuration in force.
func (m *Manager) Config() *config.Config {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.cfg
}

// files describes the files of a bundle that is on disk.
func (m *Manager) files(b config.Bundle) []FileInfo {
	info := func(path, project string, content []byte) FileInfo {
		fi := FileInfo{Path: filepath.Base(path), Project: project, Hash: config.Hash(content)}
		if project != "" {
			fi.Path = config.ProjectFileName(project)
		}
		if st, err := os.Stat(path); err == nil {
			fi.ModifiedAt = st.ModTime().UTC()
		}
		return fi
	}
	out := []FileInfo{info(m.loc.File, "", b.Main)}
	for _, n := range b.ProjectNames() {
		out = append(out, info(m.loc.ProjectPath(n), n, b.Projects[n]))
	}
	return out
}

// modifiedAt is the latest change among the files.
func modifiedAt(files []FileInfo) time.Time {
	var t time.Time
	for _, f := range files {
		if f.ModifiedAt.After(t) {
			t = f.ModifiedAt
		}
	}
	return t
}

// Document returns the file for display: secrets hidden, with its model and whether the agent runs it.
func (m *Manager) Document() (Document, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	disk, err := m.loc.Read()
	if err != nil {
		return Document{}, err
	}
	files := m.files(disk)
	doc := Document{Hash: disk.Hash(), ModifiedAt: modifiedAt(files), AppliedHash: m.appliedHash, Error: m.fileErr, Files: files}
	shown := disk
	if _, issues := config.ParseBundle(disk); hasErrors(issues) {
		// A document that does not parse cannot be redacted safely: show the last good one.
		shown = m.applied
		if doc.Error == "" {
			doc.Error = errorText(issues)
		}
	}
	if _, issues := config.ParseBundle(shown); !hasErrors(issues) {
		doc.Deprecations = Deprecations(issues)
	}
	if doc.Deprecations == nil {
		doc.Deprecations = []config.Issue{}
	}
	red, err := shown.Redact()
	if err != nil {
		return Document{}, fmt.Errorf("hide secrets: %w", err)
	}
	model, err := red.Model()
	if err != nil {
		return Document{}, err
	}
	doc.Content, doc.Model = string(red.Main), model
	return doc, nil
}

// Validate checks a submitted (redacted) apps file without writing anything: errors, and the warnings the change
// would carry. The project files on disk are part of what it is checked against.
func (m *Manager) Validate(content []byte) ([]config.Issue, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	disk, err := m.loc.Read()
	if err != nil {
		return nil, err
	}
	final, issues := config.Restore(content, disk.Main)
	next := disk.Clone()
	next.Main = final
	return m.check(issues, next), nil
}

// check parses a candidate bundle and returns the issues it carries added to those already found: errors, and the
// warnings of the change from the configuration in force.
func (m *Manager) check(issues []config.Issue, next config.Bundle) []config.Issue {
	cfg, parsed := config.ParseBundle(next)
	issues = append(issues, parsed...)
	if cfg != nil {
		if m.restrict != nil {
			issues = append(issues, m.restrict(cfg)...)
		}
		issues = append(issues, Warnings(m.cfg, cfg)...)
	}
	return issues
}

// Save writes a submitted apps file (secrets as Hidden or as new values), validates it with the project files and applies it.
func (m *Manager) Save(content []byte, baseHash string, force bool, meta Meta) (Outcome, error) {
	return m.change(bundleBase(baseHash), "", force, meta, func(cur config.Bundle) (config.Bundle, []config.Issue, error) {
		final, issues := config.Restore(content, cur.Main)
		next := cur.Clone()
		next.Main = final
		return next, issues, nil
	})
}

// Edit changes the apps file through a function (the notifications, say) and applies the result. An entity edit goes
// through EditBundle, which finds the file that holds the entity.
func (m *Manager) Edit(baseHash string, force bool, meta Meta, edit func(disk []byte) ([]byte, []config.Issue, error)) (Outcome, error) {
	return m.change(bundleBase(baseHash), "", force, meta, func(cur config.Bundle) (config.Bundle, []config.Issue, error) {
		out, issues, err := edit(cur.Main)
		if err != nil {
			return config.Bundle{}, nil, err
		}
		next := cur.Clone()
		next.Main = out
		return next, issues, nil
	})
}

// EditBundle changes the configuration through a function on the bundle (one app, one job: see the Set and Delete methods
// of config.Bundle) and applies the result.
func (m *Manager) EditBundle(baseHash string, force bool, meta Meta, edit func(b *config.Bundle) ([]config.Issue, error)) (Outcome, error) {
	return m.change(bundleBase(baseHash), "", force, meta, func(cur config.Bundle) (config.Bundle, []config.Issue, error) {
		next := cur.Clone()
		issues, err := edit(&next)
		return next, issues, err
	})
}

// singleEditor is a configuration service that can only edit the apps file.
type singleEditor interface {
	Edit(baseHash string, force bool, meta Meta, edit func(disk []byte) ([]byte, []config.Issue, error)) (Outcome, error)
}

type bundleEditor interface {
	EditBundle(baseHash string, force bool, meta Meta, edit func(b *config.Bundle) ([]config.Issue, error)) (Outcome, error)
}

// EditBundle runs an entity edit on a configuration service: on the whole bundle when the service knows project files (the
// manager does), on the apps file alone when it does not.
func EditBundle(svc singleEditor, baseHash string, force bool, meta Meta, edit func(b *config.Bundle) ([]config.Issue, error)) (Outcome, error) {
	if be, ok := svc.(bundleEditor); ok {
		return be.EditBundle(baseHash, force, meta, edit)
	}
	return svc.Edit(baseHash, force, meta, func(disk []byte) ([]byte, []config.Issue, error) {
		b := config.Bundle{Main: disk}
		issues, err := edit(&b)
		return b.Main, issues, err
	})
}

// RestoreVersion puts an older version back as a new one: every file of it, so a project file the version does not have
// is removed.
func (m *Manager) RestoreVersion(id int64, baseHash string, force bool, actor string) (Outcome, error) {
	v, err := m.store.ConfigVersion(context.Background(), id)
	if err != nil {
		return Outcome{}, err
	}
	old, err := config.DecodeBundle(v.Content)
	if err != nil {
		return Outcome{}, err
	}
	meta := Meta{Source: store.SourceRestore, Actor: actor, Comment: fmt.Sprintf("restored version %d", id)}
	return m.change(bundleBase(baseHash), "", force, meta, func(cur config.Bundle) (config.Bundle, []config.Issue, error) {
		old.MainName = cur.MainName
		return old, nil, nil
	})
}

// Versions lists the history, newest first.
func (m *Manager) Versions(limit int) ([]store.ConfigVersion, error) {
	return m.store.ConfigVersions(context.Background(), limit)
}

// Version returns one version with its apps file's text, secrets hidden. VersionFiles has the project files.
func (m *Manager) Version(id int64) (store.ConfigVersion, string, error) {
	v, err := m.store.ConfigVersion(context.Background(), id)
	if err != nil {
		return store.ConfigVersion{}, "", err
	}
	b, err := config.DecodeBundle(v.Content)
	if err != nil {
		return store.ConfigVersion{}, "", err
	}
	red, err := config.Redact(b.Main)
	if err != nil {
		return store.ConfigVersion{}, "", fmt.Errorf("hide secrets: %w", err)
	}
	v.Content = ""
	return v, string(red), nil
}

// VersionFile is a project file of a recorded version, secrets hidden.
type VersionFile struct {
	Path    string `json:"path"`
	Project string `json:"project"`
	Hash    string `json:"hash"`
	Content string `json:"content"`
}

// VersionFiles returns the project files of a version (nil when it has none), secrets hidden.
func (m *Manager) VersionFiles(id int64) ([]VersionFile, error) {
	v, err := m.store.ConfigVersion(context.Background(), id)
	if err != nil {
		return nil, err
	}
	b, err := config.DecodeBundle(v.Content)
	if err != nil {
		return nil, err
	}
	var out []VersionFile
	for _, n := range b.ProjectNames() {
		red, err := config.Redact(b.Projects[n])
		if err != nil {
			return nil, fmt.Errorf("hide secrets: %w", err)
		}
		out = append(out, VersionFile{Path: config.ProjectFileName(n), Project: n, Hash: config.Hash(b.Projects[n]), Content: string(red)})
	}
	return out, nil
}

// baseCheck says whether a change was based on a configuration that is no longer the one on disk: the hash of what is
// there, and whether it differs from the one the change was made on.
type baseCheck func(cur config.Bundle) (current string, conflict bool)

// bundleBase checks the hash of the whole configuration. An empty hash checks nothing.
func bundleBase(hash string) baseCheck {
	return func(cur config.Bundle) (string, bool) {
		got := cur.Hash()
		return got, hash != "" && got != hash
	}
}

// fileBase checks the hash of one project file (empty when the file does not exist). An empty hash checks nothing.
func fileBase(project, hash string) baseCheck {
	return func(cur config.Bundle) (string, bool) {
		got := ""
		if content, ok := cur.Projects[project]; ok {
			got = config.Hash(content)
		}
		return got, hash != "" && got != hash
	}
}

// change is the one path every change takes: read what is on disk, check what it was based on, build the next state, validate it,
// ask for the acknowledgement it needs, then write, apply and record it as a version. project is the project file the change
// is about, "" for the configuration as a whole.
func (m *Manager) change(base baseCheck, project string, force bool, meta Meta, build func(cur config.Bundle) (config.Bundle, []config.Issue, error)) (Outcome, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	out, _, err := m.changeLocked(base, project, force, meta, build)
	return out, err
}

func (m *Manager) changeLocked(base baseCheck, project string, force bool, meta Meta, build func(cur config.Bundle) (config.Bundle, []config.Issue, error)) (Outcome, config.Bundle, error) {
	disk, err := m.loc.Read()
	if err != nil {
		return Outcome{}, config.Bundle{}, err
	}
	if current, conflict := base(disk); conflict {
		return Outcome{}, config.Bundle{}, &ConflictError{Hash: current}
	}
	next, issues, err := build(disk)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			return Outcome{}, config.Bundle{}, err
		}
		return Outcome{}, config.Bundle{}, &InvalidError{Issues: []config.Issue{{Severity: config.SeverityError, Path: "yaml", Message: err.Error()}}}
	}
	cfg, parsed := config.ParseBundle(next)
	issues = append(issues, parsed...)
	if cfg != nil && m.restrict != nil {
		issues = append(issues, m.restrict(cfg)...)
	}
	if hasErrors(issues) {
		return Outcome{}, config.Bundle{}, &InvalidError{Issues: issues}
	}
	warnings := append(issues, Warnings(m.cfg, cfg)...)
	if !force {
		var needs []config.Issue
		for _, w := range warnings {
			if blocking[w.Code] {
				needs = append(needs, w)
			}
		}
		if len(needs) > 0 {
			return Outcome{}, config.Bundle{}, &NeedsAckError{Issues: warnings}
		}
	}

	hash := next.Hash()
	fileHash := ""
	if content, ok := next.Projects[project]; ok && project != "" {
		fileHash = config.Hash(content)
	}
	if hash == m.appliedHash && hash == disk.Hash() {
		return Outcome{Hash: hash, FileHash: fileHash, Issues: warnings}, next, nil // nothing changes: no new version
	}
	applies, err := m.prepare(cfg)
	if err != nil {
		return Outcome{}, config.Bundle{}, err
	}
	if err := m.loc.Write(disk, next); err != nil {
		return Outcome{}, config.Bundle{}, err
	}
	for _, apply := range applies {
		apply()
	}
	m.cfg, m.applied, m.appliedHash, m.fileErr, m.rejected, m.awaitingAck = cfg, next, hash, "", "", false

	id, err := m.store.AddConfigVersion(context.Background(), store.ConfigVersion{
		At: m.now(), Hash: hash, Source: meta.Source, Actor: meta.Actor, Comment: meta.Comment, Content: next.Encode(),
	})
	if err != nil {
		m.log.Error("could not record the configuration version", "err", err)
	}
	m.log.Info("configuration applied", "source", meta.Source, "hash", hash[:12], "apps", len(cfg.Apps), "jobs", len(cfg.Jobs), "projects", len(next.Projects))
	return Outcome{Hash: hash, Version: id, FileHash: fileHash, Issues: warnings}, next, nil
}

// prepare asks every applier first: a change is applied to all of them or to none.
func (m *Manager) prepare(next *config.Config) ([]func(), error) {
	applies := make([]func(), 0, len(m.appliers))
	for _, a := range m.appliers {
		apply, err := a.Prepare(m.cfg, next)
		if err != nil {
			return nil, err
		}
		applies = append(applies, apply)
	}
	return applies, nil
}

// Watch applies edits made to the files by hand. An invalid edit is reported and ignored: the agent keeps running
// the last good configuration until the files are valid again. It returns when ctx ends.
func (m *Manager) Watch(ctx context.Context, every time.Duration) {
	t := time.NewTicker(every)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			m.checkFile()
		}
	}
}

func (m *Manager) checkFile() {
	m.mu.Lock()
	defer m.mu.Unlock()
	disk, err := m.loc.Read()
	if err != nil {
		m.fileErr = err.Error()
		return
	}
	hash := disk.Hash()
	if hash == m.appliedHash {
		m.fileErr, m.rejected, m.awaitingAck = "", "", false
		return
	}
	acked := m.acknowledged(hash)
	if hash == m.rejected && !(m.awaitingAck && acked) {
		return
	}
	cfg, issues := config.ParseBundle(disk)
	if cfg == nil {
		m.fileErr, m.rejected, m.awaitingAck = errorText(issues), hash, false
		m.log.Error("the apps file on disk is invalid: keeping the running configuration", "problems", m.fileErr)
		return
	}
	// A hand edit meets the same guard as the API: what the UI refuses without an acknowledgement (a dropped app, a
	// changed proxy) is refused here too, until the operator fixes the file or acknowledges this exact version.
	warnings := Warnings(m.cfg, cfg)
	if needs := blockingWarnings(warnings); len(needs) > 0 && !acked {
		what := "its SHA-256"
		if len(disk.Projects) > 0 || len(m.applied.Projects) > 0 {
			what = "the SHA-256 of the whole configuration"
		}
		m.fileErr = fmt.Sprintf("the file on disk was not applied: %s. Fix the file or, if that is what you want, write %s (%s) to %s", ackText(needs), what, hash, m.markerPath())
		m.rejected, m.awaitingAck = hash, true
		m.log.Error("the apps file on disk needs an acknowledgement: keeping the running configuration", "problems", m.fileErr)
		return
	}
	applies, err := m.prepare(cfg)
	if err != nil {
		var busy *BusyError
		if errors.As(err, &busy) {
			m.log.Warn("a change to the apps file waits until it can be applied", "reason", busy.Reason)
		} else {
			m.fileErr, m.rejected, m.awaitingAck = err.Error(), hash, false
			m.log.Error("the apps file on disk cannot be applied: keeping the running configuration", "err", err)
		}
		return
	}
	for _, w := range warnings {
		m.log.Warn("configuration change", "detail", w.Message)
	}
	for _, apply := range applies {
		apply()
	}
	m.cfg, m.applied, m.appliedHash, m.fileErr, m.rejected, m.awaitingAck = cfg, disk, hash, "", "", false
	if acked {
		m.consumeMarker()
	}
	if _, err := m.store.AddConfigVersion(context.Background(), store.ConfigVersion{At: m.now(), Hash: hash, Source: store.SourceFile, Content: disk.Encode()}); err != nil {
		m.log.Error("could not record the configuration version", "err", err)
	}
	m.log.Info("configuration applied", "source", store.SourceFile, "hash", hash[:12], "apps", len(cfg.Apps), "jobs", len(cfg.Jobs), "projects", len(disk.Projects))
}

// Warnings lists what a change from old to next does that deserves a second look.
func Warnings(old, next *config.Config) []config.Issue {
	var out []config.Issue
	for _, a := range old.Apps {
		if _, ok := next.App(a.Name); !ok {
			out = append(out, config.Issue{
				Severity: config.SeverityWarning, Path: "apps[" + a.Name + "]", Code: CodeAppRemoved,
				Message: fmt.Sprintf("app %s is removed: its container keeps running, but Keelson no longer deploys, monitors or routes it", a.Name),
			})
		}
	}
	for _, j := range old.Jobs {
		if _, ok := next.Job(j.Name); !ok {
			out = append(out, config.Issue{
				Severity: config.SeverityWarning, Path: "jobs[" + j.Name + "]", Code: CodeJobRemoved,
				Message: fmt.Sprintf("job %s is removed: it stops running (its history is kept)", j.Name),
			})
		}
	}
	for _, a := range old.PreviewApps() {
		if _, ok := next.Previews(a.Name); !ok {
			out = append(out, config.Issue{
				Severity: config.SeverityWarning, Path: "apps[" + a.Name + "].previews", Code: CodePreviewsRemoved,
				Message: fmt.Sprintf("the previews template of %s is removed: its live preview environments (containers, routes, images) are removed within a minute", a.Name),
			})
		}
	}
	if !reflect.DeepEqual(old.Proxy, next.Proxy) {
		out = append(out, config.Issue{
			Severity: config.SeverityWarning, Path: "proxy", Code: CodeProxyChanged,
			Message: "the proxy section changed: every route is pushed to the new proxy, so make sure it is reachable and can serve your apps",
		})
	}
	return out
}

// Deprecations picks the deprecation warnings out of the issues of a parse.
func Deprecations(issues []config.Issue) []config.Issue {
	var out []config.Issue
	for _, is := range issues {
		if is.Code == config.CodeDeprecated {
			out = append(out, is)
		}
	}
	return out
}

func hasErrors(issues []config.Issue) bool {
	for _, is := range issues {
		if is.Severity == config.SeverityError {
			return true
		}
	}
	return false
}

func errorText(issues []config.Issue) string {
	var parts []string
	for _, is := range issues {
		if is.Severity != config.SeverityError {
			continue
		}
		where := is.File
		if is.Line > 0 {
			if where != "" {
				where += " "
			}
			where += fmt.Sprintf("line %d", is.Line)
		}
		if where != "" {
			parts = append(parts, where+": "+is.Message)
		} else {
			parts = append(parts, is.Message)
		}
	}
	return strings.Join(parts, "; ")
}
