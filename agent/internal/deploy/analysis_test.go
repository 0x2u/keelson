package deploy

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/0x2u/keelson/agent/internal/config"
	"github.com/0x2u/keelson/agent/internal/store"
)

// fakeProm answers the instant query API of Prometheus with what its test sets, and keeps the queries it was asked.
type fakeProm struct {
	srv *httptest.Server
	mu  sync.Mutex
	// answer makes the JSON of the nth query (from 1); nil answers the value set by set.
	answer  func(n int) string
	value   string
	queries []string
}

func newFakeProm(t *testing.T) *fakeProm {
	t.Helper()
	p := &fakeProm{value: "0.001"}
	p.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/v1/query" || r.Method != http.MethodPost {
			http.NotFound(w, r)
			return
		}
		_ = r.ParseForm()
		p.mu.Lock()
		p.queries = append(p.queries, r.PostForm.Get("query"))
		n := len(p.queries)
		body := vector(p.value)
		if p.answer != nil {
			body = p.answer(n)
		}
		p.mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(body))
	}))
	t.Cleanup(p.srv.Close)
	return p
}

func vector(values ...string) string {
	var samples []string
	for _, v := range values {
		samples = append(samples, `{"metric":{},"value":[1700000000,"`+v+`"]}`)
	}
	return `{"status":"success","data":{"resultType":"vector","result":[` + strings.Join(samples, ",") + `]}}`
}

func (p *fakeProm) set(v string) {
	p.mu.Lock()
	p.value = v
	p.mu.Unlock()
}

func (p *fakeProm) asked() []string {
	p.mu.Lock()
	defer p.mu.Unlock()
	return append([]string(nil), p.queries...)
}

// gatedApp is a soak app judged by one metric: at most 0.05, asked every 20ms, rolled back after limit bad evaluations in a row.
func gatedApp(t *testing.T, p *fakeProm, limit int, tweak ...func(*config.Metric)) *hostApp {
	t.Helper()
	m := config.Metric{
		Name:         "error-rate",
		Query:        `rate(errors{app="{{app}}",container="{{container}}",version="{{version}}"}[1m])`,
		Max:          new(0.05),
		Interval:     config.D(20 * time.Millisecond),
		FailureLimit: new(limit),
	}
	for _, f := range tweak {
		f(&m)
	}
	return newSoakApp(t, func(a *config.App) {
		a.Analysis = &config.Analysis{Address: p.srv.URL, Metrics: []config.Metric{m}}
	})
}

func TestAMetricAboveItsMaximumRollsTheDeploymentBack(t *testing.T) {
	p := newFakeProm(t)
	h := gatedApp(t, p, 3)
	if dep := h.deploy("v1"); dep.Status != store.StatusSucceeded {
		t.Fatalf("a healthy metric must let the first version through: %s: %s", dep.Status, dep.Error)
	}
	serving := h.state()
	h.afterSwitchTo(h.ports[1], func() { p.set("0.4") })

	dep := h.deploy("v2")
	if dep.Status != store.StatusRolledBack {
		t.Fatalf("a metric that stays above its maximum rolls back: %s: %s", dep.Status, dep.Error)
	}
	for _, want := range []string{"metric error-rate", "above the maximum 0.05", "3 evaluations in a row"} {
		if !strings.Contains(dep.Error, want) {
			t.Errorf("the error must say %q, it says: %s", want, dep.Error)
		}
	}
	if got := h.state(); got.Container != serving.Container || got.Ref != serving.Ref {
		t.Errorf("the previous version must serve again: %+v, was %+v", got, serving)
	}
	if ev := h.events(dep.ID); !strings.Contains(ev, "switching traffic back to the previous version") {
		t.Errorf("events must show the way back:\n%s", ev)
	}
}

func TestTheQueryCarriesTheAppTheContainerAndTheVersion(t *testing.T) {
	p := newFakeProm(t)
	h := gatedApp(t, p, 3)
	h.deploy("v1")
	dep := h.deploy("v2")
	if dep.Status != store.StatusSucceeded {
		t.Fatalf("%s: %s", dep.Status, dep.Error)
	}
	asked := p.asked()
	if len(asked) == 0 {
		t.Fatal("Prometheus was never asked")
	}
	last := asked[len(asked)-1]
	if strings.Contains(last, "{{") {
		t.Errorf("a variable was not replaced: %s", last)
	}
	for _, want := range []string{`app="` + h.state().App + `"`, `container="` + h.state().Container + `"`, `version="` + repo + `:v2"`} {
		if !strings.Contains(last, want) {
			t.Errorf("the query must hold %s: %s", want, last)
		}
	}
}

