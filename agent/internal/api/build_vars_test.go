package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestBuildVarsHaveTheContractShapeAndNeverCarryAValue(t *testing.T) {
	e := newEnvEnv(t)
	status, body := e.get(t, "/v1/build-vars/site")
	if status != 200 || strings.TrimSpace(body) != `{"names":[]}` {
		t.Fatalf("%d %s", status, body)
	}
	// An app that is in no apps file is no 404 here: this is what the builder keeps for a name it does not run.
	resp, body := e.signed(t, "PUT", "/v1/build-vars/site", `{"set":{"DATABASE_URL":"`+envSecret+`","B":"x"}}`, "dashboard")
	if resp.StatusCode != 200 || strings.TrimSpace(body) != `{"changed":["B","DATABASE_URL"],"removed":[]}` || strings.Contains(body, envSecret) {
		t.Fatalf("%d %s", resp.StatusCode, body)
	}
	status, body = e.get(t, "/v1/build-vars/site")
	var got struct {
		Names []map[string]string `json:"names"`
	}
	if err := json.Unmarshal([]byte(body), &got); err != nil || status != 200 || len(got.Names) != 2 || got.Names[0]["name"] != "B" || got.Names[1]["name"] != "DATABASE_URL" {
		t.Fatalf("%d %s", status, body)
	}
	for _, n := range got.Names {
		if len(n) != 2 || n["changed_at"] == "" {
			t.Errorf("a name is {name, changed_at}: %v", n)
		}
	}
	if strings.Contains(body, envSecret) {
		t.Errorf("a value is in the listing: %s", body)
	}

	// Removal by name, then everything.
	resp, body = e.signed(t, "PUT", "/v1/build-vars/site", `{"remove":["B","NOPE"]}`, "dashboard")
	if resp.StatusCode != 200 || strings.TrimSpace(body) != `{"changed":[],"removed":["B"]}` {
		t.Fatalf("%d %s", resp.StatusCode, body)
	}
	resp, body = e.signed(t, "DELETE", "/v1/build-vars/site", ``, "dashboard")
	if resp.StatusCode != 200 || strings.TrimSpace(body) != `{"removed":["DATABASE_URL"]}` {
		t.Fatalf("%d %s", resp.StatusCode, body)
	}
	if _, body := e.get(t, "/v1/build-vars/site"); strings.TrimSpace(body) != `{"names":[]}` {
		t.Errorf("%s", body)
	}
}

func TestBuildVarsAreSeparateFromTheAppsOwnVariablesOfTheSameName(t *testing.T) {
	e := newEnvEnv(t) // "web" is an app of the file
	e.signed(t, "PUT", "/v1/apps/web/env", `{"set":{"OWN":"own-value-1"}}`, "")
	if resp, body := e.signed(t, "PUT", "/v1/build-vars/web", `{"set":{"FOR_BUILD":"`+envSecret+`"}}`, ""); resp.StatusCode != 200 {
		t.Fatalf("%d %s", resp.StatusCode, body)
	}
	if _, body := e.get(t, "/v1/apps/web/env"); !strings.Contains(body, `"key":"OWN"`) || strings.Contains(body, "FOR_BUILD") {
		t.Errorf("the app's variables: %s", body)
	}
	if _, body := e.get(t, "/v1/build-vars/web"); !strings.Contains(body, `"name":"FOR_BUILD"`) || strings.Contains(body, "OWN") {
		t.Errorf("the build variables: %s", body)
	}
	e.signed(t, "DELETE", "/v1/build-vars/web", ``, "")
	if _, body := e.get(t, "/v1/apps/web/env"); !strings.Contains(body, `"key":"OWN"`) {
		t.Errorf("deleting build variables left the app's alone? %s", body)
	}
}

