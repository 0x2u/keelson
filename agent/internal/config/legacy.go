package config

// The upgrade of the legacy schema. Everything here exists to be deleted: files written before schema v1 keep loading,
// with a `deprecated` warning for every key that has a new spelling, and `keelson-agent config migrate` writes the new
// spelling to disk. Both go through the same code: upgradeBundle edits the YAML trees of the documents in place (it never
// re-encodes a document: comments, quoting and anchors stay as written), and reports each edit it made. The loader
// keeps the edited trees in memory and turns the edits into warnings; the migration encodes the trees it edited.
//
// Removing the compatibility is deleting the files named legacy*.go and the call of upgradeBundle in ParseBundle.

import (
	"errors"
	"fmt"
	"strconv"

	"gopkg.in/yaml.v3"
)

// CodeDeprecated is the code of the warning for a key that has a new spelling.
const CodeDeprecated = "deprecated"

// Edit is one change the upgrade makes to a document: the old key (or shape) it replaces and what it becomes.
type Edit struct {
	// File is the document ("projects.d/<project>.yaml" or the apps file's name) when the configuration has project
	// files; empty for a configuration made of the apps file alone. Line is in the document as it was written.
	File    string `json:"file,omitempty"`
	Project string `json:"project,omitempty"`
	Line    int    `json:"line,omitempty"`
	// Path says where: "apps[web].ports".
	Path string `json:"path"`
	From string `json:"from"`
	To   string `json:"to"`
	// Message is the warning text.
	Message string `json:"message"`
	// Leftover marks what the upgrade cannot do by itself: the key stays and keeps being read as it is.
	Leftover bool `json:"leftover,omitempty"`
}

// issue is the edit as the warning the loader reports.
func (e Edit) issue() Issue {
	return Issue{Severity: SeverityWarning, Code: CodeDeprecated, Path: e.Path, Line: e.Line, File: e.File, Project: e.Project, Message: e.Message}
}

// upgrader carries the documents of a bundle through the upgrade.
type upgrader struct {
	docs  []*parsedDoc
	edits []Edit
	errs  []Issue
	// only, when set, restricts the moves of previews and managed databases to the app of that name; noManaged leaves the
	// managed databases alone. They serve the save of one app (see Bundle.foldLegacyInto).
	only      string
	noManaged bool
	// touched are the documents a move changed.
	touched map[*parsedDoc]bool
}

func (u *upgrader) touch(d *parsedDoc) {
	if u.touched == nil {
		u.touched = map[*parsedDoc]bool{}
	}
	u.touched[d] = true
}

// upgradeBundle upgrades every document of a bundle in place. It returns the edits it made, and the errors it found in
// what it could not make sense of (a key it would have moved but whose target is taken).
func upgradeBundle(docs []*parsedDoc) ([]Edit, []Issue) {
	u := &upgrader{docs: docs}
	u.run()
	return u.edits, u.errs
}

func (u *upgrader) run() {
	for _, d := range u.docs {
		top := topMapping(&d.root)
		if top == nil {
			continue
		}
		u.server(d, top)
		for _, app := range items(section(top, "apps")) {
			u.app(d, app)
		}
		for _, job := range items(section(top, "jobs")) {
			u.job(d, job, "jobs["+text(job, "name")+"]")
		}
		for _, db := range items(section(top, "databases")) {
			u.database(d, db, "databases["+text(db, "name")+"]")
		}
	}
	u.moves()
}

// moves moves what is about an app into the app: previews and managed databases.
func (u *upgrader) moves() {
	u.previews()
	if !u.noManaged {
		u.foldManaged()
	}
}

// edit records an edit.
func (u *upgrader) edit(d *parsedDoc, line int, path, from, to, msg string) {
	u.touch(d)
	u.edits = append(u.edits, Edit{File: d.file, Project: d.project, Line: line, Path: path, From: from, To: to, Message: msg})
}

// leftover records what the upgrade leaves as it is.
func (u *upgrader) leftover(d *parsedDoc, line int, path, from, to, msg string) {
	u.edits = append(u.edits, Edit{File: d.file, Project: d.project, Line: line, Path: path, From: from, To: to, Message: msg, Leftover: true})
}

