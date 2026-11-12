package config

import (
	"errors"
	"fmt"
	"sort"

	"gopkg.in/yaml.v3"
)

// Keys are written in a tidy order; anything else follows alphabetically.
var (
	appKeyOrder      = []string{"name", "project", "environment", "image", "build", "source", "env_file", "env", "publish", "volumes", "network", "restart", "command", "stop_timeout", "health_timeout", "stable_after", "drain", "soak", "verify", "domains", "port", "health_path", "deploy", "release", "log", "keep_images", "previews", "database"}
	jobKeyOrder      = []string{"name", "project", "schedule", "timezone", "http", "host", "dir", "container", "timeout", "alert_after", "realert_after", "catch_up", "paused"}
	notifKeyOrder    = []string{"name", "events", "webhooks", "telegram", "heartbeat", "disk_alert_percent", "memory_alert_percent", "alert_cooldown"}
	previewKeyOrder  = []string{"domain", "env_file", "env", "ttl", "max"}
	buildKeyOrder    = []string{"preset", "dockerfile", "context", "install", "build_command", "start", "output_dir", "node", "spa", "standalone", "target", "args", "timeout", "memory", "cpus", "network", "platform", "database", "max_source", "source_hosts"}
	releaseKeyOrder  = []string{"steps", "on_rollback"}
	stepKeyOrder     = []string{"name", "host", "dir", "container", "backup", "timeout", "continue_on_failure"}
	databaseKeyOrder = []string{"name", "project", "engine", "host", "port", "database", "user", "password_file", "ssl_mode", "version", "network", "backups"}

	appDatabaseKeyOrder = []string{"name", "env_key", "password_file", "backups"}
	backupsKeyOrder     = []string{"schedule", "timezone", "recipients", "keep", "keep_days", "keep_pre_deploy", "timeout", "alert_after", "realert_after", "catch_up", "paused", "destinations"}
	sourceKeyOrder      = []string{"repo", "branch", "deploy_on", "workflow", "previews_workflow", "build_on", "build_server"}
	portKeyOrder        = []string{"container", "host", "env"}
	containerKeyOrder   = []string{"app", "command", "image"}
)

// nestedOrder is the key order of the mappings inside an entity, by the key that holds them.
var nestedOrder = map[string][]string{
	"build": buildKeyOrder, "previews": previewKeyOrder, "source": sourceKeyOrder, "database": appDatabaseKeyOrder,
	"backups": backupsKeyOrder, "port": portKeyOrder, "container": containerKeyOrder,
}

// Model returns the document as plain data (the YAML keys, as JSON would carry them), in the current schema: the legacy
// spellings are upgraded in memory. Redact first: it reads the text as written, secrets included.
func Model(content []byte) (map[string]any, error) {
	return Bundle{Main: content}.Model()
}

// SetApp creates or replaces one app in the document and returns the new text. The rest of the document
// keeps its comments, but is re-indented: an entity edit rewrites the file through the YAML tree.
// Hidden values in the app are resolved against the stored ones.
func SetApp(content []byte, name string, app map[string]any) ([]byte, []Issue, error) {
	return setItem(content, "apps", "name", name, app, appKeyOrder)
}

// SetJob creates or replaces one job.
func SetJob(content []byte, name string, job map[string]any) ([]byte, []Issue, error) {
	return setItem(content, "jobs", "name", name, job, jobKeyOrder)
}

// SetDatabase creates or replaces one database.
func SetDatabase(content []byte, name string, database map[string]any) ([]byte, []Issue, error) {
	return setItem(content, "databases", "name", name, database, databaseKeyOrder)
}

// DeleteApp removes one app from the document.
func DeleteApp(content []byte, name string) ([]byte, error) {
	return deleteItem(content, "apps", "name", name)
}

// DeleteJob removes one job from the document.
func DeleteJob(content []byte, name string) ([]byte, error) {
	return deleteItem(content, "jobs", "name", name)
}

// DeleteDatabase removes one database from the document, and with it the backup job it synthesizes.
func DeleteDatabase(content []byte, name string) ([]byte, error) {
	return deleteItem(content, "databases", "name", name)
}

// SetNotifications replaces the notifications section; nil removes it.
func SetNotifications(content []byte, n map[string]any) ([]byte, []Issue, error) {
	root, top, err := editableRoot(content)
	if err != nil {
		return nil, nil, err
	}
	if n == nil {
		removeKey(top, "notifications")
	} else {
		value, err := mappingFrom(n, notifKeyOrder)
		if err != nil {
			return nil, nil, err
		}
		if _, old := mappingEntry(top, "notifications"); old != nil {
			carryComments(value, old)
			*old = *value
		} else {
			top.Content = append(top.Content, scalarKey("notifications"), value)
		}
	}
	return finish(root, content)
}

func setItem(content []byte, section, nameField, name string, entity map[string]any, order []string) ([]byte, []Issue, error) {
	if got, _ := entity[nameField].(string); got != name {
		return nil, nil, fmt.Errorf("the %s name in the body (%q) must match the one in the URL (%q)", section, got, name)
	}
	root, top, err := editableRoot(content)
	if err != nil {
		return nil, nil, err
	}
	item, err := mappingFrom(entity, order)
	if err != nil {
		return nil, nil, err
	}
	edits, err := upgradeEntity(section, item)
	if err != nil {
		return nil, nil, err
	}
	_, seq := mappingEntry(top, section)
	if seq == nil {
		seq = &yaml.Node{Kind: yaml.SequenceNode, Tag: "!!seq"}
		top.Content = append(top.Content, scalarKey(section), seq)
	}
	if seq.Kind != yaml.SequenceNode {
		return nil, nil, fmt.Errorf("%s is not a list in the document", section)
	}
	replaced := false
	for i, existing := range seq.Content {
		if _, v := mappingEntry(existing, nameField); v != nil && v.Value == name {
			carryComments(item, existing)
			seq.Content[i] = item
			replaced = true
			break
		}
	}
	if !replaced {
		if len(seq.Content) == 0 {
			// `apps: []`, what the installer writes, would otherwise keep its flow style and turn the first entity
			// into a one-line `{name: ..., build: {...}}`.
			seq.Style &^= yaml.FlowStyle
		}
		seq.Content = append(seq.Content, item)
	}
	out, issues, err := finish(root, content)
	if err != nil {
		return nil, nil, err
	}
	for _, e := range edits {
		issues = append(issues, e.issue())
	}
	return out, issues, nil
}

