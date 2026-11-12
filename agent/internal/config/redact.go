package config

import (
	"bytes"
	"errors"
	"fmt"
	"sort"
	"strconv"
	"strings"

	"gopkg.in/yaml.v3"
)

// Hidden stands for a secret value in every document the API sends out. Sending it back means "keep
// the stored value". The dashboard shows such fields as "set" and never learns the value.
const Hidden = "<hidden>"

// secretRef is one value that must not leave the agent: where it is, and a stable identity that
// survives reordering and edits, so a placeholder can be matched with its stored value.
type secretRef struct {
	ID   string
	Path string
	Node *yaml.Node
	// Mask, when set, says what stands for the value in a document the API sends: part of the value stays readable
	// ("API_KEY=", "--token=", a URL up to its query). Nil means the whole value is replaced by Hidden.
	Mask func(value string) string
}

// masked is what replaces the value of s in an outgoing document.
func (s secretRef) masked(value string) string {
	if s.Mask != nil {
		return s.Mask(value)
	}
	return Hidden
}

func parseNode(content []byte) (*yaml.Node, error) {
	var root yaml.Node
	if err := yaml.Unmarshal(content, &root); err != nil {
		return nil, err
	}
	return &root, nil
}

func encodeNode(root *yaml.Node) ([]byte, error) {
	var buf bytes.Buffer
	enc := yaml.NewEncoder(&buf)
	enc.SetIndent(2)
	if err := enc.Encode(root); err != nil {
		return nil, err
	}
	if err := enc.Close(); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

// secretsOf lists the secret scalars of a document: app and previews environment values, job HTTP headers and body,
// webhook URLs and the heartbeat URL (these carry tokens in their path or query).
func secretsOf(root *yaml.Node) []secretRef {
	top := topMapping(root)
	if top == nil {
		return nil
	}
	var out []secretRef
	scalar := func(id, path string, n *yaml.Node) {
		if n != nil && n.Kind == yaml.ScalarNode {
			out = append(out, secretRef{ID: id, Path: path, Node: n})
		}
	}
	forEach := func(m *yaml.Node, fn func(key string, value *yaml.Node)) {
		if m == nil || m.Kind != yaml.MappingNode {
			return
		}
		for i := 0; i+1 < len(m.Content); i += 2 {
			fn(m.Content[i].Value, m.Content[i+1])
		}
	}
	items := func(section string) []*yaml.Node {
		if _, v := mappingEntry(top, section); v != nil && v.Kind == yaml.SequenceNode {
			return v.Content
		}
		return nil
	}
	nameOf := func(item *yaml.Node) string {
		if _, v := mappingEntry(item, "name"); v != nil {
			return v.Value
		}
		return ""
	}

	for _, app := range items("apps") {
		name := nameOf(app)
		_, env := mappingEntry(app, "env")
		forEach(env, func(k string, v *yaml.Node) { scalar("env|"+name+"|"+k, "apps["+name+"].env."+k, v) })
	}
	for _, preview := range items("previews") {
		app := ""
		if _, v := mappingEntry(preview, "app"); v != nil {
			app = v.Value
		}
		_, env := mappingEntry(preview, "env")
		forEach(env, func(k string, v *yaml.Node) { scalar("penv|"+app+"|"+k, "previews["+app+"].env."+k, v) })
	}
	for _, job := range items("jobs") {
		name := nameOf(job)
		_, h := mappingEntry(job, "http")
		if h == nil || h.Kind != yaml.MappingNode {
			continue
		}
		_, headers := mappingEntry(h, "headers")
		forEach(headers, func(k string, v *yaml.Node) {
			scalar("header|"+name+"|"+strings.ToLower(k), "jobs["+name+"].http.headers."+k, v)
		})
		_, body := mappingEntry(h, "body")
		scalar("body|"+name, "jobs["+name+"].http.body", body)
	}
	if _, n := mappingEntry(top, "notifications"); n != nil && n.Kind == yaml.MappingNode {
		if _, hooks := mappingEntry(n, "webhooks"); hooks != nil && hooks.Kind == yaml.SequenceNode {
			for i, hook := range hooks.Content {
				_, u := mappingEntry(hook, "url")
				scalar("webhook|"+strconv.Itoa(i), "notifications.webhooks["+strconv.Itoa(i)+"].url", u)
			}
		}
		if _, hb := mappingEntry(n, "heartbeat"); hb != nil && hb.Kind == yaml.MappingNode {
			_, u := mappingEntry(hb, "url")
			scalar("heartbeat", "notifications.heartbeat.url", u)
		}
	}
	out = append(out, commandSecrets(top)...)
	return out
}

// Redact returns the document with every secret value replaced by Hidden. The rest of the text, comments
// and blank lines included, is left exactly as written wherever it can be. It fails closed: when a secret
// cannot be replaced, there is an error and no text.
func Redact(content []byte) ([]byte, error) {
	root, err := parseNode(content)
	if err != nil {
		return nil, err
	}
	repl := map[*yaml.Node]string{}
	for _, s := range secretsOf(root) {
		if s.Node.Value != "" && !strings.Contains(s.Node.Value, Hidden) {
			repl[s.Node] = s.masked(s.Node.Value)
		}
	}
	return replaceScalars(content, root, repl)
}

// Restore turns a submitted document back into a storable one: each Hidden value is replaced by the value
// stored in current for the same secret. A Hidden value with nothing stored is an error issue. Secrets that
// were stored and are gone from the submitted document come back as warnings.
func Restore(submitted, current []byte) ([]byte, []Issue) {
	root, err := parseNode(submitted)
	if err != nil {
		return submitted, nil // Parse reports the syntax error
	}
	stored := map[string]secretRef{}
	if cur, err := parseNode(current); err == nil {
		for _, s := range secretsOf(cur) {
			if s.Node.Value != "" {
				stored[s.ID] = s
			}
		}
	}

	var issues []Issue
	repl := map[*yaml.Node]string{}
	present := map[string]bool{}
	for _, s := range secretsOf(root) {
		present[s.ID] = true
		if !strings.Contains(s.Node.Value, Hidden) {
			continue
		}
		old, ok := stored[s.ID]
		// A partly masked value ("API_KEY=<hidden>") stands for the stored one only while it is what was sent for it.
		if ok && s.Node.Value != Hidden && s.Node.Value != s.masked(old.Node.Value) {
			ok = false
		}
		if !ok {
			issues = append(issues, Issue{
				Severity: SeverityError, Path: s.Path, Line: s.Node.Line,
				Message: fmt.Sprintf("%s has no stored value to keep: enter it", s.Path),
			})
			continue
		}
		repl[s.Node] = old.Node.Value
	}
	ids := make([]string, 0, len(stored))
	for id := range stored {
		if !present[id] {
			ids = append(ids, id)
		}
	}
	sort.Strings(ids)
	for _, id := range ids {
		issues = append(issues, Issue{
			Severity: SeverityWarning, Path: stored[id].Path, Code: "secret_removed",
			Message: fmt.Sprintf("%s is removed: its value is no longer stored", stored[id].Path),
		})
	}

	out, err := replaceScalars(submitted, root, repl)
	if err != nil {
		return submitted, append(issues, Issue{Severity: SeverityError, Path: "yaml", Message: err.Error()})
	}
	return out, issues
}

// replaceScalars sets the value of the given scalar nodes. It edits the text in place so nothing else in
// the document moves; when a token cannot be delimited safely (block scalars, multi-line values) it
// re-encodes the whole document instead.
func replaceScalars(content []byte, root *yaml.Node, repl map[*yaml.Node]string) ([]byte, error) {
	if len(repl) == 0 {
		return content, nil
	}
	type splice struct {
		line, col, length int
		text              string
	}
	lines := strings.Split(string(content), "\n")
	var splices []splice
	inPlace := true
	for n, value := range repl {
		length, ok := tokenLength(lines, n)
		if !ok {
			inPlace = false
			break
		}
		splices = append(splices, splice{n.Line - 1, n.Column - 1, length, strconv.Quote(value)})
	}
	if inPlace {
		// Last to first on each line, so earlier columns stay valid.
		sort.Slice(splices, func(i, j int) bool {
			if splices[i].line != splices[j].line {
				return splices[i].line > splices[j].line
			}
			return splices[i].col > splices[j].col
		})
		for _, s := range splices {
			r := []rune(lines[s.line])
			lines[s.line] = string(r[:s.col]) + s.text + string(r[s.col+s.length:])
		}
		return []byte(strings.Join(lines, "\n")), nil
	}
	for n, value := range repl {
		n.Value, n.Style, n.Tag = value, yaml.DoubleQuotedStyle, "!!str"
	}
	out, err := encodeNode(root)
	if err != nil {
		return nil, errors.New("could not rewrite the document: " + err.Error())
	}
	return out, nil
}

// tokenLength is the number of runes the scalar occupies in the source line, or false when it cannot be
// told with certainty (block scalars, values spanning lines, anything not matching what the parser saw).
func tokenLength(lines []string, n *yaml.Node) (int, bool) {
	if n.Line < 1 || n.Line > len(lines) || n.Column < 1 {
		return 0, false
	}
	line := []rune(lines[n.Line-1])
	start := n.Column - 1
	if start >= len(line) {
		return 0, false
	}
	switch {
	case n.Style&(yaml.LiteralStyle|yaml.FoldedStyle) != 0:
		return 0, false
	case n.Style&yaml.DoubleQuotedStyle != 0:
		if line[start] != '"' {
			return 0, false
		}
		for i := start + 1; i < len(line); i++ {
			switch line[i] {
			case '\\':
				i++
			case '"':
				return i - start + 1, true
			}
		}
		return 0, false
	case n.Style&yaml.SingleQuotedStyle != 0:
		if line[start] != '\'' {
			return 0, false
		}
		for i := start + 1; i < len(line); i++ {
			if line[i] != '\'' {
				continue
			}
			if i+1 < len(line) && line[i+1] == '\'' {
				i++
				continue
			}
			return i - start + 1, true
		}
		return 0, false
	}
	value := []rune(n.Value)
	if len(value) == 0 || start+len(value) > len(line) || string(line[start:start+len(value)]) != n.Value {
		return 0, false
	}
	return len(value), true
}
