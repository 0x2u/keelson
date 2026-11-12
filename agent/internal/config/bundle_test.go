package config

import (
	"reflect"
	"strconv"
	"strings"
	"testing"
)

const ageKey = "age1ql3z7hjy54pw3hyww5ayyfg7zqgvc7w3j2elw8zmrj2kg5sfn9aqmcac8p"

// mainDoc holds what is server-wide, an app of its own and nothing of the shop.
const mainDoc = `# The server.
proxy: {}
apps:
  - name: web
    image: ghcr.io/o/web
    port: 3000
    domains: [web.example.com]
jobs:
  - name: report
    schedule: "@daily"
    run: [/bin/true]
`

// shopDoc is a whole project: an app with a release backup, a job calling it, its database.
const shopDoc = `# The shop.
apps:
  - name: shop
    image: ghcr.io/o/shop
    env:
      SECRET_TOKEN: s3cr3t-value
    release:
      steps:
        - {name: backup, backup: shop}
jobs:
  - name: purge
    schedule: "@daily"
    http:
      url: https://shop.example.com/purge
      bearer: {app: shop, env: CRON_SECRET}
databases:
  - name: shop
    host: db
    database: shop
    user: shop
    backup:
      schedule: "@daily"
      recipients: [` + ageKey + `]
      destination: {local: {dir: /var/backups}}
`

func mk(main string, projects map[string]string) Bundle {
	b := Bundle{MainName: "apps.yaml", Main: []byte(main)}
	for n, c := range projects {
		b.SetContent(n, []byte(c))
	}
	return b
}

// lineOf is the 1-based line of the first line containing needle.
func lineOf(t *testing.T, doc, needle string) int {
	t.Helper()
	for i, l := range strings.Split(doc, "\n") {
		if strings.Contains(l, needle) {
			return i + 1
		}
	}
	t.Fatalf("%q is not in the document", needle)
	return 0
}

// blockLine is the 1-based line where the block of text starts in the document.
func blockLine(doc, block string) int {
	return strings.Count(doc[:strings.Index(doc, block)], "\n") + 1
}

func errorsOf(issues []Issue) []Issue {
	var out []Issue
	for _, is := range issues {
		if is.Severity == SeverityError {
			out = append(out, is)
		}
	}
	return out
}

func TestWithoutProjectFilesParseBundleIsParse(t *testing.T) {
	for name, doc := range map[string]string{
		"valid":     mainDoc,
		"unknown":   "apps:\n  - {name: web, image: ghcr.io/o/web, bogus: 1}\n",
		"duplicate": "apps:\n  - {name: web, image: o/web}\n  - {name: web, image: o/web2}\n",
		"syntax":    "apps: [\n",
		"empty":     "",
	} {
		c1, i1 := Parse([]byte(doc))
		c2, i2 := ParseBundle(Bundle{MainName: "apps.yaml", Main: []byte(doc)})
		if (c1 == nil) != (c2 == nil) || !reflect.DeepEqual(i1, i2) {
			t.Errorf("%s: %+v / %+v differ from %+v / %+v", name, c1, i1, c2, i2)
		}
		for _, is := range i2 {
			if is.File != "" || is.Project != "" {
				t.Errorf("%s: a configuration without project files names no file: %+v", name, is)
			}
		}
	}
	// The duplicate is still reported at the first definition, as it always was.
	_, issues := Parse([]byte("apps:\n  - {name: web, image: o/web}\n  - {name: web, image: o/web2}\n"))
	if len(issues) != 1 || issues[0].Line != 2 {
		t.Errorf("%+v", issues)
	}
}

