package build

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"github.com/0x2u/keelson/agent/internal/docker"
)

const managedSecret = "Sup3r-Managed-Valu3"

func TestManagedArgsAreMergedUnderTheBlocksOwn(t *testing.T) {
	s := newSite(t, serveArchive(standardArchive(t)))
	eng := &fakeEngine{}
	cfg := testConfig() // args: NODE_ENV=production
	req := request(cfg)
	req.Args = map[string]string{"NEXT_PUBLIC_API": "https://api.example.com", "NODE_ENV": "from-the-store"}
	if _, err := newBuilder(eng, s).Build(context.Background(), req, (&recorder{}).emit); err != nil {
		t.Fatal(err)
	}
	got := eng.opts[0].Args
	if len(got) != 2 || got["NEXT_PUBLIC_API"] != "https://api.example.com" || got["NODE_ENV"] != "production" {
		t.Errorf("the block's args win over the stored ones: %v", got)
	}
	if len(cfg.Args) != 1 || cfg.Args["NODE_ENV"] != "production" || len(req.Args) != 2 || req.Args["NODE_ENV"] != "from-the-store" {
		t.Errorf("the inputs must not be modified: %v %v", cfg.Args, req.Args)
	}

	// No stored argument: exactly what the block says, as before.
	eng = &fakeEngine{}
	if _, err := newBuilder(eng, s).Build(context.Background(), request(testConfig()), (&recorder{}).emit); err != nil {
		t.Fatal(err)
	}
	if got := eng.opts[0].Args; len(got) != 1 || got["NODE_ENV"] != "production" {
		t.Errorf("%v", got)
	}
}

// A build argument the operator stored may be something they would not want in a log: wherever the engine echoes it,
// and in every error, it is replaced.
func TestStoredArgValuesNeverReachEventsOrErrors(t *testing.T) {
	cases := map[string]*fakeEngine{
		"echoed in the output": {lines: []string{"Step 4/9 : RUN echo " + managedSecret, "value is " + managedSecret + " and again " + managedSecret}},
		"engine build error":   {lines: []string{"ok"}, err: &docker.BuildError{Message: "the command failed with " + managedSecret}},
		"engine plain error":   {err: errors.New("boom " + managedSecret)},
	}
	for name, eng := range cases {
		t.Run(name, func(t *testing.T) {
			s := newSite(t, serveArchive(standardArchive(t)))
			req := request(testConfig())
			req.Args = map[string]string{"SECRET_ARG": managedSecret}
			var rec recorder
			_, err := newBuilder(eng, s).Build(context.Background(), req, rec.emit)
			blob := rec.all()
			if err != nil {
				blob += "\n" + err.Error()
			}
			if strings.Contains(blob, managedSecret) {
				t.Errorf("the value leaked:\n%s", blob)
			}
			if name == "echoed in the output" && !strings.Contains(blob, "value is "+redacted+" and again "+redacted) {
				t.Errorf("every occurrence must be replaced, the rest kept:\n%s", blob)
			}
			// The engine did get the value: that is what a build argument is for.
			j, _ := json.Marshal(eng.opts[0].Args)
			if !strings.Contains(string(j), managedSecret) {
				t.Errorf("the engine must receive the value: %s", j)
			}
		})
	}
}

func TestTheTailOfALongBuildIsScrubbedToo(t *testing.T) {
	s := newSite(t, serveArchive(standardArchive(t)))
	var lines []string
	for i := 0; i < maxLiveLines+10; i++ {
		lines = append(lines, "line")
	}
	lines = append(lines, "the very last line has "+managedSecret)
	eng := &fakeEngine{lines: lines}
	req := request(testConfig())
	req.Args = map[string]string{"K": managedSecret}
	var rec recorder
	if _, err := newBuilder(eng, s).Build(context.Background(), req, rec.emit); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(rec.all(), managedSecret) || !strings.Contains(rec.all(), "the very last line has "+redacted) {
		t.Errorf("tail:\n%.300s", rec.all()[len(rec.all())-300:])
	}
}

func TestShortValuesAreNotScrubbedBecauseTheyWouldGarbleTheLog(t *testing.T) {
	got := scrubbed(map[string]string{"A": "true", "B": "3000", "C": "12345", "D": "123456", "E": "123456789", "F": ""})
	if strings.Join(got, ",") != "123456789,123456" {
		t.Errorf("%v", got)
	}
	s := newSite(t, serveArchive(standardArchive(t)))
	eng := &fakeEngine{lines: []string{"NODE_ENV=true on port 3000"}}
	req := request(testConfig())
	req.Args = map[string]string{"A": "true", "B": "3000"}
	var rec recorder
	if _, err := newBuilder(eng, s).Build(context.Background(), req, rec.emit); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(rec.all(), "NODE_ENV=true on port 3000") {
		t.Errorf("%s", rec.all())
	}
}

func TestALongerValueContainingAShorterOneIsRemovedWhole(t *testing.T) {
	s := newSite(t, serveArchive(standardArchive(t)))
	eng := &fakeEngine{lines: []string{"x password-abcdef-tail y"}}
	req := request(testConfig())
	req.Args = map[string]string{"A": "abcdef", "B": "password-abcdef-tail"}
	var rec recorder
	if _, err := newBuilder(eng, s).Build(context.Background(), req, rec.emit); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(rec.all(), "x "+redacted+" y") {
		t.Errorf("%s", rec.all())
	}
}

func TestTheTokenAndStoredArgsAreBothScrubbed(t *testing.T) {
	s := newSite(t, serveArchive(standardArchive(t)))
	eng := &fakeEngine{lines: []string{testToken + " " + managedSecret}}
	req := request(testConfig())
	req.Args = map[string]string{"K": managedSecret}
	var rec recorder
	if _, err := newBuilder(eng, s).Build(context.Background(), req, rec.emit); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(rec.all(), testToken) || strings.Contains(rec.all(), managedSecret) {
		t.Errorf("%s", rec.all())
	}
}
