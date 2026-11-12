package schedule

import (
	"strings"
	"testing"
	"time"
)

func at(t *testing.T, s string, loc *time.Location) time.Time {
	t.Helper()
	if loc == nil {
		loc = time.UTC
	}
	v, err := time.ParseInLocation("2006-01-02 15:04", s, loc)
	if err != nil {
		t.Fatal(err)
	}
	return v
}

func next(t *testing.T, spec string, loc *time.Location, after string) string {
	t.Helper()
	if loc == nil {
		loc = time.UTC
	}
	s, err := Parse(spec, loc)
	if err != nil {
		t.Fatalf("Parse(%q): %v", spec, err)
	}
	n := s.Next(at(t, after, loc))
	if n.IsZero() {
		return "never"
	}
	return n.In(loc).Format("2006-01-02 15:04")
}

func TestNextForCommonSchedules(t *testing.T) {
	cases := []struct{ spec, after, want string }{
		{"*/5 * * * *", "2026-10-18 12:03", "2026-10-18 12:05"},
		{"*/5 * * * *", "2026-10-18 12:05", "2026-10-18 12:10"},  // strictly after
		{"0 6-21 * * *", "2026-10-18 21:30", "2026-10-19 06:00"}, // hourly window, like track-shipments
		{"0 6-21 * * *", "2026-10-18 05:59", "2026-10-18 06:00"},
		{"0 7 * * *", "2026-10-18 07:00", "2026-10-19 07:00"},
		{"30 3 * * *", "2026-10-18 03:29", "2026-10-18 03:30"},
		{"0 4 1 * *", "2026-10-18 12:00", "2026-11-01 04:00"},
		{"15,45 * * * *", "2026-10-18 12:20", "2026-10-18 12:45"},
		{"0 0 * * 1-5", "2026-10-17 12:00", "2026-10-19 00:00"}, // Saturday -> Monday
		{"0 0 1 jan *", "2026-10-18 12:00", "2027-01-01 00:00"},
		{"0 9 * * mon,fri", "2026-10-18 12:00", "2026-10-19 09:00"},
		{"10/20 * * * *", "2026-10-18 12:00", "2026-10-18 12:10"},
		{"10/20 * * * *", "2026-10-18 12:11", "2026-10-18 12:30"},
		{"0 0 29 2 *", "2026-10-18 12:00", "2028-02-29 00:00"}, // leap day
		{"@hourly", "2026-10-18 12:30", "2026-10-18 13:00"},
		{"@daily", "2026-10-18 12:30", "2026-10-19 00:00"},
		{"@weekly", "2026-10-18 12:30", "2026-10-25 00:00"}, // 2026-10-18 is a Sunday
		{"@monthly", "2026-10-18 12:30", "2026-11-01 00:00"},
		{"@yearly", "2026-10-18 12:30", "2027-01-01 00:00"},
	}
	for _, c := range cases {
		if got := next(t, c.spec, nil, c.after); got != c.want {
			t.Errorf("%q after %s: got %s, want %s", c.spec, c.after, got, c.want)
		}
	}
}

func TestSundayCanBeZeroOrSeven(t *testing.T) {
	for _, spec := range []string{"0 0 * * 0", "0 0 * * 7", "0 0 * * sun", "0 0 * * SUN"} {
		if got := next(t, spec, nil, "2026-10-14 12:00"); got != "2026-10-18 00:00" {
			t.Errorf("%q: got %s", spec, got)
		}
	}
}

func TestDayOfMonthAndDayOfWeekAreOrWhenBothAreRestricted(t *testing.T) {
	// "the 15th, or any Monday": 2026-10-19 is a Monday and comes before the 15th of November.
	if got := next(t, "0 0 15 * mon", nil, "2026-10-16 00:00"); got != "2026-10-19 00:00" {
		t.Errorf("got %s", got)
	}
	// With a star on one side, only the other restricts.
	if got := next(t, "0 0 15 * *", nil, "2026-10-16 00:00"); got != "2026-11-15 00:00" {
		t.Errorf("got %s", got)
	}
}

func TestEvery(t *testing.T) {
	s, err := Parse("@every 90s", nil)
	if err != nil {
		t.Fatal(err)
	}
	base := at(t, "2026-10-18 12:00", nil)
	if got := s.Next(base); !got.Equal(base.Add(90 * time.Second)) {
		t.Errorf("got %s", got)
	}
	if s.Every() != 90*time.Second {
		t.Error("Every must expose the interval")
	}
}

func TestSchedulesAreEvaluatedInTheirTimezone(t *testing.T) {
	paris, err := time.LoadLocation("Europe/Paris")
	if err != nil {
		t.Skip("no tzdata on this machine")
	}
	// 07:00 Paris is 05:00 UTC in summer and 06:00 UTC in winter.
	s, _ := Parse("0 7 * * *", paris)
	summer := s.Next(time.Date(2026, 7, 1, 0, 0, 0, 0, time.UTC))
	winter := s.Next(time.Date(2026, 12, 1, 0, 0, 0, 0, time.UTC))
	if summer.UTC().Hour() != 5 || winter.UTC().Hour() != 6 {
		t.Errorf("07:00 Paris must follow daylight saving: summer %s, winter %s", summer.UTC(), winter.UTC())
	}
	// A daily job crossing the spring-forward night still fires once, the next day.
	after := time.Date(2026, 3, 28, 12, 0, 0, 0, paris)
	if got := s.Next(after); got.In(paris).Format("2006-01-02 15:04") != "2026-03-29 07:00" {
		t.Errorf("got %s", got.In(paris))
	}
}

func TestNeverFiringSchedulesReturnTheZeroTime(t *testing.T) {
	if got := next(t, "0 0 31 2 *", nil, "2026-01-01 00:00"); got != "never" {
		t.Errorf("February 31st does not exist, got %s", got)
	}
}

func TestInvalidSpecsAreRejectedWithAReason(t *testing.T) {
	bad := map[string]string{
		"":             "5 fields",
		"* * * *":      "5 fields",
		"* * * * * *":  "5 fields",
		"60 * * * *":   "outside",
		"* 24 * * *":   "outside",
		"* * 0 * *":    "outside",
		"* * * 13 *":   "outside",
		"* * * * 8":    "outside",
		"5-1 * * * *":  "backwards",
		"*/0 * * * *":  "step",
		"*/x * * * *":  "step",
		"a * * * *":    "not a number",
		"* * * foo *":  "not a number",
		"@sometimes":   "unknown descriptor",
		"@every":       "@every",
		"@every 5":     "@every",
		"@every 5s":    "at least",
		"1,,2 * * * *": "not a number",
	}
	for spec, want := range bad {
		_, err := Parse(spec, nil)
		if err == nil || !strings.Contains(err.Error(), want) {
			t.Errorf("Parse(%q): want an error mentioning %q, got %v", spec, want, err)
		}
	}
}
