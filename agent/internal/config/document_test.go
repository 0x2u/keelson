package config

import (
	"strings"
	"testing"
)

const sample = `# Production apps.
registries:
  - host: ghcr.io
    username: bot
    password_file: /etc/keelson/ghcr

apps:
  # The shop.
  - name: shop
    image: ghcr.io/me/shop
    env:
      DATABASE_URL: postgres://user:s3cret@db/shop
      MODE: 'prod secret'
      QUOTED: "with \"quotes\""

  - name: web
    image: ghcr.io/me/web
    env: {TOKEN: abc123}

jobs:
  - name: report
    schedule: "0 7 * * *"
    http:
      url: http://127.0.0.1:3000/api/report
      headers:
        X-Api-Key: key-value
      body: |
        {"secret": "in a block scalar"}
      bearer: {app: shop, env: DATABASE_URL}

notifications:
  name: vps
  webhooks:
    - url: https://hooks.example.com/T000/B000/XXXX
  heartbeat:
    url: https://hc-ping.com/uuid-secret
    every: 5m
`

func TestParseReportsEveryProblemWithItsLine(t *testing.T) {
	doc := `apps:
  - name: Bad Name
    image: ghcr.io/me/x
  - name: ok
    image: ghcr.io/me/ok:latest
  - name: third
    image: ghcr.io/me/third
    colour: blue
jobs:
  - name: j
    schedule: "61 * * * *"
    run: [x]
`
	c, issues := Parse([]byte(doc))
	if c != nil {
		t.Fatal("a broken document must not parse")
	}
	// An unknown key is reported with its line, and does not hide the other problems of the document.
	if len(errorsOnly(issues)) != 4 || issues[0].Line != 8 || !strings.Contains(issues[0].Message, "colour") {
		t.Fatalf("unknown key plus entity problems: %+v", issues)
	}

	doc = strings.Replace(doc, "    colour: blue\n", "", 1)
	_, issues = Parse([]byte(doc))
	issues = errorsOnly(issues)
	paths := map[string]int{}
	for _, is := range issues {
		paths[is.Path] = is.Line
		if is.Severity != SeverityError {
			t.Errorf("only errors expected: %+v", is)
		}
	}
	want := map[string]int{"apps[Bad Name]": 2, "apps[ok]": 4, "jobs[j]": 9}
	for p, line := range want {
		if paths[p] != line {
			t.Errorf("%s: want line %d, got issues %+v", p, line, issues)
		}
	}
	if len(issues) != 3 {
		t.Errorf("every broken app and job is listed, got %d: %+v", len(issues), issues)
	}
}

func TestParseRejectsEmptyAndMalformedDocuments(t *testing.T) {
	for name, doc := range map[string]string{"empty": "", "blank": "\n\n", "syntax": "apps: [\n  - name: x", "scalar": "just text"} {
		c, issues := Parse([]byte(doc))
		if c != nil || len(issues) == 0 {
			t.Errorf("%s: want issues, got config %v", name, c)
		}
	}
}

func TestParseAcceptsAValidDocumentAndKeepsDefaults(t *testing.T) {
	c, issues := Parse([]byte(sample))
	if c == nil {
		t.Fatalf("valid: %+v", issues)
	}
	if len(c.Apps) != 2 || c.Apps[0].Stop() != DefaultStopTimeout || len(c.Jobs) != 1 {
		t.Errorf("unexpected: %+v", c)
	}
}

func TestRedactHidesEverySecretAndKeepsTheRestOfTheText(t *testing.T) {
	out, err := Redact([]byte(sample))
	if err != nil {
		t.Fatal(err)
	}
	got := string(out)
	for _, leaked := range []string{"s3cret", "prod secret", "with \\\"quotes\\\"", "abc123", "key-value", "in a block scalar", "T000", "uuid-secret"} {
		if strings.Contains(got, leaked) {
			t.Errorf("secret %q leaked:\n%s", leaked, got)
		}
	}
	if strings.Count(got, Hidden) != 8 {
		t.Errorf("want 8 hidden values, got %d:\n%s", strings.Count(got, Hidden), got)
	}
	// Non-secret text survives, comments and blank lines included, unless a block scalar forced a rewrite.
	for _, kept := range []string{"ghcr.io/me/shop", "http://127.0.0.1:3000/api/report", "every: 5m", "0 7 * * *"} {
		if !strings.Contains(got, kept) {
			t.Errorf("%q lost:\n%s", kept, got)
		}
	}
	// A redacted document is not a valid one (a webhook URL becomes "<hidden>"): it is restored before it is checked.
}

func TestRedactKeepsFormattingWhenNoBlockScalarIsInvolved(t *testing.T) {
	doc := "# keep me\napps:\n\n  - name: a   # inline\n    image: ghcr.io/me/a\n    env:\n      K: plain\n      Q: 'single'\n      D: \"dbl\"\n"
	out, err := Redact([]byte(doc))
	if err != nil {
		t.Fatal(err)
	}
	want := "# keep me\napps:\n\n  - name: a   # inline\n    image: ghcr.io/me/a\n    env:\n      K: \"<hidden>\"\n      Q: \"<hidden>\"\n      D: \"<hidden>\"\n"
	if string(out) != want {
		t.Errorf("formatting changed:\n%s\nwant:\n%s", out, want)
	}
}

