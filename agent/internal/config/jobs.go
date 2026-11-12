package config

import (
	"errors"
	"fmt"
	"net/http"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/0x2u/keelson/agent/internal/schedule"
)

var headerName = regexp.MustCompile(`^[A-Za-z0-9-]+$`)

// Job is something the agent runs on a schedule: an HTTP call to an app (the cron endpoints GitHub Actions used to
// hit), a command on the host (a backup script, a log purge), or a command in a one-off container of an app. Its
// Schedule says when and how long, its Action what: exactly one of http, host and container.
type Job struct {
	Name string `yaml:"name"`
	// Project groups the job with the others of a project in the dashboard: the same label as App.Project. It is
	// optional (the dashboard then derives it from the app the job calls). A job in projects.d/<p>.yaml is of the
	// project <p>: unset is filled in, another value is an error. A backup job takes its database's.
	Project  string `yaml:"project"`
	Schedule `yaml:",inline"`
	Action   `yaml:",inline"`

	// Database is the database a backup job belongs to. The job is synthesized from the database's backups section,
	// so neither field is part of the document.
	Database string `yaml:"-"`
	// Managed marks a job that is not in the document and cannot be edited as one.
	Managed bool `yaml:"-"`
}

// JobHTTP is an HTTP request. A 2xx answer is success unless ExpectStatus
// lists others.
type JobHTTP struct {
	URL     string            `yaml:"url"`
	Method  string            `yaml:"method"`
	Headers map[string]string `yaml:"headers"`
	Body    string            `yaml:"body"`
	// Bearer sends "Authorization: Bearer <secret>", the secret read from a
	// file or from an app's environment each time the job runs.
	Bearer       *JobBearer `yaml:"bearer"`
	ExpectStatus []int      `yaml:"expect_status"`
}

// JobBearer names where a bearer secret comes from: File, or the variable Env
// of the app App (its env and env_file). Exactly one of the two.
type JobBearer struct {
	File string `yaml:"file"`
	App  string `yaml:"app"`
	Env  string `yaml:"env"`
}

// Kind says what a job does: "http", "host", "container" or "backup".
func (j Job) Kind() string {
	switch {
	case j.Database != "":
		return KindBackup
	case j.HTTP != nil:
		return KindHTTP
	case len(j.Host) > 0:
		return KindHost
	}
	return KindContainer
}

// ParsedSchedule returns the job's schedule. Load has validated it.
func (j Job) ParsedSchedule() schedule.Schedule {
	s, _ := schedule.Parse(j.Cron, j.Location())
	return s
}

// Job returns the job with the given name.
func (c *Config) Job(name string) (Job, bool) {
	for _, j := range c.Jobs {
		if j.Name == name {
			return j, true
		}
	}
	return Job{}, false
}

var httpMethods = map[string]bool{
	http.MethodGet: true, http.MethodPost: true, http.MethodPut: true, http.MethodPatch: true, http.MethodDelete: true,
}

// jobIssues validates every job and reports one issue per broken job. A job may not take the name of the backup job
// a database synthesizes, nor the name its restore runs are recorded under.
func (c *Config) jobIssues() []Issue {
	var out []Issue
	seen := map[string]bool{}
	for _, d := range c.Databases {
		if d.Backups != nil {
			seen[BackupJobName(d.Name)] = true
			seen[RestoreJobName(d.Name)] = true
		}
	}
	for i := range c.Jobs {
		j := &c.Jobs[i]
		err := c.validateJob(j)
		if err == nil && !j.Managed && seen[j.Name] {
			err = errors.New("duplicate name")
		}
		seen[j.Name] = true
		if err != nil {
			out = append(out, Issue{Severity: SeverityError, Path: "jobs[" + j.Name + "]", Message: fmt.Sprintf("job %q: %v", j.Name, err)})
		}
	}
	return out
}

func (c *Config) validateJob(j *Job) error {
	if j.Managed {
		return nil // synthesized from a database that was validated on its own
	}
	if !namePattern.MatchString(j.Name) {
		return fmt.Errorf("name must match %s", namePattern)
	}
	if j.Project != "" && !namePattern.MatchString(j.Project) {
		return fmt.Errorf("project must match %s", namePattern)
	}
	if err := j.Schedule.validate(jobLimits); err != nil {
		return err
	}
	return j.Action.validate(actionContext{cfg: c, subject: "job " + j.Name})
}

func (c *Config) validateJobHTTP(h *JobHTTP) error {
	if err := httpURL(h.URL); err != nil {
		return fmt.Errorf("http url: %w", err)
	}
	h.Method = strings.ToUpper(h.Method)
	if h.Method == "" {
		h.Method = http.MethodGet
	}
	if !httpMethods[h.Method] {
		return fmt.Errorf("http method %q is not supported", h.Method)
	}
	for name, v := range h.Headers {
		if !headerName.MatchString(name) || strings.ContainsAny(v, "\r\n") {
			return fmt.Errorf("http header %q is not valid", name)
		}
		if strings.EqualFold(name, "Authorization") && h.Bearer != nil {
			return fmt.Errorf("set Authorization either in headers or as bearer, not both")
		}
	}
	for _, code := range h.ExpectStatus {
		if code < 100 || code > 599 {
			return fmt.Errorf("expect_status %d is not an HTTP status", code)
		}
	}
	if b := h.Bearer; b != nil {
		fromFile, fromApp := b.File != "", b.App != "" || b.Env != ""
		switch {
		case fromFile == fromApp:
			return fmt.Errorf("bearer: set either file, or app and env")
		case fromFile && !filepath.IsAbs(b.File):
			return fmt.Errorf("bearer file must be an absolute path")
		case fromApp:
			if _, ok := c.App(b.App); !ok {
				return fmt.Errorf("bearer: unknown app %q", b.App)
			}
			if !envNamePattern.MatchString(b.Env) {
				return fmt.Errorf("bearer: env %q is not a valid variable name", b.Env)
			}
		}
	}
	return nil
}
