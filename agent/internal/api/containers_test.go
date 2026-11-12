package api

import (
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/0x2u/keelson/agent/internal/deploy"
	"github.com/0x2u/keelson/agent/internal/docker"
)

func TestSignedStartAndRestartAnswer204AndAreAudited(t *testing.T) {
	e := newBuildEnv(t)
	for _, act := range []string{"start", "restart"} {
		resp, body := e.signed(t, "POST", "/v1/containers/web-1/"+act, "", "dashboard")
		if resp.StatusCode != http.StatusNoContent || body != "" {
			t.Fatalf("%s: %d %q", act, resp.StatusCode, body)
		}
	}
	if got := strings.Join(e.deploys.containerActs, ","); got != "start web-1,restart web-1" {
		t.Errorf("acts: %s", got)
	}
	log, _ := e.st.Audit(t.Context(), 10, 0)
	if len(log) != 2 || log[0].Action != "container.restart" || log[1].Action != "container.start" ||
		log[0].Detail != "web-1" || log[0].Status != 204 || log[0].Actor != "dashboard" || log[0].Path != "/v1/containers/web-1/restart" {
		t.Errorf("audit: %+v", log)
	}
}

func TestContainerActionFailuresHaveTheirOwnStatus(t *testing.T) {
	e := newBuildEnv(t)
	e.deploys.containerErrs = map[string]error{
		"ghost":     &docker.Error{Status: 404, Message: "no such container"},
		"portainer": deploy.ErrNotManaged,
		"busy":      deploy.ErrBusy,
		"bad":       docker.ErrInvalidID,
		"broken":    &docker.Error{Status: 500, Message: "secret engine detail"},
	}
	for name, want := range map[string]int{"ghost": 404, "portainer": 409, "busy": 409, "bad": 400, "broken": 502} {
		for _, act := range []string{"start", "restart"} {
			resp, body := e.signed(t, "POST", "/v1/containers/"+name+"/"+act, "", "")
			if resp.StatusCode != want {
				t.Errorf("%s %s: %d, want %d (%s)", act, name, resp.StatusCode, want, body)
			}
			if strings.Contains(body, "secret engine detail") {
				t.Errorf("engine details leak: %s", body)
			}
		}
	}
	log, _ := e.st.Audit(t.Context(), 20, 0)
	if len(log) != 10 || log[0].Status == 204 {
		t.Errorf("a refused request is audited with its status too: %d %+v", len(log), log[0])
	}
}

func TestStartAndRestartNeedASignatureNotTheReadToken(t *testing.T) {
	e := newDeployServer(t)
	for _, act := range []string{"start", "restart"} {
		path := "/v1/containers/web/" + act
		req, _ := http.NewRequest("POST", e.srv.URL+path, nil)
		req.Header.Set("Authorization", "Bearer "+testToken)
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		if resp.StatusCode != http.StatusUnauthorized {
			t.Errorf("%s with the read token only: %d", act, resp.StatusCode)
		}
		if resp := e.post(t, path, "", "not-the-secret-not-the-secret-0000", time.Now()); resp.StatusCode != http.StatusUnauthorized {
			t.Errorf("%s with a wrong signature: %d", act, resp.StatusCode)
		}
	}
	if len(e.fake.containerActs) != 0 {
		t.Errorf("nothing may reach the engine: %v", e.fake.containerActs)
	}
}
