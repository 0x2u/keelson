package api

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/0x2u/keelson/agent/internal/deploy"
	"github.com/0x2u/keelson/agent/internal/store"
)

const testSecret = "fedcba9876543210fedcba9876543210"

type fakeDeployments struct {
	startErr error
	started  []string // "app:tag"
	triggers []string
	rolled   []string
	events   []store.Event
	dep      store.Deployment
	proxy    *deploy.ProxyView
	builds   []buildCall
	buildErr error
	// containerErrs scripts StartContainer/RestartContainer by container name; containerActs records "start name" and
	// "restart name".
	containerErrs map[string]error
	containerActs []string
}

func (f *fakeDeployments) StartContainer(_ context.Context, name string) error {
	f.containerActs = append(f.containerActs, "start "+name)
	return f.containerErrs[name]
}

func (f *fakeDeployments) RestartContainer(_ context.Context, name string) error {
	f.containerActs = append(f.containerActs, "restart "+name)
	return f.containerErrs[name]
}

func (f *fakeDeployments) Proxy(context.Context) (*deploy.ProxyView, error) { return f.proxy, nil }

func (f *fakeDeployments) Start(_ context.Context, app string, t deploy.Target, trigger string) (string, <-chan struct{}, error) {
	if f.startErr != nil {
		return "", nil, f.startErr
	}
	f.triggers = append(f.triggers, trigger)
	f.started = append(f.started, app+":"+t.Tag+t.Digest)
	return "dep1", nil, nil
}
func (f *fakeDeployments) Rollback(_ context.Context, app string) (string, <-chan struct{}, error) {
	if f.startErr != nil {
		return "", nil, f.startErr
	}
	f.rolled = append(f.rolled, app)
	return "dep2", nil, nil
}
func (f *fakeDeployments) Apps(context.Context) ([]deploy.AppStatus, error) {
	return []deploy.AppStatus{{Name: "web", Image: "o/web"}}, nil
}
func (f *fakeDeployments) Deployment(_ context.Context, id string) (store.Deployment, error) {
	if id != f.dep.ID {
		return store.Deployment{}, store.ErrNotFound
	}
	return f.dep, nil
}
func (f *fakeDeployments) Deployments(_ context.Context, app string, limit int) ([]store.Deployment, error) {
	return []store.Deployment{f.dep}, nil
}
func (f *fakeDeployments) Events(_ context.Context, id string, after int64) ([]store.Event, error) {
	var out []store.Event
	for _, e := range f.events {
		if e.Seq > after {
			out = append(out, e)
		}
	}
	return out, nil
}

type deployEnv struct {
	srv  *httptest.Server
	fake *fakeDeployments
	st   *store.Store
	now  time.Time
}

