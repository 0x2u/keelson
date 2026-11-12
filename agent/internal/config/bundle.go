package config

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"reflect"
	"sort"
	"strings"

	"gopkg.in/yaml.v3"
)

// A configuration is the apps file, and optionally one file per project next to it (projects.d/<project>.yaml). The
// two forms are one state: they are validated together, hashed together, versioned together and applied together.

const (
	// ProjectsDirName is the directory of project files, next to the apps file, unless the operator names another.
	ProjectsDirName = "projects.d"
	// ProjectFileExt ends the name of a project file.
	ProjectFileExt = ".yaml"

	// defaultMainName names the apps file in issues when the bundle does not say.
	defaultMainName = "apps.yaml"
	// bundleMagic starts the text a version holds when the configuration has project files.
	bundleMagic = `{"keelson_bundle":`
)

// projectSections are the only top-level keys of a project file. Everything else (the proxy, the registries, the
// notifications, the managed PostgreSQL) is the server's and stays in the apps file.
var projectSections = map[string]bool{"apps": true, "jobs": true, "databases": true}

// projectFile is what a project file holds.
type projectFile struct {
	Apps      []App      `yaml:"apps"`
	Databases []Database `yaml:"databases"`
	Jobs      []Job      `yaml:"jobs"`
}

// Bundle is the text of a whole configuration: the apps file and the project files.
type Bundle struct {
	// MainName names the apps file in issues when the configuration has project files; default "apps.yaml".
	MainName string
	// Main is the apps file.
	Main []byte
	// Projects are the project files by project name (the file name without ".yaml").
	Projects map[string][]byte
	// Strays are files of the projects directory that look like project files but are not named like them (a ".yml"):
	// they are never read, and make the configuration invalid so they are not mistaken for applied.
	Strays []string
}

// ProjectFileName is how issues name the file of a project.
func ProjectFileName(project string) string { return ProjectsDirName + "/" + project + ProjectFileExt }

// ProjectNames lists the project files, sorted.
func (b Bundle) ProjectNames() []string {
	names := make([]string, 0, len(b.Projects))
	for n := range b.Projects {
		names = append(names, n)
	}
	sort.Strings(names)
	return names
}

// Clone copies the bundle, so one copy can be edited while the other stays what is in force.
func (b Bundle) Clone() Bundle {
	c := Bundle{MainName: b.MainName, Main: bytes.Clone(b.Main), Strays: append([]string(nil), b.Strays...)}
	if len(b.Projects) > 0 {
		c.Projects = make(map[string][]byte, len(b.Projects))
		for n, content := range b.Projects {
			c.Projects[n] = bytes.Clone(content)
		}
	}
	return c
}

// Content returns the document of a project, or of the apps file for "".
func (b Bundle) Content(project string) []byte {
	if project == "" {
		return b.Main
	}
	return b.Projects[project]
}

// SetContent replaces the document of a project (creating its file), or the apps file for "".
func (b *Bundle) SetContent(project string, content []byte) {
	if project == "" {
		b.Main = content
		return
	}
	if b.Projects == nil {
		b.Projects = map[string][]byte{}
	}
	b.Projects[project] = content
}

// Hash identifies the configuration. Without project files it is the hash of the apps file, so a configuration that
// never used them keeps the hash it always had; with them it covers every file and the name of each.
func (b Bundle) Hash() string {
	if len(b.Projects) == 0 {
		return Hash(b.Main)
	}
	h := sha256.New()
	fmt.Fprintf(h, "keelson-bundle v1\nmain %s\n", Hash(b.Main))
	for _, n := range b.ProjectNames() {
		fmt.Fprintf(h, "project %s %s\n", n, Hash(b.Projects[n]))
	}
	return hex.EncodeToString(h.Sum(nil))
}

// Equal says whether two bundles hold the same files.
func (b Bundle) Equal(o Bundle) bool {
	if !bytes.Equal(b.Main, o.Main) || len(b.Projects) != len(o.Projects) {
		return false
	}
	for n, content := range b.Projects {
		other, ok := o.Projects[n]
		if !ok || !bytes.Equal(content, other) {
			return false
		}
	}
	return true
}

// bundleText is the form of a bundle with project files in a recorded version.
type bundleText struct {
	Version  int               `json:"keelson_bundle"`
	Main     string            `json:"main"`
	Projects map[string]string `json:"projects"`
}

