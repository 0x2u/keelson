// Package schedule parses cron expressions and computes when they fire next.
//
// It understands the classic five fields (minute hour day-of-month month
// day-of-week) with lists, ranges, steps and month/weekday names, the
// descriptors @hourly, @daily, @weekly, @monthly and @yearly, and
// "@every <duration>". Times are evaluated in a location, so "0 7 * * *" in
// Europe/Paris means 07:00 Paris time all year.
package schedule

import (
	"fmt"
	"math/bits"
	"strconv"
	"strings"
	"time"
)

// MinEvery is the shortest interval "@every" accepts: a job that runs more
// often than this is a daemon, not a scheduled job.
const MinEvery = 30 * time.Second

// Schedule says when something runs.
type Schedule struct {
	every time.Duration // > 0 for "@every"

	minute, hour, dom, month, dow uint64 // bit sets
	domStar, dowStar              bool   // the field was "*": day matching rules differ
	loc                           *time.Location
}

type bounds struct {
	min, max int
	names    map[string]int
}

var (
	minuteB = bounds{0, 59, nil}
	hourB   = bounds{0, 23, nil}
	domB    = bounds{1, 31, nil}
	monthB  = bounds{1, 12, map[string]int{"jan": 1, "feb": 2, "mar": 3, "apr": 4, "may": 5, "jun": 6, "jul": 7, "aug": 8, "sep": 9, "oct": 10, "nov": 11, "dec": 12}}
	dowB    = bounds{0, 7, map[string]int{"sun": 0, "mon": 1, "tue": 2, "wed": 3, "thu": 4, "fri": 5, "sat": 6}}
)

var descriptors = map[string]string{
	"@yearly":   "0 0 1 1 *",
	"@annually": "0 0 1 1 *",
	"@monthly":  "0 0 1 * *",
	"@weekly":   "0 0 * * 0",
	"@daily":    "0 0 * * *",
	"@midnight": "0 0 * * *",
	"@hourly":   "0 * * * *",
}

// Parse parses spec, evaluated in loc (nil means UTC).
func Parse(spec string, loc *time.Location) (Schedule, error) {
	if loc == nil {
		loc = time.UTC
	}
	spec = strings.TrimSpace(spec)
	if rest, ok := strings.CutPrefix(spec, "@every"); ok {
		d, err := time.ParseDuration(strings.TrimSpace(rest))
		if err != nil {
			return Schedule{}, fmt.Errorf("@every: %w", err)
		}
		if d < MinEvery {
			return Schedule{}, fmt.Errorf("@every must be at least %s", MinEvery)
		}
		return Schedule{every: d, loc: loc}, nil
	}
	if strings.HasPrefix(spec, "@") {
		full, ok := descriptors[spec]
		if !ok {
			return Schedule{}, fmt.Errorf("unknown descriptor %q", spec)
		}
		spec = full
	}

	fields := strings.Fields(spec)
	if len(fields) != 5 {
		return Schedule{}, fmt.Errorf("want 5 fields (minute hour day-of-month month day-of-week), got %d", len(fields))
	}
	s := Schedule{loc: loc}
	var err error
	for _, f := range []struct {
		name string
		in   string
		b    bounds
		out  *uint64
	}{
		{"minute", fields[0], minuteB, &s.minute},
		{"hour", fields[1], hourB, &s.hour},
		{"day-of-month", fields[2], domB, &s.dom},
		{"month", fields[3], monthB, &s.month},
		{"day-of-week", fields[4], dowB, &s.dow},
	} {
		if *f.out, err = parseField(f.in, f.b); err != nil {
			return Schedule{}, fmt.Errorf("%s %q: %w", f.name, f.in, err)
		}
	}
	// 7 is Sunday too.
	if s.dow&(1<<7) != 0 {
		s.dow = s.dow&^(1<<7) | 1
	}
	s.domStar = fields[2] == "*" || fields[2] == "?"
	s.dowStar = fields[4] == "*" || fields[4] == "?"
	return s, nil
}

