package deploy

import (
	"context"
	"errors"
	"io"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/0x2u/keelson/agent/internal/appenv"
	"github.com/0x2u/keelson/agent/internal/config"
	"github.com/0x2u/keelson/agent/internal/docker"
	"github.com/0x2u/keelson/agent/internal/store"
)

const requestedImage = "keelson-local/mac-web"

// serverWithoutApps makes the harness a server whose apps file has no app, only build_limits (nil: the defaults).
func (h *buildHarness) serverWithoutApps(limits *config.BuildLimits) {
	h.d.cfg.Store(&config.Config{Proxy: &config.Proxy{}, BuildLimits: limits})
}

func requestedBuild(n int, b *config.Build) BuildRequest {
	return BuildRequest{App: "mac-web", Image: requestedImage, SHA: sha(n), Source: testSource(), Build: b, Port: 8080}
}

// startRequested runs a requested build to its end.
func (h *buildHarness) startRequested(req BuildRequest) (store.Deployment, error) {
	h.t.Helper()
	id, done, err := h.d.StartBuildRequest(context.Background(), req)
	if err != nil {
		return store.Deployment{}, err
	}
	<-done
	dep, err := h.st.Deployment(context.Background(), id)
	if err != nil {
		h.t.Fatal(err)
	}
	return dep, nil
}

func TestARequestedBuildNeedsNoAppRecordsItsHistoryAndKeepsTheImageForExport(t *testing.T) {
	h := newBuildHarness(t)
	h.serverWithoutApps(&config.BuildLimits{Memory: sz("1g")})
	ref := requestedImage + ":" + sha(1)
	h.eng.saved = map[string][]byte{ref: []byte("the archive"), requestedImage + ":" + sha(9): []byte("never built here")}

	dep, err := h.startRequested(requestedBuild(1, &config.Build{Preset: "static", Args: map[string]string{"A": "b"}}))
	if err != nil || dep.Status != store.StatusSucceeded || dep.App != "mac-web" || dep.Ref != ref || dep.Trigger != TriggerBuild {
		t.Fatalf("%v %+v %v", err, dep, h.events(dep.ID))
	}
	if len(h.eng.snapshot()) != 0 || h.eng.container("mac-web") != nil {
		t.Errorf("nothing runs on the server that built: %v", h.eng.opsList())
	}
	var said bool
	for _, e := range h.events(dep.ID) {
		said = said || strings.Contains(e, "runs elsewhere: nothing is deployed on this server")
	}
	if !said {
		t.Errorf("the log must say why nothing was deployed: %v", h.events(dep.ID))
	}
	reqs := h.b.requests()
	if len(reqs) != 1 || reqs[0].Image != requestedImage || reqs[0].Port != 8080 || reqs[0].Config.Args["A"] != "b" {
		t.Fatalf("the build the engine got: %+v", reqs)
	}
	// What the request left out is the lower of the default and the ceiling: it is never what makes it too big.
	if got := reqs[0].Config.MemoryBytes(); got != 1<<30 {
		t.Errorf("an omitted memory defaults to the ceiling when that is lower: %d", got)
	}
	h.noTokenAnywhere(dep)

	// The history is the store's: it stays, and so does the right to export, when the apps file is read again.
	h.serverWithoutApps(&config.BuildLimits{Memory: sz("1g")})
	hist, err := h.d.Deployments(context.Background(), "mac-web", 10)
	if err != nil || len(hist) != 1 || hist[0].ID != dep.ID {
		t.Errorf("history of an app-less build: %v %+v", err, hist)
	}
	r, err := h.d.ExportImageRef(context.Background(), requestedImage, sha(1))
	if err != nil {
		t.Fatal(err)
	}
	got, _ := io.ReadAll(r)
	r.Close()
	if string(got) != "the archive" {
		t.Errorf("exported %q", got)
	}
	if _, err := h.d.ExportImageRef(context.Background(), requestedImage, sha(9)); !errors.Is(err, ErrNoImage) {
		t.Errorf("an image this server did not build: %v", err)
	}
	if _, err := h.d.ExportImageRef(context.Background(), "library/nginx", "latest"); !errors.Is(err, ErrNoImage) {
		t.Errorf("an arbitrary image of the engine: %v", err)
	}
	if _, err := h.d.ExportImageRef(context.Background(), requestedImage, "a b"); !errors.Is(err, ErrInvalidTarget) {
		t.Errorf("an invalid tag: %v", err)
	}
}

