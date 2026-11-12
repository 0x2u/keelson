package build

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"os"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/0x2u/keelson/agent/internal/config"
	"github.com/0x2u/keelson/agent/internal/docker"
)

// These tests drive a real Docker engine, so the build request itself (parameters, streamed context, output
// parsing, resource caps) is exercised and not only our side of it. They only run when KEELSON_DOCKER_TEST is set, like the
// other real-engine tests, and skip when no engine answers.

func realEngine(t *testing.T) *docker.Admin {
	t.Helper()
	if os.Getenv("KEELSON_DOCKER_TEST") == "" {
		t.Skip("set KEELSON_DOCKER_TEST=1 to run against a real Docker engine")
	}
	sock := "/var/run/docker.sock"
	if h := os.Getenv("DOCKER_HOST"); strings.HasPrefix(h, "unix://") {
		sock = strings.TrimPrefix(h, "unix://")
	}
	if _, err := os.Stat(sock); err != nil {
		t.Skipf("no Docker engine socket at %s", sock)
	}
	a := docker.NewAdmin(sock)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := a.Ping(ctx); err != nil {
		t.Skipf("the Docker engine does not answer: %v", err)
	}
	return a
}

func uniqueRepo(t *testing.T, eng *docker.Admin) string {
	t.Helper()
	b := make([]byte, 6)
	rand.Read(b)
	repo := "keelson-build-test/" + hex.EncodeToString(b)
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		imgs, _ := eng.ListImages(ctx, repo)
		for _, img := range imgs {
			for _, ref := range img.RepoTags {
				_ = eng.RemoveImage(ctx, ref)
			}
		}
	})
	return repo
}

func TestRealDockerBuildOfATinyArchive(t *testing.T) {
	eng := realEngine(t)
	repo := uniqueRepo(t, eng)
	src := archive(t,
		dir("o-r-abc/"),
		dir("o-r-abc/app/"),
		file("o-r-abc/app/Dockerfile", "FROM scratch\nARG GREETING=none\nLABEL greeting=$GREETING\nCOPY hello.txt /hello.txt\n"),
		file("o-r-abc/app/hello.txt", "hello from keelson\n"),
		file("o-r-abc/README.md", "outside the context"),
	)
	s := newSite(t, serveArchive(src))
	cfg := testConfig()
	cfg.Platform = "" // the engine's own: the fixture's linux/amd64 cannot be built by an arm64 engine without emulation
	cfg.Context = "app"
	cfg.Target = ""
	cfg.Args = map[string]string{"GREETING": "hi"}
	cfg.Memory = config.S(256 << 20)
	cfg.CPUs = fl(1)
	cfg.Timeout = config.D(time.Minute)

	var rec recorder
	req := Request{Image: repo, SHA: testSHA, Config: cfg, Source: Source{URL: "https://api.github.com/repos/o/r/tarball/" + testSHA, Token: testToken}}
	ref, err := newBuilder(eng, s).Build(context.Background(), req, rec.emit)
	if err != nil {
		t.Fatalf("%v\n%s", err, rec.all())
	}
	if ref != repo+":"+testSHA {
		t.Fatalf("ref %q", ref)
	}
	out := rec.all()
	for _, want := range []string{"downloading source from api.github.com", "building " + ref, "Step 1/", "COPY hello.txt /hello.txt", "built " + ref} {
		if !strings.Contains(out, want) {
			t.Errorf("missing %q in\n%s", want, out)
		}
	}
	if strings.Contains(out, testToken) {
		t.Error("the token is in the output")
	}

	ctx := context.Background()
	imgs, err := eng.ListImages(ctx, repo)
	if err != nil || len(imgs) != 1 || len(imgs[0].RepoTags) != 1 || imgs[0].RepoTags[0] != ref {
		t.Fatalf("the image must be tagged %s: %+v %v", ref, imgs, err)
	}
	// The build argument reached the Dockerfile, the commit is on the image.
	var detail struct {
		Config struct{ Labels map[string]string }
	}
	if err := getImageJSON(ctx, eng, ref, &detail); err != nil {
		t.Fatal(err)
	}
	if detail.Config.Labels["greeting"] != "hi" || detail.Config.Labels["org.opencontainers.image.revision"] != testSHA {
		t.Errorf("labels: %v", detail.Config.Labels)
	}
}

func TestRealDockerBuildFailureTagsNothing(t *testing.T) {
	eng := realEngine(t)
	repo := uniqueRepo(t, eng)
	s := newSite(t, serveArchive(archive(t, file("o-r-abc/Dockerfile", "FROM scratch\nCOPY missing.txt /x\n"))))
	var rec recorder
	req := Request{Image: repo, SHA: testSHA, Config: testConfig(), Source: Source{URL: "https://api.github.com/x", Token: testToken}}
	req.Config.Target = ""
	_, err := newBuilder(eng, s).Build(context.Background(), req, rec.emit)
	if err == nil || !strings.Contains(err.Error(), "build failed: COPY failed") {
		t.Fatalf("got %v\n%s", err, rec.all())
	}
	if imgs, _ := eng.ListImages(context.Background(), repo); len(imgs) != 0 {
		t.Errorf("a failed build must tag nothing: %+v", imgs)
	}
	if strings.Contains(err.Error()+rec.all(), testToken) {
		t.Error("token leaked")
	}
}