func TestAMetricThatHoldsLetsTheDeploymentThroughAndIsReported(t *testing.T) {
	p := newFakeProm(t)
	h := gatedApp(t, p, 3)
	h.deploy("v1")
	dep := h.deploy("v2")
	if dep.Status != store.StatusSucceeded {
		t.Fatalf("%s: %s", dep.Status, dep.Error)
	}
	ev := h.events(dep.ID)
	for _, want := range []string{"metrics error-rate", "metric error-rate: 0.001, within at most 0.05", "metrics: error-rate:"} {
		if !strings.Contains(ev, want) {
			t.Errorf("events must say %q:\n%s", want, ev)
		}
	}
	if n := strings.Count(ev, "metric error-rate: 0.001"); n != 1 {
		t.Errorf("a metric that keeps holding is said once, not at each evaluation (%d times):\n%s", n, ev)
	}
}

func TestOneBadEvaluationAmongGoodOnesDoesNotRollBack(t *testing.T) {
	p := newFakeProm(t)
	h := gatedApp(t, p, 2)
	h.deploy("v1")
	p.mu.Lock()
	base := len(p.queries)
	p.answer = func(n int) string {
		if n-base == 2 { // the second evaluation of v2 alone is bad
			return vector("0.9")
		}
		return vector("0.001")
	}
	p.mu.Unlock()
	dep := h.deploy("v2")
	if dep.Status != store.StatusSucceeded {
		t.Fatalf("a single bad sample is not a regression: %s: %s", dep.Status, dep.Error)
	}
	if ev := h.events(dep.ID); !strings.Contains(ev, "above the maximum 0.05 (1 of 2)") {
		t.Errorf("the bad evaluation must be reported with its count:\n%s", ev)
	}
}

func TestAMetricBelowItsMinimumRollsBackAndEverySampleIsJudged(t *testing.T) {
	p := newFakeProm(t)
	h := gatedApp(t, p, 2, func(m *config.Metric) { m.Max, m.Min = nil, new(0.99) })
	p.set("0.999")
	h.deploy("v1")
	// two series, one of them under the minimum: the worst one decides
	p.mu.Lock()
	p.answer = func(int) string { return vector("0.999", "0.5") }
	p.mu.Unlock()
	dep := h.deploy("v2")
	if dep.Status != store.StatusRolledBack || !strings.Contains(dep.Error, "0.5, below the minimum 0.99") {
		t.Fatalf("%s: %s", dep.Status, dep.Error)
	}
}

func TestAnUnreachablePrometheusCountsAsFailedEvaluations(t *testing.T) {
	p := newFakeProm(t)
	h := gatedApp(t, p, 2)
	h.deploy("v1")
	p.srv.Close()
	dep := h.deploy("v2")
	if dep.Status != store.StatusRolledBack || !strings.Contains(dep.Error, "the query failed") {
		t.Fatalf("a gate that cannot be asked cannot vouch for the version: %s: %s", dep.Status, dep.Error)
	}
}

func TestAPrometheusErrorIsShownWithItsMessage(t *testing.T) {
	p := newFakeProm(t)
	h := gatedApp(t, p, 1)
	h.deploy("v1")
	p.mu.Lock()
	p.answer = func(int) string {
		return `{"status":"error","errorType":"bad_data","error":"parse error: unexpected end of input"}`
	}
	p.mu.Unlock()
	dep := h.deploy("v2")
	if dep.Status != store.StatusRolledBack || !strings.Contains(dep.Error, "bad_data: parse error") {
		t.Fatalf("%s: %s", dep.Status, dep.Error)
	}
}

