// genschema writes the JSON Schemas of the apps file and of the project files, from the structs of internal/config and
// the comments on them (they become the hover text of an editor).
//
//	cd agent && go run ./cmd/genschema                # write ../docs/json-schema/{apps,project}.schema.json
//	cd agent && go run ./cmd/genschema -check         # fail when the files on disk are not what it would write
package main

import (
	"bytes"
	"flag"
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"strings"

	"github.com/0x2u/keelson/agent/internal/config"
)

const pkgDir = "internal/config"

func main() {
	out := flag.String("out", "../docs/json-schema", "directory of the schema files")
	check := flag.Bool("check", false, "do not write: fail when a file differs")
	flag.Parse()
	if err := run(*out, *check); err != nil {
		fmt.Fprintln(os.Stderr, "genschema:", err)
		os.Exit(1)
	}
}

func run(out string, check bool) error {
	docs, err := comments(pkgDir)
	if err != nil {
		return err
	}
	stale := false
	for _, file := range []string{config.SchemaApps, config.SchemaProject} {
		b, err := config.Schema(file, docs)
		if err != nil {
			return err
		}
		path := filepath.Join(out, file+".schema.json")
		if check {
			if have, err := os.ReadFile(path); err != nil || !bytes.Equal(have, b) {
				fmt.Fprintf(os.Stderr, "genschema: %s is not up to date: run `cd agent && go run ./cmd/genschema`\n", path)
				stale = true
			}
			continue
		}
		if err := os.MkdirAll(out, 0o755); err != nil {
			return err
		}
		if err := os.WriteFile(path, b, 0o644); err != nil {
			return err
		}
	}
	if stale {
		return fmt.Errorf("the schema files are stale")
	}
	return nil
}

// comments reads the doc comments of the struct types of the package and of their fields.
func comments(dir string) (config.SchemaDocs, error) {
	fset := token.NewFileSet()
	pkgs, err := parser.ParseDir(fset, dir, func(fi os.FileInfo) bool { return !strings.HasSuffix(fi.Name(), "_test.go") }, parser.ParseComments)
	if err != nil {
		return nil, err
	}
	docs := map[string]string{}
	for _, pkg := range pkgs {
		for _, f := range pkg.Files {
			for _, decl := range f.Decls {
				gd, ok := decl.(*ast.GenDecl)
				if !ok || gd.Tok != token.TYPE {
					continue
				}
				for _, spec := range gd.Specs {
					ts := spec.(*ast.TypeSpec)
					st, ok := ts.Type.(*ast.StructType)
					if !ok {
						continue
					}
					doc := ts.Doc
					if doc == nil {
						doc = gd.Doc
					}
					docs[ts.Name.Name+"."] = text(doc)
					for _, field := range st.Fields.List {
						d := text(field.Doc)
						if d == "" {
							d = text(field.Comment)
						}
						for _, name := range field.Names {
							docs[ts.Name.Name+"."+name.Name] = d
						}
					}
				}
			}
		}
	}
	return func(typeName, field string) string { return docs[typeName+"."+field] }, nil
}

// text is a comment on one line.
func text(g *ast.CommentGroup) string {
	if g == nil {
		return ""
	}
	return strings.Join(strings.Fields(g.Text()), " ")
}
