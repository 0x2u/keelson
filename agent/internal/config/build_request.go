package config

import (
	"fmt"
	"slices"
	"strings"
)

// BuildRequestError is a build request this server refuses: a field that is not valid, or one that asks for more than
// the server's build_limits allow. The message names the field or the limit and holds nothing of the request's source.
type BuildRequestError struct{ Msg string }

func (e *BuildRequestError) Error() string { return e.Msg }

func refuseBuild(format string, args ...any) error {
	return &BuildRequestError{Msg: fmt.Sprintf(format, args...)}
}

// BuildRequestApp is the transient app of a build asked for through POST /v1/builds: it exists for the build and is not in
// the apps file, which need not even hold an app. b is the build block as the request wrote it (it is not changed);
// the returned app has every default filled in.
//
// A request above a limit of lim is refused, never clamped, with an error naming the limit. What the request leaves out
// is not above anything: memory, cpus, timeout and max_source then default to the lower of the usual default and the
// ceiling, and source_hosts to the hosts the server allows. The block cannot be `only` and cannot use the app's managed
// database (`database`): a build request has no app on this server to run or to own a database.
func BuildRequestApp(name, image string, port int, healthPath string, b *Build, lim BuildCeilings) (App, error) {
	switch {
	case !namePattern.MatchString(name):
		return App{}, refuseBuild("app must match %s", namePattern)
	case b == nil:
		return App{}, refuseBuild("build is required")
	case b.Only:
		return App{}, refuseBuild("build.only is not accepted: a build request builds an image and nothing else")
	case b.Database:
		return App{}, refuseBuild("build.database is not accepted: a build request has no managed database on this server")
	case port < 0 || port > 65535:
		return App{}, refuseBuild("port must be a port number between 1 and 65535")
	case healthPath != "" && (!strings.HasPrefix(healthPath, "/") || strings.ContainsAny(healthPath, " \t\r\n")):
		return App{}, refuseBuild("health_path %q must start with / and contain no spaces", healthPath)
	}
	if err := validateRepository(image); err != nil {
		return App{}, refuseBuild("%s", err)
	}
	b = b.Clone()
	if err := lim.fit(b); err != nil {
		return App{}, err
	}
	keep := lim.KeepImages
	a := App{Name: name, Image: image, ContainerPort: port, HealthPath: healthPath, KeepImages: &keep, Build: b}
	if err := validateBuild(&a); err != nil {
		return App{}, refuseBuild("%s", err)
	}
	for _, h := range b.SourceHosts {
		if !slices.Contains(lim.SourceHosts, h) {
			return App{}, refuseBuild("build.source_hosts: %s is not one of the hosts this server's build_limits.source_hosts allows (%s)", h, strings.Join(lim.SourceHosts, ", "))
		}
	}
	if b.Network == BuildNetworkHost && !lim.HostNetwork {
		return App{}, refuseBuild("build.network: host is not allowed by this server's build_limits (host_network is off)")
	}
	return a, nil
}

// fit refuses the numbers the request set above the ceilings, and gives what it left out the lower of the default and
// the ceiling, so that an omitted value is never what makes a request too big.
func (l BuildCeilings) fit(b *Build) error {
	switch {
	case b.Memory != nil && l.Memory > 0 && b.Memory.Bytes() > l.Memory:
		return refuseBuild("build.memory %s is above this server's build_limits.memory (%s)", b.Memory, S(l.Memory))
	case b.CPUs != nil && *b.CPUs > l.CPUs:
		return refuseBuild("build.cpus %g is above this server's build_limits.cpus (%g)", *b.CPUs, l.CPUs)
	case b.Timeout != nil && b.Timeout.Std() > l.Timeout:
		return refuseBuild("build.timeout %s is above this server's build_limits.timeout (%s)", b.Timeout, D(l.Timeout))
	case b.MaxSource != nil && b.MaxSource.Bytes() > l.MaxSource:
		return refuseBuild("build.max_source %s is above this server's build_limits.max_source (%s)", b.MaxSource, S(l.MaxSource))
	}
	if b.Memory == nil && l.Memory > 0 && l.Memory < DefaultBuildMemory {
		b.Memory = S(l.Memory)
	}
	if b.CPUs == nil && l.CPUs < DefaultBuildCPUs {
		v := l.CPUs
		b.CPUs = &v
	}
	if b.Timeout == nil && l.Timeout < DefaultBuildTimeout {
		b.Timeout = D(l.Timeout)
	}
	if b.MaxSource == nil && l.MaxSource < DefaultBuildMaxSource {
		b.MaxSource = S(l.MaxSource)
	}
	if len(b.SourceHosts) == 0 {
		b.SourceHosts = slices.Clone(l.SourceHosts)
	}
	return nil
}
