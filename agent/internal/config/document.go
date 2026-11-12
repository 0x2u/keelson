package config

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"regexp"
	"strconv"
	"strings"

	"gopkg.in/yaml.v3"
)

// Hash identifies a document: the hex SHA-256 of its exact bytes.
func Hash(content []byte) string {
	sum := sha256.Sum256(content)
	return hex.EncodeToString(sum[:])
}

var yamlLine = regexp.MustCompile(`line (\d+)`)
var yamlLinePrefix = regexp.MustCompile(`^line \d+:\s*`)

// Parse validates a document and returns the configuration, or nil when there is any error, together
// with every issue found (errors first, as they were met). It never writes anything. It is ParseBundle of a
// configuration made of this one file.
func Parse(content []byte) (*Config, []Issue) {
	return ParseBundle(Bundle{Main: content})
}

// yamlIssue turns a YAML library message ("yaml: line 3: ..." or "line 3: field x not found ...") into an issue.
func yamlIssue(msg string) Issue {
	msg = strings.TrimPrefix(msg, "yaml: ")
	is := Issue{Severity: SeverityError, Path: "yaml"}
	if m := yamlLine.FindStringSubmatch(msg); m != nil {
		is.Line, _ = strconv.Atoi(m[1])
		// The line travels in its own field: the message keeps only what is wrong.
		msg = strings.TrimSpace(yamlLinePrefix.ReplaceAllString(msg, ""))
	}
	is.Message = msg
	return is
}

// locate finds the 1-based line of an issue path in a parsed document: "apps[web]", "jobs[backup]",
// "registries[ghcr.io]", "proxy", "proxy.sites[0]", "notifications". 0 when it cannot be found.
func locate(root *yaml.Node, path string) int {
	if lines, _ := locateAll(root, path); len(lines) > 0 {
		return lines[0]
	}
	return 0
}

// locateAll is locate for every entry of the document that matches the path (a name defined twice), in document order.
// exact is false when nothing matches and the line is the one of the section that should hold the entry.
func locateAll(root *yaml.Node, path string) (lines []int, exact bool) {
	top := topMapping(root)
	if top == nil {
		return nil, false
	}
	if rest, ok := strings.CutPrefix(path, "proxy.sites["); ok {
		if line := locateSite(top, strings.TrimSuffix(rest, "]")); line > 0 {
			return []int{line}, true
		}
		return nil, false
	}
	m := pathPattern.FindStringSubmatch(path)
	if m == nil {
		return nil, false
	}
	section, name, sub := m[1], m[2], m[3]
	indexed := strings.Contains(path, "[")
	key, value := mappingEntry(top, section)
	if key == nil {
		return nil, false
	}
	if !indexed || value.Kind != yaml.SequenceNode {
		return []int{key.Line}, !indexed
	}
	field := "name"
	if section == "registries" {
		field = "host"
	}
	for _, item := range value.Content {
		if item.Kind != yaml.MappingNode {
			continue
		}
		if _, v := mappingEntry(item, field); v != nil && v.Value == name {
			line := item.Line
			if sub != "" {
				if k, _ := mappingEntry(item, sub); k != nil && k.Line > 0 {
					line = k.Line
				}
			}
			lines = append(lines, line)
		}
	}
	if len(lines) == 0 {
		return []int{key.Line}, false
	}
	return lines, true
}

// pathPattern splits an issue path: section, the name of the entry in brackets, and a key of the entry.
var pathPattern = regexp.MustCompile(`^([a-z_]+)(?:\[([^\]]*)\])?(?:\.([a-z_]+))?$`)

// topMapping is the document's top-level mapping, or nil when the document is not one.
func topMapping(root *yaml.Node) *yaml.Node {
	n := root
	if n.Kind == yaml.DocumentNode && len(n.Content) > 0 {
		n = n.Content[0]
	}
	if n.Kind != yaml.MappingNode {
		return nil
	}
	return n
}

// mappingEntry returns the key and value nodes of a mapping entry, or nils.
func mappingEntry(m *yaml.Node, key string) (*yaml.Node, *yaml.Node) {
	for i := 0; i+1 < len(m.Content); i += 2 {
		if m.Content[i].Value == key {
			return m.Content[i], m.Content[i+1]
		}
	}
	return nil, nil
}

// LoadIssues is the text form of a failed parse, for a log line or a CLI.
func LoadIssues(issues []Issue) error {
	var errs []error
	for _, is := range issues {
		if is.Severity != SeverityError {
			continue
		}
		if is.Line > 0 {
			errs = append(errs, fmt.Errorf("line %d: %s", is.Line, is.Message))
		} else {
			errs = append(errs, errors.New(is.Message))
		}
	}
	return errors.Join(errs...)
}

// locateSite finds the line of proxy.sites[index], falling back to the proxy section.
func locateSite(top *yaml.Node, index string) int {
	key, proxy := mappingEntry(top, "proxy")
	if key == nil {
		return 0
	}
	if proxy.Kind != yaml.MappingNode {
		return key.Line
	}
	k, sites := mappingEntry(proxy, "sites")
	if k == nil || sites.Kind != yaml.SequenceNode {
		return key.Line
	}
	if i, err := strconv.Atoi(index); err == nil && i >= 0 && i < len(sites.Content) {
		return sites.Content[i].Line
	}
	return k.Line
}
