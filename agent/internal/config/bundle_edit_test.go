package config

import (
	"strings"
	"testing"
)

func edited(t *testing.T, b Bundle) *Config {
	t.Helper()
	c, issues := ParseBundle(b)
	if c == nil {
		t.Fatalf("the edited bundle must be valid: %+v", issues)
	}
	return c
}

func TestSetEntityWritesItInTheFileThatHoldsIt(t *testing.T) {
	b := mk(mainDoc, map[string]string{"shop": shopDoc})
	issues, err := b.SetApp("shop", map[string]any{"name": "shop", "image": "ghcr.io/o/shop2", "release": map[string]any{"steps": []any{map[string]any{"name": "backup", "backup": "shop"}}}})
	if err != nil || len(errorsOf(issues)) != 0 {
		t.Fatal(err, issues)
	}
	if string(b.Main) != mainDoc {
		t.Errorf("the apps file is untouched:\n%s", b.Main)
	}
	if !strings.Contains(string(b.Projects["shop"]), "ghcr.io/o/shop2") || !strings.Contains(string(b.Projects["shop"]), "# The shop.") {
		t.Errorf("the project file takes the edit and keeps its comments:\n%s", b.Projects["shop"])
	}
	if strings.Contains(string(b.Projects["shop"]), "project:") {
		t.Errorf("a project file does not repeat its project:\n%s", b.Projects["shop"])
	}
	if got, _ := edited(t, b).App("shop"); got.Image != "ghcr.io/o/shop2" || got.Project != "shop" {
		t.Errorf("%+v", got)
	}

	// A job of the apps file stays there.
	if _, err := b.SetJob("report", map[string]any{"name": "report", "schedule": "@hourly", "run": []any{"/bin/true"}}); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(b.Main), "@hourly") || strings.Contains(string(b.Projects["shop"]), "report") {
		t.Errorf("main:\n%s\nshop:\n%s", b.Main, b.Projects["shop"])
	}
}

func TestANewEntityGoesToTheFileOfItsProjectWhenThereIsOne(t *testing.T) {
	b := mk(mainDoc, map[string]string{"shop": shopDoc})
	job := func(project string) map[string]any {
		j := map[string]any{"name": "daily", "schedule": "@daily", "run": []any{"/bin/true"}}
		if project != "" {
			j["project"] = project
		}
		return j
	}
	// Labelled with a project that has a file.
	if _, err := b.SetJob("daily", job("shop")); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(b.Projects["shop"]), "name: daily") || strings.Contains(string(b.Main), "name: daily") {
		t.Errorf("into the project's file:\n%s", b.Projects["shop"])
	}
	// Labelled with a project without a file: the apps file, label kept.
	if _, err := b.SetJob("nightly", map[string]any{"name": "nightly", "project": "blog", "schedule": "@daily", "run": []any{"/bin/true"}}); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(b.Main), "name: nightly\n    project: blog") {
		t.Errorf("the label stays in the apps file:\n%s", b.Main)
	}
	// No label: the apps file.
	if _, err := b.SetDatabase("pg", map[string]any{"name": "pg", "host": "h", "database": "d", "user": "u"}); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(b.Main), "name: pg") {
		t.Errorf("unlabelled goes to the apps file:\n%s", b.Main)
	}
	c := edited(t, b)
	if j, _ := c.Job("daily"); j.Project != "shop" {
		t.Errorf("%+v", j)
	}
	if j, _ := c.Job("nightly"); j.Project != "blog" {
		t.Errorf("%+v", j)
	}
	// An app is routed the same way.
	if _, err := b.SetApp("shop-admin", map[string]any{"name": "shop-admin", "project": "shop", "image": "ghcr.io/o/admin"}); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(b.Projects["shop"]), "shop-admin") {
		t.Errorf("%s", b.Projects["shop"])
	}
}

func TestAnEntityInAProjectFileKeepsItsProject(t *testing.T) {
	b := mk(mainDoc, map[string]string{"shop": shopDoc})
	before := b.Clone()
	_, err := b.SetApp("shop", map[string]any{"name": "shop", "project": "other", "image": "ghcr.io/o/shop"})
	if err == nil || !strings.Contains(err.Error(), "projects.d/shop.yaml") || !strings.Contains(err.Error(), `"other"`) {
		t.Fatalf("%v", err)
	}
	if !b.Equal(before) {
		t.Error("a refused edit changes nothing")
	}
	// The same project, or none, is fine.
	for _, p := range []any{"shop", nil} {
		app := map[string]any{"name": "shop", "image": "ghcr.io/o/shop"}
		if p != nil {
			app["project"] = p
		}
		if _, err := b.SetApp("shop", app); err != nil {
			t.Errorf("%v: %v", p, err)
		}
	}
}

