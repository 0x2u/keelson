package proxy

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/0x2u/keelson/agent/internal/config"
)

func TestACanaryRouteKeepsABrowserOnItsVersionWithACookieKeyedByTheStep(t *testing.T) {
	cfg := BuildConfig(config.Proxy{}, []Route{{
		App: "web", Hosts: []string{"a.example.com"}, Upstream: "127.0.0.1:1",
		Canary: &Canary{Upstream: "127.0.0.1:2", Percent: 50, Key: "dep-50"},
	}})
	b, _ := json.Marshal(cfg)
	for _, want := range []string{`"policy":"cookie"`, `"name":"keelson_canary"`, `"secret":"dep-50"`, `"policy":"weighted_round_robin"`} {
		if !strings.Contains(string(b), want) {
			t.Errorf("the route must carry %s: %s", want, b)
		}
	}
}

func TestTheWeightsOfACanaryAddUpToTheShareAndAreSpreadOverTheCycle(t *testing.T) {
	for _, percent := range []int{1, 10, 20, 25, 33, 50, 60, 90, 99} {
		ups, weights := canaryPool("stable", "new", percent)
		if len(ups) != len(weights) {
			t.Fatalf("%d%%: %d upstreams, %d weights", percent, len(ups), len(weights))
		}
		// Walk the cycle as Caddy does: draw number n takes the upstream whose weights span n.
		var cycle []string
		for i, w := range weights {
			for range w.(int) {
				cycle = append(cycle, ups[i].(map[string]any)["dial"].(string))
			}
		}
		if len(cycle) != 100 {
			t.Fatalf("%d%%: the cycle has %d draws, want 100", percent, len(cycle))
		}
		n := 0
		for _, d := range cycle {
			if d == "new" {
				n++
			}
		}
		if n != percent {
			t.Errorf("%d%%: %d draws of 100 go to the new version", percent, n)
		}
		// What matters on a quiet site: the new version must not wait for the end of the cycle. The longest run of the
		// stable version is what the first visitors of a step can all draw.
		run, longest := 0, 0
		for _, d := range cycle {
			if d == "stable" {
				run++
				longest = max(longest, run)
			} else {
				run = 0
			}
		}
		if bound := (100 + percent - 1) / percent; percent <= 50 && longest > bound {
			t.Errorf("%d%%: %d stable draws in a row, at most %d expected: a quiet site would see no new version", percent, longest, bound)
		}
	}
}

func TestARouteWithoutACanaryIsExactlyWhatItWas(t *testing.T) {
	plain := Route{Hosts: []string{"a.example.com"}, Upstream: "127.0.0.1:1"}
	got, _ := json.Marshal(BuildConfig(config.Proxy{}, []Route{plain}))
	for _, word := range []string{"load_balancing", "selection_policy", "cookie"} {
		if strings.Contains(string(got), word) {
			t.Errorf("a route with no canary must not mention %q: %s", word, got)
		}
	}
}

// versionServer answers every request with its name, so that a test knows which version it reached.
func versionServer(t *testing.T, name string) string {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { _, _ = io.WriteString(w, name) }))
	t.Cleanup(srv.Close)
	return strings.TrimPrefix(srv.URL, "http://")
}

// visitors makes n browsers (each with its own cookies) request host four times and says how many only ever reached
// the new version, only the old one, and both.
func visitors(t *testing.T, c *RealCaddy, jars []*cookiejar.Jar, host string) (onlyNew, onlyOld, both int) {
	t.Helper()
	for _, jar := range jars {
		cl := c.Client()
		cl.Jar = jar
		seen := map[string]bool{}
		for range 4 {
			resp, err := cl.Get("https://" + host + "/")
			if err != nil {
				t.Fatal(err)
			}
			b, _ := io.ReadAll(resp.Body)
			resp.Body.Close()
			seen[string(b)] = true
		}
		switch {
		case len(seen) > 1:
			both++
		case seen["new"]:
			onlyNew++
		default:
			onlyOld++
		}
	}
	return
}

func TestRealCaddyCanaryGivesTheNewVersionItsShareAndNeverMixesAVisitor(t *testing.T) {
	c := StartRealCaddy(t)
	oldUp, newUp := versionServer(t, "old"), versionServer(t, "new")
	driver := New(config.Proxy{Admin: config.DefaultProxyAdmin, TLS: "internal"})
	const host = "canary.test"
	apply := func(r Route) {
		t.Helper()
		r.App, r.Hosts = "web", []string{host}
		if err := driver.Apply(t.Context(), []Route{r}); err != nil {
			t.Fatalf("Caddy refused the route: %v", err)
		}
		if in := driver.Inspect(t.Context(), []Route{r}); in.InSync == nil || !*in.InSync {
			t.Fatalf("Caddy must serve exactly what was applied, or the reconciler reports a drift and applies it again every few seconds: %+v", in)
		}
	}
	apply(Route{Upstream: oldUp})
	c.Get(host, "/", nil) // the first request of a host waits for its certificate

	jars := make([]*cookiejar.Jar, 100)
	for i := range jars {
		jars[i], _ = cookiejar.New(nil)
	}

	apply(Route{Upstream: oldUp, Canary: &Canary{Upstream: newUp, Percent: 10, Key: "dep-10"}})
	// A quiet site: the first twenty visitors of a step must already include the new version (it would not at all with
	// the weights in the order of the list, which give the first 90 visitors to the old one).
	if n, _, _ := visitors(t, c, jars[:20], host); n < 1 || n > 3 {
		t.Errorf("20 visitors at 10%% is 2, %d reached the new version", n)
	}
	onlyNew, onlyOld, both := visitors(t, c, jars, host)
	t.Logf("10%%: %d on the new version, %d on the old, %d on both", onlyNew, onlyOld, both)
	if both != 0 {
		t.Errorf("%d visitors saw both versions: a page and its assets must come from one", both)
	}
	if onlyNew < 9 || onlyNew > 11 {
		t.Errorf("10%% of 100 visitors is 10, %d got the new version", onlyNew)
	}

	// The next step is a new draw: a cookie given at 10% must not decide who is in the 50%.
	apply(Route{Upstream: oldUp, Canary: &Canary{Upstream: newUp, Percent: 50, Key: "dep-50"}})
	onlyNew, onlyOld, both = visitors(t, c, jars, host)
	t.Logf("50%%: %d on the new version, %d on the old, %d on both", onlyNew, onlyOld, both)
	if both != 0 {
		t.Errorf("%d visitors saw both versions inside one step", both)
	}
	if onlyNew < 45 || onlyNew > 55 {
		t.Errorf("50%% of 100 visitors is about 50, %d got the new version", onlyNew)
	}

	// The end of the rollout: everyone goes to the new version, whatever their cookie says.
	apply(Route{Upstream: newUp})
	if onlyNew, _, both = visitors(t, c, jars, host); onlyNew != 100 || both != 0 {
		t.Errorf("after the last step all 100 visitors must be on the new version: %d, both %d", onlyNew, both)
	}

	// The way back: everyone returns to the version that served, including those who carry a cookie for the new one.
	apply(Route{Upstream: oldUp, Canary: &Canary{Upstream: newUp, Percent: 50, Key: "dep-50"}})
	visitors(t, c, jars, host)
	apply(Route{Upstream: oldUp})
	if _, onlyOld, both = visitors(t, c, jars, host); onlyOld != 100 || both != 0 {
		t.Errorf("after a rollback all 100 visitors must be on the old version: %d, both %d", onlyOld, both)
	}
}
