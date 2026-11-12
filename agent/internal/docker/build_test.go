package docker

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/url"
	"strings"
	"testing"
)

func TestBuildSendsContextWithCapsAndStreamsOutput(t *testing.T) {
	var query url.Values
	var gotBody, contentType string
	f := &fakeEngine{handler: func(w http.ResponseWriter, r *http.Request) {
		query = r.URL.Query()
		contentType = r.Header.Get("Content-Type")
		b, _ := io.ReadAll(r.Body)
		gotBody = string(b)
		io.WriteString(w, `{"stream":"Step 1/2 : FROM scr"}`+"\n"+`{"stream":"atch\n"}`+"\n")
		io.WriteString(w, `{"stream":"Step 2/2 : COPY a /a\n ---\u003e abc\n"}`+"\n")
		io.WriteString(w, `{"aux":{"ID":"sha256:abc"}}`+"\n"+`{"stream":"Successfully tagged o/web:abc\n"}`+"\n")
	}}
	var lines []string
	err := newAdmin(t, f).Build(context.Background(), BuildOptions{
		Tag: "o/web:abc", Dockerfile: "docker/Dockerfile", Target: "runner",
		Args: map[string]string{"A": "1"}, Labels: map[string]string{"k": "v"},
		MemoryBytes: 256 << 20, CPUs: 1.5, Platform: "linux/amd64",
	}, strings.NewReader("TARBYTES"), func(l string) { lines = append(lines, l) })
	if err != nil {
		t.Fatal(err)
	}
	if reqs := f.requests(); len(reqs) != 1 || !strings.HasPrefix(reqs[0], "POST /build?") {
		t.Fatalf("%v", reqs)
	}
	want := map[string]string{
		"t": "o/web:abc", "dockerfile": "docker/Dockerfile", "target": "runner", "buildargs": `{"A":"1"}`, "labels": `{"k":"v"}`,
		"memory": "268435456", "memswap": "268435456", "cpuperiod": "100000", "cpuquota": "150000",
		"rm": "1", "forcerm": "1", "pull": "0", "platform": "linux/amd64",
	}
	for k, v := range want {
		if query.Get(k) != v {
			t.Errorf("%s = %q, want %q", k, query.Get(k), v)
		}
	}
	for _, k := range []string{"networkmode", "privileged", "cgroupparent", "securityopt", "extrahosts"} {
		if query.Has(k) {
			t.Errorf("the build must not set %s", k)
		}
	}
	if contentType != "application/x-tar" || gotBody != "TARBYTES" {
		t.Errorf("%q %q", contentType, gotBody)
	}
	if got := strings.Join(lines, "|"); got != "Step 1/2 : FROM scratch|Step 2/2 : COPY a /a| ---> abc|Successfully tagged o/web:abc" {
		t.Errorf("lines: %q", got)
	}
}

func TestBuildNetworkIsTheDefaultBridgeUnlessHostOrANamedNetwork(t *testing.T) {
	var query url.Values
	f := &fakeEngine{handler: func(w http.ResponseWriter, r *http.Request) {
		query = r.URL.Query()
		io.WriteString(w, `{"stream":"ok\n"}`+"\n")
	}}
	a := newAdmin(t, f)
	for network, want := range map[string]string{"": "", "host": "host", "keelson": "keelson"} {
		if err := a.Build(context.Background(), BuildOptions{Tag: "o/web:abc", Network: network}, strings.NewReader(""), func(string) {}); err != nil {
			t.Fatalf("network %q: %v", network, err)
		}
		if got := query.Get("networkmode"); got != want {
			t.Errorf("network %q: networkmode = %q, want %q", network, got, want)
		}
	}
	for _, bad := range []string{"container:other", "none", "bridge", "default", "../x", "a b", "-x"} {
		before := len(f.requests())
		if err := a.Build(context.Background(), BuildOptions{Tag: "o/web:abc", Network: bad}, strings.NewReader(""), func(string) {}); err == nil {
			t.Errorf("network %q must be refused", bad)
		}
		if len(f.requests()) != before {
			t.Errorf("a refused network (%q) must not reach the engine", bad)
		}
	}
}

func TestBuildReportsTheStreamError(t *testing.T) {
	f := &fakeEngine{handler: func(w http.ResponseWriter, r *http.Request) {
		io.WriteString(w, `{"stream":"Step 1/1 : RUN false\n"}`+"\n"+`{"error":"The command 'false' returned a non-zero code: 1","errorDetail":{"code":1}}`+"\n")
	}}
	var lines []string
	err := newAdmin(t, f).Build(context.Background(), BuildOptions{Tag: "o/web:abc"}, strings.NewReader(""), func(l string) { lines = append(lines, l) })
	var be *BuildError
	if !errors.As(err, &be) || !strings.Contains(be.Message, "non-zero code: 1") {
		t.Fatalf("want a BuildError, got %v", err)
	}
	if len(lines) != 1 {
		t.Errorf("%v", lines)
	}
}

func TestBuildReportsEngineRefusalsAndBadTags(t *testing.T) {
	f := &fakeEngine{handler: func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(400)
		io.WriteString(w, `{"message":"invalid dockerfile"}`)
	}}
	a := newAdmin(t, f)
	err := a.Build(context.Background(), BuildOptions{Tag: "o/web:abc"}, strings.NewReader(""), nil)
	var de *Error
	if !errors.As(err, &de) || de.Status != 400 {
		t.Fatalf("%v", err)
	}
	for _, tag := range []string{"", "o/web:abc&x=1", "o web", "-x"} {
		if err := a.Build(context.Background(), BuildOptions{Tag: tag}, strings.NewReader(""), nil); !errors.Is(err, ErrInvalidImageRef) {
			t.Errorf("%q: %v", tag, err)
		}
	}
}

func TestBuildLinesAreBounded(t *testing.T) {
	long := strings.Repeat("x", 3*maxBuildLine)
	f := &fakeEngine{handler: func(w http.ResponseWriter, r *http.Request) {
		io.WriteString(w, `{"stream":"`+long+`\n"}`+"\n")
	}}
	var lines []string
	if err := newAdmin(t, f).Build(context.Background(), BuildOptions{Tag: "o/web:abc"}, strings.NewReader(""), func(l string) { lines = append(lines, l) }); err != nil {
		t.Fatal(err)
	}
	if len(lines) == 0 {
		t.Fatal("no output")
	}
	for _, l := range lines {
		if len(l) > maxBuildLine+4 {
			t.Fatalf("line of %d bytes", len(l))
		}
	}
}
