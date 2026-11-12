package docker

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// fakeDocker is a `docker` command that records how it was called and prints what a build would.
func fakeDocker(t *testing.T, script string) (bin, record string) {
	t.Helper()
	dir := t.TempDir()
	record = filepath.Join(dir, "record")
	bin = filepath.Join(dir, "docker")
	body := "#!/bin/sh\n{ echo \"ARGS: $*\"; echo \"HOST: $DOCKER_HOST\"; echo \"SECRET: $DATABASE_URL\"; echo \"STDIN: $(cat | wc -c | tr -d ' ')\"; } > " + record + "\n" + script
	if err := os.WriteFile(bin, []byte(body), 0o755); err != nil {
		t.Fatal(err)
	}
	return bin, record
}

func TestCLIBuildRunsDockerBuildWithTheContextOnStdinAndSecretsInTheEnvironment(t *testing.T) {
	bin, record := fakeDocker(t, "echo '#1 [internal] load build definition'\necho 'built' 1>&2\n")
	var lines []string
	err := (&CLI{Bin: bin, Socket: "/run/test.sock"}).Build(context.Background(), BuildOptions{
		Tag: "keelson-local/web:abc", Dockerfile: "Dockerfile.keelson", Platform: "linux/amd64", Network: "host",
		Args:   map[string]string{"DATABASE_URL": "postgres://u:pw@db/x", "NEXT_PUBLIC_URL": "https://x"},
		Labels: map[string]string{"org.opencontainers.image.revision": "abc"},
	}, strings.NewReader("TARCONTENT"), func(l string) { lines = append(lines, l) })
	if err != nil {
		t.Fatal(err)
	}
	got, _ := os.ReadFile(record)
	text := string(got)
	for _, want := range []string{"--platform linux/amd64", "--file Dockerfile.keelson", "--tag keelson-local/web:abc", "--network host", "--build-arg DATABASE_URL --build-arg NEXT_PUBLIC_URL", "--label org.opencontainers.image.revision=abc", "HOST: unix:///run/test.sock", "STDIN: 10"} {
		if !strings.Contains(text, want) {
			t.Errorf("missing %q in:\n%s", want, text)
		}
	}
	if !strings.Contains(text, "SECRET: postgres://u:pw@db/x") {
		t.Errorf("the argument's value must reach the command through its environment:\n%s", text)
	}
	if strings.Contains(strings.SplitN(text, "HOST:", 2)[0], "pw") {
		t.Errorf("a secret must never be on the command line:\n%s", text)
	}
	if strings.Join(lines, "|") != "#1 [internal] load build definition|built" {
		t.Errorf("output lines (stdout and stderr, in order): %q", lines)
	}
}

func TestCLIBuildReportsBuildKitsErrorLineAsTheBuildError(t *testing.T) {
	bin, _ := fakeDocker(t, "echo 'ERROR: failed to solve: process \"npm ci\" did not complete successfully' 1>&2\nexit 1\n")
	err := (&CLI{Bin: bin}).Build(context.Background(), BuildOptions{Tag: "keelson-local/web:abc"}, strings.NewReader("x"), nil)
	var be *BuildError
	if !errors.As(err, &be) || !strings.Contains(be.Message, "npm ci") {
		t.Errorf("a failed build is a BuildError carrying the line that says why: %v", err)
	}
	bin, _ = fakeDocker(t, "exit 3\n")
	err = (&CLI{Bin: bin}).Build(context.Background(), BuildOptions{Tag: "keelson-local/web:abc"}, strings.NewReader("x"), nil)
	if !errors.As(err, &be) || !strings.Contains(be.Message, "status 3") {
		t.Errorf("without an error line the exit status is what is reported: %v", err)
	}
}

func TestCLIBuildRefusesWhatCannotTravelInTheEnvironmentOrTheCommandLine(t *testing.T) {
	bin, record := fakeDocker(t, "")
	c := &CLI{Bin: bin}
	for name, opt := range map[string]BuildOptions{
		"an argument that is PATH":       {Tag: "a/b:c", Args: map[string]string{"PATH": "/tmp"}},
		"an argument that points docker": {Tag: "a/b:c", Args: map[string]string{"DOCKER_HOST": "tcp://evil:2375"}},
		"an argument that preloads":      {Tag: "a/b:c", Args: map[string]string{"LD_PRELOAD": "/x.so"}},
		"an argument that is not a name": {Tag: "a/b:c", Args: map[string]string{"A B": "x"}},
		"another build network":          {Tag: "a/b:c", Network: "container:victim"},
		"a tag that is not an image":     {Tag: "not a tag"},
	} {
		if err := c.Build(context.Background(), opt, strings.NewReader("x"), nil); err == nil {
			t.Errorf("%s must be refused", name)
		}
	}
	if _, err := os.Stat(record); err == nil {
		t.Error("nothing may have run for a refused build")
	}
}

func TestCLIBuildSaysWhenDockerIsNotThere(t *testing.T) {
	err := (&CLI{Bin: "no-such-docker-command"}).Build(context.Background(), BuildOptions{Tag: "a/b:c", Platform: "linux/amd64"}, strings.NewReader("x"), nil)
	if err == nil || !strings.Contains(err.Error(), "linux/amd64") || !strings.Contains(err.Error(), "not in PATH") {
		t.Errorf("the operator must learn what is missing: %v", err)
	}
}