// fail records an error.
func (u *upgrader) fail(d *parsedDoc, line int, path, msg string) {
	u.errs = append(u.errs, d.stamp(Issue{Severity: SeverityError, Path: path, Line: line, Message: msg}))
}

// rename gives a key its new name in place.
func (u *upgrader) rename(d *parsedDoc, m *yaml.Node, path, from, to string) bool {
	k, _, i := entry(m, from)
	if i < 0 {
		return false
	}
	if k2, _, _ := entry(m, to); k2 != nil {
		u.fail(d, k.Line, path, fmt.Sprintf("%s and %s are both set: %s is the old name of %s, leave it out", from, to, from, to))
		dropEntry(m, from)
		return false
	}
	line := k.Line
	k.Value = to
	u.edit(d, line, joinPath(path, from), from, to, fmt.Sprintf("%s is deprecated: use %s", from, to))
	return true
}

// dropZero removes a key whose 0 (or empty value) meant "the default": it is now read as absent (R1).
func (u *upgrader) dropZero(d *parsedDoc, m *yaml.Node, path, key string) {
	k, v, i := entry(m, key)
	if i < 0 || !zeroScalar(v) {
		return
	}
	line := k.Line
	dropEntry(m, key)
	u.edit(d, line, joinPath(path, key), key+": "+v.Value, "(left out)", fmt.Sprintf("%s: %s is deprecated: 0 meant the default, leave the key out", key, shown(v)))
}

func joinPath(path, key string) string {
	if path == "" {
		return key
	}
	return path + "." + key
}

func shown(v *yaml.Node) string {
	if v.Value == "" {
		return `""`
	}
	return v.Value
}

// server upgrades the sections of the server: managed_postgres (was postgres) and notifications.
func (u *upgrader) server(d *parsedDoc, top *yaml.Node) {
	if d.project == "" {
		u.rename(d, top, "", "postgres", "managed_postgres")
	}
	if mp := value(top, "managed_postgres"); isMapping(mp) {
		for _, k := range []string{"version", "port", "memory"} {
			u.dropZero(d, mp, "managed_postgres", k)
		}
	}
	if n := value(top, "notifications"); isMapping(n) {
		if k, v, i := entry(n, "events"); i >= 0 && deref(v).Kind == yaml.SequenceNode && len(deref(v).Content) == 0 {
			line := k.Line
			dropEntry(n, "events")
			u.edit(d, line, "notifications.events", "events: []", "(left out)", "events: [] is deprecated: it sent the default events, so it is read as absent (leave the key out)")
		}
		for _, k := range []string{"disk_alert_percent", "memory_alert_percent"} {
			u.dropZero(d, n, "notifications", k)
		}
		if hb := value(n, "heartbeat"); isMapping(hb) {
			u.dropZero(d, hb, "notifications.heartbeat", "every")
		}
	}
}

func isMapping(n *yaml.Node) bool { n = deref(n); return n != nil && n.Kind == yaml.MappingNode }

// app upgrades one app.
func (u *upgrader) app(d *parsedDoc, app *yaml.Node) {
	if !isMapping(app) {
		return
	}
	p := "apps[" + text(app, "name") + "]"
	u.rename(d, app, p, "ports", "publish")
	u.hostPorts(d, app, p)
	u.stopTimeout(d, app, p)
	for _, k := range []string{"health_timeout", "stable_after", "keep_images"} {
		u.dropZero(d, app, p, k)
	}
	if l := value(app, "log"); isMapping(l) {
		u.dropZero(d, l, p+".log", "max_file")
	}
	if b := value(app, "build"); isMapping(b) {
		for _, k := range []string{"timeout", "cpus", "memory", "max_source"} {
			u.dropZero(d, b, p+".build", k)
		}
		u.buildOnly(d, app, b, p)
	}
	if rel := value(app, "release"); isMapping(rel) {
		for _, step := range items(value(rel, "steps")) {
			u.step(d, step, p+".release.steps["+text(step, "name")+"]")
		}
	}
	if pv := value(app, "previews"); isMapping(pv) {
		u.previewsBlock(d, pv, p+".previews")
	}
	if db := value(app, "database"); isMapping(db) {
		u.backups(d, value(db, "backups"), p+".database.backups")
	}
}

