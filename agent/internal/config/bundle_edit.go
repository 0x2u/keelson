package config

import (
	"errors"
	"fmt"

	"gopkg.in/yaml.v3"
)

// The entity edits of a bundle write each entity in the file that holds it. The functions of edit.go work on one
// document; these find the document first.

// SetApp creates or replaces one app, in the file that holds it. A new app goes to the file of its project when that
// file exists, else to the apps file.
func (b *Bundle) SetApp(name string, app map[string]any) ([]Issue, error) {
	return b.set("apps", "name", name, app, appKeyOrder)
}

// SetJob creates or replaces one job (see SetApp).
func (b *Bundle) SetJob(name string, job map[string]any) ([]Issue, error) {
	return b.set("jobs", "name", name, job, jobKeyOrder)
}

// SetDatabase creates or replaces one database (see SetApp).
func (b *Bundle) SetDatabase(name string, database map[string]any) ([]Issue, error) {
	return b.set("databases", "name", name, database, databaseKeyOrder)
}

// SetPreview creates or replaces the previews template of one app: the previews key of the app, in the file that holds
// it. The template is the previews block (no app key).
func (b *Bundle) SetPreview(app string, preview map[string]any) ([]Issue, error) {
	block := map[string]any{}
	for k, v := range preview {
		if k != "app" {
			block[k] = v
		}
	}
	return b.editApp(app, true, func(item *yaml.Node) error {
		node, err := mappingFrom(block, previewKeyOrder)
		if err != nil {
			return err
		}
		if k, v, i := entry(item, "previews"); i >= 0 {
			carryComments(node, v)
			item.Content[i+1] = node
			_ = k
		} else {
			appendEntry(item, scalarKey("previews"), node)
		}
		return nil
	})
}

// DeletePreview removes the previews template of one app.
func (b *Bundle) DeletePreview(app string) error {
	_, err := b.editApp(app, true, func(item *yaml.Node) error {
		if !dropEntry(item, "previews") {
			return fmt.Errorf("previews of %q is not in the document", app)
		}
		return nil
	})
	return err
}

// SetAppDatabase creates or replaces the database of one app (its database key), in the file that holds the app.
func (b *Bundle) SetAppDatabase(app string, database map[string]any) ([]Issue, error) {
	return b.editApp(app, false, func(item *yaml.Node) error {
		node, err := mappingFrom(database, appDatabaseKeyOrder)
		if err != nil {
			return err
		}
		if _, v, i := entry(item, "database"); i >= 0 {
			carryComments(node, v)
			item.Content[i+1] = node
		} else {
			appendEntry(item, scalarKey("database"), node)
		}
		return nil
	})
}

// DeleteAppDatabase removes the database of one app.
func (b *Bundle) DeleteAppDatabase(app string) error {
	_, err := b.editApp(app, false, func(item *yaml.Node) error {
		if !dropEntry(item, "database") {
			return fmt.Errorf("app %q has no database in the document", app)
		}
		return nil
	})
	return err
}

// editApp changes the node of one app in the file that holds it. A legacy previews entry of the app (and, unless
// previewsOnly, its legacy managed database) is moved into the app first, so that the edit sees the whole of it.
func (b *Bundle) editApp(name string, previewsOnly bool, edit func(item *yaml.Node) error) ([]Issue, error) {
	if err := b.foldLegacyInto(name, previewsOnly); err != nil {
		return nil, err
	}
	project, found := b.holder("apps", "name", name)
	if !found {
		return nil, fmt.Errorf("apps %q is not in the document", name)
	}
	content := b.Content(project)
	root, top, err := editableRoot(content)
	if err != nil {
		return nil, err
	}
	for _, item := range items(section(top, "apps")) {
		if text(item, "name") == name {
			if err := edit(deref(item)); err != nil {
				return nil, err
			}
			out, issues, err := finish(root, content)
			if err != nil {
				return nil, err
			}
			b.SetContent(project, out)
			return issues, nil
		}
	}
	return nil, fmt.Errorf("apps %q is not in the document", name)
}