func TestSetPreviewGoesWhereTheAppIs(t *testing.T) {
	app := "apps:\n  - {name: shop, image: o/shop, port: 3000, domains: [shop.example.com]}\n"
	b := mk("proxy: {}\n", map[string]string{"shop": app})
	if _, err := b.SetPreview("shop", map[string]any{"app": "shop", "domain": "pr-{pr}-shop.example.com"}); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(b.Projects["shop"]), "previews:") || strings.Contains(string(b.Main), "previews") {
		t.Errorf("main:\n%s\nshop:\n%s", b.Main, b.Projects["shop"])
	}
	c := edited(t, b)
	if p, ok := c.Previews("shop"); !ok || p.TTLFor() == 0 {
		t.Errorf("%+v", p)
	}
	if err := b.DeletePreview("shop"); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(b.Projects["shop"]), "previews") {
		t.Errorf("%s", b.Projects["shop"])
	}
	// An app of the apps file gets its template there.
	b = mk("proxy: {}\n"+app, nil)
	if _, err := b.SetPreview("shop", map[string]any{"app": "shop", "domain": "pr-{pr}-shop.example.com"}); err != nil || !strings.Contains(string(b.Main), "previews:") {
		t.Errorf("%v\n%s", err, b.Main)
	}
}

func TestDeleteEntityRemovesItFromItsFile(t *testing.T) {
	b := mk(mainDoc, map[string]string{"shop": shopDoc})
	if err := b.DeleteJob("purge"); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(b.Projects["shop"]), "purge") || string(b.Main) != mainDoc {
		t.Errorf("%s", b.Projects["shop"])
	}
	if err := b.DeleteJob("report"); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(b.Main), "report") {
		t.Errorf("%s", b.Main)
	}
	// What is not in any file is refused with the words it always had.
	err := b.DeleteApp("ghost")
	if err == nil || err.Error() != `apps "ghost" is not in the document` {
		t.Errorf("%v", err)
	}
	fresh := mk(mainDoc, nil)
	_, err1 := DeleteJob([]byte(mainDoc), "ghost")
	err2 := fresh.DeleteJob("ghost")
	if err1 == nil || err2 == nil || err1.Error() != err2.Error() {
		t.Errorf("%v %v", err1, err2)
	}
	// The file of a project stays when its last entity goes: an empty project is valid.
	for _, f := range []func() error{func() error { return b.DeleteApp("shop") }, func() error { return b.DeleteDatabase("shop") }} {
		if err := f(); err != nil {
			t.Fatal(err)
		}
	}
	if _, ok := b.Projects["shop"]; !ok {
		t.Fatal("the file stays")
	}
	if c, issues := ParseBundle(b); c == nil {
		t.Errorf("%+v\n%s", issues, b.Projects["shop"])
	}
}

func TestSetEntityResolvesHiddenValuesAgainstTheFileThatHoldsThem(t *testing.T) {
	b := mk(mainDoc, map[string]string{"shop": shopDoc})
	issues, err := b.SetApp("shop", map[string]any{
		"name": "shop", "image": "ghcr.io/o/shop", "env": map[string]any{"SECRET_TOKEN": Hidden},
		"release": map[string]any{"steps": []any{map[string]any{"name": "backup", "backup": "shop"}}},
	})
	if err != nil || len(issues) != 0 {
		t.Fatalf("%v %+v", err, issues)
	}
	if !strings.Contains(string(b.Projects["shop"]), "s3cr3t-value") || strings.Contains(string(b.Projects["shop"]), Hidden) {
		t.Errorf("the stored value comes back:\n%s", b.Projects["shop"])
	}
	// A hidden value with nothing stored in that file is an error, even when another file has a value of that name.
	other := mk(mainDoc+"", map[string]string{"shop": shopDoc, "blog": "apps:\n  - {name: blog, image: o/blog}\n"})
	issues, err = other.SetApp("blog", map[string]any{"name": "blog", "image": "o/blog", "env": map[string]any{"SECRET_TOKEN": Hidden}})
	if err != nil || len(errorsOf(issues)) != 1 {
		t.Errorf("%v %+v", err, issues)
	}
}

func TestSetNotificationsEditsTheAppsFile(t *testing.T) {
	b := mk(mainDoc, map[string]string{"shop": shopDoc})
	if _, err := b.SetNotifications(map[string]any{"name": "vps"}); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(b.Main), "notifications:") || string(b.Projects["shop"]) != shopDoc {
		t.Errorf("%s", b.Main)
	}
}
