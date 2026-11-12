package build

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/0x2u/keelson/agent/internal/config"
)

// A build argument stored through the API reaches the real engine's build, is overridden by the block's own, and the
// value the build prints is scrubbed from what the agent records. It needs a local image with a shell (nginx:alpine; it
// never pulls) and skips otherwise.
func TestRealDockerBuildPassesAndScrubsStoredArgs(t *testing.T) {
	eng := realEngine(t)
	ctx := context.Background()
	if imgs, _ := eng.ListImages(ctx, "nginx"); len(imgs) == 0 {
		t.Skip("no local nginx image to build from (the test never pulls)")
	}
	repo := uniqueRepo(t, eng)
	const secret = "Sup3r-Managed-Valu3-0001"
	src := archive(t,
		dir("o-r-abc/"),
		file("o-r-abc/Dockerfile", "FROM nginx:alpine\nARG STORED_ARG\nARG FILE_ARG\nARG UNUSED_ARG=none\n"+
			"RUN echo \"stored-is=$STORED_ARG\" && echo \"file-is=$FILE_ARG\"\nLABEL stored=$STORED_ARG file=$FILE_ARG\n"),
	)
	s := newSite(t, serveArchive(src))
	cfg := testConfig()
	cfg.Target = ""
	cfg.Args = map[string]string{"FILE_ARG": "from-the-block"}
	cfg.Timeout = config.D(time.Minute)
	req := Request{Image: repo, SHA: testSHA, Config: cfg, Source: Source{URL: "https://api.github.com/x", Token: testToken},
		Args: map[string]string{"STORED_ARG": secret, "FILE_ARG": "from-the-store"}}

	var rec recorder
	ref, err := newBuilder(eng, s).Build(ctx, req, rec.emit)
	if err != nil {
		t.Fatalf("%v\n%s", err, rec.all())
	}
	out := rec.all()
	if strings.Contains(out, secret) {
		t.Errorf("the stored value is in what the agent records:\n%s", out)
	}
	if !strings.Contains(out, "stored-is="+redacted) || !strings.Contains(out, "file-is=from-the-block") {
		t.Errorf("the build printed both values; the stored one must be scrubbed and the block's one kept:\n%s", out)
	}
	var detail struct {
		Config struct{ Labels map[string]string }
	}
	if err := getImageJSON(ctx, eng, ref, &detail); err != nil {
		t.Fatal(err)
	}
	// The engine really received them: the stored value as given, the block's winning over the store's.
	if detail.Config.Labels["stored"] != secret || detail.Config.Labels["file"] != "from-the-block" {
		t.Errorf("labels: %v", detail.Config.Labels)
	}
}
