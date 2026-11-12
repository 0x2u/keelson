package config

import (
	"errors"
	"fmt"
)

// Log is how Docker keeps a container's output.
type Log struct {
	// Driver is "json-file" (the default) or "local": both rotate by size.
	Driver string `yaml:"driver"`
	// MaxSize is the size at which a log file is rotated. Default 10m.
	MaxSize *Size `yaml:"max_size"`
	// MaxFile is how many rotated files are kept. Default 3.
	MaxFile *int `yaml:"max_file"`
}

// Defaults and limits for a container's logs.
const (
	DefaultLogDriver  = "json-file"
	DefaultLogMaxSize = 10 << 20
	DefaultLogMaxFile = 3
	MinLogMaxSize     = 1 << 10
	MinLogMaxFile     = 1
	MaxLogMaxFile     = 100
)

// Clone returns a copy that shares nothing with l, nil for nil.
func (l *Log) Clone() *Log {
	if l == nil {
		return nil
	}
	c := *l
	if l.MaxSize != nil {
		v := *l.MaxSize
		c.MaxSize = &v
	}
	if l.MaxFile != nil {
		v := *l.MaxFile
		c.MaxFile = &v
	}
	return &c
}

// MaxSizeOrDefault is the rotation size.
func (l Log) MaxSizeOrDefault() Size {
	if l.MaxSize == nil {
		return DefaultLogMaxSize
	}
	return *l.MaxSize
}

// MaxFileOrDefault is how many rotated files are kept.
func (l Log) MaxFileOrDefault() int {
	if l.MaxFile == nil {
		return DefaultLogMaxFile
	}
	return *l.MaxFile
}

// validateLog checks an app's log options and fills their defaults, so that every container the agent creates rotates
// its logs.
func validateLog(a *App) error {
	if a.Log == nil {
		a.Log = &Log{}
	}
	l := a.Log
	if l.Driver == "" {
		l.Driver = DefaultLogDriver
	}
	if l.Driver != "json-file" && l.Driver != "local" {
		return fmt.Errorf("log driver must be json-file or local, not %q", l.Driver)
	}
	switch {
	case l.MaxSize == nil:
		l.MaxSize = S(DefaultLogMaxSize)
	case l.MaxSize.Bytes() < MinLogMaxSize:
		return fmt.Errorf("log max_size must be at least %s, such as 10m", Size(MinLogMaxSize))
	}
	switch {
	case l.MaxFile == nil:
		n := DefaultLogMaxFile
		l.MaxFile = &n
	case *l.MaxFile < MinLogMaxFile || *l.MaxFile > MaxLogMaxFile:
		return errors.New("log max_file must be between 1 and 100")
	}
	return nil
}

func validateKeepImages(a *App) error {
	switch {
	case a.KeepImages == nil:
		n := DefaultKeepImages
		a.KeepImages = &n
	case *a.KeepImages < 1 || *a.KeepImages > MaxKeepImages:
		return fmt.Errorf("keep_images must be between 1 and %d", MaxKeepImages)
	}
	return nil
}

// KeepImagesOrDefault is how many versions of the app stay on the server.
func (a App) KeepImagesOrDefault() int {
	if a.KeepImages == nil {
		return DefaultKeepImages
	}
	return *a.KeepImages
}

// keepImagesRaw is the count as the file and the defaults left it: 0 for an app built by hand that never was validated
// (the instance of a preview).
func (a App) keepImagesRaw() int {
	if a.KeepImages == nil {
		return 0
	}
	return *a.KeepImages
}
