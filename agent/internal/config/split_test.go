package config

import (
	"reflect"
	"sort"
	"strings"
	"testing"
)

// monolith is an apps file that holds the shop next to other things.
const monolith = `# Server: keep this.
proxy: {}

apps:
  # The shop: production.
  - name: shop
    project: shop
    image: ghcr.io/o/shop
    port: 3000
    domains: [shop.example.com]
    env:
      SECRET_TOKEN: s3cr3t-value # kept by the dashboard
    release:
      steps:
        - {name: backup, backup: shop}
        - {name: second, backup: ledger}
  - name: shop-worker
    project: shop
    image: ghcr.io/o/worker
  # A different project.
  - name: blog
    project: blog
    image: ghcr.io/o/blog
    release:
      steps:
        - {name: ledger, backup: ledger}
  - name: other
    image: ghcr.io/o/other

jobs:
  # Calls the shop.
  - name: purge
    schedule: "@daily"
    http:
      url: https://shop.example.com/purge
      bearer: {app: shop, env: CRON_SECRET}
  - name: shop-cleanup
    project: shop
    schedule: "@daily"
    run: [/bin/true]
  - name: host-report
    schedule: "@daily"
    run: [/bin/true]
  - name: blog-job
    schedule: "@daily"
    container: {app: blog, command: [x]}
  - name: for-another
    project: blog
    schedule: "@daily"
    container: {app: shop, command: [x]}

databases:
  # The shop's database.
  - name: shop
    host: db
    database: shop
    user: shop
    backup:
      schedule: "@daily"
      recipients: [` + ageKey + `]
      destination: {local: {dir: /var/backups}}
  - name: ledger
    host: db
    database: ledger
    user: ledger
    backup:
      schedule: "@daily"
      recipients: [` + ageKey + `]
      destination: {local: {dir: /var/backups}}
  - name: archive
    project: shop
    host: db
    database: archive
    user: archive
  - name: blog-db
    project: blog
    host: db
    database: blog
    user: blog

previews:
  - {app: shop, domain: 'pr-{pr}-shop.example.com'}
`

func sorted(s []string) []string {
	out := append([]string(nil), s...)
	sort.Strings(out)
	return out
}

// stripped is the configuration without the project labels, by name: what runs.
func stripped(c *Config) map[string]any {
	out := map[string]any{"proxy": c.Proxy, "registries": c.Registries, "notifications": c.Notifications, "postgres": c.ManagedPostgres}
	for _, a := range c.Apps {
		a.Project = ""
		out["app:"+a.Name] = a
	}
	for _, j := range c.Jobs {
		j.Project = ""
		out["job:"+j.Name] = j
	}
	for _, d := range c.Databases {
		d.Project = ""
		out["db:"+d.Name] = d
	}
	return out
}

