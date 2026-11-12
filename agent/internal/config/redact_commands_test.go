package config

import (
	"strings"
	"testing"
)

const commandDoc = `apps:
  - name: web
    image: o/web
    command: ["node", "server.js", "--api-key", "sk-live-AAAA", "--region=eu", "--token=tok-BBBB", "SESSION_SECRET=ss-CCCC", "PORT=3000"]
    release:
      steps:
        - {name: migrate, command: [prisma, migrate, deploy, "--password", "pw-DDDD"]}
        - {name: gate, run: [sh, -c, "DB_PASSWORD=pw-EEEE ./check.sh"]}
    build:
      dockerfile: Dockerfile
      args:
        NEXT_PUBLIC_SITE: https://example.com
        ERROR_TRACKING_AUTH_TOKEN: tk-FFFF
        DATABASE_PASSWORD: pw-GGGG
jobs:
  - name: cron
    schedule: "0 4 * * *"
    http: {url: "https://example.com/api/cron?key=url-HHHH&day=1", method: POST}
  - name: plain
    schedule: "0 5 * * *"
    http: {url: "https://example.com/api/plain"}
  - name: cmd
    schedule: "0 6 * * *"
    run: [backup.sh, "--secret", "ss-IIII", "--verbose"]
`

var leaked = []string{"sk-live-AAAA", "tok-BBBB", "ss-CCCC", "pw-DDDD", "tk-FFFF", "pw-GGGG", "url-HHHH", "ss-IIII"}

// The read token reads GET /v1/config: what an operator would put on a command line or in a URL must not leave with it.
func TestRedactHidesSecretsInCommandsUrlsAndBuildArgsButKeepsTheirNames(t *testing.T) {
	out, err := Redact([]byte(commandDoc))
	if err != nil {
		t.Fatal(err)
	}
	text := string(out)
	for _, secret := range leaked {
		if strings.Contains(text, secret) {
			t.Errorf("%s leaked:\n%s", secret, text)
		}
	}
	for _, kept := range []string{"--api-key", "--region=eu", "--token=" + Hidden, "SESSION_SECRET=" + Hidden, "PORT=3000", "ERROR_TRACKING_AUTH_TOKEN", "NEXT_PUBLIC_SITE: https://example.com", "https://example.com/api/cron?" + Hidden, "https://example.com/api/plain", "--verbose", "DB_PASSWORD"} {
		if !strings.Contains(text, kept) {
			t.Errorf("%q must stay readable:\n%s", kept, text)
		}
	}
	// The whole shell snippet is a script, not a flag or a variable: it is left as written (its secret, if any, is the operator's to move).
	if !strings.Contains(text, "./check.sh") {
		t.Errorf("unexpected rewrite of a script:\n%s", text)
	}
}

// The dashboard edits what it was shown: a value it sends back hidden means "keep the stored one", also inside a command.
func TestRestoreBringsBackWhatRedactHidAndRefusesAnEditedMask(t *testing.T) {
	hidden, err := Redact([]byte(commandDoc))
	if err != nil {
		t.Fatal(err)
	}
	restored, issues := Restore(hidden, []byte(commandDoc))
	for _, i := range issues {
		if i.Severity == SeverityError {
			t.Fatalf("a document sent back unchanged must restore: %+v", i)
		}
	}
	for _, secret := range leaked {
		if !strings.Contains(string(restored), secret) {
			t.Errorf("%s must come back", secret)
		}
	}

	// A prefix changed while the mask stays: the stored value no longer stands for it.
	edited := strings.Replace(string(hidden), "SESSION_SECRET="+Hidden, "OTHER_SECRET="+Hidden, 1)
	_, issues = Restore([]byte(edited), []byte(commandDoc))
	var refused bool
	for _, i := range issues {
		refused = refused || (i.Severity == SeverityError && strings.Contains(i.Message, "no stored value"))
	}
	if !refused {
		t.Errorf("a masked value that was edited must be refused, got %+v", issues)
	}
}