func TestRealDockerRefusedArchiveNeverStartsABuild(t *testing.T) {
	eng := realEngine(t)
	repo := uniqueRepo(t, eng)
	s := newSite(t, serveArchive(archive(t, file("o-r-abc/Dockerfile", "FROM scratch\n"), sym("o-r-abc/escape", "/etc"))))
	req := Request{Image: repo, SHA: testSHA, Config: testConfig(), Source: Source{URL: "https://api.github.com/x"}}
	req.Config.Target = ""
	_, err := newBuilder(eng, s).Build(context.Background(), req, (&recorder{}).emit)
	if !errors.Is(err, ErrArchive) {
		t.Fatalf("got %v", err)
	}
	if imgs, _ := eng.ListImages(context.Background(), repo); len(imgs) != 0 {
		t.Errorf("%+v", imgs)
	}
}

// A timeout abandons the build and the engine removes the containers of its steps. This needs a local image with a
// shell: it uses one the engine already has and skips otherwise (it never pulls).
func TestRealDockerTimeoutKillsTheBuildAndLeavesNoContainer(t *testing.T) {
	eng := realEngine(t)
	ctx := context.Background()
	base := ""
	for _, candidate := range []string{"alpine", "busybox", "nginx:alpine", "caddy:2-alpine", "postgres:16-alpine"} {
		repo, _, _ := strings.Cut(candidate, ":")
		imgs, _ := eng.ListImages(ctx, repo)
		for _, img := range imgs {
			for _, tag := range img.RepoTags {
				if tag == candidate || (candidate == repo && strings.HasPrefix(tag, repo+":")) {
					base = tag
				}
			}
		}
		if base != "" {
			break
		}
	}
	if base == "" {
		t.Skip("no local image with a shell to run a step in")
	}
	before := containerIDs(t, eng)
	repo := uniqueRepo(t, eng)
	s := newSite(t, serveArchive(archive(t, file("o-r-abc/Dockerfile", "FROM "+base+"\nRUN sleep 120\n"))))
	cfg := testConfig()
	cfg.Target = ""
	cfg.Timeout = config.D(3 * time.Second)
	start := time.Now()
	_, err := newBuilder(eng, s).Build(ctx, Request{Image: repo, SHA: testSHA, Config: cfg, Source: Source{URL: "https://api.github.com/x"}}, (&recorder{}).emit)
	if err == nil || !strings.Contains(err.Error(), "timed out after 3s") {
		t.Fatalf("got %v", err)
	}
	if time.Since(start) > 20*time.Second {
		t.Error("the timeout did not stop the build")
	}
	deadline := time.Now().Add(15 * time.Second)
	for {
		left := newIDs(before, containerIDs(t, eng))
		if len(left) == 0 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("containers left behind by the build: %v", left)
		}
		time.Sleep(250 * time.Millisecond)
	}
	if imgs, _ := eng.ListImages(ctx, repo); len(imgs) != 0 {
		t.Errorf("a timed out build must tag nothing: %+v", imgs)
	}
}

func containerIDs(t *testing.T, eng *docker.Admin) map[string]bool {
	t.Helper()
	list, err := eng.ListContainers(context.Background(), true)
	if err != nil {
		t.Fatal(err)
	}
	out := map[string]bool{}
	for _, c := range list {
		out[c.ID] = true
	}
	return out
}

func newIDs(before, after map[string]bool) []string {
	var out []string
	for id := range after {
		if !before[id] {
			out = append(out, id)
		}
	}
	return out
}

// getImageJSON reads /images/<ref>/json straight from the engine's socket: the docker package does not expose it.
func getImageJSON(ctx context.Context, _ *docker.Admin, ref string, out any) error {
	sock := "/var/run/docker.sock"
	if h := os.Getenv("DOCKER_HOST"); strings.HasPrefix(h, "unix://") {
		sock = strings.TrimPrefix(h, "unix://")
	}
	hc := &http.Client{Transport: &http.Transport{DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
		var d net.Dialer
		return d.DialContext(ctx, "unix", sock)
	}}}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, "http://docker/images/"+ref+"/json", nil)
	if err != nil {
		return err
	}
	resp, err := hc.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	return json.NewDecoder(resp.Body).Decode(out)
}

// The static preset builds on a real engine with nginx:alpine alone: no Node.js stage, no network. It skips when the
// image is not already on the host, so no test pulls anything.
func TestRealDockerBuildOfTheStaticPreset(t *testing.T) {
	eng := realEngine(t)
	ctx := context.Background()
	if _, err := eng.ImageRepoDigests(ctx, "nginx:alpine"); err != nil {
		t.Skipf("nginx:alpine is not on this host: %v", err)
	}
	repo := uniqueRepo(t, eng)
	s := newSite(t, serveArchive(archive(t, dir("o-r-abc/"), dir("o-r-abc/public/"), file("o-r-abc/public/index.html", "<h1>hi</h1>"))))
	req := presetRequest(t, "      preset: static\n      output_dir: public\n")
	req.Image, req.HealthPath = repo, "/"
	req.Config.Timeout = config.D(3 * time.Minute) // presetRequest's 5 s is for fakes; a real engine may refresh the base image
	req.Config.Args = nil
	var rec recorder
	ref, err := newBuilder(eng, s).Build(ctx, req, rec.emit)
	if err != nil {
		t.Fatalf("%v\n%s", err, rec.all())
	}
	var detail struct {
		Config struct {
			User        string
			Env         []string
			StopSignal  string
			Healthcheck struct{ Test []string }
		}
	}
	if err := getImageJSON(ctx, eng, ref, &detail); err != nil {
		t.Fatal(err)
	}
	c := detail.Config
	if c.User != "nginx" || c.StopSignal != "SIGQUIT" || len(c.Healthcheck.Test) < 2 || !strings.Contains(strings.Join(c.Healthcheck.Test, " "), "wget") || !slices.Contains(c.Env, "PORT=3000") {
		t.Errorf("the image config: %+v", c)
	}
}
