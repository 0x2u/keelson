package config

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"
)

func TestBuildBlockReadsTheJSONShapeOfTheConfigurationAPI(t *testing.T) {
	var b Build
	dec := json.NewDecoder(strings.NewReader(`{"preset":"nextjs","build_command":"pnpm build","standalone":true,"timeout":"20m","memory":"3g","cpus":1.5,"max_source":"256m","args":{"A":"1"},"platform":"linux/arm64","source_hosts":["Git.Example.com"]}`))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&b); err != nil {
		t.Fatal(err)
	}
	a, err := BuildRequestApp("web", "keelson-local/web", 3000, "/up", &b, (&Config{}).BuildCeilings())
	if err == nil {
		t.Fatalf("git.example.com is not a default source host: %+v", a.Build)
	}
	lim := (&Config{BuildLimits: &BuildLimits{SourceHosts: []string{"git.example.com"}}}).BuildCeilings()
	a, err = BuildRequestApp("web", "keelson-local/web", 3000, "/up", &b, lim)
	if err != nil {
		t.Fatal(err)
	}
	got := a.Build
	if got.Preset != "nextjs" || got.BuildCommand != "pnpm build" || got.TimeoutFor().Minutes() != 20 || got.MemoryBytes() != 3<<30 || got.CPUCount() != 1.5 ||
		got.MaxSourceBytes() != 256<<20 || got.Platform != "linux/arm64" || got.Args["A"] != "1" || got.SourceHosts[0] != "git.example.com" {
		t.Errorf("unexpected build block: %+v", got)
	}
	if a.Name != "web" || a.Image != "keelson-local/web" || a.ContainerPort != 3000 || a.HealthPath != "/up" || a.KeepImagesOrDefault() != DefaultKeepImages || a.BuildOnly() {
		t.Errorf("unexpected app: %+v", a)
	}
	if b.Memory.Bytes() != 3<<30 || b.SourceHosts[0] != "Git.Example.com" {
		t.Error("the request's own block must not be changed")
	}
}

func TestBuildRequestFieldsAreRefusedWithAClearMessage(t *testing.T) {
	lim := (&Config{}).BuildCeilings()
	for name, c := range map[string]struct {
		app, image, health string
		port               int
		build              *Build
		want               string
	}{
		"bad name":     {"Web!", "a/b", "", 0, &Build{}, "app must match"},
		"no build":     {"web", "a/b", "", 0, nil, "build is required"},
		"bad image":    {"web", "a/b:tag", "", 0, &Build{}, "must not contain a tag"},
		"no image":     {"web", "", "", 0, &Build{}, "image is required"},
		"bad port":     {"web", "a/b", "", 70000, &Build{}, "port must be"},
		"bad health":   {"web", "a/b", "up", 0, &Build{}, "health_path"},
		"bad preset":   {"web", "a/b", "", 0, &Build{Preset: "rails"}, "preset must be one of"},
		"bad arg":      {"web", "a/b", "", 0, &Build{Args: map[string]string{"1X": "v"}}, "arg"},
		"bad platform": {"web", "a/b", "", 0, &Build{Platform: "linux/s390x"}, "platform must be"},
		"low memory":   {"web", "a/b", "", 0, &Build{Memory: S(1 << 20)}, "memory must be at least 64m"},
	} {
		_, err := BuildRequestApp(c.app, c.image, c.port, c.health, c.build, lim)
		var refused *BuildRequestError
		if !errors.As(err, &refused) || !strings.Contains(err.Error(), c.want) {
			t.Errorf("%s: want a refusal with %q, got %v", name, c.want, err)
		}
	}
}

func TestOmittedBuildValuesNeverMakeARequestTooBig(t *testing.T) {
	cpus := 0.5
	lim := (&Config{BuildLimits: &BuildLimits{Memory: S(256 << 20), CPUs: &cpus, Timeout: D(5 * 60 * 1e9), MaxSource: S(10 << 20)}}).BuildCeilings()
	a, err := BuildRequestApp("web", "a/b", 0, "", &Build{}, lim)
	if err != nil {
		t.Fatal(err)
	}
	b := a.Build
	if b.MemoryBytes() != 256<<20 || b.CPUCount() != 0.5 || b.TimeoutFor().Minutes() != 5 || b.MaxSourceBytes() != 10<<20 {
		t.Errorf("the defaults are lowered to the ceilings: %+v", b)
	}
	// Above the ceilings only what is written is refused.
	if _, err := BuildRequestApp("web", "a/b", 0, "", &Build{Memory: S(512 << 20)}, lim); err == nil {
		t.Error("an explicit memory above the ceiling is refused, not clamped")
	}
}
