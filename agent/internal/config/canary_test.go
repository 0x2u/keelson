package config

import (
	"strings"
	"testing"
	"time"
)

const canaryApp = `proxy: {}
apps:
  - name: web
    image: o/web
    port: 3000
    domains: [web.example.com]
`

func TestACanaryLoadsWithItsDefaultHold(t *testing.T) {
	c, err := Load(write(t, canaryApp+"    canary: {steps: [10, 50]}\n"))
	if err != nil {
		t.Fatal(err)
	}
	a, _ := c.App("web")
	if got := a.Canary.HoldFor(); got != time.Minute {
		t.Errorf("default hold %s", got)
	}
	if got := a.CanaryTime(); got != 2*time.Minute {
		t.Errorf("two steps of a minute take %s", got)
	}
	if (App{}).CanaryTime() != 0 {
		t.Error("an app without a canary has no canary time")
	}
}

func TestACanaryRejectsWhatCouldNeverWork(t *testing.T) {
	for name, tc := range map[string]struct{ yaml, want string }{
		"no steps":            {canaryApp + "    canary: {steps: []}\n", "between 1 and 5"},
		"too many steps":      {canaryApp + "    canary: {steps: [5, 10, 20, 30, 40, 50]}\n", "between 1 and 5"},
		"zero percent":        {canaryApp + "    canary: {steps: [0, 50]}\n", "a percentage from 1 to 99"},
		"a hundred percent":   {canaryApp + "    canary: {steps: [50, 100]}\n", "100 is the end of the rollout"},
		"steps that fall":     {canaryApp + "    canary: {steps: [50, 10]}\n", "must rise"},
		"steps that repeat":   {canaryApp + "    canary: {steps: [10, 10]}\n", "must rise"},
		"hold too short":      {canaryApp + "    canary: {steps: [10], hold: 2s}\n", "canary.hold must be between 10s and 10m"},
		"hold too long":       {canaryApp + "    canary: {steps: [10], hold: 1h}\n", "canary.hold must be between 10s and 10m"},
		"nginx":               {"proxy: {type: nginx, upstreams_file: /etc/nginx/u.conf, reload: [nginx, -s, reload]}\napps:\n  - {name: web, image: o/web, port: 3000, canary: {steps: [10]}}\n", "needs proxy type caddy"},
		"an app without port": {"apps:\n  - name: web\n    image: o/web\n    canary: {steps: [10]}\n", "only used with deploy.strategy switch"},
	} {
		t.Run(name, func(t *testing.T) {
			_, err := Load(write(t, tc.yaml))
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("want an error with %q, got %v", tc.want, err)
			}
		})
	}
}

func TestAnAnalysisCanJudgeACanaryWithoutASoak(t *testing.T) {
	const metric = "    analysis:\n      metrics:\n        - {name: m, query: up, max: 1, interval: 10s, failure_limit: 3}\n"
	if _, err := Load(write(t, canaryApp+"    soak: 0s\n    canary: {steps: [10], hold: 30s}\n"+metric)); err != nil {
		t.Fatalf("the metrics are asked at every step: no soak needed: %v", err)
	}
	if _, err := Load(write(t, canaryApp+"    soak: 0s\n"+metric)); err == nil || !strings.Contains(err.Error(), "needs soak above 0s, or a canary") {
		t.Fatalf("without a soak or a canary nothing would ask the metrics: %v", err)
	}
}

func TestAGateMustBeAbleToTripInEveryStepOfACanary(t *testing.T) {
	// A long soak is no excuse: each step of 20s holds two evaluations every 10s, and the limit is three.
	_, err := Load(write(t, canaryApp+"    soak: 5m\n    canary: {steps: [10], hold: 20s}\n"+
		"    analysis:\n      metrics:\n        - {name: m, query: up, max: 1, interval: 10s, failure_limit: 3}\n"))
	if err == nil || !strings.Contains(err.Error(), "could never trip") || !strings.Contains(err.Error(), "canary.hold") {
		t.Fatalf("a step too short for its gate must be refused, and the message must name the hold: %v", err)
	}
}

func TestAPreviewInstanceIsNotCanaried(t *testing.T) {
	parent := App{Name: "web", Image: "o/web", Canary: &Canary{Steps: []int{10}}}
	if inst := (Previews{Domain: "pr-{pr}.example.com"}).Instance(parent, 7); inst.Canary != nil {
		t.Error("an instance serves a pull request: sharing its visitors would only slow it down")
	}
}
