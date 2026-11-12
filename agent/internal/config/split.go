package config

import (
	"errors"
	"fmt"
	"reflect"
	"sort"
	"strings"

	"gopkg.in/yaml.v3"
)

// equivalent is the check every split passes before it is returned; a variable so that a test can make it fail.
var equivalent = Equivalent

// SplitPlan says what a split moves out of the apps file into the project's file, and what it leaves.
type SplitPlan struct {
	Project   string   `json:"project"`
	File      string   `json:"file"`
	Apps      []string `json:"apps"`
	Jobs      []string `json:"jobs"`
	Databases []string `json:"databases"`
	// Previews are the moved apps that carry a previews template: the template is a key of the app and moves with it.
	Previews []string `json:"previews"`
	// Kept are members the project would claim that stay in the apps file, and why.
	Kept []SplitKept `json:"kept"`
}

// SplitKept is one entry a split leaves where it is.
type SplitKept struct {
	Kind   string `json:"kind"`
	Name   string `json:"name"`
	Reason string `json:"reason"`
}

// Empty says nothing would move.
func (p SplitPlan) Empty() bool {
	return len(p.Apps)+len(p.Jobs)+len(p.Databases)+len(p.Previews) == 0
}

// SplitProject moves what belongs to a project out of the apps file into its own file, and returns the new bundle with
// the plan. The bundle is only returned when the configuration it makes is the one that runs now (see Equivalent): a
// split reorganizes files, it never changes what runs.
//
// What moves: the apps labelled with the project (an app without a label belongs to the project of its name) with their
// previews and their database (keys of the app), the jobs and databases labelled with it, and the unlabelled ones the
// dashboard files under it: jobs whose http.bearer.app or container.app is one of the apps, databases named by one of
// their release `backup:` steps. A database that an app of another project also backs up stays where it is. Entries
// labelled with another project never move. Comments travel with the entries.
func (b Bundle) SplitProject(project string) (Bundle, SplitPlan, error) {
	plan := SplitPlan{Project: project, File: ProjectFileName(project)}
	if !namePattern.MatchString(project) {
		return Bundle{}, plan, fmt.Errorf("project must match %s", namePattern)
	}
	if _, ok := b.Projects[project]; ok {
		return Bundle{}, plan, fmt.Errorf("%s already exists: the project already has its own file", plan.File)
	}
	before, issues := ParseBundle(b)
	if before == nil {
		return Bundle{}, plan, fmt.Errorf("the configuration is invalid, so it cannot be split: %s", firstError(issues))
	}

	apps := map[string]bool{}
	for _, a := range before.Apps {
		if a.Project == project || (a.Project == "" && a.Name == project) {
			apps[a.Name] = true
			plan.Apps = append(plan.Apps, a.Name)
		}
	}
	for _, a := range before.Apps {
		if apps[a.Name] && a.Previews != nil {
			plan.Previews = append(plan.Previews, a.Name)
		}
	}
	moved := map[string]map[string]bool{"apps": apps, "jobs": {}, "databases": {}}
	for _, j := range before.Jobs {
		if j.Managed {
			continue
		}
		bearer := j.HTTP != nil && j.HTTP.Bearer != nil && apps[j.HTTP.Bearer.App]
		container := j.Container != nil && apps[j.Container.App]
		if j.Project == project || (j.Project == "" && (bearer || container)) {
			moved["jobs"][j.Name] = true
			plan.Jobs = append(plan.Jobs, j.Name)
		}
	}
	for _, d := range before.Databases {
		if d.Synthesized() {
			continue // a key of its app: it moves with it
		}
		if d.Project == project {
			moved["databases"][d.Name] = true
			plan.Databases = append(plan.Databases, d.Name)
			continue
		}
		if d.Project != "" {
			continue
		}
		owner := d.Managed && apps[d.App]
		for _, a := range before.Apps {
			if !apps[a.Name] || a.Release == nil {
				continue
			}
			for _, s := range a.Release.Steps {
				if s.Backup == d.Name {
					owner = true
				}
			}
		}
		if !owner {
			continue
		}
		if other := otherUser(before, d.Name, apps); other != "" {
			plan.Kept = append(plan.Kept, SplitKept{Kind: "database", Name: d.Name, Reason: fmt.Sprintf("the app %s of another project also backs it up before a release", other)})
			continue
		}
		moved["databases"][d.Name] = true
		plan.Databases = append(plan.Databases, d.Name)
	}
	if plan.Empty() {
		return Bundle{}, plan, fmt.Errorf("nothing belongs to project %q: no app, job or database is labelled with it, and no app is named after it", project)
	}

	// What the legacy schema keeps elsewhere about a moved app (its entry of the top-level previews, its managed database)
	// first goes into the app, so that it travels with it.
	work := b.Clone()
	for _, name := range plan.Apps {
		if err := work.foldLegacyInto(name, false); err != nil {
			return Bundle{}, plan, err
		}
	}
	mainText, projectText, err := carve(work.Main, project, moved)
	if err != nil {
		return Bundle{}, plan, err
	}
	next := work.Clone()
	next.Main = mainText
	next.SetContent(project, projectText)

	after, issues := ParseBundle(next)
	if after == nil {
		return Bundle{}, plan, fmt.Errorf("the split would leave an invalid configuration: %s", firstError(issues))
	}
	if err := equivalent(before, after, project); err != nil {
		return Bundle{}, plan, fmt.Errorf("the split would change what runs, so nothing was changed: %w", err)
	}
	return next, plan, nil
}

