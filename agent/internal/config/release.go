package config

import (
	"errors"
	"fmt"
	"regexp"
	"time"
)

const (
	DefaultReleaseTimeout = 10 * time.Minute
	MaxReleaseTimeout     = time.Hour
)

var stepNamePattern = regexp.MustCompile(`^[a-z0-9][a-z0-9_-]{0,30}$`)

// Release is what runs between "the new image is pulled" and "the new version
// takes over": typically a database backup and the schema migration. A failing
// step stops the deployment before anything serving was touched.
type Release struct {
	Steps []ReleaseStep `yaml:"steps"`
	// OnRollback also runs the steps when the deployment is a rollback. Off by
	// default: re-running migrations from an older image is not what a rollback
	// is for, and a backup before restoring old code is rarely wanted.
	OnRollback bool `yaml:"on_rollback"`
}

// ReleaseStep is one step of the release phase: an Action (host, container or backup), with its own timeout.
type ReleaseStep struct {
	Name   string `yaml:"name"`
	Action `yaml:",inline"`

	// Timeout bounds the step; default 10 minutes.
	Timeout *Duration `yaml:"timeout"`
	// ContinueOnFailure logs a failure as a warning and goes on, instead of aborting the deployment.
	ContinueOnFailure bool `yaml:"continue_on_failure"`
}

// Kind says what the step does: "host", "container" or "backup".
func (s ReleaseStep) Kind() string { return s.ActionKind() }

// RunTimeout is how long the step may take.
func (s ReleaseStep) RunTimeout() time.Duration {
	if s.Timeout == nil {
		return DefaultReleaseTimeout
	}
	return s.Timeout.Std()
}

func (c *Config) validateRelease(a *App) error {
	if a.Release == nil {
		return nil
	}
	seen := map[string]bool{}
	for i := range a.Release.Steps {
		s := &a.Release.Steps[i]
		if !stepNamePattern.MatchString(s.Name) {
			return fmt.Errorf("release step %q: name must match %s", s.Name, stepNamePattern)
		}
		if seen[s.Name] {
			return fmt.Errorf("release step %q: duplicate name", s.Name)
		}
		seen[s.Name] = true
		if err := s.Action.validate(actionContext{cfg: c, release: true, subject: "release step " + s.Name}); err != nil {
			return fmt.Errorf("release step %q: %w", s.Name, err)
		}
		switch {
		case s.Timeout == nil:
			s.Timeout = D(DefaultReleaseTimeout)
		case s.Timeout.Std() <= 0 || s.Timeout.Std() > MaxReleaseTimeout:
			return fmt.Errorf("release step %q: timeout must be between 1s and %s", s.Name, FormatDuration(MaxReleaseTimeout))
		}
	}
	if len(a.Release.Steps) == 0 {
		return errors.New("release needs at least one step")
	}
	return nil
}

// releaseBackupIssues reports a backup step that names a database that is not declared or has no backup section: the
// step could only fail at the first deployment, with the migration waiting behind it.
func (c *Config) releaseBackupIssues() []Issue {
	var out []Issue
	for _, a := range c.Apps {
		if a.Release == nil {
			continue
		}
		for _, s := range a.Release.Steps {
			if s.Backup == "" {
				continue
			}
			var db *Database
			for i := range c.Databases {
				if c.Databases[i].Name == s.Backup {
					db = &c.Databases[i]
				}
			}
			var why string
			switch {
			case db == nil:
				why = "is not declared in databases"
			case db.Backups == nil:
				why = "has no backups section"
			default:
				continue
			}
			out = append(out, Issue{Severity: SeverityError, Path: "apps[" + a.Name + "]", Message: fmt.Sprintf("app %q: release step %q backs up database %q, which %s", a.Name, s.Name, s.Backup, why)})
		}
	}
	return out
}
