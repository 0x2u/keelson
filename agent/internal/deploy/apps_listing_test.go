package deploy

import (
	"context"
	"strings"
	"testing"

	"github.com/0x2u/keelson/agent/internal/config"
)

func TestAppsListingReportsDomainsAndBuilders(t *testing.T) {
	h := newHarness(t, func(a *config.App) { a.Domains = []string{"www.example.com", "example.com"} })
	apps, err := h.d.Apps(context.Background())
	if err != nil || len(apps) != 1 {
		t.Fatalf("%+v %v", apps, err)
	}
	if got := strings.Join(apps[0].Domains, ","); got != "www.example.com,example.com" || apps[0].BuildOnly {
		t.Errorf("domains %q, build only %v", got, apps[0].BuildOnly)
	}

	b := newHarness(t, func(a *config.App) { a.Build = &config.Build{Only: true} })
	apps, err = b.d.Apps(context.Background())
	if err != nil || len(apps) != 1 || !apps[0].BuildOnly || len(apps[0].Domains) != 0 {
		t.Fatalf("%+v %v", apps, err)
	}
}

func TestAppsListingOmitsWhatIsNotSet(t *testing.T) {
	apps, err := newHarness(t).d.Apps(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	body, _ := jsonOf(apps)
	if strings.Contains(body, `"domains"`) || strings.Contains(body, `"build_only"`) {
		t.Errorf("an app without domains that is not a builder carries neither field: %s", body)
	}
}
