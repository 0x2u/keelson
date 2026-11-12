package main

import (
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"strings"

	"github.com/0x2u/keelson/agent/internal/config"
)

// configValidate checks the apps file and its project files the way the agent does when it loads them, and says what is
// wrong with the file and line of each problem. It reads the files and nothing else: no secret file, no Docker, no
// running agent, so it runs on a laptop or in CI against the file a server will get.
//
// Exit codes: 0 valid (warnings do not change that, unless --strict), 1 invalid, 2 usage or a file that cannot be read.
func configValidate(args []string, out io.Writer) error {
	fs := flag.NewFlagSet("config validate", flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	appsFile := fs.String("apps", env("KEELSON_APPS", ""), "apps file")
	projectsDir := fs.String("projects-dir", env("KEELSON_PROJECTS_DIR", ""), "directory of the per-project files (default: projects.d next to the apps file)")
	format := fs.String("format", "text", "text, json or github (workflow annotations)")
	strict := fs.Bool("strict", false, "a warning (a deprecated key) fails the check too")
	if err := fs.Parse(args); err != nil {
		return &exitError{exitUsage, fmt.Errorf("%w\n%s", err, configUsage)}
	}
	if *appsFile == "" || fs.NArg() != 0 || (*format != "text" && *format != "json" && *format != "github") {
		return &exitError{exitUsage, errors.New(configUsage)}
	}

	loc := location(*appsFile, *projectsDir)
	bundle, err := loc.Read()
	if err != nil {
		return &exitError{exitUsage, err}
	}
	cfg, issues := config.ParseBundle(bundle)

	errorsFound, warnings := 0, 0
	for _, is := range issues {
		if is.Severity == config.SeverityError {
			errorsFound++
		} else {
			warnings++
		}
	}
	failed := errorsFound > 0 || (*strict && warnings > 0)

	switch *format {
	case "json":
		if issues == nil {
			issues = []config.Issue{}
		}
		b, err := json.MarshalIndent(struct {
			Valid  bool           `json:"valid"`
			Issues []config.Issue `json:"issues"`
		}{!failed, issues}, "", "  ")
		if err != nil {
			return err
		}
		fmt.Fprintf(out, "%s\n", b)
	case "github":
		for _, is := range issues {
			level := "error"
			if is.Severity != config.SeverityError {
				level = "warning"
			}
			props := "file=" + githubEscape(issueFile(loc, is), true)
			if is.Line > 0 {
				props += fmt.Sprintf(",line=%d", is.Line)
			}
			fmt.Fprintf(out, "::%s %s::%s\n", level, props, githubEscape(issueText(is), false))
		}
	default:
		for _, is := range issues {
			where := issueFile(loc, is)
			if is.Line > 0 {
				where += fmt.Sprintf(":%d", is.Line)
			}
			fmt.Fprintf(out, "%s: %s: %s\n", where, is.Severity, issueText(is))
		}
		switch {
		case errorsFound > 0:
			fmt.Fprintf(out, "invalid: %s, %s\n", plural(errorsFound, "error"), plural(warnings, "warning"))
		case failed:
			fmt.Fprintf(out, "refused by --strict: %s\n", plural(warnings, "warning"))
		default:
			fmt.Fprintf(out, "valid: %s, %s, %s", plural(len(cfg.Apps), "app"), plural(len(cfg.Jobs), "job"), plural(len(cfg.Databases), "database"))
			if warnings > 0 {
				fmt.Fprintf(out, ", %s", plural(warnings, "warning"))
			}
			fmt.Fprintln(out)
		}
	}
	if failed {
		return &exitError{code: exitRefused}
	}
	return nil
}

// issueFile is the path of the file an issue is in, as the operator wrote it on the command line.
func issueFile(loc config.Location, is config.Issue) string {
	if is.Project != "" {
		return loc.ProjectPath(is.Project)
	}
	return loc.File
}

// issueText is what is wrong, with the entry it is about when the message does not already say.
func issueText(is config.Issue) string {
	if is.Path == "" || is.Path == "yaml" || strings.Contains(is.Message, is.Path) {
		return is.Message
	}
	// "apps[web]" is already said by a message that names the app.
	if _, rest, ok := strings.Cut(is.Path, "["); ok {
		name, key, _ := strings.Cut(rest, "]")
		if strings.Contains(is.Message, `"`+name+`"`) && key == "" {
			return is.Message
		}
	}
	return is.Message + " (" + is.Path + ")"
}

// githubEscape escapes a workflow command's message, and its properties when prop is set.
func githubEscape(s string, prop bool) string {
	s = strings.NewReplacer("%", "%25", "\r", "%0D", "\n", "%0A").Replace(s)
	if prop {
		s = strings.NewReplacer(":", "%3A", ",", "%2C").Replace(s)
	}
	return s
}

func plural(n int, word string) string {
	if n == 1 {
		return fmt.Sprintf("1 %s", word)
	}
	return fmt.Sprintf("%d %ss", n, word)
}
