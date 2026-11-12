package config

import (
	"encoding/json"
	"fmt"
	"math"
	"regexp"
	"strconv"
	"strings"
	"time"

	"gopkg.in/yaml.v3"
)

// The units of the file. Every duration is a string ("90s", "1h30m", "7d"), every size is a string ("512m", "2gb",
// "1GiB") or a number of bytes. The patterns are exported so the generated TypeScript and the JSON Schema use the very
// same ones (they are valid in Go's RE2 and in JavaScript).
const (
	// DurationPattern matches a Go duration with the extra unit "d" (24 hours): 90s, 1h30m, 1.5h, 7d, 0.
	DurationPattern = `^(0|([0-9]+(\.[0-9]+)?(ns|us|µs|ms|s|m|h|d))+)$`
	// SizePattern matches a size: a number, an optional k, m or g, and an optional b or ib: 512m, 2gb, 1GiB, 1024.
	SizePattern = `^([0-9]+)([kKmMgG]?)([iI]?[bB]?)$`
	// NamePattern is what app, job, database, project and environment names must match.
	NamePattern = `^[a-z0-9][a-z0-9_-]{0,62}$`
	// EnvNamePattern is what a variable the agent sets itself (port.env) must match.
	EnvNamePattern = `^[A-Z_][A-Z0-9_]*$`
	// DomainPattern is a lowercase host name.
	DomainPattern = `^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$`
)

var (
	namePattern    = regexp.MustCompile(NamePattern)
	envNamePattern = regexp.MustCompile(EnvNamePattern)
	domainPattern  = regexp.MustCompile(DomainPattern)
	sizePattern    = regexp.MustCompile(SizePattern)
	durationToken  = regexp.MustCompile(`([0-9]+(?:\.[0-9]+)?)d`)
)

// ParseDuration reads a duration: Go's syntax (1h30m, 90s, 1.5h) with the extra unit "d", a day of 24 hours (7d,
// 1d12h). It does not refuse a negative one: the field that holds it says what is wrong with it.
func ParseDuration(s string) (time.Duration, error) {
	s = strings.TrimSpace(s)
	if strings.Contains(s, "d") {
		// "d" is the only unit that ends in d: every other one is a valid Go unit once the days are hours.
		var bad error
		s = durationToken.ReplaceAllStringFunc(s, func(tok string) string {
			n, err := strconv.ParseFloat(strings.TrimSuffix(tok, "d"), 64)
			if err != nil || n > math.MaxInt32 {
				bad = fmt.Errorf("%q is not a duration", tok)
				return tok
			}
			return strconv.FormatFloat(n*24, 'f', -1, 64) + "h"
		})
		if bad != nil {
			return 0, bad
		}
	}
	d, err := time.ParseDuration(s)
	if err != nil {
		return 0, fmt.Errorf("%q is not a duration: use a number with a unit, such as 90s, 5m, 1h30m or 7d", s)
	}
	return d, nil
}

// Duration is a length of time in the file: a string such as 90s or 7d.
type Duration time.Duration

// D wraps d in a pointer, for the optional durations of the structs.
func D(d time.Duration) *Duration { v := Duration(d); return &v }

// clone copies the duration behind a pointer, nil for nil.
func (d *Duration) clone() *Duration {
	if d == nil {
		return nil
	}
	v := *d
	return &v
}

// Std is the duration as the standard library has it.
func (d Duration) Std() time.Duration { return time.Duration(d) }

// String is the compact form: 90s, 1h30m, 7d.
func (d Duration) String() string { return FormatDuration(time.Duration(d)) }

// FormatDuration writes d the way the file does: whole days as d, no trailing zero units.
func FormatDuration(d time.Duration) string {
	if d == 0 {
		return "0s"
	}
	if d%(24*time.Hour) == 0 && d > 0 {
		return strconv.FormatInt(int64(d/(24*time.Hour)), 10) + "d"
	}
	s := d.String()
	if strings.HasSuffix(s, "m0s") {
		s = strings.TrimSuffix(s, "0s")
	}
	if strings.HasSuffix(s, "h0m") {
		s = strings.TrimSuffix(s, "0m")
	}
	return s
}

// UnmarshalYAML reads a duration string. A bare number is refused (R2), but for 0.
func (d *Duration) UnmarshalYAML(n *yaml.Node) error {
	if n.Kind != yaml.ScalarNode {
		return typeError(n, "a duration must be a string such as 90s, 5m or 7d")
	}
	if n.Tag != "!!str" && n.Value != "0" {
		return typeError(n, "%s is not a duration: write it as a string with a unit, such as 90s, 5m or 7d", strconv.Quote(n.Value))
	}
	v, err := ParseDuration(n.Value)
	if err != nil {
		return typeError(n, "%v", err)
	}
	*d = Duration(v)
	return nil
}

// MarshalYAML writes the compact string.
func (d Duration) MarshalYAML() (any, error) { return d.String(), nil }

// MarshalJSON writes the compact string.
func (d Duration) MarshalJSON() ([]byte, error) { return json.Marshal(d.String()) }

// UnmarshalJSON reads the string form.
func (d *Duration) UnmarshalJSON(b []byte) error {
	var s string
	if err := json.Unmarshal(b, &s); err != nil {
		return fmt.Errorf("a duration must be a string such as 90s")
	}
	v, err := ParseDuration(s)
	if err != nil {
		return err
	}
	*d = Duration(v)
	return nil
}

// Size is an amount of bytes in the file: 512m, 2gb, 1GiB or a plain number of bytes.
type Size int64