// hostPorts folds host_ports and port_env into `port: {host, env}`.
func (u *upgrader) hostPorts(d *parsedDoc, app *yaml.Node, p string) {
	hk, hv, hi := entry(app, "host_ports")
	ek, ev, ei := entry(app, "port_env")
	pk, _, pi := entry(app, "port")
	switch {
	case hi < 0 && ei < 0:
		return
	case hi < 0:
		u.fail(d, ek.Line, p, "port_env is only used with host_ports")
		dropEntry(app, "port_env")
		return
	case pi >= 0:
		u.fail(d, pk.Line, p, "port and host_ports are alternatives: use port for a container with its own network, host_ports for network: host")
		dropEntry(app, "host_ports")
		dropEntry(app, "port_env")
		return
	}
	spec := newMapping()
	spec.Style = deref(app).Style & yaml.FlowStyle
	appendEntry(spec, strNode("host"), hv)
	u.edit(d, hk.Line, p+".host_ports", "host_ports", "port.host", "host_ports is deprecated: use port: {host: [...]}")
	if ei >= 0 {
		appendEntry(spec, strNode("env"), ev)
		u.edit(d, ek.Line, p+".port_env", "port_env", "port.env", "port_env is deprecated: use port: {env: ...}")
	}
	// The mapping takes the place of host_ports, under the key `port`.
	hk.Value = "port"
	deref(app).Content[hi+1] = spec
	dropEntry(app, "port_env")
}

// stopTimeout turns a number of seconds into a duration.
func (u *upgrader) stopTimeout(d *parsedDoc, app *yaml.Node, p string) {
	k, v, i := entry(app, "stop_timeout")
	if i < 0 {
		return
	}
	v = deref(v)
	if v.Kind != yaml.ScalarNode || v.Tag != "!!int" {
		return
	}
	if zeroScalar(v) {
		u.dropZero(d, app, p, "stop_timeout")
		return
	}
	line, from := k.Line, v.Value
	v.Value, v.Tag, v.Style = from+"s", "!!str", 0
	u.edit(d, line, p+".stop_timeout", "stop_timeout: "+from, "stop_timeout: "+from+"s", fmt.Sprintf("stop_timeout: %s is deprecated: a number of seconds is now a duration, %ss", from, from))
}

// step upgrades one release step: run is host, command and image are the container.
func (u *upgrader) step(d *parsedDoc, step *yaml.Node, p string) {
	if !isMapping(step) {
		return
	}
	u.rename(d, step, p, "run", "host")
	if ck, cv, ci := entry(step, "command"); ci >= 0 {
		if k2, _, _ := entry(step, "container"); k2 != nil {
			u.fail(d, ck.Line, p, "command and container are both set: command is the old name of container.command, leave it out")
			dropEntry(step, "command")
		} else {
			c := newMapping()
			c.Style = deref(step).Style & yaml.FlowStyle
			appendEntry(c, strNode("command"), cv)
			u.edit(d, ck.Line, p+".command", "command", "container.command", "command is deprecated: use container: {command: [...]}")
			if ik, iv, ii := entry(step, "image"); ii >= 0 {
				appendEntry(c, strNode("image"), iv)
				u.edit(d, ik.Line, p+".image", "image", "container.image", "image is deprecated: use container: {image: ...}")
				dropEntry(step, "image")
			}
			ck.Value = "container"
			ci, _ = indexOf(step, "container")
			deref(step).Content[ci+1] = c
		}
	}
	u.dropZero(d, step, p, "timeout")
}

// indexOf is the index of a key in Content, -1 when absent.
func indexOf(m *yaml.Node, key string) (int, bool) {
	_, _, i := entry(m, key)
	return i, i >= 0
}