func deleteItem(content []byte, section, nameField, name string) ([]byte, error) {
	root, top, err := editableRoot(content)
	if err != nil {
		return nil, err
	}
	key, seq := mappingEntry(top, section)
	if seq == nil || seq.Kind != yaml.SequenceNode {
		return nil, fmt.Errorf("no %s section in the document", section)
	}
	kept := seq.Content[:0:0]
	found := false
	for _, existing := range seq.Content {
		if _, v := mappingEntry(existing, nameField); v != nil && v.Value == name {
			found = true
			continue
		}
		kept = append(kept, existing)
	}
	if !found {
		return nil, fmt.Errorf("%s %q is not in the document", section, name)
	}
	seq.Content = kept
	if len(kept) == 0 {
		removeKey(top, key.Value)
	}
	out, _, err := finish(root, content)
	return out, err
}

// finish encodes the edited tree. Hidden values that came from the submitted entity are resolved against
// the document as it was before the edit.
func finish(root *yaml.Node, before []byte) ([]byte, []Issue, error) {
	text, err := encodeNode(root)
	if err != nil {
		return nil, nil, err
	}
	restored, issues := Restore(text, before)
	return restored, issues, nil
}

// editableRoot parses the document for modification: an empty one becomes an empty mapping.
func editableRoot(content []byte) (root, top *yaml.Node, err error) {
	root, err = parseNode(content)
	if err != nil {
		return nil, nil, err
	}
	if root.Kind == 0 {
		root = &yaml.Node{Kind: yaml.DocumentNode, Content: []*yaml.Node{{Kind: yaml.MappingNode, Tag: "!!map"}}}
	}
	top = topMapping(root)
	if top == nil {
		return nil, nil, errors.New("the document is not a mapping")
	}
	return root, top, nil
}

func scalarKey(s string) *yaml.Node { return &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: s} }

func removeKey(m *yaml.Node, key string) {
	for i := 0; i+1 < len(m.Content); i += 2 {
		if m.Content[i].Value == key {
			m.Content = append(m.Content[:i], m.Content[i+2:]...)
			return
		}
	}
}

// carryComments keeps the comments around a replaced node.
func carryComments(to, from *yaml.Node) {
	to.HeadComment, to.LineComment, to.FootComment = from.HeadComment, from.LineComment, from.FootComment
}

// mappingFrom builds a mapping node from plain data, keys in the given order first, then alphabetically. The mappings
// inside it come out in the documented order too (see nestedOrder).
func mappingFrom(m map[string]any, order []string) (*yaml.Node, error) {
	node := &yaml.Node{Kind: yaml.MappingNode, Tag: "!!map"}
	seen := map[string]bool{}
	add := func(k string) error {
		var v yaml.Node
		switch sub, isMap := m[k].(map[string]any); {
		case isMap && k == "release":
			n, err := releaseNode(sub)
			if err != nil {
				return fmt.Errorf("%s: %w", k, err)
			}
			v = *n
		case isMap && nestedOrder[k] != nil:
			n, err := mappingFrom(sub, nestedOrder[k])
			if err != nil {
				return fmt.Errorf("%s: %w", k, err)
			}
			v = *n
		default:
			if err := v.Encode(m[k]); err != nil {
				return fmt.Errorf("%s: %w", k, err)
			}
		}
		node.Content = append(node.Content, scalarKey(k), &v)
		seen[k] = true
		return nil
	}
	for _, k := range order {
		if _, ok := m[k]; ok {
			if err := add(k); err != nil {
				return nil, err
			}
		}
	}
	rest := make([]string, 0, len(m))
	for k := range m {
		if !seen[k] {
			rest = append(rest, k)
		}
	}
	sort.Strings(rest)
	for _, k := range rest {
		if err := add(k); err != nil {
			return nil, err
		}
	}
	return node, nil
}

// releaseNode builds the `release:` mapping with its steps in the documented key order (name first), where plain maps
// would come out alphabetical.
func releaseNode(m map[string]any) (*yaml.Node, error) {
	node, err := mappingFrom(m, releaseKeyOrder)
	if err != nil {
		return nil, err
	}
	steps, ok := m["steps"].([]any)
	if !ok {
		return node, nil
	}
	list := &yaml.Node{Kind: yaml.SequenceNode, Tag: "!!seq"}
	for _, raw := range steps {
		step, ok := raw.(map[string]any)
		if !ok {
			return node, nil // not the shape we know: leave the plain encoding, validation reports it
		}
		n, err := mappingFrom(step, stepKeyOrder)
		if err != nil {
			return nil, err
		}
		list.Content = append(list.Content, n)
	}
	for i := 0; i+1 < len(node.Content); i += 2 {
		if node.Content[i].Value == "steps" {
			node.Content[i+1] = list
		}
	}
	return node, nil
}
