package config

import (
	"errors"
	"fmt"
	"sort"
	"strconv"
	"time"

	"gopkg.in/yaml.v3"
)

// MigrateOptions are the choices of Bundle.Migrate.
type MigrateOptions struct {
	// DropBuilders removes the apps that only build (build.only) and writes the build_limits that cover what they were
	// allowed to build.
	DropBuilders bool
	// PinLegacyDefaults writes `restart: "no"` on every app that has no restart key, so that an app that came back after
	// nothing keeps doing so (the default of an app without restart is now unless-stopped).
	PinLegacyDefaults bool
}

// MigratePlan says what a migration did to the files it returned.
type MigratePlan struct {
	// Edits are the changes, in the order they were made. Leftovers are what could not be migrated and stays as it is.
	Edits     []Edit `json:"edits"`
	Leftovers []Edit `json:"leftovers"`
	// Changed lists the files whose text changes: "apps.yaml" or the main file's name, and "projects.d/<p>.yaml".
	Changed []string `json:"changed"`
	// Dropped are the builder apps removed with DropBuilders.
	Dropped []string `json:"dropped"`
	// Pinned are the apps given `restart: "no"` with PinLegacyDefaults.
	Pinned []string `json:"pinned"`
}

// Empty says there is nothing to migrate.
func (p MigratePlan) Empty() bool { return len(p.Changed) == 0 }

// Migrate rewrites the files that use the legacy schema into the current one. Everything the loader reads as a legacy
// spelling (and warns about) is written in its new spelling, the comments, the quoting and the order of the entries are
// kept, and a file with nothing to migrate is not touched (not even re-encoded). The new bundle is only returned when it
// loads without a single deprecation warning (but for the leftovers: what cannot be moved by itself stays and is listed),
// and when the configuration it makes runs exactly what the one it replaces ran (see Equivalent), so a migration never
// changes what runs: the exceptions are the ones asked for (DropBuilders, PinLegacyDefaults) and are accounted for.
//
// It does the same edits as the loader makes in memory (upgradeBundle): the check that the migrated files are equivalent
// cannot prove by itself that the mapping from the old keys to the new ones keeps their meaning; what proves it is the
// golden dump of every legacy example (docs/schema.md).
func (b Bundle) Migrate(opt MigrateOptions) (Bundle, MigratePlan, error) {
	var plan MigratePlan
	before, issues := ParseBundle(b)
	if before == nil {
		return Bundle{}, plan, fmt.Errorf("the configuration is invalid, so it cannot be migrated: %s", firstError(issues))
	}
	docs, syntax := b.parseDocs()
	if len(syntax) > 0 {
		return Bundle{}, plan, fmt.Errorf("the configuration is invalid, so it cannot be migrated: %s", firstError(syntax))
	}
	u := &upgrader{docs: docs}
	u.run()
	if len(u.errs) > 0 {
		return Bundle{}, plan, fmt.Errorf("the configuration cannot be migrated: %s", firstError(u.errs))
	}
	pinned := map[string]bool{}
	if opt.PinLegacyDefaults {
		u.pinRestart(pinned)
	}
	if opt.DropBuilders {
		if err := u.dropBuilders(before, &plan); err != nil {
			return Bundle{}, plan, err
		}
	}

	next := b.Clone()
	for _, d := range docs {
		if !u.touched[d] {
			continue
		}
		out, err := encodeNode(&d.root)
		if err != nil {
			return Bundle{}, plan, err
		}
		next.SetContent(d.project, out)
		name := d.file
		if name == "" {
			name = defaultMainName
			if b.MainName != "" {
				name = b.MainName
			}
		}
		plan.Changed = append(plan.Changed, name)
	}
	dropped := map[string]bool{}
	for _, n := range plan.Dropped {
		dropped["apps["+n+"].build.only"] = true
	}
	for _, e := range u.edits {
		if e.Leftover && dropped[e.Path] {
			continue // the builder is gone
		}
		if e.Leftover {
			plan.Leftovers = append(plan.Leftovers, e)
		} else {
			plan.Edits = append(plan.Edits, e)
		}
	}
	for name := range pinned {
		plan.Pinned = append(plan.Pinned, name)
	}
	sort.Strings(plan.Pinned)
	if len(plan.Changed) == 0 {
		return b.Clone(), plan, nil
	}

	after, again, _ := parseBundle(next)
	if after == nil {
		return Bundle{}, plan, fmt.Errorf("bug: the migrated files are invalid, so nothing was changed: %s", firstError(again))
	}
	left := map[string]bool{}
	for _, l := range plan.Leftovers {
		left[l.Path] = true
	}
	for _, dep := range Deprecations(again) {
		if !left[dep.Path] {
			return Bundle{}, plan, fmt.Errorf("bug: a rule missed %s (%s), so nothing was changed", dep.Path, dep.Message)
		}
	}
	if err := equivalentMigration(before, after, opt, pinned); err != nil {
		return Bundle{}, plan, fmt.Errorf("the migration would change what runs, so nothing was changed: %w", err)
	}
	return next, plan, nil
}

// Deprecations picks the deprecation warnings out of the issues of a parse.
func Deprecations(issues []Issue) []Issue {
	var out []Issue
	for _, is := range issues {
		if is.Code == CodeDeprecated {
			out = append(out, is)
		}
	}
	return out
}

