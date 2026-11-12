package api

import (
	"bytes"
	"context"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/0x2u/keelson/agent/internal/build"
	"github.com/0x2u/keelson/agent/internal/config"
	"github.com/0x2u/keelson/agent/internal/deploy"
	"github.com/0x2u/keelson/agent/internal/store"
)

const (
	buildSHA   = "0123456789abcdef0123456789abcdef01234567"
	buildToken = "ghs_TopSecretInstallationToken"
	buildURL   = "https://api.github.com/repos/o/r/tarball/" + buildSHA
)

// buildCall is what a fake recorded of a build request.
type buildCall struct {
	app, sha string
	pr       int
	src      build.Source
}

func (f *fakeDeployments) StartBuild(_ context.Context, app, sha string, src build.Source) (string, <-chan struct{}, error) {
	if f.buildErr != nil {
		return "", nil, f.buildErr
	}
	f.builds = append(f.builds, buildCall{app: app, sha: sha, src: src})
	return "dep3", nil, nil
}

// fakeBuilds records the builds other servers asked for.
type fakeBuilds struct {
	err      error
	requests []deploy.BuildRequest
	ceilings config.BuildCeilings
}

func (f *fakeBuilds) StartBuildRequest(_ context.Context, req deploy.BuildRequest) (string, <-chan struct{}, error) {
	if f.err != nil {
		return "", nil, f.err
	}
	f.requests = append(f.requests, req)
	return "dep7", nil, nil
}

func (f *fakeBuilds) BuildCeilings() config.BuildCeilings { return f.ceilings }

func (f *fakePreviews) StartPreviewBuild(_ context.Context, app string, pr int, sha string, src build.Source) (deploy.PreviewStarted, <-chan struct{}, error) {
	if f.err != nil {
		return deploy.PreviewStarted{}, nil, f.err
	}
	f.builds = append(f.builds, buildCall{app: app, sha: sha, pr: pr, src: src})
	return deploy.PreviewStarted{DeploymentID: "d4", Name: app + "-pr-" + itoa(pr), URL: "https://pr-" + itoa(pr) + "-shop.example.com"}, nil, nil
}

// buildEnv is a server with the deploy routes, the audit log and a log that is kept.
type buildEnv struct {
	*configEnv
	deploys  *fakeDeployments
	previews *fakePreviews
	logs     *bytes.Buffer
	builds   *fakeBuilds
}

