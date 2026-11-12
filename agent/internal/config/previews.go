package config

import (
	"errors"
	"fmt"
	"maps"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// Preview limits and defaults.
const (
	DefaultPreviewTTL = 168 * time.Hour
	MinPreviewTTL     = time.Minute
	DefaultPreviewMax = 5
	MaxPreviewMax     = 100
	// MaxPreviewNumber is the largest pull request number an instance can have: it keeps names and domains short.
	MaxPreviewNumber = 999999

	// previewPlaceholder stands for the pull request number in a domain pattern.
	previewPlaceholder = "{pr}"
	previewInfix       = "-pr-"
	// maxPreviewParentName leaves room in a 63-character name for "-pr-" and six digits.
	maxPreviewParentName = 63 - len(previewInfix) - 6
)

// Previews is the template of the ephemeral environments of one app (App.Previews): every pull request that CI built
// an image for gets an instance, named "<app>-pr-<n>", that lives until the pull request is closed, its TTL ends, or
// newer instances push it out. Instances are never in the apps list: they live in the agent's database. The parent
// app is the one that holds the template: its image repository, port and runtime settings are what an instance runs.
// It must be proxied with a container port (its own network), behind the Caddy driver.
type Previews struct {
	// Domain is the public host pattern, with {pr} for the pull request number, in one label: pr-{pr}-shop.example.com.
	Domain string `yaml:"domain"`
	// EnvFile and Env are the instance's own environment. The parent's env_file and env are never inherited: they
	// hold production secrets.
	EnvFile string            `yaml:"env_file"`
	Env     map[string]string `yaml:"env"`
	// TTL is how long an instance lives after its last deployment. Default 168h.
	TTL *Duration `yaml:"ttl"`
	// Max is how many instances of the app exist at once: creating one more removes the oldest. Default 5.
	Max *int `yaml:"max"`
}

// Previews returns the previews template of an app.
func (c *Config) Previews(app string) (Previews, bool) {
	for _, a := range c.Apps {
		if a.Name == app && a.Previews != nil {
			return *a.Previews, true
		}
	}
	return Previews{}, false
}

// PreviewApps lists the apps that have a previews template, in file order.
func (c *Config) PreviewApps() []App {
	var out []App
	for _, a := range c.Apps {
		if a.Previews != nil {
			out = append(out, a)
		}
	}
	return out
}

// TTLFor is how long an instance lives after its last deployment.
func (p Previews) TTLFor() time.Duration {
	if p.TTL == nil {
		return DefaultPreviewTTL
	}
	return p.TTL.Std()
}

// MaxCount is how many instances exist at once.
func (p Previews) MaxCount() int {
	if p.Max == nil {
		return DefaultPreviewMax
	}
	return *p.Max
}

// PreviewName is the name of the instance of app for pull request pr.
func PreviewName(app string, pr int) string { return app + previewInfix + strconv.Itoa(pr) }

// ParsePreviewName splits "<app>-pr-<n>" into its parts; ok is false for any other name.
func ParsePreviewName(name string) (app string, pr int, ok bool) {
	i := strings.LastIndex(name, previewInfix)
	if i <= 0 {
		return "", 0, false
	}
	digits := name[i+len(previewInfix):]
	n, err := strconv.Atoi(digits)
	if err != nil || n < 1 || n > MaxPreviewNumber || strconv.Itoa(n) != digits {
		return "", 0, false
	}
	return name[:i], n, true
}

// ValidPreviewNumber reports whether n can be the number of an instance.
func ValidPreviewNumber(n int) bool { return n >= 1 && n <= MaxPreviewNumber }

// Host is the public host of the instance for pull request pr.
func (p Previews) Host(pr int) string {
	return strings.ReplaceAll(p.Domain, previewPlaceholder, strconv.Itoa(pr))
}

// Instance synthesizes the app that runs for pull request pr: the parent's image repository and runtime settings
// (port, health check, command, stop and health timeouts, log options, drain, restart policy, network, build block), its
// own domain and environment. Nothing that could reach production data or state comes along: no volumes, no release
// steps, no host ports, no env_file or env of the parent.
func (p Previews) Instance(parent App, pr int) App {
	project := parent.Project
	if project == "" {
		project = parent.Name
	}
	a := App{
		Name:          PreviewName(parent.Name, pr),
		Parent:        parent.Name,
		Project:       project,
		Stage:         "pr-" + strconv.Itoa(pr),
		Image:         parent.Image,
		EnvFile:       p.EnvFile,
		Env:           maps.Clone(p.Env),
		Network:       parent.Network,
		Restart:       parent.Restart,
		Command:       append([]string(nil), parent.Command...),
		StopTimeout:   parent.StopTimeout.clone(),
		HealthTimeout: parent.HealthTimeout.clone(),
		StableAfter:   parent.StableAfter.clone(),
		Domains:       []string{p.Host(pr)},
		Port:          PortSpec{Container: parent.Port.Container},
		ContainerPort: parent.ContainerPort,
		HealthPath:    parent.HealthPath,
	}
	// Soak and Verify are not inherited: an instance serves a pull request, not visitors (Soak nil means none).
	a.StableAfterSet = parent.StableAfterSet
	a.Build = parent.Build.Clone()
	a.Log = parent.Log.Clone()
	a.Drain = parent.Drain.clone()
	return a
}

// previewNumberPattern matches what {pr} can stand for.
const previewNumberPattern = `[1-9][0-9]{0,5}`

// domainRegexp matches every host the pattern can produce.
func (p Previews) domainRegexp() *regexp.Regexp {
	parts := strings.Split(p.Domain, previewPlaceholder)
	for i, s := range parts {
		parts[i] = regexp.QuoteMeta(s)
	}
	return regexp.MustCompile("^" + strings.Join(parts, previewNumberPattern) + "$")
}

// previewIssues validates the previews template of every app that has one.
func (c *Config) previewIssues() []Issue {
	var out []Issue
	domains := map[string]string{} // pattern -> app of the template that owns it
	for i := range c.Apps {
		a := &c.Apps[i]
		if a.Previews == nil {
			continue
		}
		p := a.Previews
		err := c.validatePreview(a, p)
		if err == nil {
			if other, dup := domains[p.Domain]; dup {
				err = fmt.Errorf("domain %q is also the pattern of the previews of %q", p.Domain, other)
			}
		}
		if err == nil {
			domains[p.Domain] = a.Name
		}
		if err != nil {
			out = append(out, Issue{Severity: SeverityError, Path: "apps[" + a.Name + "].previews", Message: fmt.Sprintf("previews of %q: %v", a.Name, err)})
		}
	}
	return out
}

func (c *Config) validatePreview(parent *App, p *Previews) error {
	switch {
	case len(parent.Name) > maxPreviewParentName:
		return fmt.Errorf("the app name is too long for instance names: at most %d characters", maxPreviewParentName)
	case len(parent.HostPorts) > 0:
		return errors.New("the parent app uses port.host: instances need a container with its own network (port)")
	case parent.ContainerPort == 0:
		return errors.New("the parent app is not proxied: it needs port (and a proxy) so instances can be routed")
	case c.Proxy != nil && c.Proxy.Type == ProxyNginx:
		return errors.New("previews need proxy type caddy: with nginx the hosts live in your own server blocks")
	}

	p.Domain = strings.ToLower(strings.TrimSpace(p.Domain))
	if err := validatePreviewDomain(p.Domain); err != nil {
		return err
	}

	switch {
	case p.TTL == nil:
		p.TTL = D(DefaultPreviewTTL)
	case p.TTL.Std() < MinPreviewTTL:
		return fmt.Errorf("ttl must be at least %s: expired instances are removed once a minute", FormatDuration(MinPreviewTTL))
	}
	switch {
	case p.Max == nil:
		n := DefaultPreviewMax
		p.Max = &n
	case *p.Max < 1 || *p.Max > MaxPreviewMax:
		return fmt.Errorf("max must be between 1 and %d", MaxPreviewMax)
	}

	// The parent's own names, domains and the other apps must not collide with what instances take.
	re := p.domainRegexp()
	for _, a := range c.Apps {
		if base, _, ok := ParsePreviewName(a.Name); ok && base == parent.Name {
			return fmt.Errorf("the app %q has the name of an instance (%s-pr-<n>)", a.Name, parent.Name)
		}
		for _, d := range a.Domains {
			if re.MatchString(d) {
				return fmt.Errorf("domain %q can be the pattern's host for an instance but belongs to the app %q", d, a.Name)
			}
		}
	}
	return nil
}

// validatePreviewDomain checks a lowercase domain pattern by rendering it with the longest number it can get.
func validatePreviewDomain(domain string) error {
	if !strings.Contains(domain, previewPlaceholder) {
		return fmt.Errorf("domain %q must contain %s, which stands for the pull request number", domain, previewPlaceholder)
	}
	first, rest, _ := strings.Cut(domain, ".")
	if !strings.Contains(first, previewPlaceholder) || strings.Contains(rest, previewPlaceholder) {
		return fmt.Errorf("domain %q must carry %s in its first label only: a wildcard certificate covers one level", domain, previewPlaceholder)
	}
	rendered := strings.ReplaceAll(domain, previewPlaceholder, strconv.Itoa(MaxPreviewNumber))
	label, _, _ := strings.Cut(rendered, ".")
	if len(rendered) > 253 || len(label) > 63 || !domainPattern.MatchString(rendered) {
		return fmt.Errorf("domain %q is not a valid hostname once %s is replaced by a number", domain, previewPlaceholder)
	}
	return nil
}
