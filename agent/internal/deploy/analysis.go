package deploy

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/0x2u/keelson/agent/internal/config"
)

// metricTimeout bounds one query to Prometheus. A slow Prometheus counts as a failed evaluation, not as a hung deployment.
const metricTimeout = 10 * time.Second

// metricGate is one metric of the app's analysis while a soak runs.
type metricGate struct {
	m     config.Metric
	query string    // the query with {{app}}, {{container}} and {{version}} replaced
	next  time.Time // when it is asked next
	evals int
	bad   int // evaluations in a row that failed
	last  string
	ok    bool // the last evaluation held: the events say it again only when this changes
}

// newGates prepares the metrics of the app for a soak that starts now. The first evaluation is one interval in, so that a
// rate has samples of the new version to work on.
func (d *Deployer) newGates(a config.App, container, ref string) []*metricGate {
	if a.Analysis == nil {
		return nil
	}
	start := d.now()
	gates := make([]*metricGate, 0, len(a.Analysis.Metrics))
	for _, m := range a.Analysis.Metrics {
		gates = append(gates, &metricGate{m: m, query: config.ExpandQuery(m.Query, a.Name, container, ref), next: start.Add(m.EveryOrDefault())})
	}
	return gates
}

// nextGate is the earliest moment a gate wants to be asked, the zero time when there is none.
func nextGate(gates []*metricGate) time.Time {
	var at time.Time
	for _, g := range gates {
		if at.IsZero() || g.next.Before(at) {
			at = g.next
		}
	}
	return at
}

func describeGates(gates []*metricGate) string {
	names := make([]string, len(gates))
	for i, g := range gates {
		names[i] = g.m.Name
	}
	return strings.Join(names, ", ")
}

// gateRound asks every gate that is due, and the ones that were never asked when final is set, and returns the error that
// ends the soak: a gate whose evaluation failed failure_limit times in a row.
func (d *Deployer) gateRound(ctx context.Context, id string, a config.App, gates []*metricGate, final bool) error {
	for _, g := range gates {
		if now := d.now(); now.Before(g.next) && !(final && g.evals == 0) {
			continue
		}
		g.next = g.next.Add(g.m.EveryOrDefault())
		for !g.next.After(d.now()) { // a slow round must not make it ask twice to catch up
			g.next = g.next.Add(g.m.EveryOrDefault())
		}
		if err := d.evaluate(ctx, id, a, g); err != nil {
			return err
		}
	}
	return nil
}

// evaluate asks one gate its query once and judges the answer.
func (d *Deployer) evaluate(ctx context.Context, id string, a config.App, g *metricGate) error {
	values, err := d.queryPrometheus(ctx, a.Analysis.PrometheusAddress(), g.query)
	if ctx.Err() != nil {
		return ctx.Err()
	}
	g.evals++
	var text string
	var bad bool
	switch {
	case err != nil:
		text, bad = fmt.Sprintf("the query failed: %v", err), true
	case len(values) == 0:
		text, bad = "the query returned no data", g.m.FailsOnNoData()
	default:
		text, bad = judge(g.m, values)
	}
	wasOK := g.ok
	g.last, g.ok = text, !bad
	if bad {
		g.bad++
	} else {
		g.bad = 0
	}
	switch {
	case bad:
		d.event(id, "warn", "metric %s: %s (%d of %d)", g.m.Name, text, g.bad, g.m.LimitOrDefault())
	case g.evals == 1 || !wasOK:
		d.event(id, "info", "metric %s: %s", g.m.Name, text)
	}
	if bad && g.bad >= g.m.LimitOrDefault() {
		return fmt.Errorf("metric %s: %s, %d evaluations in a row", g.m.Name, text, g.bad)
	}
	return nil
}

// judge compares the samples of a query with the bounds of a metric. Every sample is judged, and the one furthest from the
// bounds is the one reported.
func judge(m config.Metric, values []float64) (string, bool) {
	hi, lo := values[0], values[0]
	for _, v := range values[1:] {
		hi, lo = math.Max(hi, v), math.Min(lo, v)
	}
	switch {
	case m.Max != nil && hi > *m.Max:
		return fmt.Sprintf("%s, above the maximum %s", fmtValue(hi), fmtValue(*m.Max)), true
	case m.Min != nil && lo < *m.Min:
		return fmt.Sprintf("%s, below the minimum %s", fmtValue(lo), fmtValue(*m.Min)), true
	}
	shown := hi
	if m.Max == nil {
		shown = lo
	}
	return fmt.Sprintf("%s, within %s", fmtValue(shown), bounds(m)), false
}

func bounds(m config.Metric) string {
	switch {
	case m.Min != nil && m.Max != nil:
		return fmtValue(*m.Min) + " to " + fmtValue(*m.Max)
	case m.Max != nil:
		return "at most " + fmtValue(*m.Max)
	}
	return "at least " + fmtValue(*m.Min)
}

func fmtValue(v float64) string { return strconv.FormatFloat(v, 'g', 4, 64) }

// summarizeGates is what the held line says about the metrics.
func summarizeGates(gates []*metricGate) string {
	parts := make([]string, len(gates))
	for i, g := range gates {
		parts[i] = fmt.Sprintf("%s: %d evaluations, last %s", g.m.Name, g.evals, g.last)
	}
	return strings.Join(parts, "; ")
}

// queryPrometheus asks the instant query API and returns the numbers of the answer: the samples of a vector, or a scalar.
// A sample that is NaN (a rate of nothing divided by nothing) is no data.
func (d *Deployer) queryPrometheus(ctx context.Context, base, query string) ([]float64, error) {
	ctx, cancel := context.WithTimeout(ctx, metricTimeout)
	defer cancel()
	form := url.Values{"query": {query}}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, base+"/api/v1/query", strings.NewReader(form.Encode()))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	resp, err := d.prom.Do(req)
	if err != nil {
		var ue *url.Error
		if errors.As(err, &ue) {
			err = ue.Err
		}
		return nil, fmt.Errorf("ask %s: %w", base, err)
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return nil, err
	}
	var body struct {
		Status    string `json:"status"`
		ErrorType string `json:"errorType"`
		Error     string `json:"error"`
		Data      struct {
			ResultType string          `json:"resultType"`
			Result     json.RawMessage `json:"result"`
		} `json:"data"`
	}
	if err := json.Unmarshal(raw, &body); err != nil {
		return nil, fmt.Errorf("%s answered %d, which is not a Prometheus answer", base, resp.StatusCode)
	}
	if body.Status != "success" {
		return nil, fmt.Errorf("prometheus: %s: %s", body.ErrorType, body.Error)
	}
	var samples [][]any
	switch body.Data.ResultType {
	case "scalar":
		var one []any
		if err := json.Unmarshal(body.Data.Result, &one); err != nil {
			return nil, err
		}
		samples = [][]any{one}
	case "vector":
		var vec []struct {
			Value []any `json:"value"`
		}
		if err := json.Unmarshal(body.Data.Result, &vec); err != nil {
			return nil, err
		}
		for _, s := range vec {
			samples = append(samples, s.Value)
		}
	default:
		return nil, fmt.Errorf("the query answered a %s: it must answer a number or an instant vector", body.Data.ResultType)
	}
	var out []float64
	for _, s := range samples {
		if len(s) != 2 {
			return nil, errors.New("a sample has no value")
		}
		text, _ := s[1].(string)
		v, err := strconv.ParseFloat(text, 64)
		if err != nil {
			return nil, fmt.Errorf("the value %q is not a number", text)
		}
		if !math.IsNaN(v) {
			out = append(out, v)
		}
	}
	return out, nil
}
