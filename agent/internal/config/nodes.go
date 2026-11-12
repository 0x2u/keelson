package config

import (
	"strconv"
	"strings"

	"gopkg.in/yaml.v3"
)

// Helpers on YAML nodes. The upgrade of the legacy schema (legacy.go) and the migration edit the tree of a document in
// place, so that comments, anchors, quoting and everything the edit does not touch stay as written.

// deref follows an alias to the node it stands for.
func deref(n *yaml.Node) *yaml.Node {
	for n != nil && n.Kind == yaml.AliasNode && n.Alias != nil {
		n = n.Alias
	}
	return n
}

// entry finds a key of a mapping: its key node, its value node and the index of the key in Content. Nils and -1 when
// the key is not there (or n is not a mapping).
func entry(m *yaml.Node, key string) (k, v *yaml.Node, idx int) {
	m = deref(m)
	if m == nil || m.Kind != yaml.MappingNode {
		return nil, nil, -1
	}
	for i := 0; i+1 < len(m.Content); i += 2 {
		if m.Content[i].Value == key && m.Content[i].Kind == yaml.ScalarNode {
			return m.Content[i], m.Content[i+1], i
		}
	}
	return nil, nil, -1
}

// value is the value node of a key, nil when absent.
func value(m *yaml.Node, key string) *yaml.Node {
	_, v, _ := entry(m, key)
	return v
}

// text is the scalar text of a key's value, "" when absent or not a scalar.
func text(m *yaml.Node, key string) string {
	if v := deref(value(m, key)); v != nil && v.Kind == yaml.ScalarNode {
		return v.Value
	}
	return ""
}

// dropEntry removes a key and its value from a mapping; it reports whether the key was there.
func dropEntry(m *yaml.Node, key string) bool {
	_, _, i := entry(m, key)
	if i < 0 {
		return false
	}
	m = deref(m)
	m.Content = append(m.Content[:i], m.Content[i+2:]...)
	return true
}

// appendEntry adds a key at the end of a mapping.
func appendEntry(m *yaml.Node, k, v *yaml.Node) {
	m = deref(m)
	m.Content = append(m.Content, k, v)
}

// insertEntry puts a key at an index of Content (which is even).
func insertEntry(m *yaml.Node, idx int, k, v *yaml.Node) {
	m = deref(m)
	m.Content = append(m.Content, nil, nil)
	copy(m.Content[idx+2:], m.Content[idx:])
	m.Content[idx], m.Content[idx+1] = k, v
}

// renameKey changes the name of a key in place: the key node keeps its line and its comments.
func renameKey(m *yaml.Node, from, to string) bool {
	k, _, i := entry(m, from)
	if i < 0 {
		return false
	}
	k.Value = to
	return true
}

func newMapping() *yaml.Node { return &yaml.Node{Kind: yaml.MappingNode, Tag: "!!map"} }

func newSequence(items ...*yaml.Node) *yaml.Node {
	return &yaml.Node{Kind: yaml.SequenceNode, Tag: "!!seq", Content: items}
}

// strNode is a plain string scalar.
func strNode(s string) *yaml.Node { return &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: s} }

// moveComments carries the comments of a node that goes away onto the one that replaces it.
func moveComments(to, from *yaml.Node) {
	join := func(a, b string) string {
		switch {
		case a == "":
			return b
		case b == "":
			return a
		}
		return a + "\n\n" + b
	}
	to.HeadComment = join(from.HeadComment, to.HeadComment)
	to.LineComment = join(to.LineComment, from.LineComment)
	to.FootComment = join(to.FootComment, from.FootComment)
}

// items are the entries of a sequence node (nil when it is not one).
func items(n *yaml.Node) []*yaml.Node {
	n = deref(n)
	if n != nil && n.Kind == yaml.SequenceNode {
		return n.Content
	}
	return nil
}

// section is the value of a top-level key when it is a sequence.
func section(top *yaml.Node, name string) *yaml.Node {
	if v := deref(value(top, name)); v != nil && v.Kind == yaml.SequenceNode {
		return v
	}
	return nil
}

// zeroScalar says a value is the "0" of a legacy key where 0 meant "default": the number, a zero duration or size, or
// an empty string.
func zeroScalar(n *yaml.Node) bool {
	n = deref(n)
	if n == nil || n.Kind != yaml.ScalarNode {
		return false
	}
	v := strings.TrimSpace(n.Value)
	if v == "" {
		return n.Tag != "!!null" || n.Value == ""
	}
	if f, err := strconv.ParseFloat(v, 64); err == nil {
		return f == 0
	}
	if d, err := ParseDuration(v); err == nil {
		return d == 0
	}
	if b, err := ParseSize(v); err == nil {
		return b == 0
	}
	return false
}

// isTrue says a scalar is the boolean true.
func isTrue(n *yaml.Node) bool {
	n = deref(n)
	return n != nil && n.Kind == yaml.ScalarNode && n.Tag == "!!bool" && (n.Value == "true" || n.Value == "True" || n.Value == "TRUE")
}
