package docker

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"
)

func newAdmin(t *testing.T, f *fakeEngine) *Admin { return &Admin{Client: newClient(t, f)} }

func TestPullSendsCredentialsAndReportsMilestones(t *testing.T) {
	var auth string
	f := &fakeEngine{handler: func(w http.ResponseWriter, r *http.Request) {
		auth = r.Header.Get("X-Registry-Auth")
		io.WriteString(w, `{"status":"Pulling from o/web","id":"v1"}`+"\n")
		io.WriteString(w, `{"status":"Downloading","progress":"[=>  ]","id":"layer"}`+"\n")
		io.WriteString(w, `{"status":"Digest: sha256:abc"}`+"\n")
		io.WriteString(w, `{"status":"Status: Downloaded newer image for ghcr.io/o/web:v1"}`+"\n")
	}}
	var got []string
	err := newAdmin(t, f).Pull(context.Background(), "ghcr.io/o/web", "v1", RegistryAuth("ghcr.io", "bot", "pw"), func(s string) { got = append(got, s) })
	if err != nil {
		t.Fatal(err)
	}
	if reqs := f.requests(); len(reqs) != 1 || reqs[0] != "POST /images/create?fromImage=ghcr.io%2Fo%2Fweb&tag=v1" {
		t.Errorf("unexpected request: %v", reqs)
	}
	if !strings.HasPrefix(auth, "eyJ") { // base64 of a JSON object
		t.Errorf("registry auth header not sent: %q", auth)
	}
	if len(got) != 3 || strings.Contains(strings.Join(got, "|"), "Downloading") {
		t.Errorf("layer noise must be filtered out, got %v", got)
	}
}

func TestPullReportsErrorsFromTheStream(t *testing.T) {
	f := &fakeEngine{handler: func(w http.ResponseWriter, r *http.Request) {
		// The engine answers 200 and fails inside the stream.
		io.WriteString(w, `{"status":"Pulling from o/web"}`+"\n")
		io.WriteString(w, `{"error":"manifest unknown","errorDetail":{"message":"manifest unknown"}}`+"\n")
	}}
	err := newAdmin(t, f).Pull(context.Background(), "o/web", "nope", "", nil)
	if err == nil || !strings.Contains(err.Error(), "manifest unknown") {
		t.Fatalf("want the stream error, got %v", err)
	}
}

func TestCreateBuildsEngineRequest(t *testing.T) {
	var body map[string]any
	f := &fakeEngine{handler: func(w http.ResponseWriter, r *http.Request) {
		json.NewDecoder(r.Body).Decode(&body)
		w.WriteHeader(201)
		io.WriteString(w, `{"Id":"cid"}`)
	}}
	id, err := newAdmin(t, f).Create(context.Background(), ContainerSpec{
		Name: "web", Image: "o/web:v1", Env: []string{"A=1"}, Labels: map[string]string{"k": "v"},
		Ports:         []PortBinding{{HostIP: "127.0.0.1", HostPort: "8080", ContainerPort: "80", Proto: "tcp"}},
		Binds:         []string{"/data:/data:ro"},
		NetworkMode:   "host",
		RestartPolicy: "unless-stopped",
		StopTimeout:   7,
	})
	if err != nil || id != "cid" {
		t.Fatalf("got %q, %v", id, err)
	}
	if reqs := f.requests(); reqs[0] != "POST /containers/create?name=web" {
		t.Errorf("unexpected request: %v", reqs)
	}
	host := body["HostConfig"].(map[string]any)
	pb := host["PortBindings"].(map[string]any)["80/tcp"].([]any)[0].(map[string]any)
	switch {
	case body["Image"] != "o/web:v1",
		body["StopTimeout"] != float64(7),
		host["NetworkMode"] != "host",
		host["Binds"].([]any)[0] != "/data:/data:ro",
		host["RestartPolicy"].(map[string]any)["Name"] != "unless-stopped",
		pb["HostIp"] != "127.0.0.1" || pb["HostPort"] != "8080":
		t.Errorf("unexpected body: %v", body)
	}
}

