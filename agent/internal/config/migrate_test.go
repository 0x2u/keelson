package config

import (
	"path/filepath"
	"strings"
	"testing"
)

func readLegacy(t *testing.T, example string) Bundle {
	t.Helper()
	b, err := Location{File: example, ProjectsDir: strings.TrimSuffix(example, ".apps.yaml") + ".projects.d"}.Read()
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func dumpOf(t *testing.T, b Bundle) string {
	t.Helper()
	c, issues := ParseBundle(b)
	if c == nil {
		t.Fatalf("%+v", issues)
	}
	out, err := c.RuntimeJSON()
	if err != nil {
		t.Fatal(err)
	}
	return string(out)
}

// Every legacy example migrates to a file that loads without a deprecation (the leftovers apart), runs what the legacy
// file ran (the dump is the same, byte for byte) and migrates to itself.
func TestMigratingTheLegacyExamples(t *testing.T) {
	for _, example := range legacyExamples(t) {
		t.Run(filepath.Base(example), func(t *testing.T) {
			b := readLegacy(t, example)
			next, plan, err := b.Migrate(MigrateOptions{})
			if err != nil {
				t.Fatal(err)
			}
			if plan.Empty() && !next.Equal(b) {
				t.Fatal("a migration with nothing to change returns the files as they are")
			}
			if before, after := dumpOf(t, b), dumpOf(t, next); before != after {
				t.Errorf("the migration changed what runs:\n%s", firstDifference(before, after))
			}
			_, issues := ParseBundle(next)
			left := map[string]bool{}
			for _, l := range plan.Leftovers {
				left[l.Path] = true
			}
			for _, d := range deprecationsOf(issues) {
				if !left[d.Path] {
					t.Errorf("a deprecation is left: %+v", d)
				}
			}
			again, plan2, err := next.Migrate(MigrateOptions{})
			if err != nil || !plan2.Empty() || !again.Equal(next) {
				t.Errorf("a migrated configuration migrates to itself: %v %+v", err, plan2)
			}
		})
	}
}
