package config

import (
	"fmt"
	"reflect"
	"strings"
)

// FileRef is a file the configuration names and the agent reads: an env_file, or a secret in a file.
type FileRef struct {
	// Where says which key names it: "apps[shop].env_file", "databases[main].password_file".
	Where string
	// Key is the key itself ("env_file", "password_file", "bot_token_file"...).
	Key  string
	Path string
}

// Secret says the file holds a credential, not settings: it should not be readable by every account.
func (r FileRef) Secret() bool { return r.Key != "env_file" && r.Key != "cert_file" }

// FileRefs lists the files the configuration names, in document order: every key that ends in _file (env_file,
// password_file, secret_file, bot_token_file, cert_file, key_file...) but upstreams_file, which the agent writes itself.
// It is made from the structs, as the schema is, so a new key of that kind is found without being listed here. Nothing is
// read: the files may not exist yet.
func (c *Config) FileRefs() []FileRef {
	var out []FileRef
	seen := map[FileRef]bool{}
	var walk func(v reflect.Value, where string)
	walk = func(v reflect.Value, where string) {
		switch v.Kind() {
		case reflect.Pointer:
			if !v.IsNil() {
				walk(v.Elem(), where)
			}
		case reflect.Slice:
			for i := range v.Len() {
				walk(v.Index(i), fmt.Sprintf("%s[%s]", where, entryName(v.Index(i), i)))
			}
		case reflect.Struct:
			for _, f := range yamlFields(v.Type()) {
				fv, err := v.FieldByIndexErr(f.Path)
				if err != nil {
					continue // an inline struct that is not there
				}
				path := joinPath(where, f.Key)
				if f.Type.Kind() == reflect.String && strings.HasSuffix(f.Key, "_file") && f.Key != "upstreams_file" {
					if p := fv.String(); p != "" {
						ref := FileRef{Where: path, Key: f.Key, Path: p}
						if !seen[ref] {
							seen[ref] = true
							out = append(out, ref)
						}
					}
					continue
				}
				walk(fv, path)
			}
		}
	}
	walk(reflect.ValueOf(c), "")
	return out
}

// entryName names an entry of a list the way issues do: its name, its host, else its position.
func entryName(v reflect.Value, i int) string {
	v = reflect.Indirect(v)
	if v.Kind() == reflect.Struct {
		for _, field := range []string{"Name", "Host"} {
			if f := v.FieldByName(field); f.IsValid() && f.Kind() == reflect.String && f.String() != "" {
				return f.String()
			}
		}
	}
	return fmt.Sprint(i)
}