// job upgrades one job: run is host.
func (u *upgrader) job(d *parsedDoc, job *yaml.Node, p string) {
	if !isMapping(job) {
		return
	}
	u.rename(d, job, p, "run", "host")
	for _, k := range []string{"timeout", "alert_after"} {
		u.dropZero(d, job, p, k)
	}
}

// database upgrades one database: backup is backups.
func (u *upgrader) database(d *parsedDoc, db *yaml.Node, p string) {
	if !isMapping(db) {
		return
	}
	if u.rename(d, db, p, "backup", "backups") || value(db, "backups") != nil {
		u.backups(d, value(db, "backups"), p+".backups")
	}
}

// backups upgrades a backups section: destination is a list of one destinations.
func (u *upgrader) backups(d *parsedDoc, b *yaml.Node, p string) {
	if !isMapping(b) {
		return
	}
	for _, k := range []string{"timeout", "alert_after", "keep", "keep_pre_deploy"} {
		u.dropZero(d, b, p, k)
	}
	k, v, i := entry(b, "destination")
	if i < 0 {
		return
	}
	if k2, _, _ := entry(b, "destinations"); k2 != nil {
		u.fail(d, k.Line, p, "set destination or destinations, not both")
		dropEntry(b, "destination")
		return
	}
	line := k.Line
	seq := newSequence(v)
	// A block mapping in a block list keeps its look; a flow mapping stays on its line.
	if deref(v).Style&yaml.FlowStyle != 0 {
		seq.Style = yaml.FlowStyle
	}
	k.Value = "destinations"
	deref(b).Content[i+1] = seq
	u.edit(d, line, p+".destination", "destination", "destinations", "destination is deprecated: use destinations, a list")
}

// previewsBlock coerces the zeros of a previews block.
func (u *upgrader) previewsBlock(d *parsedDoc, pv *yaml.Node, p string) {
	for _, k := range []string{"ttl", "max"} {
		u.dropZero(d, pv, p, k)
	}
}

// findApp looks an app up by name in every document, the apps file first.
func (u *upgrader) findApp(name string) (*parsedDoc, *yaml.Node) {
	for _, d := range u.docs {
		top := topMapping(&d.root)
		if top == nil {
			continue
		}
		for _, app := range items(section(top, "apps")) {
			if isMapping(app) && text(app, "name") == name {
				return d, deref(app)
			}
		}
	}
	return nil, nil
}

// appProject is the project an app is filed under: its label, the project of the file that holds it, or its name.
func appProject(d *parsedDoc, app *yaml.Node) string {
	switch {
	case text(app, "project") != "":
		return text(app, "project")
	case d.project != "":
		return d.project
	}
	return text(app, "name")
}

// previews moves the entries of the top-level previews section into the app they are about.
func (u *upgrader) previews() {
	for _, d := range u.docs {
		top := topMapping(&d.root)
		if top == nil {
			continue
		}
		sk, sv, si := entry(top, "previews")
		if si < 0 {
			continue
		}
		var first *yaml.Node
		var kept []*yaml.Node
		for _, item := range items(sv) {
			if !isMapping(item) {
				kept = append(kept, item)
				continue
			}
			name := text(item, "app")
			if u.only != "" && name != u.only {
				kept = append(kept, item)
				continue
			}
			path := "previews[" + name + "]"
			line := deref(item).Line
			if !namePattern.MatchString(name) {
				u.fail(d, line, path, fmt.Sprintf("previews of %q: app must match %s", name, namePattern))
				continue
			}
			appDoc, app := u.findApp(name)
			switch {
			case app == nil:
				u.fail(d, line, path, fmt.Sprintf("previews of %q: the parent app is not in the apps list", name))
				continue
			case d.project != "" && appProject(appDoc, app) != d.project:
				u.fail(d, line, path, fmt.Sprintf("previews of %q: the app belongs to project %q, so its previews belong in that project's file (or the apps file)", name, appProject(appDoc, app)))
				continue
			case value(app, "previews") != nil:
				u.fail(d, line, path, fmt.Sprintf("previews of %q: duplicate entry: an app has one previews template", name))
				continue
			}
			item = deref(item)
			pm := newMapping()
			pm.Style = item.Style
			for i := 0; i+1 < len(item.Content); i += 2 {
				if item.Content[i].Value != "app" {
					pm.Content = append(pm.Content, item.Content[i], item.Content[i+1])
				}
			}
			key := strNode("previews")
			key.Line = line
			key.HeadComment = item.HeadComment
			pm.FootComment, pm.LineComment = item.FootComment, item.LineComment
			appendEntry(app, key, pm)
			u.touch(d)
			u.touch(appDoc)
			if first == nil {
				first = key
			}
			u.previewsBlock(d, pm, "apps["+name+"].previews")
			u.edit(d, line, "apps["+name+"].previews", "previews[app: "+name+"]", "apps["+name+"].previews",
				"the top-level previews section is deprecated: previews are a key of their app, apps["+name+"].previews (without app)")
		}
		if first != nil {
			moveComments(first, sk)
		}
		if len(kept) == 0 {
			dropEntry(top, "previews")
		} else {
			deref(sv).Content = kept
		}
	}
}