func newDeployServer(t *testing.T) *deployEnv {
	t.Helper()
	st, err := store.Open(filepath.Join(t.TempDir(), "a.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	fake := &fakeDeployments{dep: store.Deployment{ID: "dep1", App: "web", Status: store.StatusSucceeded}}
	h, err := New(&fakeDocker{}, Options{
		Token: testToken, Version: "test", Logger: slog.New(slog.NewTextHandler(io.Discard, nil)),
		Deploy: &DeployOptions{Deployments: fake, Secret: testSecret, Replays: st},
	})
	if err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(h)
	t.Cleanup(srv.Close)
	return &deployEnv{srv: srv, fake: fake, st: st}
}

// post sends a POST signed at ts with the given secret.
func (e *deployEnv) post(t *testing.T, path, body, secret string, ts time.Time) *http.Response {
	t.Helper()
	req, _ := http.NewRequest("POST", e.srv.URL+path, strings.NewReader(body))
	unix := ts.Unix()
	req.Header.Set(HeaderTimestamp, strconv.FormatInt(unix, 10))
	req.Header.Set(HeaderSignature, Sign(secret, unix, "POST", path, []byte(body)))
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { resp.Body.Close() })
	return resp
}

func TestSignedDeployStartsDeployment(t *testing.T) {
	e := newDeployServer(t)
	resp := e.post(t, "/v1/apps/web/deploy", `{"tag":"abc123"}`, testSecret, time.Now())
	if resp.StatusCode != http.StatusAccepted {
		t.Fatalf("got %d", resp.StatusCode)
	}
	var out map[string]string
	json.NewDecoder(resp.Body).Decode(&out)
	if out["deployment_id"] != "dep1" || len(e.fake.started) != 1 || e.fake.started[0] != "web:abc123" {
		t.Errorf("unexpected result: %v %v", out, e.fake.started)
	}

	resp = e.post(t, "/v1/apps/web/rollback", ``, testSecret, time.Now())
	if resp.StatusCode != http.StatusAccepted || len(e.fake.rolled) != 1 {
		t.Errorf("rollback: %d %v", resp.StatusCode, e.fake.rolled)
	}
}

func TestPostWithoutAValidSignatureIsRejectedAndNeverReachesTheEngine(t *testing.T) {
	e := newDeployServer(t)
	body := `{"tag":"x"}`
	path := "/v1/apps/web/deploy"
	now := time.Now()

	send := func(mutate func(r *http.Request)) int {
		req, _ := http.NewRequest("POST", e.srv.URL+path, strings.NewReader(body))
		req.Header.Set(HeaderTimestamp, strconv.FormatInt(now.Unix(), 10))
		req.Header.Set(HeaderSignature, Sign(testSecret, now.Unix(), "POST", path, []byte(body)))
		mutate(req)
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		return resp.StatusCode
	}

	cases := map[string]func(*http.Request){
		"no signature": func(r *http.Request) { r.Header.Del(HeaderSignature) },
		"no timestamp": func(r *http.Request) { r.Header.Del(HeaderTimestamp) },
		"bad hex":      func(r *http.Request) { r.Header.Set(HeaderSignature, "zz") },
		"short sig":    func(r *http.Request) { r.Header.Set(HeaderSignature, "abcd") },
		"read token": func(r *http.Request) {
			r.Header.Del(HeaderSignature)
			r.Header.Set("Authorization", "Bearer "+testToken)
		},
		"wrong secret": func(r *http.Request) {
			r.Header.Set(HeaderSignature, Sign(testToken, now.Unix(), "POST", path, []byte(body)))
		},
		"tampered body": func(r *http.Request) {
			r.Body = io.NopCloser(strings.NewReader(`{"tag":"evil"}`))
			r.ContentLength = 14
		},
		"other path": func(r *http.Request) {
			r.Header.Set(HeaderSignature, Sign(testSecret, now.Unix(), "POST", "/v1/apps/api/deploy", []byte(body)))
		},
		"stale":  func(r *http.Request) { setTime(r, now.Add(-MaxSkew-time.Minute), path, body) },
		"future": func(r *http.Request) { setTime(r, now.Add(MaxSkew+time.Minute), path, body) },
	}
	for name, mutate := range cases {
		if got := send(mutate); got != http.StatusUnauthorized {
			t.Errorf("%s: want 401, got %d", name, got)
		}
	}
	if len(e.fake.started) != 0 {
		t.Errorf("rejected requests reached the deployer: %v", e.fake.started)
	}
}

func setTime(r *http.Request, ts time.Time, path, body string) {
	r.Header.Set(HeaderTimestamp, strconv.FormatInt(ts.Unix(), 10))
	r.Header.Set(HeaderSignature, Sign(testSecret, ts.Unix(), "POST", path, []byte(body)))
}

func TestReplayedSignedRequestIsRejected(t *testing.T) {
	e := newDeployServer(t)
	now := time.Now()
	first := e.post(t, "/v1/apps/web/deploy", `{"tag":"v1"}`, testSecret, now)
	replay := e.post(t, "/v1/apps/web/deploy", `{"tag":"v1"}`, testSecret, now)
	if first.StatusCode != 202 || replay.StatusCode != 401 {
		t.Errorf("want 202 then 401, got %d then %d", first.StatusCode, replay.StatusCode)
	}
	if len(e.fake.started) != 1 {
		t.Errorf("the replay started a deployment: %v", e.fake.started)
	}
}

func TestSignatureCoversTheQueryString(t *testing.T) {
	e := newDeployServer(t)
	now := time.Now()
	req, _ := http.NewRequest("POST", e.srv.URL+"/v1/apps/web/rollback?x=1", nil)
	req.Header.Set(HeaderTimestamp, strconv.FormatInt(now.Unix(), 10))
	req.Header.Set(HeaderSignature, Sign(testSecret, now.Unix(), "POST", "/v1/apps/web/rollback", nil))
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != 401 {
		t.Errorf("a signature for another URI must not verify, got %d", resp.StatusCode)
	}
}

func TestOversizedSignedBodyIsRefused(t *testing.T) {
	e := newDeployServer(t)
	big := `{"tag":"` + strings.Repeat("a", maxSignedBody) + `"}`
	if got := e.post(t, "/v1/apps/web/deploy", big, testSecret, time.Now()).StatusCode; got != http.StatusRequestEntityTooLarge {
		t.Errorf("want 413, got %d", got)
	}
}

func TestDeployRequestBodyIsStrict(t *testing.T) {
	e := newDeployServer(t)
	for _, body := range []string{``, `not json`, `{"tag":"v1","extra":1}`, `[]`} {
		if got := e.post(t, "/v1/apps/web/deploy", body, testSecret, time.Now().Add(time.Duration(len(body))*time.Second)).StatusCode; got != 400 {
			t.Errorf("body %q: want 400, got %d", body, got)
		}
	}
}

func TestDeployErrorsMapToStatus(t *testing.T) {
	e := newDeployServer(t)
	cases := []struct {
		err  error
		want int
	}{
		{deploy.ErrUnknownApp, 404},
		{deploy.ErrInvalidTarget, 400},
		{deploy.ErrBusy, 409},
		{deploy.ErrNoRollbackTarget, 409},
		{errors.New("disk on fire"), 500},
	}
	for i, c := range cases {
		e.fake.startErr = c.err
		// Distinct timestamps keep every request's signature unique.
		got := e.post(t, "/v1/apps/web/deploy", `{"tag":"v1"}`, testSecret, time.Now().Add(time.Duration(i)*time.Second)).StatusCode
		if got != c.want {
			t.Errorf("%v: want %d, got %d", c.err, c.want, got)
		}
	}
}

func TestDeploymentReadsNeedTheReadToken(t *testing.T) {
	e := newDeployServer(t)
	for _, path := range []string{"/v1/apps", "/v1/deployments", "/v1/deployments/dep1", "/v1/deployments/dep1/events"} {
		if got := do(t, "GET", e.srv.URL+path, "").StatusCode; got != 401 {
			t.Errorf("%s without token: %d", path, got)
		}
		if got := do(t, "GET", e.srv.URL+path, testSecret).StatusCode; got != 401 {
			t.Errorf("%s with the deploy secret as a bearer: %d", path, got)
		}
		if got := do(t, "GET", e.srv.URL+path, testToken).StatusCode; got != 200 {
			t.Errorf("%s with the read token: %d", path, got)
		}
	}
	if got := do(t, "GET", e.srv.URL+"/v1/deployments/ghost", testToken).StatusCode; got != 404 {
		t.Errorf("unknown deployment: %d", got)
	}
	if got := do(t, "GET", e.srv.URL+"/v1/deployments?limit=0", testToken).StatusCode; got != 400 {
		t.Errorf("bad limit: %d", got)
	}
}

func TestDeploymentEventsReplayThenEnd(t *testing.T) {
	e := newDeployServer(t)
	e.fake.events = []store.Event{{Seq: 1, Level: "info", Message: "pulling"}, {Seq: 2, Level: "info", Message: "healthy"}}

	resp := do(t, "GET", e.srv.URL+"/v1/deployments/dep1/events", testToken)
	ev := readEvents(t, resp.Body)
	if len(ev) != 3 || !strings.Contains(ev[0], "pulling") || !strings.Contains(ev[1], "healthy") || ev[2] != `end: {"status":"succeeded"}` {
		t.Errorf("unexpected events: %v", ev)
	}
}

// The pipeline of a deployment is part of its record, in the list and alone, and each event says which phase it was
// written in; a deployment from before phases has none of those fields.
func TestDeploymentsCarryTheirPhasesAndEventsTheirPhase(t *testing.T) {
	e := newDeployServer(t)
	t0 := time.Date(2026, 11, 2, 10, 0, 0, 0, time.UTC)
	end := t0.Add(9 * time.Second)
	e.fake.dep = store.Deployment{
		ID: "dep1", App: "web", Ref: "o/web:v2", PreviousRef: "o/web:v1", ServingRef: "o/web:v1",
		Status: store.StatusRolledBack, Trigger: "api", Error: "container exited with code 1", StartedAt: t0, FinishedAt: &end,
		Phases: []store.Phase{
			{Name: store.PhaseRelease, Status: store.PhaseDone, StartedAt: t0, FinishedAt: new(t0.Add(4 * time.Second))},
			{Name: store.PhaseSwitch, Status: store.PhaseFailed, StartedAt: t0.Add(4 * time.Second), FinishedAt: &end},
		},
	}
	e.fake.events = []store.Event{
		{Seq: 1, Time: t0, Level: "info", Message: "deploying o/web:v2 to web"},
		{Seq: 2, Time: t0, Level: "error", Message: "new container failed", Phase: store.PhaseSwitch},
	}

	want := `{"id":"dep1","app":"web","ref":"o/web:v2","previous_ref":"o/web:v1","serving_ref":"o/web:v1","status":"rolled_back","trigger":"api",` +
		`"error":"container exited with code 1","started_at":"2026-11-02T10:00:00Z","finished_at":"2026-11-02T10:00:09Z","phases":[` +
		`{"name":"release","status":"done","started_at":"2026-11-02T10:00:00Z","finished_at":"2026-11-02T10:00:04Z"},` +
		`{"name":"switch","status":"failed","started_at":"2026-11-02T10:00:04Z","finished_at":"2026-11-02T10:00:09Z"}]}`
	body := func(path string) string {
		b, err := io.ReadAll(do(t, "GET", e.srv.URL+path, testToken).Body)
		if err != nil {
			t.Fatal(err)
		}
		return strings.TrimSpace(string(b))
	}
	if got := body("/v1/deployments/dep1"); got != want {
		t.Errorf("one deployment:\n got %s\nwant %s", got, want)
	}
	if got := body("/v1/deployments"); got != "["+want+"]" {
		t.Errorf("the list:\n got %s\nwant %s", got, "["+want+"]")
	}

	ev := readEvents(t, do(t, "GET", e.srv.URL+"/v1/deployments/dep1/events", testToken).Body)
	if len(ev) != 3 || strings.Contains(ev[0], `"phase"`) || !strings.Contains(ev[1], `"phase":"switch"`) {
		t.Errorf("an event outside any phase has none, one inside names it: %v", ev)
	}

	e.fake.dep = store.Deployment{ID: "dep1", App: "web", Ref: "o/web:v1", Status: store.StatusSucceeded, Trigger: "api", StartedAt: t0}
	if got := body("/v1/deployments/dep1"); strings.Contains(got, "phases") || strings.Contains(got, "serving_ref") {
		t.Errorf("a deployment from before phases has neither field: %s", got)
	}
}

func TestInfoReportsDeployMode(t *testing.T) {
	e := newDeployServer(t)
	resp := do(t, "GET", e.srv.URL+"/v1/info", testToken)
	var info map[string]any
	json.NewDecoder(resp.Body).Decode(&info)
	if info["read_only"] != false {
		t.Errorf("deploy mode must not report read_only: %v", info)
	}
}

func TestDeploySecretMustBeStrongAndDistinct(t *testing.T) {
	mk := func(secret string) error {
		_, err := New(&fakeDocker{}, Options{Token: testToken, Deploy: &DeployOptions{Secret: secret}})
		return err
	}
	if mk("short") == nil {
		t.Error("a short secret must be rejected")
	}
	if mk(testToken) == nil {
		t.Error("the deploy secret must differ from the read token")
	}
	if err := mk(testSecret); err != nil {
		t.Errorf("valid secret rejected: %v", err)
	}
}

func TestProxyRouteIsReadOnlyAndAbsentWithoutAProxy(t *testing.T) {
	e := newDeployServer(t)
	if resp := do(t, "GET", e.srv.URL+"/v1/proxy", ""); resp.StatusCode != http.StatusUnauthorized {
		t.Errorf("without a token: %d", resp.StatusCode)
	}
	if resp := do(t, "GET", e.srv.URL+"/v1/proxy", testToken); resp.StatusCode != http.StatusNotFound {
		t.Errorf("no proxy configured must be a 404 the dashboard can tell apart: %d", resp.StatusCode)
	}

	e.fake.proxy = &deploy.ProxyView{Routes: []deploy.RouteView{{App: "web", Domains: []string{"example.com"}, Upstream: "127.0.0.1:3000"}}}
	resp := do(t, "GET", e.srv.URL+"/v1/proxy", testToken)
	var out struct {
		Routes []struct{ App, Upstream string }
	}
	if resp.StatusCode != 200 || json.NewDecoder(resp.Body).Decode(&out) != nil || len(out.Routes) != 1 || out.Routes[0].Upstream != "127.0.0.1:3000" {
		t.Errorf("status %d, %+v", resp.StatusCode, out)
	}
}

type fakeHistory struct {
	container string
	since     time.Time
	step      time.Duration
	points    []store.StatPoint
}

func (f *fakeHistory) StatsHistory(_ context.Context, container string, since time.Time, step time.Duration) ([]store.StatPoint, error) {
	f.container, f.since, f.step = container, since, step
	return f.points, nil
}

func TestStatsHistoryValidatesTheRangeAndAveragesLongOnes(t *testing.T) {
	st, err := store.Open(filepath.Join(t.TempDir(), "a.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	hist := &fakeHistory{}
	h, err := New(&fakeDocker{}, Options{
		Token: testToken, Logger: slog.New(slog.NewTextHandler(io.Discard, nil)),
		Deploy: &DeployOptions{Deployments: &fakeDeployments{}, Secret: testSecret, Replays: st, History: hist},
	})
	if err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(h)
	t.Cleanup(srv.Close)

	for _, bad := range []string{"", "?container=web&range=banana", "?container=web&range=30s", "?container=web&range=48h"} {
		if resp := do(t, "GET", srv.URL+"/v1/stats/history"+bad, testToken); resp.StatusCode != http.StatusBadRequest {
			t.Errorf("%q: got %d, want 400", bad, resp.StatusCode)
		}
	}

	resp := do(t, "GET", srv.URL+"/v1/stats/history?container=web", testToken)
	var out struct {
		Container   string
		StepSeconds int64 `json:"step_seconds"`
		Points      []store.StatPoint
	}
	if resp.StatusCode != 200 || json.NewDecoder(resp.Body).Decode(&out) != nil || out.Points == nil || len(out.Points) != 0 {
		t.Fatalf("an unsampled container has an empty list, not null: %d %+v", resp.StatusCode, out)
	}
	if hist.container != "web" || out.StepSeconds != 30 || time.Since(hist.since) < 59*time.Minute || time.Since(hist.since) > 61*time.Minute {
		t.Errorf("default is the last hour at the sampling interval: %+v step %d", hist, out.StepSeconds)
	}

	do(t, "GET", srv.URL+"/v1/stats/history?container=web&range=24h", testToken)
	if hist.step != 6*time.Minute {
		t.Errorf("24h must be averaged into about 240 points (6 min each), got %s", hist.step)
	}
}

func TestDeployRecordsWhyOnlyFromAKnownSet(t *testing.T) {
	e := newDeployServer(t)
	for body, want := range map[string]int{
		`{"digest":"sha256:` + strings.Repeat("a", 64) + `","trigger":"promotion"}`: http.StatusAccepted,
		`{"tag":"v1"}`:                              http.StatusAccepted,
		`{"tag":"v1","trigger":"api"}`:              http.StatusAccepted,
		`{"tag":"v1","trigger":"cron; drop table"}`: http.StatusBadRequest,
		`{"tag":"v1","trigger":"rollback"}`:         http.StatusBadRequest, // a rollback has its own route
	} {
		if resp := e.post(t, "/v1/apps/web/deploy", body, testSecret, time.Now()); resp.StatusCode != want {
			t.Errorf("%s: got %d, want %d", body, resp.StatusCode, want)
		}
	}
	got := append([]string(nil), e.fake.triggers...)
	sort.Strings(got)
	if strings.Join(got, ",") != "api,api,promotion" {
		t.Errorf("only the three accepted requests start a deployment, with their reasons: %v", got)
	}
}