func TestBundleMergesTheFilesAndFillsTheProject(t *testing.T) {
	c, issues := ParseBundle(mk(mainDoc, map[string]string{"shop": shopDoc}))
	if c == nil {
		t.Fatalf("%+v", issues)
	}
	names := func() (apps, jobs, dbs []string) {
		for _, a := range c.Apps {
			apps = append(apps, a.Name+"/"+a.Project)
		}
		for _, j := range c.Jobs {
			jobs = append(jobs, j.Name+"/"+j.Project)
		}
		for _, d := range c.Databases {
			dbs = append(dbs, d.Name+"/"+d.Project)
		}
		return
	}
	apps, jobs, dbs := names()
	// The apps file first, then the project files; the synthesized backup job follows its database's project.
	if !reflect.DeepEqual(apps, []string{"web/", "shop/shop"}) {
		t.Errorf("apps %v", apps)
	}
	if !reflect.DeepEqual(jobs, []string{"report/", "purge/shop", "backup-shop/shop"}) {
		t.Errorf("jobs %v", jobs)
	}
	if !reflect.DeepEqual(dbs, []string{"shop/shop"}) {
		t.Errorf("databases %v", dbs)
	}
	if _, ok := c.App("shop"); !ok || c.Jobs[2].Database != "shop" {
		t.Error("lookups work on the merged configuration")
	}
}

func TestProjectFileMayRepeatItsOwnProjectButNotAnotherOne(t *testing.T) {
	own := strings.Replace(shopDoc, "  - name: shop\n    image: ghcr.io/o/shop\n", "  - name: shop\n    project: shop\n    image: ghcr.io/o/shop\n", 1)
	if c, issues := ParseBundle(mk(mainDoc, map[string]string{"shop": own})); c == nil {
		t.Fatalf("an explicit project equal to the file's is fine: %+v", issues)
	}
	for _, tc := range []struct{ entity, needle, kind string }{
		{"apps", "  - name: shop\n    image: ghcr.io/o/shop\n", "app"},
		{"jobs", "  - name: purge\n", "job"},
		{"databases", "  - name: shop\n    host: db\n", "database"},
	} {
		other := strings.Replace(shopDoc, tc.needle, strings.Replace(tc.needle, "\n", "\n    project: other\n", 1), 1)
		c, issues := ParseBundle(mk(mainDoc, map[string]string{"shop": other}))
		errs := errorsOf(issues)
		if c != nil || len(errs) != 1 {
			t.Fatalf("%s: %+v", tc.entity, issues)
		}
		is := errs[0]
		if is.File != "projects.d/shop.yaml" || is.Project != "shop" || is.Path != tc.entity+"[shop]" && is.Path != tc.entity+"[purge]" ||
			!strings.Contains(is.Message, `project is "other"`) || is.Line != blockLine(other, strings.SplitN(tc.needle, "\n", 2)[0]+"\n    project: other") {
			t.Errorf("%s: %+v", tc.kind, is)
		}
	}
}

func TestProjectLabelsFollowTheNameRules(t *testing.T) {
	for _, doc := range []string{
		"jobs:\n  - {name: j, project: Bad Name, schedule: '@daily', run: [/bin/true]}\n",
		"databases:\n  - {name: d, project: -x, host: h, database: d, user: u}\n",
		"apps:\n  - {name: a, project: UPPER, image: o/a}\n",
	} {
		c, issues := Parse([]byte(doc))
		if errs := errorsOnly(issues); c != nil || len(errs) != 1 || !strings.Contains(errs[0].Message, "project must match") {
			t.Errorf("%q: %+v", doc, issues)
		}
	}
	ok := "jobs:\n  - {name: j, project: shop, schedule: '@daily', run: [/bin/true]}\ndatabases:\n  - {name: d, project: shop, host: h, database: d, user: u}\n"
	c, issues := Parse([]byte(ok))
	if c == nil {
		t.Fatal(issues)
	}
	if c.Jobs[0].Project != "shop" || c.Databases[0].Project != "shop" {
		t.Errorf("labels are kept: %+v %+v", c.Jobs[0], c.Databases[0])
	}
}