func TestARequestedBuildUsesTheBuildersOwnStoredVariablesUnderTheSameNameAndNothingFromElsewhere(t *testing.T) {
	h := newBuildHarness(t)
	svc := attachStore(t, h.d)
	// The variables of an app that exists on this server...
	mustApply(t, svc, "web", appenv.Change{Set: map[string]string{"API_URL": "https://builder", "SECRET": "not-a-build-variable-1"}, Build: []string{"API_URL"}})
	// ... are those of a build requested under that name, once no app is in the file.
	h.serverWithoutApps(nil)
	req := BuildRequest{App: "web", Image: repo, SHA: sha(1), Source: testSource(), Build: &config.Build{Args: map[string]string{"API_URL": "https://from-request", "B": "2"}}}
	if dep, err := h.startRequested(req); err != nil || dep.Status != store.StatusSucceeded {
		t.Fatalf("%v %+v", err, dep)
	}
	got := h.b.requests()[0]
	if got.Args["API_URL"] != "https://builder" || got.Args["SECRET"] != "" || len(got.Args) != 1 {
		t.Errorf("the builder's own variables flagged for builds are the managed arguments: %v", got.Args)
	}
	// build.Request merges them under the request's own, which win (see build.mergedArgs).
	if got.Config.Args["API_URL"] != "https://from-request" || got.Config.Args["B"] != "2" {
		t.Errorf("the request's arguments: %v", got.Config.Args)
	}
}

const buildVarSecret = "postgres://u:Bu1ld-V4r-Secret@127.0.0.1:5432/site"

func TestARequestedBuildUsesTheBuildVarsOfItsNameLogsOnlyHowManyAndTheyWinOverTheAppsOwnFlaggedVariables(t *testing.T) {
	h := newBuildHarness(t)
	svc := attachStore(t, h.d)
	h.serverWithoutApps(nil)
	if _, err := svc.ApplyBuildVars("mac-web", appenv.BuildVarsChange{Set: map[string]string{"DATABASE_URL": buildVarSecret, "NEXT_PUBLIC_X": "x-value"}}); err != nil {
		t.Fatal(err)
	}
	// The same name with its own variables flagged for build (an orphaned scope, or an app that was in the file): the build
	// variables win name by name, and what they do not name is still the app's.
	if err := svc.Store.Update("mac-web", appenv.ScopeApp, time.Now(), func(sc *appenv.Scope) (bool, error) {
		sc.Entries["DATABASE_URL"] = appenv.Entry{Value: "postgres://the-apps-own", Build: true}
		sc.Entries["ONLY_APP"] = appenv.Entry{Value: "kept", Build: true}
		return true, nil
	}); err != nil {
		t.Fatal(err)
	}
	// Another name's build variables are never used.
	if _, err := svc.ApplyBuildVars("other", appenv.BuildVarsChange{Set: map[string]string{"OTHER_ONLY": "nope-nope"}}); err != nil {
		t.Fatal(err)
	}

	req := requestedBuild(1, &config.Build{Preset: "static", Args: map[string]string{"NEXT_PUBLIC_X": "from-request"}})
	dep, err := h.startRequested(req)
	if err != nil || dep.Status != store.StatusSucceeded {
		t.Fatalf("%v %+v %v", err, dep, h.events(dep.ID))
	}
	got := h.b.requests()[0]
	if got.Args["DATABASE_URL"] != buildVarSecret || got.Args["ONLY_APP"] != "kept" || got.Args["OTHER_ONLY"] != "" || len(got.Args) != 3 {
		t.Errorf("the arguments: %v", got.Args)
	}
	if got.Config.Args["NEXT_PUBLIC_X"] != "from-request" {
		t.Errorf("the request's own args still win: %v", got.Config.Args)
	}
	events := strings.Join(h.events(dep.ID), "\n")
	if !strings.Contains(events, "2 build variable(s) from this server's build-vars for mac-web") {
		t.Errorf("the log must say they were used: %s", events)
	}
	if strings.Contains(events, buildVarSecret) || strings.Contains(events, "Bu1ld-V4r") || strings.Contains(h.logs.String(), "Bu1ld-V4r") || strings.Contains(dep.Error, "Bu1ld-V4r") {
		t.Errorf("a value is in what the agent records:\n%s\n%s", events, h.logs.String())
	}

	// Without build-vars (and without anything of the name) the log says nothing about them.
	if _, err := svc.ClearBuildVars("mac-web"); err != nil {
		t.Fatal(err)
	}
	dep, err = h.startRequested(requestedBuild(2, &config.Build{Preset: "static"}))
	if err != nil || dep.Status != store.StatusSucceeded {
		t.Fatalf("%v %+v", err, dep)
	}
	if strings.Contains(strings.Join(h.events(dep.ID), "\n"), "build-vars") {
		t.Errorf("no build variables: %v", h.events(dep.ID))
	}
	if got := h.b.requests()[1].Args; got["DATABASE_URL"] != "postgres://the-apps-own" || len(got) != 2 {
		t.Errorf("the app's own flagged variables are what is left: %v", got)
	}
}

func TestAnAppOfTheFileBuildsItsOwnImageWithItsOwnVariablesNotTheBuildVars(t *testing.T) {
	h := newBuildHarness(t)
	svc := attachStore(t, h.d)
	mustApply(t, svc, "web", appenv.Change{Set: map[string]string{"API_URL": "https://own"}, Build: []string{"API_URL"}})
	if _, err := svc.ApplyBuildVars("web", appenv.BuildVarsChange{Set: map[string]string{"API_URL": "https://for-others", "EXTRA": "extra-value"}}); err != nil {
		t.Fatal(err)
	}
	dep, err := h.startBuild("web", 1)
	if err != nil || dep.Status != store.StatusSucceeded {
		t.Fatalf("%v %+v", err, dep)
	}
	if got := h.b.requests()[0].Args; len(got) != 1 || got["API_URL"] != "https://own" {
		t.Errorf("the app's own build keeps its own scope: %v", got)
	}
	for _, e := range h.events(dep.ID) {
		if strings.Contains(e, "build-vars") {
			t.Errorf("%s", e)
		}
	}
}

