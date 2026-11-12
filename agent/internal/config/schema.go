package config

import (
	"encoding/json"
	"fmt"
	"reflect"
	"strings"
)

// The JSON Schema of the files is made from the structs, as the check of unknown keys is (R5): one source, so the schema
// an editor uses cannot drift from what the agent accepts. It describes structure and types, not the rules that need the
// whole configuration (unique names, a job that finds its app, a port that does not collide): `keelson-agent config
// validate` is the check, the schema is for the editor. The legacy spellings the loader still reads (and reports as
// deprecated) are not in it.

// Schema files.
const (
	SchemaApps    = "apps"    // the apps file: apps, jobs, databases and the server-wide sections
	SchemaProject = "project" // a file of projects.d/: apps, jobs and databases only
)

// SchemaDocs returns the documentation of a struct (field empty) or of one of its fields, by Go names; "" when there is none.
type SchemaDocs func(typeName, field string) string

// Schema returns the JSON Schema (draft 2020-12) of the apps file or of a project file, indented, with the same bytes for
// the same structs and documentation.
func Schema(file string, docs SchemaDocs) ([]byte, error) {
	var root reflect.Type
	var title string
	switch file {
	case SchemaApps:
		root, title = reflect.TypeOf(Config{}), "Keelson apps file"
	case SchemaProject:
		root, title = reflect.TypeOf(projectFile{}), "Keelson project file (projects.d/NAME.yaml)"
	default:
		return nil, fmt.Errorf("unknown schema %q", file)
	}
	if docs == nil {
		docs = func(string, string) string { return "" }
	}
	g := &schemaGen{docs: docs, defs: map[string]any{}}
	top := g.object(root, true)
	top["$schema"] = "https://json-schema.org/draft/2020-12/schema"
	top["title"] = title
	for name, def := range g.units() {
		g.defs[name] = def
	}
	top["$defs"] = g.defs
	b, err := json.MarshalIndent(top, "", "  ")
	if err != nil {
		return nil, err
	}
	return append(b, '\n'), nil
}

type schemaGen struct {
	docs SchemaDocs
	defs map[string]any
}

// units are the definitions of the types that read themselves from a string or a number.
func (g *schemaGen) units() map[string]any {
	return map[string]any{
		"duration": map[string]any{
			"description": "A length of time as a string with a unit: 90s, 5m, 1h30m, 7d. A bare number is refused, but for 0.",
			"anyOf": []any{
				map[string]any{"type": "string", "pattern": DurationPattern},
				map[string]any{"const": 0},
			},
		},
		"size": map[string]any{
			"description": "An amount of bytes: 512m, 2g, 1GiB, or a number of bytes.",
			"anyOf": []any{
				map[string]any{"type": "string", "pattern": SizePattern},
				map[string]any{"type": "integer", "minimum": 0},
			},
		},
		"port": map[string]any{
			"description": "The container port a proxy forwards to, or a mapping: {container: 3000}, or {host: [3000, 3001], env: PORT} for an app on the host network that alternates between two host ports and is told which to listen on through the variable env.",
			"anyOf": []any{
				map[string]any{"type": "integer", "minimum": 1, "maximum": 65535},
				map[string]any{
					"type":                 "object",
					"additionalProperties": false,
					"properties": map[string]any{
						"container": map[string]any{"type": "integer", "minimum": 1, "maximum": 65535},
						"host":      map[string]any{"type": "array", "items": map[string]any{"type": "integer", "minimum": 1, "maximum": 65535}},
						"env":       map[string]any{"type": "string", "pattern": EnvNamePattern},
					},
				},
			},
		},
	}
}

// object describes a struct: its keys, and nothing else.
func (g *schemaGen) object(t reflect.Type, top bool) map[string]any {
	props := map[string]any{}
	for _, f := range yamlFields(t) {
		prop := g.of(f.Type)
		if doc := g.docs(t.Name(), t.FieldByIndex(f.Path).Name); doc != "" {
			prop = withDescription(prop, doc)
		}
		props[f.Key] = prop
	}
	out := map[string]any{"type": "object", "additionalProperties": false, "properties": props}
	if doc := g.docs(t.Name(), ""); doc != "" && !top {
		out["description"] = doc
	}
	return out
}

// withDescription adds a description next to a schema. A reference cannot carry one in every validator, so it is wrapped.
func withDescription(s map[string]any, doc string) map[string]any {
	if _, isRef := s["$ref"]; isRef {
		return map[string]any{"description": doc, "allOf": []any{s}}
	}
	if _, has := s["description"]; !has {
		s["description"] = doc
	}
	return s
}

// of describes the values of a Go type.
func (g *schemaGen) of(t reflect.Type) map[string]any {
	t = indirect(t)
	switch t {
	case durationType:
		return ref("duration")
	case sizeType:
		return ref("size")
	case portSpecType:
		return ref("port")
	}
	switch t.Kind() {
	case reflect.String:
		return map[string]any{"type": "string"}
	case reflect.Bool:
		return map[string]any{"type": "boolean"}
	case reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64, reflect.Uint, reflect.Uint8, reflect.Uint16, reflect.Uint32, reflect.Uint64:
		return map[string]any{"type": "integer"}
	case reflect.Float32, reflect.Float64:
		return map[string]any{"type": "number"}
	case reflect.Slice, reflect.Array:
		return map[string]any{"type": "array", "items": g.of(t.Elem())}
	case reflect.Map:
		return map[string]any{"type": "object", "additionalProperties": g.of(t.Elem())}
	case reflect.Struct:
		if t.Name() == "" {
			return g.object(t, false)
		}
		if _, done := g.defs[t.Name()]; !done {
			g.defs[t.Name()] = nil // a type that holds itself must not be described again while it is described
			g.defs[t.Name()] = g.object(t, false)
		}
		return ref(t.Name())
	}
	return map[string]any{} // any value
}

func ref(name string) map[string]any {
	return map[string]any{"$ref": "#/$defs/" + strings.TrimPrefix(name, "#/$defs/")}
}