// equivalentMigration is Equivalent with the differences the options ask for taken into account.
var equivalentMigration = func(before, after *Config, opt MigrateOptions, pinned map[string]bool) error {
	b := *before
	b.Apps = append([]App(nil), before.Apps...)
	for i := range b.Apps {
		if pinned[b.Apps[i].Name] {
			b.Apps[i].Restart = "no"
		}
	}
	if opt.DropBuilders {
		kept := b.Apps[:0:0]
		for _, a := range b.Apps {
			if !a.BuildOnly() {
				kept = append(kept, a)
			}
		}
		b.Apps = kept
		b.BuildLimits = after.BuildLimits
	}
	return Equivalent(&b, after, "")
}

// pinRestart writes `restart: "no"` on the apps that have no restart key.
func (u *upgrader) pinRestart(pinned map[string]bool) {
	for _, d := range u.docs {
		top := topMapping(&d.root)
		if top == nil {
			continue
		}
		for _, app := range items(section(top, "apps")) {
			app = deref(app)
			if !isMapping(app) || value(app, "restart") != nil || isTrue(value(value(app, "build"), "only")) {
				continue
			}
			name := text(app, "name")
			v := strNode("no")
			v.Style = yaml.DoubleQuotedStyle
			at := len(app.Content)
			if _, _, i := entry(app, "image"); i >= 0 {
				at = i + 2
			}
			insertEntry(app, at, strNode("restart"), v)
			u.touch(d)
			pinned[name] = true
			u.edit(d, app.Line, "apps["+name+"].restart", "(restart left out)", `restart: "no"`, "restart: pinned to \"no\", which is what an app without restart got before the default became unless-stopped")
		}
	}
}

// dropBuilders removes the apps that only build and writes the build_limits that cover them.
func (u *upgrader) dropBuilders(before *Config, plan *MigratePlan) error {
	var builders []App
	for _, a := range before.Apps {
		if a.BuildOnly() {
			builders = append(builders, a)
		}
	}
	if len(builders) == 0 {
		return nil
	}
	main := u.docs[0]
	top := topMapping(&main.root)
	if top == nil {
		return errors.New("the apps file is not a mapping")
	}
	if value(top, "build_limits") != nil {
		return errors.New("--drop-builders: the apps file already has build_limits, and the limits of the builders cannot be merged into them by hand-written values: remove one of the two")
	}
	limits := newMapping()
	var (
		mem, maxSource int64
		cpus           float64
		timeout        = int64(0)
		keep           = DefaultKeepImages
		hosts          []string
		hostNet        bool
	)
	for _, a := range builders {
		mem = max(mem, a.Build.MemoryBytes())
		maxSource = max(maxSource, a.Build.MaxSourceBytes())
		cpus = max(cpus, a.Build.CPUCount())
		timeout = max(timeout, int64(a.Build.TimeoutFor()))
		keep = max(keep, a.KeepImagesOrDefault())
		for _, h := range a.Build.SourceHosts {
			if !contains(DefaultSourceHosts, h) && !contains(hosts, h) {
				hosts = append(hosts, h)
			}
		}
		hostNet = hostNet || a.Build.Network == BuildNetworkHost
	}
	add := func(k, v string) { appendEntry(limits, strNode(k), strNode(v)) }
	add("memory", Size(mem).String())
	add("cpus", strconv.FormatFloat(cpus, 'f', -1, 64))
	if cpus == float64(int64(cpus)) {
		limits.Content[len(limits.Content)-1].Tag = "!!int"
	} else {
		limits.Content[len(limits.Content)-1].Tag = "!!float"
	}
	add("timeout", FormatDuration(durationOf(timeout)))
	add("max_source", Size(maxSource).String())
	if len(hosts) > 0 {
		seq := newSequence()
		for _, h := range append(append([]string(nil), DefaultSourceHosts...), hosts...) {
			seq.Content = append(seq.Content, strNode(h))
		}
		seq.Style = yaml.FlowStyle
		appendEntry(limits, strNode("source_hosts"), seq)
	}
	if hostNet {
		appendEntry(limits, strNode("host_network"), &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!bool", Value: "true"})
	}
	if keep != DefaultKeepImages {
		appendEntry(limits, strNode("keep_images"), &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!int", Value: strconv.Itoa(keep)})
	}
	limits.Style = yaml.FlowStyle
	appendEntry(top, strNode("build_limits"), limits)
	u.touch(main)
	u.edit(main, 0, "build_limits", "(builder apps)", "build_limits", "build_limits written: the largest of what the builder apps were allowed to build")

	names := map[string]bool{}
	for _, a := range builders {
		names[a.Name] = true
		plan.Dropped = append(plan.Dropped, a.Name)
	}
	for _, d := range u.docs {
		dtop := topMapping(&d.root)
		if dtop == nil {
			continue
		}
		seq := section(dtop, "apps")
		if seq == nil {
			continue
		}
		kept := seq.Content[:0:0]
		for _, item := range seq.Content {
			if names[text(item, "name")] {
				u.touch(d)
				u.edit(d, deref(item).Line, "apps["+text(item, "name")+"]", "apps["+text(item, "name")+"] (build.only)", "(removed)", "the builder app "+text(item, "name")+" is removed: builds come through POST /v1/builds within build_limits")
				continue
			}
			kept = append(kept, item)
		}
		seq.Content = kept
		if len(kept) == 0 {
			// `apps: []` keeps the file valid for what the installer and the dashboard expect of a machine's file.
			seq.Style = yaml.FlowStyle
		}
	}
	return nil
}

func contains(list []string, s string) bool {
	for _, v := range list {
		if v == s {
			return true
		}
	}
	return false
}

func durationOf(ns int64) time.Duration { return time.Duration(ns) }
