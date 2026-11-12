package config

import (
	"errors"
	"fmt"
	"math"
	"net/url"
	"regexp"
	"strings"
	"time"
)

var metricNamePattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$`)

// Bounds of the metric gates. Each metric is one query every interval for the whole soak, against a Prometheus the
// operator runs: a handful is what a deployment is judged by, and the floor keeps the agent from hammering it.
const (
	MaxMetrics            = 5
	DefaultMetricInterval = 10 * time.Second
	MinMetricInterval     = time.Second
	// DefaultFailureLimit is how many evaluations in a row must fail before the deployment is rolled back: one bad
	// sample (a scrape that landed on the restart) must not undo a good deployment.
	DefaultFailureLimit = 3
	MaxFailureLimit     = 20
	// DefaultPrometheus is where the agent looks for Prometheus when `analysis.address` is not set.
	DefaultPrometheus = "http://127.0.0.1:9090"
)

// What a metric does when its query returns no sample (an app nobody has called yet).
const (
	NoDataPass = "pass"
	NoDataFail = "fail"
)

// Analysis judges the new version by metrics during the soak: after the traffic switch each metric's query is asked of a
// Prometheus, and a value outside its bounds, a number of evaluations in a row, sends traffic back to the previous version.
type Analysis struct {
	// Address is the base URL of the Prometheus (or of anything that answers its query API: Mimir, VictoriaMetrics,
	// Thanos), such as http://127.0.0.1:9090. A path prefix is kept (https://metrics.example.com/prometheus). It holds no
	// credentials: put an authenticating proxy in front, on this server. Default http://127.0.0.1:9090.
	Address string `yaml:"address"`
	// Metrics are the gates, at most 5. Every one must hold.
	Metrics []Metric `yaml:"metrics"`
}

// Metric is one gate: a PromQL query and the bounds its value must stay within.
type Metric struct {
	// Name labels the gate in the deployment's events and in the error (letters, digits, - and _).
	Name string `yaml:"name"`
	// Query is a PromQL expression. {{app}}, {{container}} (the new container) and {{version}} (the image reference
	// being deployed) are replaced by their value, escaped for a PromQL string. The query must answer a number: a scalar
	// or an instant vector, every sample of which is judged.
	Query string `yaml:"query"`
	// Max is the highest value that is fine (an error rate: 0.01). Min is the lowest (a success rate: 0.99). At least one.
	Max *float64 `yaml:"max"`
	Min *float64 `yaml:"min"`
	// Interval is how often the query is asked. Default 10s, at least 1s. The first evaluation is one interval after the
	// soak starts, so that a rate has samples of the new version to work on.
	Interval *Duration `yaml:"interval"`
	// FailureLimit is how many evaluations in a row must be bad before the deployment is rolled back. Default 3.
	FailureLimit *int `yaml:"failure_limit"`
	// NoData is what an empty answer counts as: "pass" (default; a quiet app has no traffic to judge) or "fail".
	NoData string `yaml:"no_data"`
}

// EveryOrDefault is the interval between two evaluations.
func (m Metric) EveryOrDefault() time.Duration {
	if m.Interval == nil {
		return DefaultMetricInterval
	}
	return m.Interval.Std()
}

// LimitOrDefault is the number of bad evaluations in a row that rolls the deployment back.
func (m Metric) LimitOrDefault() int {
	if m.FailureLimit == nil {
		return DefaultFailureLimit
	}
	return *m.FailureLimit
}

// FailsOnNoData reports whether an empty answer is a bad evaluation.
func (m Metric) FailsOnNoData() bool { return m.NoData == NoDataFail }

// PrometheusAddress is the address to query, without a trailing slash.
func (a Analysis) PrometheusAddress() string {
	if a.Address == "" {
		return DefaultPrometheus
	}
	return strings.TrimRight(a.Address, "/")
}

// QueryTemplateVars are the variables a query may use.
var QueryTemplateVars = []string{"app", "container", "version"}

// ExpandQuery replaces {{app}}, {{container}} and {{version}} in a query. The values go inside a PromQL string, so a
// backslash, a double quote and a newline in them are escaped.
func ExpandQuery(query string, app, container, version string) string {
	esc := strings.NewReplacer(`\`, `\\`, `"`, `\"`, "\n", `\n`)
	return strings.NewReplacer("{{app}}", esc.Replace(app), "{{container}}", esc.Replace(container), "{{version}}", esc.Replace(version)).Replace(query)
}