func TestMutationsUseTheRightVerbs(t *testing.T) {
	f := &fakeEngine{handler: func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(204) }}
	a := newAdmin(t, f)
	ctx := context.Background()
	for _, err := range []error{a.Start(ctx, "web"), a.Stop(ctx, "web", 5), a.Rename(ctx, "web", "web.prev"), a.Remove(ctx, "web"), a.RemoveThrowaway(ctx, "web-job")} {
		if err != nil {
			t.Fatal(err)
		}
	}
	want := []string{
		"POST /containers/web/start",
		"POST /containers/web/stop?t=5",
		"POST /containers/web/rename?name=web.prev",
		"DELETE /containers/web?force=1",         // an app's volumes stay
		"DELETE /containers/web-job?force=1&v=1", // a throwaway's anonymous volumes go
	}
	got := f.requests()
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("request %d: want %q, got %q", i, want[i], got[i])
		}
	}
}

func TestNotModifiedCountsAsSuccessButOtherErrorsDoNot(t *testing.T) {
	status := 304
	f := &fakeEngine{handler: func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(status)
		if status != 304 {
			io.WriteString(w, `{"message":"No such container: web"}`)
		}
	}}
	a := newAdmin(t, f)
	if err := a.Stop(context.Background(), "web", 1); err != nil {
		t.Errorf("304 means already stopped: %v", err)
	}
	status = 404
	if err := a.Start(context.Background(), "web"); !IsNotFound(err) {
		t.Errorf("want not found, got %v", err)
	}
}

func TestAdminRejectsInvalidNamesWithoutRequests(t *testing.T) {
	f := &fakeEngine{handler: func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(204) }}
	a := newAdmin(t, f)
	ctx := context.Background()
	bad := "../x"
	_, createErr := a.Create(ctx, ContainerSpec{Name: bad})
	for _, err := range []error{
		a.Start(ctx, bad), a.Stop(ctx, bad, 1), a.Remove(ctx, bad), a.RemoveThrowaway(ctx, bad), a.Rename(ctx, "web", bad), a.Rename(ctx, bad, "web"), createErr,
	} {
		if !errors.Is(err, ErrInvalidID) {
			t.Errorf("want ErrInvalidID, got %v", err)
		}
	}
	if reqs := f.requests(); len(reqs) != 0 {
		t.Errorf("invalid names reached the engine: %v", reqs)
	}
}

func TestWaitReturnsTheExitCode(t *testing.T) {
	f := &fakeEngine{handler: func(w http.ResponseWriter, r *http.Request) {
		io.WriteString(w, `{"StatusCode":3,"Error":null}`)
	}}
	code, err := newAdmin(t, f).Wait(context.Background(), "job")
	if err != nil || code != 3 {
		t.Fatalf("got %d, %v", code, err)
	}
	if reqs := f.requests(); reqs[0] != "POST /containers/job/wait?condition=not-running" {
		t.Errorf("unexpected request: %v", reqs)
	}
}

func TestWaitReportsEngineErrorsAndStopsWithItsContext(t *testing.T) {
	f := &fakeEngine{handler: func(w http.ResponseWriter, r *http.Request) {
		io.WriteString(w, `{"StatusCode":125,"Error":{"Message":"container failed to start"}}`)
	}}
	if _, err := newAdmin(t, f).Wait(context.Background(), "job"); err == nil || !strings.Contains(err.Error(), "failed to start") {
		t.Errorf("want the engine's message, got %v", err)
	}
	if _, err := newAdmin(t, f).Wait(context.Background(), "../x"); !errors.Is(err, ErrInvalidID) {
		t.Errorf("want ErrInvalidID, got %v", err)
	}

	block := &fakeEngine{handler: func(w http.ResponseWriter, r *http.Request) { <-r.Context().Done() }}
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	if _, err := newAdmin(t, block).Wait(ctx, "job"); err == nil {
		t.Error("a cancelled context must end the wait")
	}
}
