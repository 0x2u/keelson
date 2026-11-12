package config

import (
	"fmt"
	"reflect"
	"sort"
	"strings"

	"gopkg.in/yaml.v3"
)

// The structs of this package are the schema (R5): the YAML library is told nothing about which keys are allowed, so
// rejectUnknownKeys walks a document next to the type it will be decoded into and reports every key the type does not
// have. A typo cannot silently disable a setting, and the report carries the exact line of the key.

var (
	durationType = reflect.TypeOf(Duration(0))
	sizeType     = reflect.TypeOf(Size(0))
	portSpecType = reflect.TypeOf(PortSpec{})
)

// yamlField is one key of a struct.
type yamlField struct {
	Key  string
	Type reflect.Type
	// Path is the Go field path through the inline structs.
	Path []int
}

// yamlFields lists the keys of a struct type: the exported fields with a yaml name, the inline structs flattened.
func yamlFields(t reflect.Type) []yamlField {
	var out []yamlField
	for i := range t.NumField() {
		f := t.Field(i)
		if !f.IsExported() {
			continue
		}
		tag := f.Tag.Get("yaml")
		if tag == "-" {
			continue
		}
		name, opts, _ := strings.Cut(tag, ",")
		if strings.Contains(opts, "inline") {
			for _, in := range yamlFields(indirect(f.Type)) {
				out = append(out, yamlField{in.Key, in.Type, append([]int{i}, in.Path...)})
			}
			continue
		}
		if name == "" {
			name = strings.ToLower(f.Name)
		}
		out = append(out, yamlField{name, f.Type, []int{i}})
	}
	return out
}

func indirect(t reflect.Type) reflect.Type {
	for t.Kind() == reflect.Pointer {
		t = t.Elem()
	}
	return t
}

// atomic says the YAML value is one thing as far as the keys go: a scalar, or a type that reads itself.
func atomic(t reflect.Type) bool {
	return t == durationType || t == sizeType
}

// unknownKeys walks the node n next to the type t and returns an issue for every key t does not have. skipTop, when set,
// lists top-level keys that are somebody else's concern (a project file's own message).
func unknownKeys(n *yaml.Node, t reflect.Type, path string, skipTop func(key string) bool) []Issue {
	var out []Issue
	n = deref(n)
	if n == nil {
		return nil
	}
	t = indirect(t)
	switch {
	case atomic(t):
		return nil
	case t == portSpecType:
		if n.Kind == yaml.MappingNode {
			for i := 0; i+1 < len(n.Content); i += 2 {
				switch k := n.Content[i]; k.Value {
				case "container", "host", "env":
				default:
					out = append(out, unknownKey(k, path))
				}
			}
		}
		return out
	}
	switch t.Kind() {
	case reflect.Struct:
		if n.Kind != yaml.MappingNode {
			return nil
		}
		known := map[string]reflect.Type{}
		for _, f := range yamlFields(t) {
			known[f.Key] = f.Type
		}
		for i := 0; i+1 < len(n.Content); i += 2 {
			k, v := n.Content[i], n.Content[i+1]
			if k.Tag == "!!merge" || k.Value == "<<" {
				continue
			}
			ft, ok := known[k.Value]
			if !ok {
				if path == "" && skipTop != nil && skipTop(k.Value) {
					continue
				}
				out = append(out, unknownKey(k, path))
				continue
			}
			out = append(out, unknownKeys(v, ft, joinPath(path, k.Value), nil)...)
		}
	case reflect.Slice:
		if n.Kind != yaml.SequenceNode || t.Elem().Kind() == reflect.String || t.Elem().Kind() == reflect.Int {
			return nil
		}
		for i, item := range n.Content {
			out = append(out, unknownKeys(item, t.Elem(), itemPath(path, item, i), nil)...)
		}
	case reflect.Map:
		if n.Kind != yaml.MappingNode || indirect(t.Elem()).Kind() != reflect.Struct {
			return nil
		}
		for i := 0; i+1 < len(n.Content); i += 2 {
			out = append(out, unknownKeys(n.Content[i+1], t.Elem(), path+"."+n.Content[i].Value, nil)...)
		}
	}
	return out
}

// itemPath names an entry of a list: apps[web], jobs[backup], proxy.sites[0].
func itemPath(path string, item *yaml.Node, i int) string {
	if item = deref(item); item != nil && item.Kind == yaml.MappingNode {
		for _, key := range []string{"name", "host"} {
			if v := text(item, key); v != "" {
				return fmt.Sprintf("%s[%s]", path, v)
			}
		}
	}
	return fmt.Sprintf("%s[%d]", path, i)
}

func unknownKey(k *yaml.Node, path string) Issue {
	where := "the document"
	if path != "" {
		where = path
	}
	return Issue{Severity: SeverityError, Path: "yaml", Line: k.Line, Message: fmt.Sprintf("unknown key %q in %s", k.Value, where)}
}

// KnownKeys lists the keys a section of the file accepts, sorted: the top level for "", else a path such as "apps" or
// "apps.release.steps". It is what a form or a document check can ask, and what the tests of the schema use.
func KnownKeys(path string) []string {
	t := reflect.TypeOf(Config{})
	if path != "" {
		for _, seg := range strings.Split(path, ".") {
			t = indirect(t)
			if t.Kind() == reflect.Slice {
				t = indirect(t.Elem())
			}
			var next reflect.Type
			for _, f := range yamlFields(t) {
				if f.Key == seg {
					next = f.Type
				}
			}
			if next == nil {
				return nil
			}
			t = next
		}
	}
	t = indirect(t)
	if t.Kind() == reflect.Slice {
		t = indirect(t.Elem())
	}
	if t.Kind() != reflect.Struct {
		return nil
	}
	var keys []string
	for _, f := range yamlFields(t) {
		keys = append(keys, f.Key)
	}
	sort.Strings(keys)
	return keys
}
