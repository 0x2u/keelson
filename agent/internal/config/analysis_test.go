package config

import (
	"strings"
	"testing"
	"time"
)

const gatedApp = `proxy: {}
apps:
  - name: web
    image: o/web
    port: 3000
    domains: [web.example.com]
    soak: 1m
`

func TestAnalysisLoadsWithItsDefaults(t *testing.T) {
	c, err := Load(write(t, gatedApp+`    analysis:
      metrics:
        - name: error-rate
          query: sum(rate(http_errors_total{app="{{app}}"}[1m]))
          max: 0.02
`))
	if err != nil {
		t.Fatal(err)
	}
	a, _ := c.App("web")
	if a.Analysis.PrometheusAddress() != DefaultPrometheus {
		t.Errorf("address %q", a.Analysis.PrometheusAddress())
	}
	m := a.Analysis.Metrics[0]
	if m.EveryOrDefault() != 10*time.Second || m.LimitOrDefault() != 3 || m.NoData != NoDataPass || m.FailsOnNoData() {
		t.Errorf("defaults not applied: %+v", m)
	}
}

func TestAnalysisAddressKeepsItsPathAndLosesTheTrailingSlash(t *testing.T) {
	a := Analysis{Address: "https://metrics.example.com/prometheus/"}
	if got := a.PrometheusAddress(); got != "https://metrics.example.com/prometheus" {
		t.Errorf("got %q", got)
	}
}

func TestAnalysisRejectsWhatCouldNeverWork(t *testing.T) {
	metric := func(extra string) string {
		return "      metrics:\n        - name: m\n          query: up\n          max: 1\n" + extra
	}
	for name, tc := range map[string]struct{ yaml, want string }{
		"without a soak":          {strings.Replace(gatedApp, "soak: 1m", "soak: 0s", 1) + "    analysis:\n" + metric(""), "needs soak above 0s"},
		"without a proxy":         {"apps:\n  - name: web\n    image: o/web\n    soak: 1m\n    analysis:\n" + metric(""), "only used with deploy.strategy switch"},
		"no metrics":              {gatedApp + "    analysis:\n      address: http://127.0.0.1:9090\n", "has no metrics"},
		"no bound":                {gatedApp + "    analysis:\n      metrics:\n        - {name: m, query: up}\n", "set max, min or both"},
		"min above max":           {gatedApp + "    analysis:\n      metrics:\n        - {name: m, query: up, min: 2, max: 1}\n", "min (2) is above max (1)"},
		"empty query":             {gatedApp + "    analysis:\n      metrics:\n        - {name: m, query: '  ', max: 1}\n", "query is empty"},
		"bad name":                {gatedApp + "    analysis:\n      metrics:\n        - {name: 'a b', query: up, max: 1}\n", "letters, digits"},
		"duplicate name":          {gatedApp + "    analysis:\n      metrics:\n        - {name: m, query: up, max: 1}\n        - {name: m, query: up, max: 2}\n", "used twice"},
		"typo in a variable":      {gatedApp + "    analysis:\n      metrics:\n        - {name: m, query: 'up{job=\"{{apps}}\"}', max: 1}\n", "{{apps}}"},
		"unclosed variable":       {gatedApp + "    analysis:\n      metrics:\n        - {name: m, query: 'up{job=\"{{app\"}', max: 1}\n", "the variables are"},
		"interval too short":      {gatedApp + "    analysis:\n      metrics:\n        - {name: m, query: up, max: 1, interval: 200ms}\n", "at least 1s"},
		"failure limit zero":      {gatedApp + "    analysis:\n      metrics:\n        - {name: m, query: up, max: 1, failure_limit: 0}\n", "failure_limit must be between 1 and 20"},
		"no_data unknown":         {gatedApp + "    analysis:\n      metrics:\n        - {name: m, query: up, max: 1, no_data: ignore}\n", "must be pass or fail"},
		"credentials":             {gatedApp + "    analysis:\n      address: http://user:pw@127.0.0.1:9090\n" + metric(""), "must not carry credentials"},
		"not http":                {gatedApp + "    analysis:\n      address: ftp://127.0.0.1\n" + metric(""), "http or https URL"},
		"a query string":          {gatedApp + "    analysis:\n      address: http://127.0.0.1:9090/?x=1\n" + metric(""), "no query or fragment"},
		"too many":                {gatedApp + "    analysis:\n      metrics:\n" + strings.Repeat("        - {name: m%d, query: up, max: 1}\n", 0) + manyMetrics(6), "at most 5"},
		"a gate that cannot trip": {gatedApp + "    analysis:\n      metrics:\n        - {name: m, query: up, max: 1, interval: 30s, failure_limit: 3}\n", "could never trip"},
	} {
		t.Run(name, func(t *testing.T) {
			_, err := Load(write(t, tc.yaml))
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("want an error with %q, got %v", tc.want, err)
			}
		})
	}
}

func manyMetrics(n int) string {
	var b strings.Builder
	for i := range n {
		b.WriteString("        - {name: m" + string(rune('a'+i)) + ", query: up, max: 1}\n")
	}
	return b.String()
}

func TestAGateThatTripsOnTheLastEvaluationOfTheSoakIsAccepted(t *testing.T) {
	// 30s of soak, one evaluation every 10s: three evaluations, the limit is three
	_, err := Load(write(t, strings.Replace(gatedApp, "soak: 1m", "soak: 30s", 1)+"    analysis:\n      metrics:\n        - {name: m, query: up, max: 1}\n"))
	if err != nil {
		t.Fatal(err)
	}
}

func TestExpandQueryEscapesWhatItInserts(t *testing.T) {
	got := ExpandQuery(`up{app="{{app}}",c="{{container}}",v="{{version}}"}`, `a"b`, "c", `r\1`+"\n")
	want := `up{app="a\"b",c="c",v="r\\1\n"}`
	if got != want {
		t.Errorf("got  %s\nwant %s", got, want)
	}
}

func TestAPreviewInstanceIsNotJudgedByTheProductionMetrics(t *testing.T) {
	parent := App{Name: "web", Image: "o/web", Analysis: &Analysis{Metrics: []Metric{{Name: "m", Query: "up", Max: new(1.0)}}}}
	inst := Previews{Domain: "pr-{pr}.example.com"}.Instance(parent, 7)
	if inst.Analysis != nil {
		t.Error("an instance serves a pull request: it must not inherit the analysis")
	}
}