func TestNoDataPassesByDefaultAndFailsWhenAsked(t *testing.T) {
	empty := `{"status":"success","data":{"resultType":"vector","result":[]}}`
	nan := vector("NaN") // a rate of nothing over nothing
	for name, body := range map[string]string{"empty vector": empty, "NaN": nan} {
		t.Run(name+" passes", func(t *testing.T) {
			p := newFakeProm(t)
			h := gatedApp(t, p, 2)
			h.deploy("v1")
			p.mu.Lock()
			p.answer = func(int) string { return body }
			p.mu.Unlock()
			dep := h.deploy("v2")
			if dep.Status != store.StatusSucceeded {
				t.Fatalf("an app nobody called has no error rate to judge: %s: %s", dep.Status, dep.Error)
			}
			if ev := h.events(dep.ID); !strings.Contains(ev, "returned no data") {
				t.Errorf("events must say there was no data:\n%s", ev)
			}
		})
		t.Run(name+" fails with no_data fail", func(t *testing.T) {
			p := newFakeProm(t)
			h := gatedApp(t, p, 2, func(m *config.Metric) { m.NoData = config.NoDataFail })
			h.deploy("v1")
			p.mu.Lock()
			p.answer = func(int) string { return body }
			p.mu.Unlock()
			dep := h.deploy("v2")
			if dep.Status != store.StatusRolledBack || !strings.Contains(dep.Error, "no data") {
				t.Fatalf("%s: %s", dep.Status, dep.Error)
			}
		})
	}
}

func TestAScalarAnswerIsJudgedToo(t *testing.T) {
	p := newFakeProm(t)
	h := gatedApp(t, p, 1)
	h.deploy("v1")
	p.mu.Lock()
	p.answer = func(int) string {
		return `{"status":"success","data":{"resultType":"scalar","result":[1700000000,"3"]}}`
	}
	p.mu.Unlock()
	dep := h.deploy("v2")
	if dep.Status != store.StatusRolledBack || !strings.Contains(dep.Error, "3, above the maximum 0.05") {
		t.Fatalf("%s: %s", dep.Status, dep.Error)
	}
}

func TestAMatrixAnswerIsRefusedWithAClearMessage(t *testing.T) {
	p := newFakeProm(t)
	h := gatedApp(t, p, 1)
	h.deploy("v1")
	p.mu.Lock()
	p.answer = func(int) string {
		return `{"status":"success","data":{"resultType":"matrix","result":[]}}`
	}
	p.mu.Unlock()
	dep := h.deploy("v2")
	if dep.Status != store.StatusRolledBack || !strings.Contains(dep.Error, "must answer a number or an instant vector") {
		t.Fatalf("%s: %s", dep.Status, dep.Error)
	}
}

func TestAMetricIsJudgedOnceEvenWhenItsFirstEvaluationIsAfterTheSoak(t *testing.T) {
	p := newFakeProm(t)
	h := gatedApp(t, p, 1, func(m *config.Metric) { m.Interval = config.D(time.Hour) })
	h.deploy("v1")
	p.set("0.7")
	asked := len(p.asked())
	dep := h.deploy("v2")
	if dep.Status != store.StatusRolledBack {
		t.Fatalf("a gate with a long interval still has its say before the version goes live: %s: %s", dep.Status, dep.Error)
	}
	if got := len(p.asked()) - asked; got != 1 {
		t.Errorf("asked %d times, want once", got)
	}
}

func TestAnAppWithoutAnAnalysisNeverAsksPrometheus(t *testing.T) {
	p := newFakeProm(t)
	h := newSoakApp(t)
	h.deploy("v1")
	if dep := h.deploy("v2"); dep.Status != store.StatusSucceeded {
		t.Fatalf("%s: %s", dep.Status, dep.Error)
	}
	if n := len(p.asked()); n != 0 {
		t.Errorf("asked %d times", n)
	}
}

func TestTheSoakBudgetHoldsTheMetricQueries(t *testing.T) {
	a := config.App{Soak: config.D(time.Minute), Drain: config.D(0), StopTimeout: config.D(time.Second)}
	without := soakBudget(a)
	a.Analysis = &config.Analysis{Metrics: []config.Metric{{Name: "a"}, {Name: "b"}}}
	if got := soakBudget(a) - without; got != 4*metricTimeout {
		t.Errorf("two metrics add %s to the budget, want %s", got, 4*metricTimeout)
	}
}