func TestServerWideSectionsAndUnknownKeysInAProjectFileAreErrorsWithTheirLine(t *testing.T) {
	doc := "apps:\n  - {name: shop, image: o/shop}\nproxy: {}\nnotifications: {name: x}\nwhatever: 1\n"
	c, issues := ParseBundle(mk(mainDoc, map[string]string{"shop": doc}))
	issues = errorsOnly(issues)
	if c != nil || len(issues) != 3 {
		t.Fatalf("%+v", issues)
	}
	want := map[string]struct {
		line int
		text string
	}{
		"proxy":         {3, "server-wide"},
		"notifications": {4, "server-wide"},
		"whatever":      {5, "not allowed in a project file"},
	}
	for _, is := range issues {
		w, ok := want[is.Path]
		if !ok || is.Line != w.line || !strings.Contains(is.Message, w.text) || is.File != "projects.d/shop.yaml" || is.Project != "shop" {
			t.Errorf("%+v", is)
		}
	}
}

func TestNestedUnknownKeyInAProjectFileNamesTheFileAndLine(t *testing.T) {
	doc := "apps:\n  - name: shop\n    image: o/shop\n    bogus: 1\n"
	c, issues := ParseBundle(mk(mainDoc, map[string]string{"shop": doc}))
	issues = errorsOnly(issues)
	if c != nil || len(issues) != 1 || issues[0].Line != 4 || issues[0].File != "projects.d/shop.yaml" || !strings.Contains(issues[0].Message, "bogus") {
		t.Fatalf("%+v", issues)
	}
}

func TestSyntaxErrorInOneFileReportsOnlySyntaxErrors(t *testing.T) {
	// The apps file calls an app that the broken file would define: a merged check would add "unknown app".
	main := mainDoc + "  - name: c\n    schedule: '@daily'\n    container: {app: shop, command: [x]}\n"
	c, issues := ParseBundle(mk(main, map[string]string{"shop": "apps: [\n"}))
	if c != nil || len(issues) != 1 || issues[0].File != "projects.d/shop.yaml" || issues[0].Path != "yaml" || issues[0].Line == 0 {
		t.Fatalf("%+v", issues)
	}
}

func TestValidationRunsOnTheMergedConfiguration(t *testing.T) {
	// A job of the apps file may call an app, and a release step a database, that another file defines.
	main := mainDoc + "  - name: calls-shop\n    schedule: '@daily'\n    container: {app: shop, command: [x]}\n"
	if c, issues := ParseBundle(mk(main, map[string]string{"shop": shopDoc})); c == nil {
		t.Fatalf("references across files: %+v", issues)
	}

	// Without the app that the job of the project file calls, the error is in the project file, at the job.
	noApp := strings.Replace(shopDoc, "bearer: {app: shop, env: CRON_SECRET}", "bearer: {app: ghost, env: CRON_SECRET}", 1)
	c, issues := ParseBundle(mk(mainDoc, map[string]string{"shop": noApp}))
	errs := errorsOf(issues)
	if c != nil || len(errs) != 1 {
		t.Fatalf("%+v", issues)
	}
	if e := errs[0]; e.Path != "jobs[purge]" || e.File != "projects.d/shop.yaml" || e.Line != lineOf(t, noApp, "- name: purge") || !strings.Contains(e.Message, `unknown app "ghost"`) {
		t.Errorf("%+v", e)
	}

	// A release step that backs up a database nobody declares.
	noDB := strings.Replace(shopDoc, "databases:", "xdatabases:", 1)
	noDB = noDB[:strings.Index(noDB, "xdatabases:")]
	_, issues = ParseBundle(mk(mainDoc, map[string]string{"shop": noDB}))
	errs = errorsOf(issues)
	if len(errs) != 1 || errs[0].Path != "apps[shop]" || errs[0].File != "projects.d/shop.yaml" || errs[0].Line != lineOf(t, noDB, "- name: shop") {
		t.Errorf("%+v", issues)
	}

	// The main file's own errors keep naming the main file once there are project files.
	broken := strings.Replace(mainDoc, "port: 3000", "port: 99999", 1)
	_, issues = ParseBundle(mk(broken, map[string]string{"shop": shopDoc}))
	errs = errorsOf(issues)
	if len(errs) == 0 || errs[0].File != "apps.yaml" || errs[0].Project != "" || errs[0].Line != lineOf(t, broken, "- name: web") {
		t.Errorf("%+v", issues)
	}
}

