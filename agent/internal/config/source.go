package config

import (
	"fmt"
	"regexp"
	"slices"
	"strings"
)

// Deploy strategies.
const (
	// StrategySwitch runs the new container next to the old one and switches the traffic once it is healthy (blue/green).
	StrategySwitch = "switch"
	// StrategyReplace stops the old container and starts the new one in its place.
	StrategyReplace = "replace"
)

// Deploy is how the app is deployed. Without it the strategy follows the routing: an app with domains or a port is
// switched, any other is replaced.
type Deploy struct {
	// Strategy is "switch" (blue/green; needs a port or domains) or "replace" (in place; no domains, no port).
	Strategy string `yaml:"strategy"`
}

// Strategy is how the app is deployed: its declared strategy, else switch when it is proxied, else replace.
func (a App) Strategy() string {
	if a.Deploy != nil && a.Deploy.Strategy != "" {
		return a.Deploy.Strategy
	}
	if a.inferredProxied() {
		return StrategySwitch
	}
	return StrategyReplace
}

// Source links an app to the repository it is built from. The agent checks the shape and never acts on it: the dashboard
// reads it (to deploy when a workflow succeeds, to build a pull request) and writes it. Saving it creates a
// configuration version and needs no redeploy.
type Source struct {
	// Repo is "owner/name". Its case is kept and matching is case-insensitive.
	Repo string `yaml:"repo"`
	// Branch is the git branch the app follows.
	Branch string `yaml:"branch"`
	// DeployOn is "workflow" (deploy when the workflow named below succeeds) or absent (manual deploys only).
	DeployOn string `yaml:"deploy_on"`
	// Workflow names the CI workflow whose success deploys the app. Required with deploy_on.
	Workflow string `yaml:"workflow"`
	// PreviewsWorkflow names the workflow whose success on a pull request builds its preview. Absent: off.
	PreviewsWorkflow string `yaml:"previews_workflow"`
	// BuildOn lists the events that build the app: push and pull_request. Absent: nothing builds by itself.
	BuildOn []string `yaml:"build_on"`
	// BuildServer is the name of the server (as the dashboard knows it) that builds the image. Absent: the app builds
	// where it runs.
	BuildServer string `yaml:"build_server"`
}

// Source events and triggers.
const (
	SourceDeployOnWorkflow = "workflow"
	SourceEventPush        = "push"
	SourceEventPull        = "pull_request"
)

var (
	repoSlug  = regexp.MustCompile(`^[A-Za-z0-9_.-]{1,100}/[A-Za-z0-9_.-]{1,100}$`)
	gitRefBad = regexp.MustCompile(`[\x00-\x20\x7f~^:?*\[\\]|\.\.|@\{|//|\.lock(/|$)`)
)

func validateSource(s *Source) error {
	if !repoSlug.MatchString(s.Repo) {
		return fmt.Errorf("source: repo must be owner/name, such as acme/shop")
	}
	if s.Branch != "" {
		b := s.Branch
		if gitRefBad.MatchString(b) || strings.HasPrefix(b, "/") || strings.HasSuffix(b, "/") || strings.HasSuffix(b, ".") || strings.HasPrefix(b, "-") || b == "@" || len(b) > 255 {
			return fmt.Errorf("source: branch %q is not a git branch name", b)
		}
	}
	switch s.DeployOn {
	case "":
		if s.Workflow != "" {
			return fmt.Errorf("source: workflow needs deploy_on: %s", SourceDeployOnWorkflow)
		}
	case SourceDeployOnWorkflow:
		if s.Workflow == "" {
			return fmt.Errorf("source: deploy_on %s needs workflow, the name of the CI workflow whose success deploys the app", SourceDeployOnWorkflow)
		}
	default:
		return fmt.Errorf("source: deploy_on must be %q or left out", SourceDeployOnWorkflow)
	}
	for _, f := range []struct{ key, value string }{{"workflow", s.Workflow}, {"previews_workflow", s.PreviewsWorkflow}, {"build_server", s.BuildServer}} {
		if len(f.value) > 200 || strings.ContainsAny(f.value, "\x00\r\n") || f.value != strings.TrimSpace(f.value) {
			return fmt.Errorf("source: %s must be a plain name of at most 200 characters", f.key)
		}
	}
	seen := map[string]bool{}
	for _, e := range s.BuildOn {
		if !slices.Contains([]string{SourceEventPush, SourceEventPull}, e) {
			return fmt.Errorf("source: build_on lists %q: only %s and %s", e, SourceEventPush, SourceEventPull)
		}
		if seen[e] {
			return fmt.Errorf("source: build_on lists %q twice", e)
		}
		seen[e] = true
	}
	return nil
}