func TestBuildVarsAuditNamesOnlyAndNoLogOrAnswerHoldsAValue(t *testing.T) {
	e := newEnvEnv(t)
	_, out1 := e.signed(t, "PUT", "/v1/build-vars/site", `{"set":{"DATABASE_URL":"`+envSecret+`","A":"1"}}`, "dashboard")
	_, out2 := e.signed(t, "PUT", "/v1/build-vars/site", `{"remove":["A"]}`, "dashboard")
	e.signed(t, "PUT", "/v1/build-vars/site", `{"set":{"DB_PASSWORD=`+envSecret2+`":"x"},"remove":["also `+envSecret2+`"]}`, "dashboard")
	_, out4 := e.signed(t, "PUT", "/v1/build-vars/site", `{"set":{"OK":"`+envSecret+`"`, "") // truncated JSON
	_, out5 := e.signed(t, "DELETE", "/v1/build-vars/site", ``, "dashboard")
	e.get(t, "/v1/build-vars/site")
	// out3 echoes the key names the sender made up (as the variables API does), which is the sender's own text.
	for _, out := range []string{out1, out2, out4, out5} {
		if strings.Contains(out, envSecret) || strings.Contains(out, envSecret2) {
			t.Errorf("a value is in an answer: %s", out)
		}
	}
	if strings.Contains(e.logs.String(), envSecret) || strings.Contains(e.logs.String(), envSecret2) || !strings.Contains(e.logs.String(), "/v1/build-vars/site") {
		t.Errorf("the log:\n%s", e.logs.String())
	}
	log, _ := e.st.Audit(t.Context(), 20, 0) // newest first
	var got []string
	for _, a := range log {
		got = append(got, a.Action+" "+a.Method+" "+a.Path+" "+itoa(a.Status)+" "+a.Actor+" | "+a.Detail)
		if strings.Contains(a.Detail+a.Path+a.Actor, envSecret) || strings.Contains(a.Detail+a.Path+a.Actor, envSecret2) {
			t.Errorf("a value is in the audit log: %+v", a)
		}
	}
	joined := strings.Join(got, "\n")
	for _, want := range []string{
		"build_vars.remove DELETE /v1/build-vars/site 200 dashboard | site scope=build unset=DATABASE_URL",
		"build_vars.set PUT /v1/build-vars/site 400 dashboard | site scope=build invalid=2",
		"build_vars.remove PUT /v1/build-vars/site 200 dashboard | site scope=build unset=A",
		"build_vars.set PUT /v1/build-vars/site 200 dashboard | site scope=build set=A,DATABASE_URL",
	} {
		if !strings.Contains(joined, want) {
			t.Errorf("missing %q in\n%s", want, joined)
		}
	}
}

func TestBuildVarsRefusalsListEveryIssueAndAnInvalidNameIsNeverCopied(t *testing.T) {
	e := newEnvEnv(t)
	long := strings.Repeat("K", 300)
	resp, body := e.signed(t, "PUT", "/v1/build-vars/site", `{"set":{"PATH":"x","1bad":"y","`+long+`":"z","OK":"1"}}`, "")
	if resp.StatusCode != 400 || !strings.Contains(body, `"error":"invalid"`) || !strings.Contains(body, `"key":"PATH"`) || !strings.Contains(body, `"key":"1bad"`) || strings.Contains(body, long) {
		t.Fatalf("%d %s", resp.StatusCode, body)
	}
	if _, body := e.get(t, "/v1/build-vars/site"); strings.TrimSpace(body) != `{"names":[]}` {
		t.Errorf("a refused change wrote something: %s", body)
	}
	for _, path := range []string{"/v1/build-vars/UPPER", "/v1/build-vars/..%2Fx", "/v1/build-vars/a.b", "/v1/build-vars/x%00y"} {
		if status, out := e.get(t, path); status != 400 || strings.Contains(out, "UPPER") {
			t.Errorf("GET %s: %d %s", path, status, out)
		}
		for _, method := range []string{"PUT", "DELETE"} {
			if resp, out := e.signed(t, method, path, `{"set":{"A":"1"}}`, ""); resp.StatusCode != 400 || strings.Contains(out, "UPPER") {
				t.Errorf("%s %s: %d %s", method, path, resp.StatusCode, out)
			}
		}
	}
	if _, body := e.get(t, "/v1/build-vars/site"); strings.TrimSpace(body) != `{"names":[]}` {
		t.Errorf("a refused request wrote something: %s", body)
	}
}

