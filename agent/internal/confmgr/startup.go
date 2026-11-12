package confmgr

import (
	"context"
	"fmt"
	"log/slog"
	"path/filepath"
	"time"

	"github.com/0x2u/keelson/agent/internal/config"
	"github.com/0x2u/keelson/agent/internal/store"
)

// versionsTried bounds how far back the start looks for a configuration that loads.
const versionsTried = 100

// Fallback says the agent started on an older version of the configuration because the files on disk could not be used.
type Fallback struct {
	// Version is the one in force, with its content (a bundle when it has project files: see config.DecodeBundle).
	Version store.ConfigVersion
	// DiskHash is the hash of the configuration on disk that was refused, and Reason why.
	DiskHash string
	Reason   string
}

// Choose picks the configuration to start with: the apps file when it is valid and usable (the check says whether
// what it references, such as secret files, can be read), otherwise the newest recorded version that is. A restart
// loop on a typo would take every app's supervision down with it, where the last good configuration keeps them
// served. It fails like Load does when no version works either, and when the file cannot be read at all. The projects
// directory next to the apps file is part of the configuration: see ChooseAt.
func Choose(path string, st *store.Store, usable func(*config.Config) error) (*config.Config, *Fallback, error) {
	return ChooseAt(config.DefaultLocation(path), st, usable)
}

// ChooseAt is Choose for a configuration at a given location: the apps file and the project files are one state, so a
// project file that is invalid makes the whole state fall back to the last good version.
func ChooseAt(loc config.Location, st *store.Store, usable func(*config.Config) error) (*config.Config, *Fallback, error) {
	disk, err := loc.Read()
	if err != nil {
		return nil, nil, err
	}
	cfg, reason := loadUsable(disk, usable)
	if cfg != nil {
		return cfg, nil, nil
	}
	hash := disk.Hash()
	ctx := context.Background()
	versions, err := st.ConfigVersions(ctx, versionsTried)
	if err == nil {
		for _, v := range versions {
			if v.Hash == hash {
				continue
			}
			full, err := st.ConfigVersion(ctx, v.ID)
			if err != nil {
				continue
			}
			b, err := config.DecodeBundle(full.Content)
			if err != nil {
				continue
			}
			b.MainName = filepath.Base(loc.File)
			if older, _ := loadUsable(b, usable); older != nil {
				return older, &Fallback{Version: full, DiskHash: hash, Reason: reason}, nil
			}
		}
	}
	return nil, nil, fmt.Errorf("%s: %s", loc.File, reason)
}

func loadUsable(b config.Bundle, usable func(*config.Config) error) (*config.Config, string) {
	cfg, issues := config.ParseBundle(b)
	if cfg == nil {
		return nil, errorText(issues)
	}
	if usable != nil {
		if err := usable(cfg); err != nil {
			return nil, err.Error()
		}
	}
	return cfg, ""
}

// NewFallback is New for an agent started on a recorded version: the file on disk stays as the operator left it, no
// version is recorded for it, and Document says what is in force and why until the file is fixed.
func NewFallback(path string, st *store.Store, fb *Fallback, initial *config.Config, log *slog.Logger, appliers ...Applier) (*Manager, error) {
	return NewFallbackAt(config.DefaultLocation(path), st, fb, initial, log, appliers...)
}

// NewFallbackAt is NewFallback for a configuration at a given location.
func NewFallbackAt(loc config.Location, st *store.Store, fb *Fallback, initial *config.Config, log *slog.Logger, appliers ...Applier) (*Manager, error) {
	if log == nil {
		log = slog.Default()
	}
	b, err := config.DecodeBundle(fb.Version.Content)
	if err != nil {
		return nil, err
	}
	b.MainName = filepath.Base(loc.File)
	m := &Manager{loc: loc, store: st, log: log, appliers: appliers, now: time.Now, cfg: initial, applied: b, appliedHash: b.Hash(), rejected: fb.DiskHash}
	m.fileErr = fmt.Sprintf("using version %d: the file on disk is invalid because %s", fb.Version.ID, fb.Reason)
	log.Error("the apps file on disk cannot be used: running the last good configuration", "version", fb.Version.ID, "because", fb.Reason)
	return m, nil
}