// S wraps n bytes in a pointer, for the optional sizes of the structs.
func S(n int64) *Size { v := Size(n); return &v }

// Bytes is the size in bytes.
func (s Size) Bytes() int64 { return int64(s) }

// String is the canonical form: the largest of g, m, k that divides the size exactly, else the number of bytes.
func (s Size) String() string {
	n := int64(s)
	switch {
	case n > 0 && n%(1<<30) == 0:
		return strconv.FormatInt(n>>30, 10) + "g"
	case n > 0 && n%(1<<20) == 0:
		return strconv.FormatInt(n>>20, 10) + "m"
	case n > 0 && n%(1<<10) == 0:
		return strconv.FormatInt(n>>10, 10) + "k"
	}
	return strconv.FormatInt(n, 10)
}

// DockerString is the size as Docker's options take it (the log driver's max-size): a number with k, m or g, or bytes.
func (s Size) DockerString() string { return s.String() }

// ParseSize reads a size such as "512m", "2g", "1024k" or a plain number of bytes. Suffixes are binary multiples; a
// trailing "b" or "ib" is accepted ("2gb", "2GiB").
func ParseSize(s string) (int64, error) {
	m := sizePattern.FindStringSubmatch(strings.TrimSpace(s))
	if m == nil {
		return 0, fmt.Errorf("%q is not a size: use a number with an optional k, m or g, such as 512m", s)
	}
	n, err := strconv.ParseInt(m[1], 10, 64)
	if err != nil {
		return 0, fmt.Errorf("%q is not a size", s)
	}
	shift := map[string]uint{"": 0, "k": 10, "m": 20, "g": 30}[strings.ToLower(m[2])]
	if m[2] == "" && m[3] != "" && !strings.EqualFold(m[3], "b") {
		return 0, fmt.Errorf("%q is not a size", s)
	}
	if n > (1<<62)>>shift {
		return 0, fmt.Errorf("%q is too large", s)
	}
	return n << shift, nil
}

// UnmarshalYAML reads a size: a string, or a number of bytes.
func (s *Size) UnmarshalYAML(n *yaml.Node) error {
	if n.Kind != yaml.ScalarNode {
		return typeError(n, "a size must be a string such as 512m or 2g")
	}
	v, err := ParseSize(n.Value)
	if err != nil {
		return typeError(n, "%v", err)
	}
	*s = Size(v)
	return nil
}

// MarshalYAML writes the canonical string.
func (s Size) MarshalYAML() (any, error) { return s.String(), nil }

// MarshalJSON writes the canonical string.
func (s Size) MarshalJSON() ([]byte, error) { return json.Marshal(s.String()) }

// UnmarshalJSON reads a string or a number of bytes.
func (s *Size) UnmarshalJSON(b []byte) error {
	var raw any
	if err := json.Unmarshal(b, &raw); err != nil {
		return err
	}
	switch v := raw.(type) {
	case float64:
		*s = Size(int64(v))
		return nil
	case string:
		n, err := ParseSize(v)
		if err != nil {
			return err
		}
		*s = Size(n)
		return nil
	}
	return fmt.Errorf("a size must be a string such as 512m or a number of bytes")
}

// typeError is an error of the value of node n, in the form the YAML library collects with the others of a document
// (and yamlIssue turns into an issue with its line).
func typeError(n *yaml.Node, format string, args ...any) error {
	return &yaml.TypeError{Errors: []string{fmt.Sprintf("line %d: %s", n.Line, fmt.Sprintf(format, args...))}}
}

// PortSpec is the port of an app: `port: 3000` (the container port a proxy forwards to), or `port: {container: 3000}`
// (the same), or `port: {host: [3000, 3001], env: PORT}` for an app on the host network, which alternates between two
// host ports and is told which one to listen on through the variable env.
type PortSpec struct {
	Container int
	Host      []int
	Env       string
}

// IsZero says no port is set.
func (p PortSpec) IsZero() bool { return p.Container == 0 && len(p.Host) == 0 && p.Env == "" }

// UnmarshalYAML reads an integer or a mapping.
func (p *PortSpec) UnmarshalYAML(n *yaml.Node) error {
	switch n.Kind {
	case yaml.ScalarNode:
		var v int
		if err := n.Decode(&v); err != nil {
			return typeError(n, "port must be a port number or a mapping with container, or host and env")
		}
		*p = PortSpec{Container: v}
		return nil
	case yaml.MappingNode:
		var raw struct {
			Container *int   `yaml:"container"`
			Host      []int  `yaml:"host"`
			Env       string `yaml:"env"`
		}
		if err := n.Decode(&raw); err != nil {
			return err
		}
		out := PortSpec{Host: raw.Host, Env: raw.Env}
		if raw.Container != nil {
			out.Container = *raw.Container
			if out.Container == 0 {
				return typeError(n, "port.container must be a port number between 1 and 65535")
			}
		}
		*p = out
		return nil
	}
	return typeError(n, "port must be a port number or a mapping with container, or host and env")
}

// MarshalYAML writes the short form when only the container port is set.
func (p PortSpec) MarshalYAML() (any, error) {
	if len(p.Host) == 0 && p.Env == "" {
		return p.Container, nil
	}
	m := map[string]any{}
	if p.Container != 0 {
		m["container"] = p.Container
	}
	if len(p.Host) > 0 {
		m["host"] = p.Host
	}
	if p.Env != "" {
		m["env"] = p.Env
	}
	return m, nil
}