func TestRestoreBringsBackStoredSecretsAndWarnsAboutLostOnes(t *testing.T) {
	red, _ := Redact([]byte(sample))
	// The operator changes a non-secret value and removes the webhook; every other secret is untouched.
	edited := strings.Replace(string(red), "ghcr.io/me/web", "ghcr.io/me/web2", 1)
	edited = strings.Replace(edited, "  webhooks:\n    - url: \"<hidden>\"\n", "", 1)

	out, issues := Restore([]byte(edited), []byte(sample))
	got := string(out)
	for _, want := range []string{"s3cret", "abc123", "key-value", "uuid-secret", "ghcr.io/me/web2"} {
		if !strings.Contains(got, want) {
			t.Errorf("%q must be back:\n%s", want, got)
		}
	}
	if strings.Contains(got, Hidden) {
		t.Errorf("no placeholder may remain:\n%s", got)
	}
	var removed []string
	for _, is := range issues {
		if is.Severity == SeverityError {
			t.Errorf("unexpected error: %+v", is)
		}
		if is.Code == "secret_removed" {
			removed = append(removed, is.Path)
		}
	}
	if len(removed) != 1 || removed[0] != "notifications.webhooks[0].url" {
		t.Errorf("removed secrets: %v", removed)
	}
	if c, iss := Parse(out); c == nil {
		t.Errorf("restored document must be valid: %+v", iss)
	}
}

func TestRestoreRefusesAPlaceholderWithNothingStored(t *testing.T) {
	doc := "apps:\n  - name: new\n    image: ghcr.io/me/new\n    env:\n      KEY: \"<hidden>\"\n"
	_, issues := Restore([]byte(doc), []byte(sample))
	var errs []Issue
	for _, is := range issues {
		if is.Severity == SeverityError {
			errs = append(errs, is)
		}
	}
	if len(errs) != 1 || errs[0].Line != 5 || !strings.Contains(errs[0].Path, "apps[new].env.KEY") {
		t.Errorf("want one error at line 5, got %+v", issues)
	}
}

func TestRestoreHandlesValuesNeedingEscapes(t *testing.T) {
	current := "apps:\n  - name: a\n    image: ghcr.io/me/a\n    env:\n      K: \"x\"\n"
	// A stored secret containing quotes and a newline must survive a round trip.
	cur, _, err := SetApp([]byte(current), "a", map[string]any{"name": "a", "image": "ghcr.io/me/a", "env": map[string]any{"K": "line1\nsays \"hi\" #not-a-comment"}})
	if err != nil {
		t.Fatal(err)
	}
	red, err := Redact(cur)
	if err != nil {
		t.Fatal(err)
	}
	out, issues := Restore(red, cur)
	if len(issues) != 0 {
		t.Fatalf("%+v", issues)
	}
	c, iss := Parse(out)
	if c == nil || c.Apps[0].Env["K"] != "line1\nsays \"hi\" #not-a-comment" {
		t.Errorf("value changed: %+v %+v", c, iss)
	}
}

func TestSetAppCreatesReplacesAndKeepsTheRest(t *testing.T) {
	out, issues, err := SetApp([]byte(sample), "web", map[string]any{
		"name": "web", "image": "ghcr.io/me/web", "restart": "always",
		"env": map[string]any{"TOKEN": Hidden, "NEW": "value"},
	})
	if err != nil || len(issues) != 0 {
		t.Fatalf("%v %+v", err, issues)
	}
	c, iss := Parse(out)
	if c == nil {
		t.Fatalf("%+v\n%s", iss, out)
	}
	web, _ := c.App("web")
	if web.Restart != "always" || web.Env["TOKEN"] != "abc123" || web.Env["NEW"] != "value" {
		t.Errorf("web: %+v", web)
	}
	shop, _ := c.App("shop")
	if shop.Env["DATABASE_URL"] != "postgres://user:s3cret@db/shop" {
		t.Errorf("another app's secrets must be untouched: %+v", shop.Env)
	}
	if !strings.Contains(string(out), "# The shop.") {
		t.Errorf("comments must survive an entity edit:\n%s", out)
	}

	added, _, err := SetApp(out, "api", map[string]any{"name": "api", "image": "ghcr.io/me/api", "restart": "always"})
	if err != nil {
		t.Fatal(err)
	}
	c, iss = Parse(added)
	if c == nil {
		t.Fatalf("%+v\n%s", iss, added)
	}
	if _, ok := c.App("api"); !ok {
		t.Fatalf("%+v\n%s", iss, added)
	}
	if len(c.Apps) != 3 {
		t.Errorf("want 3 apps, got %d", len(c.Apps))
	}
}