// otherUser names an app outside the moved ones that backs the database up in a release step, "" when there is none.
func otherUser(c *Config, database string, moved map[string]bool) string {
	for _, a := range c.Apps {
		if moved[a.Name] || a.Release == nil {
			continue
		}
		for _, s := range a.Release.Steps {
			if s.Backup == database {
				return a.Name
			}
		}
	}
	return ""
}

func setOf(names []string) map[string]bool {
	out := make(map[string]bool, len(names))
	for _, n := range names {
		out[n] = true
	}
	return out
}

func firstError(issues []Issue) string {
	for _, is := range issues {
		if is.Severity != SeverityError {
			continue
		}
		where := is.File
		if is.Line > 0 {
			where = strings.TrimSpace(fmt.Sprintf("%s line %d", where, is.Line))
		}
		if where != "" {
			return where + ": " + is.Message
		}
		return is.Message
	}
	return "unknown"
}

// carve cuts the named entries out of the apps file's tree and puts them in the tree of a new project file. Entries keep
// the comments around them; a section that moves whole takes its own comment along.
func carve(main []byte, project string, moved map[string]map[string]bool) (mainOut, projectOut []byte, err error) {
	root, top, err := editableRoot(main)
	if err != nil {
		return nil, nil, err
	}
	newTop := &yaml.Node{Kind: yaml.MappingNode, Tag: "!!map"}
	for _, section := range []string{"apps", "jobs", "databases"} {
		field := "name"
		key, seq := mappingEntry(top, section)
		if seq == nil || seq.Kind != yaml.SequenceNode {
			continue
		}
		var kept, taken []*yaml.Node
		for _, item := range seq.Content {
			if _, v := mappingEntry(item, field); v != nil && moved[section][v.Value] {
				taken = append(taken, item)
			} else {
				kept = append(kept, item)
			}
		}
		if len(taken) == 0 {
			continue
		}
		newKey := scalarKey(section)
		newSeq := &yaml.Node{Kind: yaml.SequenceNode, Tag: "!!seq", Content: taken}
		seq.Content = kept
		if len(kept) == 0 {
			newKey.HeadComment, newKey.LineComment = key.HeadComment, key.LineComment
			newSeq.FootComment = seq.FootComment
			removeKey(top, section)
		}
		newTop.Content = append(newTop.Content, newKey, newSeq)
	}
	if len(newTop.Content) == 0 {
		return nil, nil, errors.New("nothing to move")
	}
	if mainOut, err = encodeNode(root); err != nil {
		return nil, nil, err
	}
	projectRoot := &yaml.Node{Kind: yaml.DocumentNode, Content: []*yaml.Node{newTop}}
	if projectOut, err = encodeNode(projectRoot); err != nil {
		return nil, nil, err
	}
	return mainOut, projectOut, nil
}

// Equivalent says whether two configurations run the same thing: the same server-wide sections, and the same apps (with
// their previews, database and source), jobs and databases by name, whatever file each is written in and in what order.
// The one thing allowed to differ is the project label of the entries of the project that was split: an unlabelled
// entry of the project may now carry its file's project, and the dashboard files an app without a label under its name,
// which is not a difference. The databases the agent created for apps carry their app's project, whatever label they
// had.
func Equivalent(before, after *Config, project string) error {
	if !reflect.DeepEqual(before.Registries, after.Registries) {
		return errors.New("the registries differ")
	}
	if !reflect.DeepEqual(before.Proxy, after.Proxy) {
		return errors.New("the proxy differs")
	}
	if !reflect.DeepEqual(before.Notifications, after.Notifications) {
		return errors.New("the notifications differ")
	}
	if !reflect.DeepEqual(before.ManagedPostgres, after.ManagedPostgres) {
		return errors.New("the managed PostgreSQL settings differ")
	}
	if !reflect.DeepEqual(before.BuildLimits, after.BuildLimits) {
		return errors.New("the build limits differ")
	}
	label := func(p string) string {
		if p == project {
			return ""
		}
		return p
	}
	if err := sameEntries("app", before.Apps, after.Apps,
		func(a App) string { return a.Name },
		func(a App) App { a.Project = effectiveProject(a); return a }); err != nil {
		return err
	}
	if err := sameEntries("job", before.Jobs, after.Jobs,
		func(j Job) string { return j.Name },
		func(j Job) Job { j.Project = label(j.Project); return j }); err != nil {
		return err
	}
	if err := sameEntries("database", before.Databases, after.Databases,
		func(d Database) string { return d.Name },
		func(d Database) Database {
			if d.Managed {
				d.Project = ""
			} else {
				d.Project = label(d.Project)
			}
			return d
		}); err != nil {
		return err
	}
	return nil
}

func sameEntries[T any](kind string, before, after []T, name func(T) string, norm func(T) T) error {
	index := func(list []T) map[string]T {
		m := make(map[string]T, len(list))
		for _, e := range list {
			m[name(e)] = norm(e)
		}
		return m
	}
	b, a := index(before), index(after)
	var names []string
	for n := range b {
		names = append(names, n)
	}
	sort.Strings(names)
	for _, n := range names {
		other, ok := a[n]
		switch {
		case !ok:
			return fmt.Errorf("%s %q is gone", kind, n)
		case !reflect.DeepEqual(b[n], other):
			return fmt.Errorf("%s %q differs", kind, n)
		}
	}
	for n := range a {
		if _, ok := b[n]; !ok {
			return fmt.Errorf("%s %q is new", kind, n)
		}
	}
	if len(before) != len(after) {
		return fmt.Errorf("the number of %s entries differs (%d, then %d)", kind, len(before), len(after))
	}
	return nil
}