// Encode is the text a version records: the apps file itself when there are no project files, so the versions of a
// configuration that never used them are what they always were; otherwise one JSON document holding every file.
func (b Bundle) Encode() string {
	if len(b.Projects) == 0 {
		return string(b.Main)
	}
	t := bundleText{Version: 1, Main: string(b.Main), Projects: make(map[string]string, len(b.Projects))}
	for n, content := range b.Projects {
		t.Projects[n] = string(content)
	}
	out, _ := json.Marshal(t) // strings and a map of strings: cannot fail
	return string(out)
}

// DecodeBundle reads what Encode wrote (or a plain apps file).
func DecodeBundle(content string) (Bundle, error) {
	if !strings.HasPrefix(content, bundleMagic) {
		return Bundle{Main: []byte(content)}, nil
	}
	var t bundleText
	dec := json.NewDecoder(strings.NewReader(content))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&t); err != nil || t.Version != 1 {
		return Bundle{}, errors.New("the recorded configuration is not a bundle this agent knows")
	}
	b := Bundle{Main: []byte(t.Main)}
	if len(t.Projects) > 0 {
		b.Projects = make(map[string][]byte, len(t.Projects))
		for n, text := range t.Projects {
			b.Projects[n] = []byte(text)
		}
	}
	return b, nil
}

// Redact hides the secrets of every file, as Redact does for one.
func (b Bundle) Redact() (Bundle, error) {
	out := b.Clone()
	var err error
	if out.Main, err = Redact(b.Main); err != nil {
		return Bundle{}, err
	}
	for n, content := range b.Projects {
		if out.Projects[n], err = Redact(content); err != nil {
			return Bundle{}, fmt.Errorf("%s: %w", ProjectFileName(n), err)
		}
	}
	return out, nil
}

// Model is the bundle as plain data, the way Model gives one document: the apps file's model, with the apps, jobs and
// databases of every project file added to its lists, and the project of each entry of a project file filled in. The
// legacy spellings are upgraded first, in memory (the file is not touched), so the model is always the current schema:
// what the dashboard reads has one shape whatever the files say. Redact first.
func (b Bundle) Model() (map[string]any, error) {
	docs, issues := b.parseDocs()
	if len(issues) > 0 {
		return nil, errors.New(issues[0].Message)
	}
	upgradeBundle(docs)
	var m map[string]any
	for i, d := range docs {
		pm := map[string]any{}
		if d.root.Kind != 0 {
			if err := d.root.Decode(&pm); err != nil {
				if d.project != "" {
					return nil, fmt.Errorf("%s: %w", ProjectFileName(d.project), err)
				}
				return nil, err
			}
		}
		if pm == nil {
			pm = map[string]any{}
		}
		if i == 0 {
			m = pm
			continue
		}
		for _, section := range []string{"apps", "jobs", "databases"} {
			items, _ := pm[section].([]any)
			for _, item := range items {
				if entry, ok := item.(map[string]any); ok {
					if p, _ := entry["project"].(string); p == "" {
						entry["project"] = d.project
					}
				}
			}
			if len(items) > 0 {
				existing, _ := m[section].([]any)
				m[section] = append(existing, items...)
			}
		}
	}
	return m, nil
}

// Counts says how many apps, jobs, databases and previews a document lists, without validating it. Zero for a
// document that does not parse. The previews are those of its apps (and the entries of a legacy top-level section).
func Counts(content []byte) (apps, jobs, databases, previews int) {
	root, err := parseNode(content)
	if err != nil {
		return 0, 0, 0, 0
	}
	top := topMapping(root)
	if top == nil {
		return 0, 0, 0, 0
	}
	count := func(name string) int { return len(items(section(top, name))) }
	for _, app := range items(section(top, "apps")) {
		if value(app, "previews") != nil {
			previews++
		}
	}
	return count("apps"), count("jobs"), count("databases"), previews + count("previews")
}

// parsedDoc is one document of a bundle while it is read.
type parsedDoc struct {
	project string // "" for the apps file
	file    string // what issues call it: empty when the bundle has no project file
	root    yaml.Node
	cfg     Config
}

func (d *parsedDoc) stamp(is Issue) Issue {
	is.File, is.Project = d.file, d.project
	return is
}

// parseDocs reads the YAML of every document of a bundle. The issues are syntax errors (and an empty apps file).
func (b Bundle) parseDocs() ([]*parsedDoc, []Issue) {
	multi := len(b.Projects) > 0
	mainFile := ""
	if multi {
		if mainFile = b.MainName; mainFile == "" {
			mainFile = defaultMainName
		}
	}
	docs := []*parsedDoc{{file: mainFile}}
	for _, n := range b.ProjectNames() {
		docs = append(docs, &parsedDoc{project: n, file: ProjectFileName(n)})
	}
	var issues []Issue
	for _, d := range docs {
		content := b.Content(d.project)
		if err := yaml.Unmarshal(content, &d.root); err != nil {
			issues = append(issues, d.stamp(yamlIssue(err.Error())))
			continue
		}
	}
	return docs, issues
}

