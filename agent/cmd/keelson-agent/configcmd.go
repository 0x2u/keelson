package main

import (
	"bytes"
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"strings"

	"github.com/0x2u/keelson/agent/internal/config"
	"github.com/0x2u/keelson/agent/internal/confmgr"
)

const configUsage = "usage: keelson-agent config validate --apps FILE [--projects-dir DIR] [--format text|json|github] [--strict]\n" +
	"       keelson-agent config split --apps FILE --project NAME [--projects-dir DIR] [--dry-run]\n" +
	"       keelson-agent config dump --apps FILE [--projects-dir DIR]\n" +
	"       keelson-agent config migrate --apps FILE [--projects-dir DIR] [--dry-run] [--drop-builders] [--pin-legacy-defaults]\n" +
	"                                    [--no-backup] [--allow-leftovers]"

// Exit codes of `config migrate`.
const (
	exitRefused   = 1 // the configuration is invalid, or the migration would change what runs
	exitUsage     = 2
	exitLeftovers = 3 // something could not be migrated and --allow-leftovers was not given
)

// exitError makes main exit with a given code (and print err when it is not nil).
type exitError struct {
	code int
	err  error
}

func (e *exitError) Error() string {
	if e.err == nil {
		return ""
	}
	return e.err.Error()
}

func (e *exitError) Unwrap() error { return e.err }

// configCmd runs `keelson-agent config ...`: commands on the configuration files, which work on the files and need no
// running agent (a running one picks the change up like a hand edit, within seconds).
func configCmd(_ context.Context, args []string) error {
	if len(args) == 0 {
		return errors.New(configUsage)
	}
	switch args[0] {
	case "validate":
		return configValidate(args[1:], os.Stdout)
	case "split":
		return configSplit(args[1:], os.Stdout)
	case "dump":
		return configDump(args[1:], os.Stdout)
	case "migrate":
		return configMigrate(args[1:], os.Stdout, os.Stderr)
	}
	return errors.New(configUsage)
}

// configDump prints what the configuration makes the agent run (the apps file and its project files), as neutral JSON
// with the secrets hidden: the same text for the same runtime whatever the YAML spelling, so a diff before and after a
// change of the files shows exactly what the change does to what runs (see docs/schema.md). It reads the
// files and nothing else: no secret file, no Docker, no running agent.
func configDump(args []string, out io.Writer) error {
	fs := flag.NewFlagSet("config dump", flag.ContinueOnError)
	appsFile := fs.String("apps", env("KEELSON_APPS", ""), "apps file")
	projectsDir := fs.String("projects-dir", env("KEELSON_PROJECTS_DIR", ""), "directory of the per-project files (default: projects.d next to the apps file)")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if *appsFile == "" || fs.NArg() != 0 {
		return errors.New(configUsage)
	}
	cfg, err := config.LoadFrom(location(*appsFile, *projectsDir))
	if err != nil {
		return err
	}
	b, err := cfg.RuntimeJSON()
	if err != nil {
		return err
	}
	_, err = out.Write(b)
	return err
}

// configSplit moves what belongs to one project out of the apps file into projects.d/NAME.yaml, atomically, and only when
// that leaves the configuration running exactly what it ran. With --dry-run it only says what would move.
func configSplit(args []string, out io.Writer) error {
	fs := flag.NewFlagSet("config split", flag.ContinueOnError)
	appsFile := fs.String("apps", env("KEELSON_APPS", ""), "apps file")
	projectsDir := fs.String("projects-dir", env("KEELSON_PROJECTS_DIR", ""), "directory of the per-project files (default: projects.d next to the apps file)")
	project := fs.String("project", "", "the project to move into its own file")
	dryRun := fs.Bool("dry-run", false, "say what would move and change nothing")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if *appsFile == "" || *project == "" || fs.NArg() != 0 {
		return errors.New(configUsage)
	}
	loc := location(*appsFile, *projectsDir)
	before, err := loc.Read()
	if err != nil {
		return err
	}
	next, plan, err := before.SplitProject(*project)
	if err != nil {
		return err
	}

	verb := "moved"
	if *dryRun {
		verb = "would move"
	}
	fmt.Fprintf(out, "%s into %s:\n", verb, plan.File)
	for _, group := range []struct {
		kind  string
		names []string
	}{{"app", plan.Apps}, {"job", plan.Jobs}, {"database", plan.Databases}, {"previews of", plan.Previews}} {
		for _, n := range group.names {
			fmt.Fprintf(out, "  %s %s\n", group.kind, n)
		}
	}
	for _, k := range plan.Kept {
		fmt.Fprintf(out, "  kept in the apps file: %s %s (%s)\n", k.Kind, k.Name, k.Reason)
	}
	if *dryRun {
		fmt.Fprintln(out, "the configuration would run exactly what it runs now; nothing was changed")
		return nil
	}
	if err := loc.Write(before, next); err != nil {
		return err
	}
	fmt.Fprintf(out, "%s written; a running agent applies it within seconds as a new version\n", loc.ProjectPath(*project))
	return nil
}