func TestNamesAreUniqueAcrossFiles(t *testing.T) {
	for _, tc := range []struct {
		name, main, project, path, mainNeedle, needle string
	}{
		{"app", mainDoc, "apps:\n  - {name: web, image: o/web2}\n", "apps[web]", "- name: web", "- {name: web"},
		{"job", mainDoc, "jobs:\n  - {name: report, schedule: '@daily', run: [/bin/false]}\n", "jobs[report]", "- name: report", "- {name: report"},
		{"database", "databases:\n  - {name: pg, host: h, database: d, user: u}\n", "databases:\n  - {name: pg, host: h2, database: d, user: u}\n", "databases[pg]", "- {name: pg", "- {name: pg"},
	} {
		c, issues := ParseBundle(mk(tc.main, map[string]string{"shop": tc.project}))
		errs := errorsOf(issues)
		if c != nil || len(errs) != 1 {
			t.Fatalf("%s: %+v", tc.name, issues)
		}
		e := errs[0]
		first := lineOf(t, tc.main, tc.mainNeedle)
		if e.Path != tc.path || e.File != "projects.d/shop.yaml" || e.Line != lineOf(t, tc.project, tc.needle) ||
			!strings.Contains(e.Message, "duplicate") || !strings.Contains(e.Message, "first defined in apps.yaml, line "+strconv.Itoa(first)) {
			t.Errorf("%s: %+v (first at %d)", tc.name, e, first)
		}
	}

	// Two project files that define the same name: the later file (by project name) is the one in the way.
	a := "apps:\n  - {name: same, image: o/a}\n"
	c, issues := ParseBundle(mk(mainDoc, map[string]string{"alpha": a, "beta": a}))
	errs := errorsOf(issues)
	if c != nil || len(errs) != 1 || errs[0].File != "projects.d/beta.yaml" || !strings.Contains(errs[0].Message, "first defined in projects.d/alpha.yaml, line 2") {
		t.Errorf("%+v", issues)
	}
}

func TestAJobMayNotTakeTheNameOfADatabasesBackupJobInAnotherFile(t *testing.T) {
	job := "jobs:\n  - {name: backup-shop, schedule: '@daily', run: [/bin/true]}\n"
	c, issues := ParseBundle(mk(job+"proxy: {}\n", map[string]string{"shop": shopDoc}))
	errs := errorsOf(issues)
	if c != nil || len(errs) != 1 || errs[0].Path != "jobs[backup-shop]" || errs[0].File != "apps.yaml" || errs[0].Line != 2 {
		t.Fatalf("%+v", issues)
	}
}

func TestPreviewsOfAProjectFileMustBelongToAnAppOfThatProject(t *testing.T) {
	app := "apps:\n  - {name: shop, image: o/shop, port: 3000, domains: [shop.example.com]}\n"
	main := "proxy: {}\n"
	good := app + "previews:\n  - {app: shop, domain: 'pr-{pr}-shop.example.com'}\n"
	if c, issues := ParseBundle(mk(main, map[string]string{"shop": good})); c == nil {
		t.Fatalf("%+v", issues)
	}

	// The same template in another project's file is an error: the app is the shop's.
	other := "previews:\n  - {app: shop, domain: 'pr-{pr}-shop.example.com'}\n"
	c, issues := ParseBundle(mk(main+app, map[string]string{"zeta": other}))
	errs := errorsOf(issues)
	// shop is in the apps file with no label: its project is "shop", not "zeta".
	if c != nil || len(errs) != 1 || errs[0].Path != "previews[shop]" || errs[0].File != "projects.d/zeta.yaml" || errs[0].Line != 2 || !strings.Contains(errs[0].Message, `belongs to project "shop"`) {
		t.Fatalf("%+v", issues)
	}

	// The apps file may hold the template of an app that a project file defines.
	c, issues = ParseBundle(mk(main+other, map[string]string{"shop": app}))
	if c == nil {
		t.Fatalf("%+v", issues)
	}
	if _, ok := c.Previews("shop"); !ok {
		t.Error("the template is in the merged configuration")
	}
}

