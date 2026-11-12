package docker

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"testing"
)

func TestCreateSendsLogRotationOnlyWhenAsked(t *testing.T) {
	var bodies []map[string]any
	f := &fakeEngine{handler: func(w http.ResponseWriter, r *http.Request) {
		var b map[string]any
		_ = json.NewDecoder(r.Body).Decode(&b)
		bodies = append(bodies, b)
		w.WriteHeader(201)
		io.WriteString(w, `{"Id":"cid"}`)
	}}
	a := newAdmin(t, f)
	if _, err := a.Create(context.Background(), ContainerSpec{Name: "plain", Image: "o/web:v1"}); err != nil {
		t.Fatal(err)
	}
	if _, err := a.Create(context.Background(), ContainerSpec{Name: "rotated", Image: "o/web:v1", LogDriver: "json-file", LogMaxSize: "10m", LogMaxFile: 3}); err != nil {
		t.Fatal(err)
	}
	if _, ok := bodies[0]["HostConfig"].(map[string]any)["LogConfig"]; ok {
		t.Error("no log option asked: the engine default must stay")
	}
	lc := bodies[1]["HostConfig"].(map[string]any)["LogConfig"].(map[string]any)
	cfg := lc["Config"].(map[string]any)
	if lc["Type"] != "json-file" || cfg["max-size"] != "10m" || cfg["max-file"] != "3" {
		t.Errorf("unexpected log config: %v", lc)
	}
}

func TestCreateRunsAsAUserOnlyWhenAsked(t *testing.T) {
	var bodies []map[string]any
	f := &fakeEngine{handler: func(w http.ResponseWriter, r *http.Request) {
		var b map[string]any
		_ = json.NewDecoder(r.Body).Decode(&b)
		bodies = append(bodies, b)
		w.WriteHeader(201)
		io.WriteString(w, `{"Id":"cid"}`)
	}}
	a := newAdmin(t, f)
	if _, err := a.Create(context.Background(), ContainerSpec{Name: "plain", Image: "o/web:v1"}); err != nil {
		t.Fatal(err)
	}
	if _, err := a.Create(context.Background(), ContainerSpec{Name: "owned", Image: "o/web:v1", User: "1001:1002"}); err != nil {
		t.Fatal(err)
	}
	if _, ok := bodies[0]["User"]; ok {
		t.Error("no user asked: the image's user must stay")
	}
	if bodies[1]["User"] != "1001:1002" {
		t.Errorf("unexpected user: %v", bodies[1]["User"])
	}
}

func TestListImagesFiltersByRepository(t *testing.T) {
	f := &fakeEngine{handler: func(w http.ResponseWriter, r *http.Request) {
		io.WriteString(w, `[{"Id":"sha256:a","RepoTags":["o/web:v1"],"RepoDigests":["o/web@sha256:d"],"Created":5}]`)
	}}
	imgs, err := newClient(t, f).ListImages(context.Background(), "o/web")
	if err != nil || len(imgs) != 1 || imgs[0].RepoTags[0] != "o/web:v1" || imgs[0].RepoDigests[0] != "o/web@sha256:d" {
		t.Fatalf("got %+v, %v", imgs, err)
	}
	q := f.requests()[0]
	u, _ := url.Parse("http://x" + q[len("GET "):])
	if u.Path != "/images/json" || u.Query().Get("filters") != `{"reference":["o/web"]}` {
		t.Errorf("unexpected request %q", q)
	}
}

func TestListDanglingImagesAsksForTheDanglingFilter(t *testing.T) {
	f := &fakeEngine{handler: func(w http.ResponseWriter, r *http.Request) {
		io.WriteString(w, `[{"Id":"sha256:stage","RepoTags":null,"RepoDigests":null,"Created":5}]`)
	}}
	imgs, err := newClient(t, f).ListDanglingImages(context.Background())
	if err != nil || len(imgs) != 1 || imgs[0].ID != "sha256:stage" || len(imgs[0].RepoTags) != 0 {
		t.Fatalf("got %+v, %v", imgs, err)
	}
	u, _ := url.Parse("http://x" + f.requests()[0][len("GET "):])
	if u.Path != "/images/json" || u.Query().Get("filters") != `{"dangling":["true"]}` {
		t.Errorf("unexpected request %q", f.requests()[0])
	}
}

func TestRemoveImageNeverForcesAndTellsInUseFromFailure(t *testing.T) {
	status := 200
	f := &fakeEngine{handler: func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(status)
		io.WriteString(w, `{"message":"conflict: unable to delete, image is being used by running container"}`)
	}}
	a := newAdmin(t, f)
	ctx := context.Background()

	if err := a.RemoveImage(ctx, "ghcr.io/o/web:v1"); err != nil {
		t.Fatal(err)
	}
	if got := f.requests()[0]; got != "DELETE /images/ghcr.io/o/web:v1?force=0" {
		t.Errorf("unexpected request %q", got)
	}
	status = 409
	if err := a.RemoveImage(ctx, "o/web@sha256:abc"); !errors.Is(err, ErrImageInUse) {
		t.Errorf("a 409 means in use, got %v", err)
	}
	status = 404
	if err := a.RemoveImage(ctx, "o/web:gone"); err != nil {
		t.Errorf("an image already gone is not an error: %v", err)
	}
	status = 500
	if err := a.RemoveImage(ctx, "o/web:v2"); err == nil || errors.Is(err, ErrImageInUse) {
		t.Errorf("an engine failure must surface, got %v", err)
	}
	n := len(f.requests())
	for _, bad := range []string{"", "o/web:v1?force=1", "o/web v1", "-rf", "../x"} {
		if err := a.RemoveImage(ctx, bad); !errors.Is(err, ErrInvalidImageRef) {
			t.Errorf("%q must be refused, got %v", bad, err)
		}
	}
	if len(f.requests()) != n {
		t.Error("an invalid reference must not reach the engine")
	}
}

func TestImageRepoDigestsReadsTheDigestsAnImageIsKnownBy(t *testing.T) {
	f := &fakeEngine{handler: func(w http.ResponseWriter, r *http.Request) {
		io.WriteString(w, `{"Id":"sha256:abc","RepoDigests":["o/web@sha256:d1","mirror/web@sha256:d1"]}`)
	}}
	c := newClient(t, f)
	got, err := c.ImageRepoDigests(context.Background(), "sha256:abc")
	if err != nil || len(got) != 2 || got[0] != "o/web@sha256:d1" {
		t.Fatalf("got %v, %v", got, err)
	}
	if req := f.requests()[0]; req != "GET /images/sha256:abc/json" {
		t.Errorf("request %q", req)
	}
	if _, err := c.ImageRepoDigests(context.Background(), "../etc"); err == nil {
		t.Error("an id that is not an image reference must be refused before any request")
	}
}