// managedKeys are the keys of a legacy managed entry that fold into the database of an app (or are dropped because
// the agent knows their value).
var managedKeys = map[string]bool{
	"name": true, "project": true, "managed": true, "app": true, "env_key": true, "engine": true, "host": true, "port": true,
	"database": true, "user": true, "network": true, "password_file": true, "version": true, "backups": true,
}

// managedCandidate is a legacy `managed: true` entry of the databases section.
type managedCandidate struct {
	doc  *parsedDoc
	seq  *yaml.Node
	item *yaml.Node
}

// foldManaged moves each legacy managed database into the app it was created for, as apps[].database, when that loses
// nothing. The entries that cannot be folded stay as they are and keep loading as they always did (and the edit is
// marked as a leftover).
func (u *upgrader) foldManaged() {
	instance := DefaultPostgresMajor
	if len(u.docs) > 0 {
		if top := topMapping(&u.docs[0].root); top != nil {
			if mp := value(top, "managed_postgres"); isMapping(mp) {
				if n, err := strconv.Atoi(text(mp, "version")); err == nil {
					instance = n
				}
			}
		}
	}
	var cands []managedCandidate
	perApp := map[string]int{}
	for _, d := range u.docs {
		top := topMapping(&d.root)
		if top == nil {
			continue
		}
		seq := section(top, "databases")
		for _, item := range items(seq) {
			if isMapping(item) && isTrue(value(item, "managed")) {
				perApp[text(item, "app")]++
				if u.only != "" && text(item, "app") != u.only {
					continue
				}
				u.database(d, item, "databases["+text(item, "name")+"]")
				cands = append(cands, managedCandidate{d, seq, deref(item)})
			}
		}
	}
	firstDatabaseKey := map[*parsedDoc]*yaml.Node{}
	for _, c := range cands {
		name := text(c.item, "name")
		path := "databases[" + name + "]"
		app := text(c.item, "app")
		appDoc, appNode := u.findApp(app)
		if reason := foldRefusal(c, appDoc, appNode, perApp[app], instance); reason != "" {
			u.leftover(c.doc, c.item.Line, path, "databases[managed: true]", "apps["+app+"].database", fmt.Sprintf("%s is a managed database in the legacy form and it stays as it is, because %s: it is read as before, and moving it into apps[%s].database is left to you", path, reason, app))
			continue
		}
		dbm := newMapping()
		dbm.Style = c.item.Style & yaml.FlowStyle
		if name != app {
			appendEntry(dbm, strNode("name"), value(c.item, "name"))
		}
		if text(c.item, "env_key") != DefaultDatabaseEnvKey {
			appendEntry(dbm, strNode("env_key"), value(c.item, "env_key"))
		}
		appendEntry(dbm, strNode("password_file"), value(c.item, "password_file"))
		if b := value(c.item, "backups"); b != nil {
			appendEntry(dbm, strNode("backups"), b)
		}
		key := strNode("database")
		key.Line = c.item.Line
		key.HeadComment, key.LineComment, key.FootComment = c.item.HeadComment, c.item.LineComment, c.item.FootComment
		appendEntry(appNode, key, dbm)
		u.touch(c.doc)
		u.touch(appDoc)
		if firstDatabaseKey[appDoc] == nil {
			firstDatabaseKey[appDoc] = key
		}
		kept := c.seq.Content[:0:0]
		for _, it := range c.seq.Content {
			if deref(it) != c.item {
				kept = append(kept, it)
			}
		}
		c.seq.Content = kept
		u.edit(c.doc, c.item.Line, "apps["+app+"].database", path+" (managed: true)", "apps["+app+"].database",
			fmt.Sprintf("%s with managed: true is deprecated: the database the agent created for an app is a key of that app, apps[%s].database (the keys the agent knows are left out)", path, app))
	}
	for _, d := range u.docs {
		top := topMapping(&d.root)
		if top == nil {
			continue
		}
		if k, v, i := entry(top, "databases"); i >= 0 && deref(v).Kind == yaml.SequenceNode && len(deref(v).Content) == 0 {
			// A section that went empty goes with its comment, which lands on the first database folded into the file.
			u.touch(d)
			for _, target := range u.docs {
				if first := firstDatabaseKey[target]; first != nil {
					moveComments(first, k)
					break
				}
			}
			dropEntry(top, "databases")
		}
	}
}