func TestFileNamesAndStraysAreChecked(t *testing.T) {
	c, issues := ParseBundle(mk(mainDoc, map[string]string{"Bad Name": "apps: []\n"}))
	issues = errorsOnly(issues)
	if c != nil || len(issues) != 1 || issues[0].File != "projects.d/Bad Name.yaml" || !strings.Contains(issues[0].Message, "project name") {
		t.Errorf("%+v", issues)
	}
	b := mk(mainDoc, map[string]string{"shop": shopDoc})
	b.Strays = []string{"old.yml"}
	c, issues = ParseBundle(b)
	issues = errorsOnly(issues)
	if c != nil || len(issues) != 1 || issues[0].File != "projects.d/old.yml" || !strings.Contains(issues[0].Message, "rename it") {
		t.Errorf("%+v", issues)
	}
}

func TestAnEmptyProjectFileHoldsNothing(t *testing.T) {
	for _, doc := range []string{"", "# nothing yet\n", "{}\n"} {
		c, issues := ParseBundle(mk(mainDoc, map[string]string{"shop": doc}))
		if c == nil {
			t.Fatalf("%q: %+v", doc, issues)
		}
	}
	// The apps file is never empty: that is still the error it was.
	if c, issues := ParseBundle(mk("", map[string]string{"shop": shopDoc})); c != nil || len(issues) != 1 || issues[0].Message != "the document is empty" {
		t.Errorf("%+v", issues)
	}
}

func TestBundleHash(t *testing.T) {
	plain := mk(mainDoc, nil)
	if plain.Hash() != Hash([]byte(mainDoc)) {
		t.Error("without project files the hash is the apps file's, as it always was")
	}
	b := mk(mainDoc, map[string]string{"shop": shopDoc})
	h := b.Hash()
	if h == plain.Hash() || h != b.Clone().Hash() {
		t.Error("project files change the hash, and a copy has the hash of the original")
	}
	changed := b.Clone()
	changed.SetContent("shop", []byte(shopDoc+"# edit\n"))
	renamed := mk(mainDoc, map[string]string{"shop2": shopDoc})
	mainChanged := mk(mainDoc+"# edit\n", map[string]string{"shop": shopDoc})
	empty := mk(mainDoc, map[string]string{"shop": shopDoc, "extra": ""})
	seen := map[string]string{"base": h}
	for name, other := range map[string]Bundle{"project edit": changed, "renamed": renamed, "main edit": mainChanged, "extra file": empty} {
		if prev, dup := seen[other.Hash()]; dup {
			t.Errorf("%s has the hash of %s", name, prev)
		}
		seen[other.Hash()] = name
	}
	if !b.Equal(b.Clone()) || b.Equal(changed) || b.Equal(plain) {
		t.Error("Equal")
	}
}

func TestBundleEncodeDecode(t *testing.T) {
	plain := mk(mainDoc, nil)
	if plain.Encode() != mainDoc {
		t.Error("a configuration without project files is recorded as the apps file itself")
	}
	if got, err := DecodeBundle(mainDoc); err != nil || string(got.Main) != mainDoc || len(got.Projects) != 0 {
		t.Errorf("%+v %v", got, err)
	}
	b := mk(mainDoc, map[string]string{"shop": shopDoc, "blog": ""})
	text := b.Encode()
	if !strings.HasPrefix(text, `{"keelson_bundle":1,`) {
		t.Errorf("%q", text)
	}
	if text != b.Clone().Encode() {
		t.Error("the encoding is canonical")
	}
	got, err := DecodeBundle(text)
	if err != nil || !got.Equal(b) || got.Hash() != b.Hash() {
		t.Errorf("%+v %v", got, err)
	}
	// What a bundle encodes to is not an apps file.
	if c, _ := Parse([]byte(text)); c != nil {
		t.Error("a recorded bundle must not parse as an apps file")
	}
	for _, bad := range []string{`{"keelson_bundle":2,"main":"x","projects":{}}`, `{"keelson_bundle":1,"main":"x","extra":1}`, `{"keelson_bundle":`} {
		if _, err := DecodeBundle(bad); err == nil {
			t.Errorf("%s must be refused", bad)
		}
	}
}