func newBuildEnv(t *testing.T) *buildEnv {
	t.Helper()
	st, err := store.Open(filepath.Join(t.TempDir(), "a.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	fd, fp, logs, fb := &fakeDeployments{}, &fakePreviews{}, &bytes.Buffer{}, &fakeBuilds{}
	h, err := New(&fakeDocker{}, Options{
		Token: testToken, Logger: slog.New(slog.NewTextHandler(logs, &slog.HandlerOptions{Level: slog.LevelDebug})),
		Deploy: &DeployOptions{Deployments: fd, Secret: testSecret, Replays: st, Config: &fakeConfig{}, Audit: st, Previews: fp, Builds: fb},
	})
	if err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(h)
	t.Cleanup(srv.Close)
	return &buildEnv{configEnv: &configEnv{srv: srv, st: st}, deploys: fd, previews: fp, logs: logs, builds: fb}
}

func buildBody(extra string) string {
	return `{"sha":"` + buildSHA + `","source":{"url":"` + buildURL + `","token":"` + buildToken + `"}` + extra + `}`
}

func TestSignedBuildStartsADeploymentAndNeverRecordsTheToken(t *testing.T) {
	e := newBuildEnv(t)
	resp, body := e.signed(t, "POST", "/v1/apps/shop/build", buildBody(`,"deploy":true`), "dashboard")
	if resp.StatusCode != http.StatusAccepted || strings.TrimSpace(body) != `{"deployment_id":"dep3"}` {
		t.Fatalf("%d %s", resp.StatusCode, body)
	}
	if len(e.deploys.builds) != 1 {
		t.Fatalf("%+v", e.deploys.builds)
	}
	if c := e.deploys.builds[0]; c.app != "shop" || c.sha != buildSHA || c.src.URL != buildURL || c.src.Token != buildToken {
		t.Errorf("the deployer must get the request as sent: %+v", c)
	}
	log, _ := e.st.Audit(t.Context(), 10, 0)
	if len(log) != 1 || log[0].Action != "build" || log[0].Method != "POST" || log[0].Path != "/v1/apps/shop/build" ||
		log[0].Actor != "dashboard" || log[0].Status != 202 || log[0].Detail != "shop sha="+buildSHA {
		t.Errorf("audit: %+v", log)
	}

	// Without "deploy" the default is to deploy.
	if resp, _ := e.signed(t, "POST", "/v1/apps/shop/build", buildBody(``), ""); resp.StatusCode != 202 {
		t.Errorf("deploy is optional: %d", resp.StatusCode)
	}
	for _, e := range e.audit(t) {
		if strings.Contains(e, buildToken) {
			t.Errorf("the token is in the audit log: %s", e)
		}
	}
	if strings.Contains(e.logs.String(), buildToken) {
		t.Errorf("the token is in the log:\n%s", e.logs.String())
	}
}

func requestedBuildBody(extra string) string {
	return `{"app":"web","image":"keelson-local/web","sha":"` + buildSHA + `","source":{"url":"` + buildURL + `","token":"` + buildToken + `"},` +
		`"build":{"preset":"static","memory":"1g","args":{"A":"1"}},"port":8080,"health_path":"/up"` + extra + `}`
}

func TestSignedBuildRequestStartsABuildOfAnyAppAndNeverRecordsTheToken(t *testing.T) {
	e := newBuildEnv(t)
	resp, body := e.signed(t, "POST", "/v1/builds", requestedBuildBody(``), "dashboard")
	if resp.StatusCode != http.StatusAccepted || strings.TrimSpace(body) != `{"deployment_id":"dep7"}` {
		t.Fatalf("%d %s", resp.StatusCode, body)
	}
	if len(e.builds.requests) != 1 {
		t.Fatalf("%+v", e.builds.requests)
	}
	r := e.builds.requests[0]
	if r.App != "web" || r.Image != "keelson-local/web" || r.SHA != buildSHA || r.Source.URL != buildURL || r.Source.Token != buildToken ||
		r.Port != 8080 || r.HealthPath != "/up" || r.Build == nil || r.Build.Preset != "static" || r.Build.Memory.Bytes() != 1<<30 || r.Build.Args["A"] != "1" {
		t.Errorf("the deployer must get the request as sent: %+v %+v", r, r.Build)
	}
	log, _ := e.st.Audit(t.Context(), 10, 0)
	if len(log) != 1 || log[0].Action != "build" || log[0].Path != "/v1/builds" || log[0].Actor != "dashboard" || log[0].Status != 202 || log[0].Detail != "web sha="+buildSHA {
		t.Errorf("audit: %+v", log)
	}
	for _, entry := range e.audit(t) {
		if strings.Contains(entry, buildToken) {
			t.Errorf("the token is in the audit log: %s", entry)
		}
	}
	if strings.Contains(e.logs.String(), buildToken) {
		t.Errorf("the token is in the log:\n%s", e.logs.String())
	}
}

func TestBuildRequestBodiesAndErrorsAreAnsweredPrecisely(t *testing.T) {
	e := newBuildEnv(t)
	for name, body := range map[string]string{
		"no body":       ``,
		"no source":     `{"app":"web","image":"a/web","sha":"` + buildSHA + `","build":{}}`,
		"no build":      `{"app":"web","image":"a/web","sha":"` + buildSHA + `","source":{"url":"` + buildURL + `","token":"t"}}`,
		"unknown field": requestedBuildBody(`,"deploy":true`),
		"unknown build": `{"app":"web","image":"a/web","sha":"` + buildSHA + `","source":{"url":"` + buildURL + `","token":"t"},"build":{"nope":1}}`,
	} {
		if resp, out := e.signed(t, "POST", "/v1/builds", body, ""); resp.StatusCode != 400 {
			t.Errorf("%s: want 400, got %d %s", name, resp.StatusCode, out)
		}
	}
	if len(e.builds.requests) != 0 {
		t.Fatalf("nothing may start: %+v", e.builds.requests)
	}
	for _, c := range []struct {
		err    error
		status int
		text   string
	}{
		{&config.BuildRequestError{Msg: "build.memory 4g is above this server's build_limits.memory (1g)"}, 400, "build_limits.memory"},
		{build.ErrSourceHost, 400, ""},
		{build.ErrBadSHA, 400, "sha"},
		{deploy.ErrBuildNameTaken, 409, "taken"},
		{deploy.ErrBuildBusy, 409, "another build"},
		{deploy.ErrBusy, 409, "already running"},
		{deploy.ErrShuttingDown, 503, "shutting down"},
	} {
		e.builds.err = c.err
		resp, out := e.signed(t, "POST", "/v1/builds", requestedBuildBody(``), "")
		if resp.StatusCode != c.status || !strings.Contains(out, c.text) {
			t.Errorf("%v: want %d %q, got %d %s", c.err, c.status, c.text, resp.StatusCode, out)
		}
	}
	req, _ := http.NewRequest("POST", e.srv.URL+"/v1/builds", strings.NewReader(requestedBuildBody(``)))
	req.Header.Set("Authorization", "Bearer "+testToken)
	r, _ := http.DefaultClient.Do(req)
	r.Body.Close()
	if r.StatusCode != http.StatusUnauthorized {
		t.Errorf("the read token must not build: %d", r.StatusCode)
	}
}

// audit returns every audit entry as text.
func (e *buildEnv) audit(t *testing.T) []string {
	t.Helper()
	entries, err := e.st.Audit(t.Context(), 100, 0)
	if err != nil {
		t.Fatal(err)
	}
	out := make([]string, len(entries))
	for i, en := range entries {
		out[i] = en.Actor + "|" + en.IP + "|" + en.Method + "|" + en.Path + "|" + en.Action + "|" + en.Detail
	}
	return out
}

func TestBuildRequestsAreValidated(t *testing.T) {
	e := newBuildEnv(t)
	bad := map[string]string{
		"no source":      `{"sha":"` + buildSHA + `"}`,
		"no body":        ``,
		"not json":       `sha=abc`,
		"unknown field":  buildBody(`,"force":true`),
		"deploy false":   buildBody(`,"deploy":false`),
		"source typed":   `{"sha":"` + buildSHA + `","source":"https://x"}`,
		"token a number": `{"sha":"` + buildSHA + `","source":{"url":"` + buildURL + `","token":5}}`,
	}
	for name, body := range bad {
		resp, out := e.signed(t, "POST", "/v1/apps/shop/build", body, "")
		if resp.StatusCode != 400 {
			t.Errorf("%s: want 400, got %d %s", name, resp.StatusCode, out)
		}
		if strings.Contains(out, buildToken) {
			t.Errorf("%s: the answer echoes the token: %s", name, out)
		}
	}
	if len(e.deploys.builds) != 0 {
		t.Errorf("a refused body reached the deployer: %+v", e.deploys.builds)
	}
}

func TestBuildErrorsMapToStatuses(t *testing.T) {
	e := newBuildEnv(t)
	cases := []struct {
		err    error
		status int
		text   string
	}{
		{deploy.ErrUnknownApp, 404, "not found"},
		{deploy.ErrNoBuild, 400, "no build block"},
		{build.ErrBadSHA, 400, "sha must be"},
		{build.ErrSourceHost, 400, "source_hosts"},
		{build.ErrSourceToken, 400, "token"},
		{deploy.ErrBuildBusy, 409, "another build"},
		{deploy.ErrBusy, 409, "already running"},
		{deploy.ErrShuttingDown, 503, "shutting down"},
		{io.ErrUnexpectedEOF, 500, "internal error"},
	}
	for _, c := range cases {
		e.deploys.buildErr = c.err
		resp, body := e.signed(t, "POST", "/v1/apps/shop/build", buildBody(``), "")
		if resp.StatusCode != c.status || !strings.Contains(body, c.text) {
			t.Errorf("%v: want %d %q, got %d %s", c.err, c.status, c.text, resp.StatusCode, body)
		}
		if c.status == 500 && strings.Contains(body, "unexpected EOF") {
			t.Error("internal errors must not leak their text")
		}
	}
}

func TestBuildNeedsASignatureNotTheReadToken(t *testing.T) {
	e := newBuildEnv(t)
	path := "/v1/apps/shop/build"
	body := buildBody(``)
	for name, setup := range map[string]func(*http.Request){
		"no credentials": func(*http.Request) {},
		"read token":     func(r *http.Request) { r.Header.Set("Authorization", "Bearer "+testToken) },
		"bad signature": func(r *http.Request) {
			ts := time.Now().Unix()
			r.Header.Set(HeaderTimestamp, strconv.FormatInt(ts, 10))
			r.Header.Set(HeaderSignature, Sign(testToken, ts, "POST", path, []byte(body)))
		},
		"tampered": func(r *http.Request) {
			ts := time.Now().Unix()
			r.Header.Set(HeaderTimestamp, strconv.FormatInt(ts, 10))
			r.Header.Set(HeaderSignature, Sign(testSecret, ts, "POST", path, []byte(buildBody(`,"deploy":true`))))
		},
	} {
		req, _ := http.NewRequest("POST", e.srv.URL+path, strings.NewReader(body))
		setup(req)
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		if resp.StatusCode != http.StatusUnauthorized {
			t.Errorf("%s: want 401, got %d", name, resp.StatusCode)
		}
	}
	// GET is not a route at all.
	if got := do(t, "GET", e.srv.URL+path, testToken).StatusCode; got == 200 || got == 202 {
		t.Errorf("GET: %d", got)
	}
	if len(e.deploys.builds) != 0 {
		t.Error("an unsigned request reached the deployer")
	}
	if got := e.audit(t); len(got) != 0 {
		t.Errorf("unauthenticated calls are not audited: %v", got)
	}
}

func TestPutPreviewWithASourceBuildsIt(t *testing.T) {
	e := newBuildEnv(t)
	resp, body := e.signed(t, "PUT", "/v1/previews/shop/12", buildBody(``), "dashboard")
	if resp.StatusCode != http.StatusAccepted || !strings.Contains(body, `"deployment_id":"d4"`) || !strings.Contains(body, `"name":"shop-pr-12"`) {
		t.Fatalf("%d %s", resp.StatusCode, body)
	}
	if len(e.previews.builds) != 1 {
		t.Fatalf("%+v", e.previews.builds)
	}
	if c := e.previews.builds[0]; c.app != "shop" || c.pr != 12 || c.sha != buildSHA || c.src.Token != buildToken || c.src.URL != buildURL {
		t.Errorf("%+v", c)
	}
	log, _ := e.st.Audit(t.Context(), 10, 0)
	if len(log) != 1 || log[0].Action != "preview.deploy" || log[0].Detail != "shop-pr-12 sha="+buildSHA {
		t.Errorf("audit: %+v", log)
	}
	for _, line := range e.audit(t) {
		if strings.Contains(line, buildToken) {
			t.Errorf("token in audit: %s", line)
		}
	}
	if strings.Contains(e.logs.String(), buildToken) {
		t.Errorf("token in the log:\n%s", e.logs.String())
	}
	if len(e.previews.started) != 0 {
		t.Error("a build must not also start a tag deployment")
	}
}

func TestPutPreviewTakesExactlyOneOfTagOrSource(t *testing.T) {
	e := newBuildEnv(t)
	tag := strings.Repeat("c", 40)
	src := `"source":{"url":"` + buildURL + `","token":"` + buildToken + `"}`
	bad := map[string]string{
		"tag and sha":        `{"tag":"` + tag + `","sha":"` + buildSHA + `",` + src + `}`,
		"tag and source":     `{"tag":"` + tag + `",` + src + `}`,
		"sha without source": `{"sha":"` + buildSHA + `"}`,
		"source without sha": `{` + src + `}`,
		"empty":              `{}`,
	}
	for name, body := range bad {
		resp, out := e.signed(t, "PUT", "/v1/previews/shop/1", body, "")
		if resp.StatusCode != 400 {
			t.Errorf("%s: want 400, got %d %s", name, resp.StatusCode, out)
		}
	}
	if len(e.previews.builds)+len(e.previews.started) != 0 {
		t.Error("refused requests reached the service")
	}
	// The existing form still works.
	if resp, _ := e.signed(t, "PUT", "/v1/previews/shop/1", `{"tag":"`+tag+`"}`, ""); resp.StatusCode != 202 || len(e.previews.started) != 1 {
		t.Errorf("tag form: %d %v", resp.StatusCode, e.previews.started)
	}
}

func TestPreviewBuildErrorsMapToStatuses(t *testing.T) {
	e := newBuildEnv(t)
	for _, c := range []struct {
		err    error
		status int
	}{
		{deploy.ErrNoPreview, 404}, {deploy.ErrNoBuild, 400}, {build.ErrBadSHA, 400}, {build.ErrSourceHost, 400},
		{build.ErrSourceToken, 400}, {deploy.ErrBuildBusy, 409}, {deploy.ErrBusy, 409}, {deploy.ErrShuttingDown, 503},
	} {
		e.previews.err = c.err
		if resp, body := e.signed(t, "PUT", "/v1/previews/shop/1", buildBody(``), ""); resp.StatusCode != c.status {
			t.Errorf("%v: want %d, got %d %s", c.err, c.status, resp.StatusCode, body)
		}
	}
}