func TestBuildVarsReadsNeedTheTokenAndChangesNeedASignature(t *testing.T) {
	e := newEnvEnv(t)
	if got := do(t, "GET", e.srv.URL+"/v1/build-vars/site", "").StatusCode; got != 401 {
		t.Errorf("no token: %d", got)
	}
	if got := do(t, "GET", e.srv.URL+"/v1/build-vars/site", testSecret).StatusCode; got != 401 {
		t.Errorf("the deploy secret does not read: %d", got)
	}
	for _, method := range []string{"PUT", "DELETE"} {
		for name, setup := range map[string]func(*http.Request){
			"no credentials": func(*http.Request) {},
			"read token":     func(r *http.Request) { r.Header.Set("Authorization", "Bearer "+testToken) },
			"bad signature": func(r *http.Request) {
				ts := time.Now().Unix()
				r.Header.Set(HeaderTimestamp, itoa(int(ts)))
				r.Header.Set(HeaderSignature, Sign(testToken, ts, method, r.URL.RequestURI(), []byte(`{"set":{"A":"1"}}`)))
			},
		} {
			req, _ := http.NewRequest(method, e.srv.URL+"/v1/build-vars/site", strings.NewReader(`{"set":{"A":"1"}}`))
			setup(req)
			resp, err := http.DefaultClient.Do(req)
			if err != nil {
				t.Fatal(err)
			}
			resp.Body.Close()
			if resp.StatusCode != 401 {
				t.Errorf("%s %s: %d", method, name, resp.StatusCode)
			}
		}
	}
	if _, body := e.get(t, "/v1/build-vars/site"); strings.TrimSpace(body) != `{"names":[]}` {
		t.Errorf("an unauthenticated change was applied: %s", body)
	}
}

func TestBuildVarsBodyLimitIsTheLargerOneOfTheVariables(t *testing.T) {
	e := newEnvEnv(t)
	set := map[string]string{}
	for i := range 8 {
		set["BIG"+itoa(i)] = strings.Repeat("x", 32<<10-8)
	}
	b, _ := json.Marshal(map[string]any{"set": set})
	if resp, body := e.signed(t, "PUT", "/v1/build-vars/site", string(b), ""); resp.StatusCode != 200 {
		t.Fatalf("%d %.200s", resp.StatusCode, body)
	}
	huge := `{"set":{"A":"` + strings.Repeat("y", 3<<20) + `"}}`
	if resp, _ := e.signed(t, "PUT", "/v1/build-vars/site", huge, ""); resp.StatusCode != http.StatusRequestEntityTooLarge {
		t.Errorf("%d", resp.StatusCode)
	}
	for name, ok := range map[string]bool{"/v1/build-vars/site": true, "/v1/build-vars/": false, "/v1/build-vars/a/b": false, "/v1/build-vars": false} {
		if isEnvChange(httptest.NewRequest("PUT", name, nil)) != ok {
			t.Errorf("isEnvChange(%s) = %v", name, !ok)
		}
	}
	if isEnvChange(httptest.NewRequest("POST", "/v1/build-vars/site", nil)) {
		t.Error("only a PUT carries a change")
	}
}

func TestBuildVarsRoutesAreAbsentWithoutAStore(t *testing.T) {
	e, _ := newPreviewsEnv(t)
	if status := do(t, "GET", e.srv.URL+"/v1/build-vars/site", testToken).StatusCode; status != 404 {
		t.Errorf("%d", status)
	}
}