func TestBundleRedactHidesSecretsInEveryFile(t *testing.T) {
	main := mainDoc + "notifications:\n  name: x\n  webhooks:\n    - {url: 'https://hooks.example.com/tok-123'}\n"
	b := mk(main, map[string]string{"shop": shopDoc})
	red, err := b.Redact()
	if err != nil {
		t.Fatal(err)
	}
	all := string(red.Main) + string(red.Projects["shop"])
	if strings.Contains(all, "s3cr3t-value") || strings.Contains(all, "tok-123") || strings.Count(all, Hidden) < 2 {
		t.Errorf("secrets must be hidden:\n%s", all)
	}
	if !strings.Contains(string(red.Projects["shop"]), "# The shop.") || !strings.Contains(string(b.Projects["shop"]), "s3cr3t-value") {
		t.Error("comments stay, and the original is untouched")
	}
	// A hidden value in a project file is restored from that file.
	restored, issues := Restore(red.Projects["shop"], b.Projects["shop"])
	if len(issues) != 0 || strings.Contains(string(restored), Hidden) || !strings.Contains(string(restored), `SECRET_TOKEN: "s3cr3t-value"`) {
		t.Errorf("%+v\n%s", issues, restored)
	}
	if _, err := mk(mainDoc, map[string]string{"shop": "apps: [\n"}).Redact(); err == nil {
		t.Error("a file that does not parse cannot be redacted: fail closed")
	}
}

func TestBundleModelAddsTheProjectFilesEntries(t *testing.T) {
	red, err := mk(mainDoc, map[string]string{"shop": shopDoc}).Redact()
	if err != nil {
		t.Fatal(err)
	}
	m, err := red.Model()
	if err != nil {
		t.Fatal(err)
	}
	names := func(section string) []string {
		var out []string
		for _, it := range m[section].([]any) {
			e := it.(map[string]any)
			p, _ := e["project"].(string)
			out = append(out, e["name"].(string)+"/"+p)
		}
		return out
	}
	if !reflect.DeepEqual(names("apps"), []string{"web/", "shop/shop"}) || !reflect.DeepEqual(names("jobs"), []string{"report/", "purge/shop"}) || !reflect.DeepEqual(names("databases"), []string{"shop/shop"}) {
		t.Errorf("%v %v %v", names("apps"), names("jobs"), names("databases"))
	}
	if _, ok := m["proxy"]; !ok {
		t.Error("the apps file's own sections stay")
	}
	for _, it := range m["apps"].([]any) {
		if e := it.(map[string]any); e["name"] == "shop" {
			if env := e["env"].(map[string]any); env["SECRET_TOKEN"] != Hidden {
				t.Errorf("the model is of the redacted files: %v", env)
			}
		}
	}
	// Without project files it is the apps file's model, as it always was.
	plain, _ := mk(mainDoc, nil).Model()
	direct, _ := Model([]byte(mainDoc))
	if !reflect.DeepEqual(plain, direct) {
		t.Error("the model of a configuration without project files is unchanged")
	}
}

func TestCounts(t *testing.T) {
	a, j, d, p := Counts([]byte(shopDoc))
	if a != 1 || j != 1 || d != 1 || p != 0 {
		t.Errorf("%d %d %d %d", a, j, d, p)
	}
	if a, j, d, p := Counts([]byte("apps: [\n")); a+j+d+p != 0 {
		t.Error("a document that does not parse counts nothing")
	}
}