// configMigrate rewrites the configuration files that use the legacy schema into schema v1, atomically, and only when the
// result loads without a deprecation (what cannot be migrated by itself is listed) and runs exactly what the files run now.
// The original of every file it changes is kept as <file>.pre-v1. See docs/schema.md.
//
// Exit codes: 0 done, or nothing to migrate; 1 refused (invalid, or the runtime would differ); 2 usage; 3 leftovers and no
// --allow-leftovers (a dry run reports them the same way).
func configMigrate(args []string, out, errOut io.Writer) error {
	fs := flag.NewFlagSet("config migrate", flag.ContinueOnError)
	fs.SetOutput(errOut)
	appsFile := fs.String("apps", env("KEELSON_APPS", ""), "apps file")
	projectsDir := fs.String("projects-dir", env("KEELSON_PROJECTS_DIR", ""), "directory of the per-project files (default: projects.d next to the apps file)")
	dryRun := fs.Bool("dry-run", false, "say what would change and write nothing")
	dropBuilders := fs.Bool("drop-builders", false, "remove the apps that only build (build.only) and write the build_limits that cover them")
	pin := fs.Bool("pin-legacy-defaults", false, `write restart: "no" on the apps without restart, which is what they ran with before the default became unless-stopped`)
	noBackup := fs.Bool("no-backup", false, "do not keep the original of each changed file as <file>.pre-v1")
	allowLeftovers := fs.Bool("allow-leftovers", false, "migrate even when something cannot be migrated by itself (it stays as it is)")
	if err := fs.Parse(args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return err
		}
		return &exitError{exitUsage, err}
	}
	if *appsFile == "" || fs.NArg() != 0 {
		return &exitError{exitUsage, errors.New(configUsage)}
	}
	loc := location(*appsFile, *projectsDir)
	before, err := loc.Read()
	if err != nil {
		return &exitError{exitRefused, err}
	}
	next, plan, err := before.Migrate(config.MigrateOptions{DropBuilders: *dropBuilders, PinLegacyDefaults: *pin})
	if err != nil {
		return &exitError{exitRefused, err}
	}

	for _, e := range plan.Edits {
		fmt.Fprintf(out, "%s\n", editLine(e))
	}
	for _, e := range plan.Leftovers {
		fmt.Fprintf(out, "left as it is: %s\n", editLine(e))
	}
	leftovers := len(plan.Leftovers) > 0 && !*allowLeftovers
	switch {
	case plan.Empty() && len(plan.Leftovers) == 0:
		fmt.Fprintln(out, "nothing to migrate: the configuration is already schema v1")
		return nil
	case plan.Empty():
		fmt.Fprintln(out, "nothing could be migrated by itself; the files are unchanged")
	default:
		fmt.Fprintln(out, "the migrated configuration loads without deprecations and runs exactly what runs now")
	}
	if leftovers {
		fmt.Fprintln(out, "nothing was written: some of it cannot be migrated by itself (see above); migrate it by hand, or give --allow-leftovers to migrate the rest")
		return &exitError{exitLeftovers, nil}
	}
	if *dryRun || plan.Empty() {
		if *dryRun {
			fmt.Fprintf(out, "dry run: nothing was changed (would write %s)\n", strings.Join(plan.Changed, ", "))
		}
		return nil
	}
	if !*noBackup {
		for _, f := range changedFiles(loc, before, next) {
			backup := f + ".pre-v1"
			if _, err := os.Stat(backup); err == nil {
				fmt.Fprintf(out, "%s already exists: it is kept (it holds the original of an earlier migration)\n", backup)
				continue
			}
			data, err := os.ReadFile(f)
			if err != nil {
				return &exitError{exitRefused, err}
			}
			if err := os.WriteFile(backup, data, 0o600); err != nil {
				return &exitError{exitRefused, fmt.Errorf("keep the original: %w", err)}
			}
			fmt.Fprintf(out, "original kept as %s\n", backup)
		}
	}
	if err := loc.Write(before, next); err != nil {
		return &exitError{exitRefused, err}
	}
	fmt.Fprintf(out, "written: %s; a running agent applies it within seconds as a new version\n", strings.Join(plan.Changed, ", "))
	if len(plan.Dropped) > 0 {
		fmt.Fprintf(out, "the builder apps %s are removed, which a running agent does not apply until it is acknowledged: write the hash below to %s\n  %s\n",
			strings.Join(plan.Dropped, ", "), loc.File+confmgr.ForceSuffix, next.Hash())
	}
	return nil
}

func editLine(e config.Edit) string {
	where := e.File
	if e.Line > 0 {
		where = strings.TrimSpace(fmt.Sprintf("%s line %d", where, e.Line))
	}
	if where == "" {
		return e.Message
	}
	return where + ": " + e.Message
}

// changedFiles are the paths of the files a write changes.
func changedFiles(loc config.Location, before, next config.Bundle) []string {
	var out []string
	if !bytes.Equal(before.Main, next.Main) {
		out = append(out, loc.File)
	}
	for _, n := range next.ProjectNames() {
		if old, ok := before.Projects[n]; ok && !bytes.Equal(old, next.Projects[n]) {
			out = append(out, loc.ProjectPath(n))
		}
	}
	return out
}