// ParseBundle validates a configuration and returns it, or nil when there is any error, together with every issue
// found (the errors, then the warnings, such as the deprecation of a legacy key: a warning never stops a configuration
// from loading). The files are read in this order: the YAML of each; the upgrade of the legacy spellings, in memory
// (upgradeBundle: it never re-encodes a document, and reports each edit as a `deprecated` warning with the line the key
// had in the file); the check of the keys against the schema (an unknown key is an error in the file that has it); the
// decoding; the merge of the entries; and the checks that need the whole, once on the merged configuration: names are
// unique across the files, jobs and release steps find the apps and databases wherever they are written, and so on. The
// merged lists hold the apps file's entries first, then each project file's in project order. A project file's entries
// without a project take the file's project.
func ParseBundle(b Bundle) (*Config, []Issue) {
	cfg, issues, _ := parseBundle(b)
	return cfg, issues
}

// parseBundle is ParseBundle that also returns the edits of the upgrade.
func parseBundle(b Bundle) (*Config, []Issue, []Edit) {
	multi := len(b.Projects) > 0
	docs, issues := b.parseDocs()
	if len(issues) == 0 && docs[0].root.Kind == 0 {
		issues = append(issues, docs[0].stamp(Issue{Severity: SeverityError, Path: "yaml", Message: "the document is empty"}))
	}
	if len(issues) > 0 {
		return nil, issues, nil
	}

	edits, upgradeErrs := upgradeBundle(docs)
	issues = append(issues, upgradeErrs...)
	syntax := false
	for _, d := range docs {
		if d.root.Kind == 0 {
			continue // a project file with nothing in it holds nothing
		}
		var found []Issue
		if d.project == "" {
			d.cfg, found, syntax = decodeMain(d, syntax)
		} else {
			d.cfg, found, syntax = decodeProject(d, syntax)
		}
		issues = append(issues, found...)
	}
	if syntax {
		return nil, issues, edits
	}
	for _, s := range b.Strays {
		issues = append(issues, Issue{Severity: SeverityError, Path: "yaml", File: ProjectsDirName + "/" + s, Message: "a project file is named <project>" + ProjectFileExt + ": rename it (a file of another name is never read)"})
	}

	// A project file's entries belong to its project.
	for _, d := range docs[1:] {
		issues = append(issues, d.claim()...)
	}

	merged := docs[0].cfg
	for _, d := range docs[1:] {
		merged.Apps = append(merged.Apps, d.cfg.Apps...)
		merged.Jobs = append(merged.Jobs, d.cfg.Jobs...)
		merged.Databases = append(merged.Databases, d.cfg.Databases...)
	}

	pl := &placer{docs: docs, multi: multi, dups: map[string]int{}}
	for _, is := range merged.validate() {
		issues = append(issues, pl.place(is))
	}
	failed := false
	for _, is := range issues {
		failed = failed || is.Severity == SeverityError
	}
	for _, e := range edits {
		issues = append(issues, e.issue())
	}
	if failed {
		return nil, issues, edits
	}
	merged.Jobs = append(merged.Jobs, merged.backupJobs()...)
	return &merged, issues, edits
}

// effectiveProject is the project the dashboard files an app under: its label, or its name.
func effectiveProject(a App) string {
	if a.Project != "" {
		return a.Project
	}
	return a.Name
}

// decodeMain reads the apps file. An unknown key must not hide the other problems: what the document says besides it is
// still returned, to be checked with the rest.
func decodeMain(d *parsedDoc, syntax bool) (Config, []Issue, bool) {
	var c Config
	var issues []Issue
	if top := topMapping(&d.root); top != nil {
		for _, is := range unknownKeys(top, reflect.TypeOf(c), "", nil) {
			issues = append(issues, d.stamp(is))
		}
	}
	err := d.root.Decode(&c)
	if err == nil || errors.Is(err, io.EOF) {
		return c, issues, syntax
	}
	var typeErr *yaml.TypeError
	if !errors.As(err, &typeErr) {
		return Config{}, append(issues, d.stamp(yamlIssue(err.Error()))), true
	}
	for _, msg := range typeErr.Errors {
		issues = append(issues, d.stamp(yamlIssue(msg)))
	}
	return c, issues, syntax
}

