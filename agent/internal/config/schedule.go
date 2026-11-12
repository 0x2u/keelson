package config

import (
	"errors"
	"fmt"
	"time"

	"github.com/0x2u/keelson/agent/internal/schedule"
)

// Schedule is what a job and a database's backups share: when they run, how long a run may take and when a failing
// one raises an alert. A key left out is its default; a key that is there is what it says (R1).
type Schedule struct {
	// Cron is a cron expression ("*/5 * * * *"), a descriptor (@daily) or "@every 10m".
	Cron string `yaml:"schedule"`
	// Timezone is an IANA name such as Europe/Paris; default UTC.
	Timezone string `yaml:"timezone"`
	// Timeout bounds one run. Default 1m for a job, 30m for a backup.
	Timeout *Duration `yaml:"timeout"`
	// AlertAfter is how many failures in a row raise job.failed. Default 1.
	AlertAfter *int `yaml:"alert_after"`
	// RealertAfter is how long a failure streak that keeps going waits before job.failed is sent again once an alert
	// got through. Default 24h; 0s never repeats. An alert that did not get through is sent again at the next failed
	// run whatever this says.
	RealertAfter *Duration `yaml:"realert_after"`
	// CatchUp runs once, late, when occurrences were missed because the agent or the server was down.
	CatchUp bool `yaml:"catch_up"`
	// Paused keeps it configured but not scheduled; it can still be run by hand.
	Paused bool `yaml:"paused"`
}

// Defaults and limits of the run of a schedule.
const (
	DefaultJobTimeout = time.Minute
	MaxJobTimeout     = time.Hour
	// DefaultAlertAfter is how many failures in a row raise an alert.
	DefaultAlertAfter = 1
	// DefaultRealertAfter is how long a continuing failure streak waits before job.failed is repeated.
	DefaultRealertAfter = 24 * time.Hour
)

// Location returns the timezone.
func (s Schedule) Location() *time.Location {
	loc, err := time.LoadLocation(s.Timezone)
	if err != nil || s.Timezone == "" {
		return time.UTC
	}
	return loc
}

// RunTimeout is how long a run may take (a job's default when the file gave none and nothing filled it in).
func (s Schedule) RunTimeout() time.Duration {
	if s.Timeout == nil {
		return DefaultJobTimeout
	}
	return s.Timeout.Std()
}

// AlertThreshold is how many failures in a row raise the alert.
func (s Schedule) AlertThreshold() int {
	if s.AlertAfter == nil {
		return DefaultAlertAfter
	}
	return *s.AlertAfter
}

// Realert returns how long a continuing failure streak waits before job.failed is sent again; 0 means never.
func (s Schedule) Realert() time.Duration {
	if s.RealertAfter == nil {
		return DefaultRealertAfter
	}
	return s.RealertAfter.Std()
}

// scheduleLimits are what differs between the schedules of a job and of a backup.
type scheduleLimits struct{ defTimeout, maxTimeout time.Duration }

var (
	jobLimits    = scheduleLimits{DefaultJobTimeout, MaxJobTimeout}
	backupLimits = scheduleLimits{DefaultBackupTimeout, MaxBackupTimeout}
)

// validate checks the schedule and fills the defaults of the keys left out.
func (s *Schedule) validate(l scheduleLimits) error {
	if s.Timezone != "" {
		if _, err := time.LoadLocation(s.Timezone); err != nil {
			return fmt.Errorf("unknown timezone %q", s.Timezone)
		}
	}
	if _, err := schedule.Parse(s.Cron, s.Location()); err != nil {
		return fmt.Errorf("schedule: %w", err)
	}
	switch {
	case s.Timeout == nil:
		s.Timeout = D(l.defTimeout)
	case s.Timeout.Std() <= 0 || s.Timeout.Std() > l.maxTimeout:
		return fmt.Errorf("timeout must be between 1s and %s", FormatDuration(l.maxTimeout))
	}
	switch {
	case s.AlertAfter == nil:
		n := DefaultAlertAfter
		s.AlertAfter = &n
	case *s.AlertAfter < 1:
		return errors.New("alert_after must be at least 1")
	}
	if s.RealertAfter != nil && s.RealertAfter.Std() < 0 {
		return errors.New("realert_after must not be negative")
	}
	return nil
}