func TestSplitMovesTheProjectAndLeavesTheConfigurationRunningTheSame(t *testing.T) {
	b := mk(monolith, nil)
	orig := b.Clone()
	before, issues := ParseBundle(b)
	if before == nil {
		t.Fatal(issues)
	}
	next, plan, err := b.SplitProject("shop")
	if err != nil {
		t.Fatal(err)
	}
	if !b.Equal(orig) {
		t.Error("a split computes the new bundle and changes nothing in the one it is given (a dry run needs that)")
	}
	if plan.Project != "shop" || plan.File != "projects.d/shop.yaml" ||
		!reflect.DeepEqual(sorted(plan.Apps), []string{"shop", "shop-worker"}) ||
		!reflect.DeepEqual(sorted(plan.Jobs), []string{"purge", "shop-cleanup"}) ||
		!reflect.DeepEqual(sorted(plan.Databases), []string{"archive", "shop"}) ||
		!reflect.DeepEqual(plan.Previews, []string{"shop"}) {
		t.Errorf("%+v", plan)
	}
	if len(plan.Kept) != 1 || plan.Kept[0].Name != "ledger" || plan.Kept[0].Kind != "database" || !strings.Contains(plan.Kept[0].Reason, "blog") {
		t.Errorf("the database that the blog's release also backs up stays: %+v", plan.Kept)
	}

	after, issues := ParseBundle(next)
	if after == nil {
		t.Fatal(issues)
	}
	if !reflect.DeepEqual(stripped(before), stripped(after)) {
		t.Error("the configuration that runs is not the same")
	}
	if err := Equivalent(before, after, "shop"); err != nil {
		t.Error(err)
	}

	main, project := string(next.Main), string(next.Projects["shop"])
	for _, want := range []string{"name: shop\n", "name: shop-worker", "name: purge", "name: shop-cleanup", "name: archive", "previews:"} {
		if !strings.Contains(project, want) || (want != "name: shop\n" && strings.Contains(main, want)) {
			t.Errorf("%q should be in the project file only:\nmain:\n%s\nproject:\n%s", want, main, project)
		}
	}
	for _, stay := range []string{"name: blog", "name: other", "name: host-report", "name: blog-job", "name: for-another", "name: ledger", "name: blog-db", "proxy: {}"} {
		if !strings.Contains(main, stay) || strings.Contains(project, stay) {
			t.Errorf("%q must stay in the apps file:\n%s", stay, main)
		}
	}
	// The labelled entries of the shop are labelled in the project file as they were; the others get it from the file.
	for _, a := range after.Apps {
		if a.Name == "shop" || a.Name == "shop-worker" {
			if a.Project != "shop" {
				t.Errorf("%+v", a)
			}
		}
	}
	if j, _ := after.Job("purge"); j.Project != "shop" {
		t.Errorf("a job the dashboard derived into the project carries it now: %+v", j)
	}
	if j, _ := after.Job("for-another"); j.Project != "blog" || strings.Contains(project, "for-another") {
		t.Error("an entry labelled with another project never moves, whatever it calls")
	}

	// Comments travel with their entry; secrets are copied verbatim, not hidden.
	for _, c := range []string{"# The shop: production.", "# Calls the shop.", "# The shop's database.", "# kept by the dashboard"} {
		if !strings.Contains(project, c) || strings.Contains(main, c) {
			t.Errorf("%q should have moved:\nmain:\n%s\nproject:\n%s", c, main, project)
		}
	}
	for _, c := range []string{"# Server: keep this.", "# A different project."} {
		if !strings.Contains(main, c) || strings.Contains(project, c) {
			t.Errorf("%q should have stayed:\nmain:\n%s\nproject:\n%s", c, main, project)
		}
	}
	if !strings.Contains(project, "s3cr3t-value") || strings.Contains(project, Hidden) {
		t.Error("the secret moves as it is")
	}
}

func TestSplitMovesAnUnlabelledAppNamedLikeTheProjectAndItsJobs(t *testing.T) {
	doc := "apps:\n  - {name: shop, image: o/shop}\n  - {name: web, image: o/web}\njobs:\n  - {name: run, schedule: '@daily', container: {app: shop, command: [x]}}\n"
	b := mk(doc, nil)
	next, plan, err := b.SplitProject("shop")
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(plan.Apps, []string{"shop"}) || !reflect.DeepEqual(plan.Jobs, []string{"run"}) {
		t.Errorf("%+v", plan)
	}
	after := edited(t, next)
	if a, _ := after.App("shop"); a.Project != "shop" {
		t.Errorf("%+v", a)
	}
	if strings.Contains(string(next.Main), "shop") || !strings.Contains(string(next.Main), "web") {
		t.Errorf("%s", next.Main)
	}

	// All that is left is moved: the apps file stays a valid document.
	only := mk("apps:\n  - {name: shop, image: o/shop}\n", nil)
	next, _, err = only.SplitProject("shop")
	if err != nil {
		t.Fatal(err)
	}
	if c, issues := ParseBundle(next); c == nil || len(c.Apps) != 1 {
		t.Errorf("%+v %s", issues, next.Main)
	}
}

func TestSplitSectionThatMovesWholeTakesItsComment(t *testing.T) {
	doc := "# Jobs of the shop.\njobs:\n  - {name: j, project: shop, schedule: '@daily', run: [/bin/true]}\napps:\n  - {name: shop, image: o/shop}\n  - {name: web, image: o/web}\n"
	next, _, err := mk(doc, nil).SplitProject("shop")
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(next.Main), "# Jobs of the shop.") || !strings.Contains(string(next.Projects["shop"]), "# Jobs of the shop.") {
		t.Errorf("main:\n%s\nproject:\n%s", next.Main, next.Projects["shop"])
	}
}

func TestSplitRefusals(t *testing.T) {
	// Nothing to move.
	if _, plan, err := mk(monolith, nil).SplitProject("ghost"); err == nil || !strings.Contains(err.Error(), "nothing belongs to project") || !plan.Empty() {
		t.Errorf("%v %+v", err, plan)
	}
	// The project already has its file.
	if _, _, err := mk(monolith, map[string]string{"shop": "apps: []\n"}).SplitProject("shop"); err == nil || !strings.Contains(err.Error(), "already exists") {
		t.Errorf("%v", err)
	}
	// A name that cannot name a file.
	if _, _, err := mk(monolith, nil).SplitProject("Not A Name"); err == nil {
		t.Error("the project must be a name")
	}
	// A configuration that is not valid is not rearranged.
	if _, _, err := mk("apps:\n  - {name: shop, image: o/shop, bogus: 1}\n", nil).SplitProject("shop"); err == nil || !strings.Contains(err.Error(), "invalid") || !strings.Contains(err.Error(), "line 2") {
		t.Errorf("%v", err)
	}
}