// decodeProject reads a project file: only apps, jobs and databases may be there.
func decodeProject(d *parsedDoc, syntax bool) (Config, []Issue, bool) {
	var issues []Issue
	if !namePattern.MatchString(d.project) {
		issues = append(issues, d.stamp(Issue{Severity: SeverityError, Path: "yaml", Message: fmt.Sprintf("the file name must be a project name: %s.yaml with a name matching %s", d.project, namePattern)}))
	}
	if top := topMapping(&d.root); top != nil {
		for i := 0; i+1 < len(top.Content); i += 2 {
			k := top.Content[i]
			if projectSections[k.Value] {
				continue
			}
			msg := fmt.Sprintf("%s is not allowed in a project file, which holds only apps, jobs and databases", k.Value)
			switch k.Value {
			case "proxy", "registries", "notifications", "postgres", "managed_postgres", "build_limits":
				msg = fmt.Sprintf("%s is server-wide: it belongs in the apps file, not in a project file", k.Value)
			}
			issues = append(issues, d.stamp(Issue{Severity: SeverityError, Path: k.Value, Line: k.Line, Message: msg}))
		}
		for _, is := range unknownKeys(top, reflect.TypeOf(projectFile{}), "", func(key string) bool { return !projectSections[key] }) {
			issues = append(issues, d.stamp(is))
		}
	}
	toConfig := func(p projectFile) Config {
		return Config{Apps: p.Apps, Jobs: p.Jobs, Databases: p.Databases}
	}
	var p projectFile
	err := d.root.Decode(&p)
	if err == nil || errors.Is(err, io.EOF) {
		return toConfig(p), issues, syntax
	}
	var typeErr *yaml.TypeError
	if !errors.As(err, &typeErr) {
		return Config{}, append(issues, d.stamp(yamlIssue(err.Error()))), true
	}
	for _, msg := range typeErr.Errors {
		issues = append(issues, d.stamp(yamlIssue(msg)))
	}
	return toConfig(p), issues, syntax
}

// claim gives the entries of a project file their project, and reports an entry that names another one.
func (d *parsedDoc) claim() []Issue {
	var out []Issue
	check := func(kind, section, name string, project *string) {
		switch *project {
		case "":
			*project = d.project
		case d.project:
		default:
			path := section + "[" + name + "]"
			out = append(out, d.stamp(Issue{Severity: SeverityError, Path: path, Line: locate(&d.root, path),
				Message: fmt.Sprintf("%s %q: project is %q but this file holds project %q (leave project out, or move the entry to its own file)", kind, name, *project, d.project)}))
		}
	}
	for i := range d.cfg.Apps {
		check("app", "apps", d.cfg.Apps[i].Name, &d.cfg.Apps[i].Project)
	}
	for i := range d.cfg.Jobs {
		check("job", "jobs", d.cfg.Jobs[i].Name, &d.cfg.Jobs[i].Project)
	}
	for i := range d.cfg.Databases {
		check("database", "databases", d.cfg.Databases[i].Name, &d.cfg.Databases[i].Project)
	}
	return out
}

// placer finds the file and line of the issues of the merged configuration.
type placer struct {
	docs  []*parsedDoc
	multi bool
	dups  map[string]int
}

type spot struct {
	doc  *parsedDoc
	line int
}

func (p *placer) place(is Issue) Issue {
	// Only the entity sections can be in a project file.
	section, _, indexed := strings.Cut(is.Path, "[")
	searched := p.docs[:1]
	if indexed && projectSections[section] {
		searched = p.docs
	}
	var spots []spot
	for _, d := range searched {
		if lines, exact := locateAll(&d.root, is.Path); exact {
			for _, l := range lines {
				spots = append(spots, spot{d, l})
			}
		}
	}
	if len(spots) == 0 {
		main := p.docs[0]
		is.Line = locate(&main.root, is.Path)
		return main.stamp(is)
	}
	pick := 0
	if p.multi && strings.Contains(is.Message, "duplicate") {
		// The validators report the second and later definitions: point at the one that is in the way, and say where the first is.
		pick = min(1+p.dups[is.Path], len(spots)-1)
		p.dups[is.Path]++
		first := spots[0]
		if pick > 0 {
			is.Message = fmt.Sprintf("%s (first defined in %s, line %d)", is.Message, fileLabel(first.doc), first.line)
		}
	}
	is.Line = spots[pick].line
	return spots[pick].doc.stamp(is)
}

func fileLabel(d *parsedDoc) string {
	if d.file == "" {
		return defaultMainName
	}
	return d.file
}
