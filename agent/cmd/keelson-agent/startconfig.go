package main

import (
	"io"
	"log/slog"

	"github.com/0x2u/keelson/agent/internal/config"
	"github.com/0x2u/keelson/agent/internal/confmgr"
	"github.com/0x2u/keelson/agent/internal/notify"
	"github.com/0x2u/keelson/agent/internal/store"
)

// location is where the configuration is: the apps file, and the directory of project files, which is projects.d next to
// the apps file unless the operator names another (--projects-dir, KEELSON_PROJECTS_DIR).
func location(appsFile, projectsDir string) config.Location {
	loc := config.DefaultLocation(appsFile)
	if projectsDir != "" {
		loc.ProjectsDir = projectsDir
	}
	return loc
}

// startConfig returns the configuration an agent starts with. A command that only borrows the agent's state (a local
// deploy) wants the file as it is; `serve` and `connect` fall back to the last good version (see confmgr.Choose).
func startConfig(appsFile string, st *store.Store, fallback bool) (*config.Config, *confmgr.Fallback, error) {
	return startConfigAt(config.DefaultLocation(appsFile), st, fallback)
}

// startConfigAt is startConfig for a configuration at a given location: the apps file and its project files.
func startConfigAt(loc config.Location, st *store.Store, fallback bool) (*config.Config, *confmgr.Fallback, error) {
	if !fallback {
		cfg, err := config.LoadFrom(loc)
		return cfg, nil, err
	}
	return confmgr.ChooseAt(loc, st, startupUsable)
}

// startupUsable is what `serve` needs of a configuration beyond its syntax: the secret files its notifications read.
// The hot reload refuses a change for the same reason, so a file that passes here is one the agent could also apply.
func startupUsable(cfg *config.Config) error {
	if cfg.Notifications == nil {
		return nil
	}
	_, err := notify.New(cfg.Notifications, slog.New(slog.NewTextHandler(io.Discard, nil)))
	return err
}

// newManager creates the configuration manager for the configuration openDeploy chose.
func newManager(c stackConfig, st *store.Store, cfg *config.Config, fb *confmgr.Fallback, appliers ...confmgr.Applier) (*confmgr.Manager, error) {
	loc := location(c.appsFile, c.projectsDir)
	if fb != nil {
		return confmgr.NewFallbackAt(loc, st, fb, cfg, c.log, appliers...)
	}
	return confmgr.NewAt(loc, st, cfg, c.log, appliers...)
}