// foldRefusal says why a managed entry cannot be folded into its app, "" when it can.
func foldRefusal(c managedCandidate, appDoc *parsedDoc, app *yaml.Node, perApp, instance int) string {
	item := c.item
	for i := 0; i+1 < len(item.Content); i += 2 {
		if !managedKeys[item.Content[i].Value] {
			return fmt.Sprintf("it sets %s, which the database of an app does not have", item.Content[i].Value)
		}
	}
	name := text(item, "name")
	switch {
	case app == nil:
		return fmt.Sprintf("the app %q is not in the apps list", text(item, "app"))
	case perApp > 1:
		return fmt.Sprintf("the app %q has %d managed databases and an app has one", text(item, "app"), perApp)
	case value(app, "database") != nil:
		return fmt.Sprintf("the app %q already has a database", text(item, "app"))
	case !namePattern.MatchString(name) || text(item, "database") != name || text(item, "user") != name:
		return "its name, database and user are not the same"
	case text(item, "engine") != "" && text(item, "engine") != EnginePostgres:
		return "its engine is not postgres"
	case text(item, "host") != ManagedPostgresContainer || text(item, "port") != strconv.Itoa(ManagedPostgresPort) || text(item, "network") != ManagedPostgresNetwork:
		return "it is not on the managed PostgreSQL's host, port and network"
	case !ValidEnvKey(text(item, "env_key")):
		return "its env_key is missing or not a variable name"
	case text(item, "password_file") == "":
		return "it has no password_file"
	}
	if v := text(item, "version"); v != "" {
		if n, err := strconv.Atoi(v); err != nil || n != instance {
			return fmt.Sprintf("its version %s is not the instance's (%d)", v, instance)
		}
	}
	label := text(item, "project")
	if label == "" {
		label = c.doc.project
	}
	if want := appProject(appDoc, app); label != "" && label != want {
		return fmt.Sprintf("its project %q is not the app's (%q)", label, want)
	}
	return ""
}

// upgradeEntity upgrades one entity (an app, a job or a database) that is about to be written into a document, so that
// what is written is always the current schema. The edits it made are the deprecations of the submitted body.
func upgradeEntity(kind string, item *yaml.Node) ([]Edit, error) {
	d := &parsedDoc{}
	u := &upgrader{docs: []*parsedDoc{d}}
	switch kind {
	case "apps":
		u.app(d, item)
	case "jobs":
		u.job(d, item, "jobs["+text(item, "name")+"]")
	case "databases":
		u.database(d, item, "databases["+text(item, "name")+"]")
	}
	if len(u.errs) > 0 {
		return nil, errors.New(u.errs[0].Message)
	}
	return u.edits, nil
}