func parseField(field string, b bounds) (uint64, error) {
	var set uint64
	for _, part := range strings.Split(field, ",") {
		rangePart, stepPart, hasStep := strings.Cut(part, "/")
		step := 1
		if hasStep {
			n, err := strconv.Atoi(stepPart)
			if err != nil || n < 1 {
				return 0, fmt.Errorf("bad step %q", stepPart)
			}
			step = n
		}

		lo, hi := b.min, b.max
		if b.max == 7 {
			hi = 6 // "*" in day-of-week means 0-6; an explicit 7 is accepted below
		}
		switch {
		case rangePart == "*" || rangePart == "?":
		case strings.Contains(rangePart, "-"):
			a, z, _ := strings.Cut(rangePart, "-")
			var err error
			if lo, err = value(a, b); err != nil {
				return 0, err
			}
			if hi, err = value(z, b); err != nil {
				return 0, err
			}
			if lo > hi {
				return 0, fmt.Errorf("range %q is backwards", rangePart)
			}
		default:
			v, err := value(rangePart, b)
			if err != nil {
				return 0, err
			}
			lo, hi = v, v
			if hasStep { // "5/15" means from 5 to the end
				hi = b.max
			}
		}
		for v := lo; v <= hi; v += step {
			set |= 1 << uint(v)
		}
	}
	if set == 0 {
		return 0, fmt.Errorf("matches nothing")
	}
	return set, nil
}

func value(s string, b bounds) (int, error) {
	if v, ok := b.names[strings.ToLower(s)]; ok {
		return v, nil
	}
	n, err := strconv.Atoi(s)
	if err != nil {
		return 0, fmt.Errorf("%q is not a number or a name", s)
	}
	if n < b.min || n > b.max {
		return 0, fmt.Errorf("%d is outside %d-%d", n, b.min, b.max)
	}
	return n, nil
}

// Every returns the interval of an "@every" schedule, or 0.
func (s Schedule) Every() time.Duration { return s.every }

// Next returns the first firing time strictly after t, or the zero time if
// none exists within five years (an impossible date such as February 31st).
func (s Schedule) Next(t time.Time) time.Time {
	if s.every > 0 {
		return t.Add(s.every)
	}
	t = t.In(s.loc).Truncate(time.Minute).Add(time.Minute)
	limit := t.AddDate(5, 0, 0)

	for t.Before(limit) {
		switch {
		case s.month&(1<<uint(t.Month())) == 0:
			t = time.Date(t.Year(), t.Month()+1, 1, 0, 0, 0, 0, s.loc)
		case !s.dayMatches(t):
			t = time.Date(t.Year(), t.Month(), t.Day()+1, 0, 0, 0, 0, s.loc)
		case s.hour&(1<<uint(t.Hour())) == 0:
			t = time.Date(t.Year(), t.Month(), t.Day(), t.Hour()+1, 0, 0, 0, s.loc)
		case s.minute&(1<<uint(t.Minute())) == 0:
			t = t.Add(time.Minute)
		default:
			return t
		}
	}
	return time.Time{}
}

// dayMatches applies cron's rule: when both day fields are restricted, a day
// matches if either does; otherwise the restricted one decides.
func (s Schedule) dayMatches(t time.Time) bool {
	dom := s.dom&(1<<uint(t.Day())) != 0
	dow := s.dow&(1<<uint(t.Weekday())) != 0
	if s.domStar || s.dowStar {
		return dom && dow
	}
	return dom || dow
}

// String lists how many values each field matches; for logs and tests.
func (s Schedule) String() string {
	if s.every > 0 {
		return "@every " + s.every.String()
	}
	return fmt.Sprintf("minutes=%d hours=%d dom=%d months=%d dow=%d", bits.OnesCount64(s.minute), bits.OnesCount64(s.hour), bits.OnesCount64(s.dom), bits.OnesCount64(s.month), bits.OnesCount64(s.dow))
}