// foldLegacyInto moves what the legacy schema keeps elsewhere about an app (its entry of the top-level previews, its
// `managed: true` database) into the app, in the files, before the app is written: the app a form submits already has
// them as its keys, and both would otherwise be there twice. Only the documents the move changes are re-encoded.
func (b *Bundle) foldLegacyInto(app string, previewsOnly bool) error {
	docs, issues := b.parseDocs()
	if len(issues) > 0 {
		return nil // the edit reports the syntax error
	}
	u := &upgrader{docs: docs, only: app, noManaged: previewsOnly}
	u.moves()
	if len(u.errs) > 0 {
		return errors.New(u.errs[0].Message)
	}
	for _, d := range docs {
		if !u.touched[d] {
			continue
		}
		out, err := encodeNode(&d.root)
		if err != nil {
			return err
		}
		b.SetContent(d.project, out)
	}
	return nil
}

// DeleteApp removes one app from the file that holds it.
func (b *Bundle) DeleteApp(name string) error {
	// A legacy previews entry of the app would be left without its parent.
	if err := b.foldLegacyInto(name, true); err != nil {
		return err
	}
	return b.remove("apps", "name", name)
}

// DeleteJob removes one job from the file that holds it.
func (b *Bundle) DeleteJob(name string) error { return b.remove("jobs", "name", name) }

// DeleteDatabase removes one database from the file that holds it.
func (b *Bundle) DeleteDatabase(name string) error { return b.remove("databases", "name", name) }

// SetNotifications replaces the notifications section of the apps file; nil removes it.
func (b *Bundle) SetNotifications(n map[string]any) ([]Issue, error) {
	out, issues, err := SetNotifications(b.Main, n)
	if err != nil {
		return nil, err
	}
	b.Main = out
	return issues, nil
}

// holder says which document lists the entity: the project, or "" for the apps file. A document that does not parse
// holds nothing here (editing it reports why).
func (b *Bundle) holder(section, nameField, name string) (string, bool) {
	has := func(content []byte) bool {
		root, err := parseNode(content)
		if err != nil {
			return false
		}
		top := topMapping(root)
		if top == nil {
			return false
		}
		_, seq := mappingEntry(top, section)
		if seq == nil || seq.Kind != yaml.SequenceNode {
			return false
		}
		for _, item := range seq.Content {
			if _, v := mappingEntry(item, nameField); v != nil && v.Value == name {
				return true
			}
		}
		return false
	}
	if has(b.Main) {
		return "", true
	}
	for _, n := range b.ProjectNames() {
		if has(b.Projects[n]) {
			return n, true
		}
	}
	return "", false
}

func (b *Bundle) set(section, nameField, name string, entity map[string]any, order []string) ([]Issue, error) {
	if section == "apps" {
		if err := b.foldLegacyInto(name, false); err != nil {
			return nil, err
		}
	}
	project, found := b.holder(section, nameField, name)
	label, _ := entity["project"].(string)
	switch {
	case found && project != "" && label != "" && label != project:
		return nil, fmt.Errorf("%s %q is in %s, which holds project %q: its project cannot be changed to %q here (delete it and create it again)", section, name, ProjectFileName(project), project, label)
	case found:
	case label != "":
		if _, ok := b.Projects[label]; ok {
			project = label
		}
	}
	out, issues, err := setItem(b.Content(project), section, nameField, name, entity, order)
	if err != nil {
		return nil, err
	}
	b.SetContent(project, out)
	return issues, nil
}

func (b *Bundle) remove(section, nameField, name string) error {
	project, found := b.holder(section, nameField, name)
	if !found {
		project = "" // the apps file words the refusal
	}
	out, err := deleteItem(b.Content(project), section, nameField, name)
	if err != nil {
		return err
	}
	b.SetContent(project, out)
	return nil
}
