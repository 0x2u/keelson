package config

import (
	"fmt"
	"regexp"
	"strings"

	"gopkg.in/yaml.v3"
)

// secretName says whether a flag, variable or build argument is named like something that holds a secret. The name
// stays visible in the documents the API sends: only the value is hidden.
var secretName = regexp.MustCompile(`(?i)token|secret|passw|key|credential`).MatchString

var identifier = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`)

// hiddenAfter masks a value but keeps what precedes it ("API_KEY=", "--token=", "https://host/path?").
func hiddenAfter(prefix string) func(string) string {
	return func(string) string { return prefix + Hidden }
}

// commandSecrets lists the secret scalars that sit in places an operator also reads: the arguments of the commands the
// agent runs (app commands, release steps, jobs), job URLs with a query string, and the values of build arguments named
// like secrets. Their identities do not depend on their position: an argument is known by the flag or variable that
// carries it.
func commandSecrets(top *yaml.Node) []secretRef {
	var out []secretRef
	seq := func(n *yaml.Node) []*yaml.Node {
		if n != nil && n.Kind == yaml.SequenceNode {
			return n.Content
		}
		return nil
	}
	nameOf := func(item *yaml.Node) string {
		if _, v := mappingEntry(item, "name"); v != nil {
			return v.Value
		}
		return ""
	}
	argv := func(scope, path string, n *yaml.Node) { out = append(out, argvSecrets(scope, path, seq(n))...) }

	_, apps := mappingEntry(top, "apps")
	for _, app := range seq(apps) {
		name := nameOf(app)
		_, cmd := mappingEntry(app, "command")
		argv("app|"+name+"|command", "apps["+name+"].command", cmd)
		if _, release := mappingEntry(app, "release"); release != nil && release.Kind == yaml.MappingNode {
			_, steps := mappingEntry(release, "steps")
			for i, step := range seq(steps) {
				stepName := nameOf(step)
				if stepName == "" {
					stepName = fmt.Sprint(i)
				}
				for _, field := range []string{"run", "command"} {
					_, v := mappingEntry(step, field)
					argv("step|"+name+"|"+stepName+"|"+field, "apps["+name+"].release.steps["+stepName+"]."+field, v)
				}
			}
		}
		if _, b := mappingEntry(app, "build"); b != nil && b.Kind == yaml.MappingNode {
			if _, args := mappingEntry(b, "args"); args != nil && args.Kind == yaml.MappingNode {
				for i := 0; i+1 < len(args.Content); i += 2 {
					key, v := args.Content[i].Value, args.Content[i+1]
					if secretName(key) && v.Kind == yaml.ScalarNode {
						out = append(out, secretRef{ID: "barg|" + name + "|" + key, Path: "apps[" + name + "].build.args." + key, Node: v})
					}
				}
			}
		}
	}

	_, jobs := mappingEntry(top, "jobs")
	for _, job := range seq(jobs) {
		name := nameOf(job)
		_, run := mappingEntry(job, "run")
		argv("job|"+name+"|run", "jobs["+name+"].run", run)
		if _, c := mappingEntry(job, "container"); c != nil && c.Kind == yaml.MappingNode {
			_, cmd := mappingEntry(c, "command")
			argv("job|"+name+"|command", "jobs["+name+"].container.command", cmd)
		}
		if _, h := mappingEntry(job, "http"); h != nil && h.Kind == yaml.MappingNode {
			if _, u := mappingEntry(h, "url"); u != nil && u.Kind == yaml.ScalarNode {
				if i := strings.IndexByte(u.Value, '?'); i >= 0 && i < len(u.Value)-1 {
					out = append(out, secretRef{ID: "url|" + name, Path: "jobs[" + name + "].http.url", Node: u, Mask: hiddenAfter(u.Value[:i+1])})
				}
			} else if u != nil {
				continue
			}
		}
	}
	return out
}

// argvSecrets finds the secret-looking arguments of one command: the element after a flag named like a secret
// ("--token abc"), "--token=abc", and "API_KEY=abc".
func argvSecrets(scope, path string, items []*yaml.Node) []secretRef {
	var out []secretRef
	seen := map[string]int{}
	add := func(key string, el *yaml.Node, mask func(string) string) {
		n := seen[key]
		seen[key]++
		out = append(out, secretRef{ID: fmt.Sprintf("argv|%s|%s|%d", scope, key, n), Path: path + "." + key, Node: el, Mask: mask})
	}
	prevFlag := ""
	for _, el := range items {
		if el.Kind != yaml.ScalarNode {
			prevFlag = ""
			continue
		}
		v := el.Value
		flag := prevFlag
		prevFlag = ""
		switch {
		case strings.Contains(v, Hidden) && !strings.HasPrefix(v, "-") && flag == "" && !strings.Contains(v, "="):
			// A placeholder that stands for a whole value without a flag before it is not one of ours.
		case strings.HasPrefix(v, "-"):
			if name, val, ok := strings.Cut(v, "="); ok {
				if secretName(name) && val != "" {
					add(name, el, hiddenAfter(name+"="))
				}
			} else {
				prevFlag = v
			}
		case flag != "":
			if secretName(strings.TrimLeft(flag, "-")) && v != "" {
				add(flag, el, nil)
			}
		default:
			if name, val, ok := strings.Cut(v, "="); ok && identifier.MatchString(name) && secretName(name) && val != "" {
				add(name, el, hiddenAfter(name+"="))
			}
		}
	}
	return out
}
