package config

import (
	"fmt"
	"path/filepath"
)

// Action is what a release step or a job does: exactly one of a command on the host, a command in a container, an
// HTTP call (jobs) or a database backup (release steps). The same keys name the same thing everywhere.
type Action struct {
	// Host is a command executed on the host, as the agent's user. No shell is involved: it is an argument list.
	Host []string `yaml:"host"`
	// Dir is the working directory of a host command. It must be absolute.
	Dir string `yaml:"dir"`
	// Container runs a command in a throwaway container: see ContainerAction.
	Container *ContainerAction `yaml:"container"`
	// HTTP calls an app (jobs only).
	HTTP *JobHTTP `yaml:"http"`
	// Backup is the name of a declared database with backups (release steps only): the step takes a backup of it, with
	// the same checks as its scheduled one, and fails if it cannot.
	Backup string `yaml:"backup"`
}

// ContainerAction runs Command in a throwaway container with the environment, volumes and network of an app.
type ContainerAction struct {
	// App is the app a job runs in, from the version it is serving. A release step never sets it: it runs in the app
	// being deployed.
	App string `yaml:"app"`
	// Image overrides the repository of a release step's container, for a tool that is not in the runtime image (a
	// migrator). It is deployed with the same tag as the app, so CI builds both. A job never sets it.
	Image string `yaml:"image"`
	// Command replaces the image's CMD.
	Command []string `yaml:"command"`
}

// The kinds of an action.
const (
	KindHost      = "host"
	KindContainer = "container"
	KindHTTP      = "http"
	KindBackup    = "backup"
)

// actionKinds says which kinds are set, in the order of the documentation.
func (a Action) actionKinds() []string {
	var out []string
	if len(a.Host) > 0 {
		out = append(out, KindHost)
	}
	if a.Container != nil {
		out = append(out, KindContainer)
	}
	if a.HTTP != nil {
		out = append(out, KindHTTP)
	}
	if a.Backup != "" {
		out = append(out, KindBackup)
	}
	return out
}

// ActionKind says what the action does; "" when it is not exactly one thing (validation refuses that).
func (a Action) ActionKind() string {
	if k := a.actionKinds(); len(k) == 1 {
		return k[0]
	}
	return ""
}

// CommandOf is the argument list of a host or container action.
func (a Action) CommandOf() []string {
	switch {
	case len(a.Host) > 0:
		return a.Host
	case a.Container != nil:
		return a.Container.Command
	}
	return nil
}

// actionContext says where an action sits, which decides what it may be.
type actionContext struct {
	cfg *Config
	// release is true for a step of an app's release, false for a job.
	release bool
	// subject names the action in messages: `release step "migrate"` or `job "purge"`.
	subject string
}

// validate checks an action. Exactly one kind is set, and the kind holds only what it can use.
func (a *Action) validate(ctx actionContext) error {
	kinds := a.actionKinds()
	if len(kinds) != 1 {
		if ctx.release {
			return fmt.Errorf("set exactly one of host (on the host), container (in a container) or backup (a declared database)")
		}
		return fmt.Errorf("set exactly one of host, container or http")
	}
	switch kinds[0] {
	case KindHTTP:
		if ctx.release {
			return fmt.Errorf("http is not supported in release steps: use host or container")
		}
		if a.Dir != "" {
			return fmt.Errorf("dir only applies to a host action")
		}
		return ctx.cfg.validateJobHTTP(a.HTTP)
	case KindBackup:
		if !ctx.release {
			return fmt.Errorf("backup is not supported in jobs: back a database up with backups on the database")
		}
		if a.Dir != "" {
			return fmt.Errorf("dir does not apply to a backup step")
		}
		if !namePattern.MatchString(a.Backup) {
			return fmt.Errorf("backup must name a database (%s)", namePattern)
		}
	case KindHost:
		if a.Host[0] == "" {
			return fmt.Errorf("host needs a program")
		}
		if a.Dir != "" && !filepath.IsAbs(a.Dir) {
			return fmt.Errorf("dir must be an absolute path")
		}
	case KindContainer:
		if a.Dir != "" {
			return fmt.Errorf("dir only applies to a host action")
		}
		c := a.Container
		if len(c.Command) == 0 || c.Command[0] == "" {
			return fmt.Errorf("container: command is required")
		}
		if ctx.release {
			if c.App != "" {
				return fmt.Errorf("container: app does not apply to a release step, which runs in the app being deployed")
			}
			if c.Image != "" {
				if err := validateRepository(c.Image); err != nil {
					return fmt.Errorf("container: image: %w", err)
				}
			}
		} else {
			if c.Image != "" {
				return fmt.Errorf("container: image only applies to a release step")
			}
			if _, ok := ctx.cfg.App(c.App); !ok {
				return fmt.Errorf("container: unknown app %q", c.App)
			}
		}
	}
	return nil
}
