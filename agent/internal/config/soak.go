package config

import (
	"errors"
	"fmt"
	"net/url"
	"strings"
	"time"
)

// Soak bounds. The soak keeps the previous container running after the traffic switch while the new one is watched:
// 30 seconds catches a crash on the first requests and a worker that dies after its first jobs; the ceiling is what a
// deployment can reasonably keep two copies of the app alive for (memory on a small server).
const (
	DefaultSoak = 30 * time.Second
	MaxSoak     = 10 * time.Minute
	// MaxVerify caps the number of checked paths: each one is requested every few seconds for the whole soak.
	MaxVerify = 10
)

// Verify is one page the soak requests on the new container, over 127.0.0.1 on the port it listens on.
type Verify struct {
	// Path starts with "/" and may carry a query ("/products/1?lang=fr").
	Path string `yaml:"path"`
	// Status is the status code the page must answer. 0 (the default) accepts any 2xx; a redirect is an answer, not
	// followed, so a path that redirects needs its code (301, 302...) here.
	Status int `yaml:"status"`
}

// SoakFor is how long the new version is watched after the traffic switch. Loading a file always sets it for a blue/green
// app (30s unless the file says otherwise); an App built by hand has none.
func (a App) SoakFor() time.Duration {
	if a.Soak == nil {
		return 0
	}
	return a.Soak.Std()
}

// ValidVerifyPath reports whether p can be requested as the path of a verify entry (and of health_path, which follows
// the same rule): it starts with "/", holds no space or control character, and is a request URI.
func ValidVerifyPath(p string) bool {
	if !strings.HasPrefix(p, "/") || strings.ContainsAny(p, " \\") {
		return false
	}
	for _, r := range p {
		if r < 0x20 || r == 0x7f {
			return false
		}
	}
	u, err := url.ParseRequestURI(p)
	return err == nil && u.Host == ""
}

func validateSoak(a *App) error {
	if !a.Proxied() {
		if a.Soak != nil {
			return errors.New("soak is only used with deploy.strategy switch (an app with port or domains): it watches the new container after the traffic switch")
		}
		if len(a.Verify) > 0 {
			return errors.New("verify is only used with deploy.strategy switch (an app with port or domains)")
		}
		return nil
	}
	switch {
	case a.Soak == nil:
		a.Soak = D(DefaultSoak)
	case a.Soak.Std() < 0 || a.Soak.Std() > MaxSoak:
		return fmt.Errorf("soak must be between 0s and %s", MaxSoak)
	}
	if len(a.Verify) > MaxVerify {
		return fmt.Errorf("verify lists %d paths: at most %d", len(a.Verify), MaxVerify)
	}
	if len(a.Verify) > 0 && a.Soak.Std() == 0 {
		return errors.New("verify is checked during the soak: it needs soak above 0s")
	}
	for i, v := range a.Verify {
		if !ValidVerifyPath(v.Path) {
			return fmt.Errorf("verify[%d]: path %q must start with / and contain no spaces", i, v.Path)
		}
		if v.Status != 0 && (v.Status < 100 || v.Status > 599) {
			return fmt.Errorf("verify[%d]: status %d is not an HTTP status code", i, v.Status)
		}
	}
	return nil
}