func TestARequestedBuildIsHeldToBuildLimitsAndNeverClamped(t *testing.T) {
	limits := &config.BuildLimits{
		Memory: sz("1g"), CPUs: ptr(2.0), Timeout: config.D(10 * 60 * 1e9), MaxSource: sz("100m"), SourceHosts: []string{"git.example.com"},
	}
	for name, c := range map[string]struct {
		limits *config.BuildLimits
		build  config.Build
		want   string
	}{
		"memory":       {limits, config.Build{Memory: sz("2g")}, "build_limits.memory (1g)"},
		"cpus":         {limits, config.Build{CPUs: ptr(3.0)}, "build_limits.cpus (2)"},
		"timeout":      {limits, config.Build{Timeout: config.D(11 * 60 * 1e9)}, "build_limits.timeout (10m)"},
		"max_source":   {limits, config.Build{MaxSource: sz("200m")}, "build_limits.max_source (100m)"},
		"source_hosts": {limits, config.Build{SourceHosts: []string{"git.example.com", "evil.example.org"}}, "evil.example.org is not one of the hosts"},
		"host network": {limits, config.Build{Network: "host"}, "host_network is off"},
		"default host": {nil, config.Build{SourceHosts: []string{"git.example.com"}}, "git.example.com is not one of the hosts"},
		"only":         {limits, config.Build{Only: true}, "build.only is not accepted"},
		"database":     {limits, config.Build{Database: true}, "build.database is not accepted"},
	} {
		t.Run(name, func(t *testing.T) {
			h := newBuildHarness(t)
			h.serverWithoutApps(c.limits)
			b := c.build
			_, err := h.startRequested(requestedBuild(1, &b))
			var refused *config.BuildRequestError
			if !errors.As(err, &refused) || !strings.Contains(err.Error(), c.want) {
				t.Fatalf("want a refusal with %q, got %v", c.want, err)
			}
			if len(h.b.requests()) != 0 {
				t.Error("a refused request must not build")
			}
			if deps, _ := h.st.ListDeployments(context.Background(), "", 10); len(deps) != 0 {
				t.Errorf("a refused request records nothing: %+v", deps)
			}
		})
	}

	// At the limit, and with host_network on, the same requests are accepted.
	h := newBuildHarness(t)
	h.serverWithoutApps(&config.BuildLimits{Memory: sz("1g"), HostNetwork: true})
	b := &config.Build{Memory: sz("1g"), Network: "host"}
	if dep, err := h.startRequested(requestedBuild(1, b)); err != nil || dep.Status != store.StatusSucceeded {
		t.Errorf("at the limit: %v %+v", err, dep)
	}
}

func TestARequestedBuildCannotTakeTheNameOrTheImageOfAnAppOfThisServer(t *testing.T) {
	h := newBuildHarness(t) // apps web (ghcr.io/o/web), api (ghcr.io/o/api), static (ghcr.io/o/web)
	for name, req := range map[string]BuildRequest{
		"same name, other image": {App: "web", Image: requestedImage},
		"other name, same image": {App: "mac-web", Image: "ghcr.io/o/api"},
	} {
		req.SHA, req.Source, req.Build = sha(1), testSource(), &config.Build{}
		if _, err := h.startRequested(req); !errors.Is(err, ErrBuildNameTaken) {
			t.Errorf("%s: %v", name, err)
		}
	}
	if len(h.b.requests()) != 0 {
		t.Error("a refused request must not build")
	}
	// The same name with the same image is the same app: allowed (its image is then built here, and runs elsewhere).
	h.d.cfg.Store(&config.Config{Apps: []config.App{h.app}, Proxy: &config.Proxy{}})
	req := BuildRequest{App: "web", Image: repo, SHA: sha(1), Source: testSource(), Build: &config.Build{}}
	if dep, err := h.startRequested(req); err != nil || dep.Status != store.StatusSucceeded {
		t.Errorf("%v %+v", err, dep)
	}
}

func TestARequestedBuildPrunesOldImagesOfItsNameByKeepImages(t *testing.T) {
	h := newBuildHarness(t)
	keep := 2
	h.serverWithoutApps(&config.BuildLimits{KeepImages: &keep})
	for n := 1; n <= 3; n++ {
		h.eng.images = append(h.eng.images, docker.Image{ID: "i" + sha(n)[39:], RepoTags: []string{requestedImage + ":" + sha(n)}})
		if dep, err := h.startRequested(requestedBuild(n, &config.Build{})); err != nil || dep.Status != store.StatusSucceeded {
			t.Fatalf("%v %+v", err, dep)
		}
	}
	if got, want := h.removed(), []string{requestedImage + ":" + sha(1)}; !slices.Equal(got, want) {
		t.Errorf("keep_images: 2 keeps the two newest builds: removed %v, want %v", got, want)
	}
}