func TestSplitKeepsOtherProjectFilesAsTheyAre(t *testing.T) {
	blog := "apps:\n  - {name: blog, image: o/blog}\n"
	b := mk("apps:\n  - {name: shop, project: shop, image: o/shop}\n  - {name: web, image: o/web}\n", map[string]string{"blog": blog})
	next, _, err := b.SplitProject("shop")
	if err != nil {
		t.Fatal(err)
	}
	if string(next.Projects["blog"]) != blog || len(next.Projects) != 2 {
		t.Errorf("%+v", next.Projects)
	}
}

func TestEquivalentSaysWhatDiffers(t *testing.T) {
	parse := func(doc string) *Config {
		c, issues := Parse([]byte(doc))
		if c == nil {
			t.Fatal(issues)
		}
		return c
	}
	base := "proxy: {}\napps:\n  - {name: shop, image: o/shop, port: 3000, domains: [shop.example.com]}\njobs:\n  - {name: j, schedule: '@daily', run: [/bin/true]}\n"
	b := parse(base)
	for name, tc := range map[string]struct{ doc, want string }{
		"image":    {strings.Replace(base, "o/shop", "o/shop2", 1), `app "shop" differs`},
		"job":      {strings.Replace(base, "@daily", "@hourly", 1), `job "j" differs`},
		"gone":     {strings.Replace(base, "jobs:\n  - {name: j, schedule: '@daily', run: [/bin/true]}\n", "", 1), `job "j" is gone`},
		"new":      {base + "databases:\n  - {name: d, host: h, database: d, user: u}\n", `database "d" is new`},
		"proxy":    {strings.Replace(base, "proxy: {}", "proxy: {admin: 'http://127.0.0.1:2999'}", 1), "the proxy differs"},
		"app list": {strings.Replace(base, "apps:\n", "apps:\n  - {name: extra, image: o/extra}\n", 1), `app "extra" is new`},
	} {
		if err := Equivalent(b, parse(tc.doc), "shop"); err == nil || !strings.Contains(err.Error(), tc.want) {
			t.Errorf("%s: %v, want %q", name, err, tc.want)
		}
	}
	// Order, and the label of the project that was split, are not differences.
	reordered := parse("proxy: {}\njobs:\n  - {name: j, project: shop, schedule: '@daily', run: [/bin/true]}\napps:\n  - {name: shop, project: shop, image: o/shop, port: 3000, domains: [shop.example.com]}\n")
	if err := Equivalent(b, reordered, "shop"); err != nil {
		t.Error(err)
	}
	// The label of another project is.
	other := parse("proxy: {}\njobs:\n  - {name: j, project: blog, schedule: '@daily', run: [/bin/true]}\napps:\n  - {name: shop, image: o/shop, port: 3000, domains: [shop.example.com]}\n")
	if err := Equivalent(b, other, "shop"); err == nil || !strings.Contains(err.Error(), `job "j" differs`) {
		t.Errorf("%v", err)
	}
	// An app that the dashboard would file under another project is a difference, even with the same image.
	moved := parse("proxy: {}\napps:\n  - {name: shop, project: elsewhere, image: o/shop, port: 3000, domains: [shop.example.com]}\njobs:\n  - {name: j, schedule: '@daily', run: [/bin/true]}\n")
	if err := Equivalent(b, moved, "shop"); err == nil {
		t.Error("an app's project is part of what the dashboard shows")
	}
}

func TestSplitIsRefusedWhenTheConfigurationWouldNotBeTheSame(t *testing.T) {
	saved := equivalent
	defer func() { equivalent = saved }()
	var seen [2]*Config
	equivalent = func(before, after *Config, project string) error {
		seen = [2]*Config{before, after}
		return saved(before, &Config{Registries: after.Registries, Apps: after.Apps[:1], Proxy: after.Proxy}, project)
	}
	b := mk(monolith, nil)
	orig := b.Clone()
	next, _, err := b.SplitProject("shop")
	if err == nil || !strings.Contains(err.Error(), "would change what runs") || !next.Equal(Bundle{}) {
		t.Fatalf("%v", err)
	}
	if seen[0] == nil || seen[1] == nil || len(seen[0].Apps) != len(seen[1].Apps) {
		t.Error("the check compares the configuration before with the one the files would make")
	}
	if !b.Equal(orig) {
		t.Error("nothing is changed")
	}
}