// unknownTemplateVar returns the first {{...}} of a query that is not one of QueryTemplateVars. PromQL has no use for
// double braces, so any other is a typo.
func unknownTemplateVar(q string) string {
	for {
		i := strings.Index(q, "{{")
		if i < 0 {
			return ""
		}
		rest := q[i+2:]
		j := strings.Index(rest, "}}")
		if j < 0 {
			return q[i:]
		}
		name := strings.TrimSpace(rest[:j])
		known := false
		for _, v := range QueryTemplateVars {
			known = known || rest[:j] == v
		}
		if !known {
			return "{{" + name + "}}"
		}
		q = rest[j+2:]
	}
}

// validPrometheusAddress reports what is wrong with an address, or "".
func validPrometheusAddress(s string) error {
	u, err := url.Parse(s)
	if err != nil || u.Host == "" || (u.Scheme != "http" && u.Scheme != "https") {
		return fmt.Errorf("address %q must be an http or https URL such as http://127.0.0.1:9090", s)
	}
	if u.User != nil {
		return errors.New("address must not carry credentials: put a proxy that adds them in front of Prometheus")
	}
	if u.RawQuery != "" || u.Fragment != "" {
		return fmt.Errorf("address %q is the base URL: it has no query or fragment", s)
	}
	return nil
}

func validateAnalysis(a *App) error {
	if a.Analysis == nil {
		return nil
	}
	if !a.Proxied() {
		return errors.New("analysis is only used with deploy.strategy switch (an app with port or domains): it judges the new container after the traffic switch")
	}
	if len(a.Analysis.Metrics) == 0 {
		return errors.New("analysis has no metrics: list at least one, or remove analysis")
	}
	if a.SoakFor() <= 0 {
		return errors.New("analysis is evaluated during the soak: it needs soak above 0s")
	}
	if a.Analysis.Address != "" {
		if err := validPrometheusAddress(a.Analysis.Address); err != nil {
			return fmt.Errorf("analysis: %w", err)
		}
	}
	if len(a.Analysis.Metrics) > MaxMetrics {
		return fmt.Errorf("analysis lists %d metrics: at most %d", len(a.Analysis.Metrics), MaxMetrics)
	}
	seen := map[string]bool{}
	for i := range a.Analysis.Metrics {
		m := &a.Analysis.Metrics[i]
		if err := validateMetric(m, a.SoakFor()); err != nil {
			return fmt.Errorf("analysis.metrics[%d]: %w", i, err)
		}
		if seen[m.Name] {
			return fmt.Errorf("analysis.metrics[%d]: the name %q is used twice", i, m.Name)
		}
		seen[m.Name] = true
	}
	return nil
}

func validateMetric(m *Metric, soak time.Duration) error {
	if !metricNamePattern.MatchString(m.Name) {
		return fmt.Errorf("name %q must be letters, digits, - and _ (at most 40)", m.Name)
	}
	if strings.TrimSpace(m.Query) == "" {
		return errors.New("query is empty")
	}
	if v := unknownTemplateVar(m.Query); v != "" {
		return fmt.Errorf("query uses %s: the variables are {{app}}, {{container}} and {{version}}", v)
	}
	if m.Max == nil && m.Min == nil {
		return errors.New("set max, min or both: without a bound nothing can fail")
	}
	for name, b := range map[string]*float64{"max": m.Max, "min": m.Min} {
		if b != nil && (math.IsNaN(*b) || math.IsInf(*b, 0)) {
			return fmt.Errorf("%s must be a finite number", name)
		}
	}
	if m.Max != nil && m.Min != nil && *m.Min > *m.Max {
		return fmt.Errorf("min (%g) is above max (%g): no value would pass", *m.Min, *m.Max)
	}
	if m.Interval == nil {
		m.Interval = D(DefaultMetricInterval)
	} else if m.Interval.Std() < MinMetricInterval {
		return fmt.Errorf("interval must be at least %s", FormatDuration(MinMetricInterval))
	}
	if m.FailureLimit == nil {
		m.FailureLimit = new(DefaultFailureLimit)
	} else if *m.FailureLimit < 1 || *m.FailureLimit > MaxFailureLimit {
		return fmt.Errorf("failure_limit must be between 1 and %d", MaxFailureLimit)
	}
	switch m.NoData {
	case "":
		m.NoData = NoDataPass
	case NoDataPass, NoDataFail:
	default:
		return fmt.Errorf("no_data %q must be pass or fail", m.NoData)
	}
	// The gate must be able to trip: the soak holds floor(soak/interval) evaluations (one every interval, the last at
	// its end), and the limit is a run of them.
	if n := int(soak / m.Interval.Std()); n < *m.FailureLimit {
		return fmt.Errorf("the soak (%s) holds %d evaluation(s) every %s, but failure_limit is %d: the gate could never trip. Lengthen soak, shorten interval or lower failure_limit",
			FormatDuration(soak), n, FormatDuration(m.Interval.Std()), *m.FailureLimit)
	}
	return nil
}