func TestSetAppIntoAnEmptyDocumentAndNameMismatch(t *testing.T) {
	out, _, err := SetApp(nil, "a", map[string]any{"name": "a", "image": "ghcr.io/me/a"})
	if err != nil {
		t.Fatal(err)
	}
	if c, iss := Parse(out); c == nil {
		t.Fatalf("%+v\n%s", iss, out)
	}
	if _, _, err := SetApp(out, "a", map[string]any{"name": "b", "image": "ghcr.io/me/a"}); err == nil {
		t.Error("a body name different from the path must be refused")
	}
}

func TestSetAppIntoAnEmptyFlowListWritesBlockYAML(t *testing.T) {
	// The installer's starter file is `apps: []`: the first app must not come out as one flow line.
	out, _, err := SetApp([]byte("# starter\napps: []\n"), "web", map[string]any{
		"name": "web", "image": "keelson-local/web", "publish": []any{"127.0.0.1:8100:8080"},
		"build": map[string]any{"dockerfile": "Dockerfile", "context": "."},
	})
	if err != nil {
		t.Fatal(err)
	}
	want := "# starter\napps:\n  - name: web\n    image: keelson-local/web\n    build:\n      dockerfile: Dockerfile\n      context: .\n    publish:\n      - 127.0.0.1:8100:8080\n"
	if string(out) != want {
		t.Fatalf("got:\n%s\nwant:\n%s", out, want)
	}
}

func TestDeleteItemsAndEmptySections(t *testing.T) {
	out, err := DeleteApp([]byte(sample), "web")
	if err != nil {
		t.Fatal(err)
	}
	c, _ := Parse(out)
	if c == nil || len(c.Apps) != 1 || c.Apps[0].Name != "shop" {
		t.Errorf("%s", out)
	}
	out, err = DeleteApp(out, "shop")
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(out), "apps:") {
		t.Errorf("an empty apps list is removed:\n%s", out)
	}
	if _, err := DeleteApp(out, "ghost"); err == nil {
		t.Error("deleting what is not there is an error")
	}
	out, err = DeleteJob([]byte(sample), "report")
	if err != nil || strings.Contains(string(out), "jobs:") {
		t.Errorf("%v\n%s", err, out)
	}
}

func TestSetNotificationsReplacesOrRemoves(t *testing.T) {
	out, _, err := SetNotifications([]byte(sample), map[string]any{"name": "new", "webhooks": []any{map[string]any{"url": Hidden}}})
	if err != nil {
		t.Fatal(err)
	}
	c, iss := Parse(out)
	if c == nil || c.Notifications.Name != "new" || c.Notifications.Webhooks[0].URL != "https://hooks.example.com/T000/B000/XXXX" {
		t.Fatalf("%+v\n%s", iss, out)
	}
	out, _, err = SetNotifications(out, nil)
	if err != nil || strings.Contains(string(out), "notifications") {
		t.Errorf("%v\n%s", err, out)
	}
}

func TestModelIsPlainData(t *testing.T) {
	red, _ := Redact([]byte(sample))
	m, err := Model(red)
	if err != nil {
		t.Fatal(err)
	}
	apps, _ := m["apps"].([]any)
	first, _ := apps[0].(map[string]any)
	env, _ := first["env"].(map[string]any)
	if first["name"] != "shop" || env["DATABASE_URL"] != Hidden {
		t.Errorf("%+v", m)
	}
	if empty, _ := Model(nil); len(empty) != 0 {
		t.Errorf("an empty document is an empty model: %+v", empty)
	}
}

func TestHashIsStable(t *testing.T) {
	if Hash([]byte("a")) != Hash([]byte("a")) || Hash([]byte("a")) == Hash([]byte("b")) || len(Hash(nil)) != 64 {
		t.Error("hash")
	}
}

// A release step reads name first, like every other list entry; maps built from plain data would come out alphabetical
// (command before name) and the file would read oddly to the operator who opens it.
func TestSetAppWritesReleaseStepsInTheDocumentedOrder(t *testing.T) {
	out, _, err := SetApp([]byte("apps: []\n"), "web", map[string]any{
		"name": "web", "image": "ghcr.io/me/web",
		"release": map[string]any{"steps": []any{
			map[string]any{"timeout": "5m", "container": map[string]any{"command": []any{"sh", "-c", "true"}}, "name": "migrate", "continue_on_failure": true},
			map[string]any{"host": []any{"/usr/local/bin/backup"}, "name": "backup", "dir": "/srv"},
		}},
	})
	if err != nil {
		t.Fatal(err)
	}
	text := string(out)
	for _, want := range []string{"- name: migrate\n          container:", "- name: backup\n          host:"} {
		if !strings.Contains(text, want) {
			t.Errorf("missing %q in\n%s", want, text)
		}
	}
	if i, j := strings.Index(text, "container:"), strings.Index(text, "timeout:"); i < 0 || j < i {
		t.Errorf("command, then timeout, then continue_on_failure:\n%s", text)
	}
}
