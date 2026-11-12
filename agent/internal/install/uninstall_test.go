package install

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func (r *rig) uninstall(purge, dry bool) (UninstallReport, error) {
	r.t.Helper()
	return Uninstall(Options{Root: r.root, Sys: r.sys}, UninstallOptions{Purge: purge, DryRun: dry})
}

func exists(path string) bool { _, err := os.Stat(path); return err == nil }

func (r *rig) writeNginx(rel, content string) string {
	r.t.Helper()
	path := filepath.Join(r.root, rel)
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		r.t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		r.t.Fatal(err)
	}
	return path
}

func joined(l []string) string { return strings.Join(l, "\n") }

func TestUninstallStopsTheAgentButKeepsWhatDescribesWhatItRan(t *testing.T) {
	r := newRig(t)
	r.sys.ufw = true
	r.opts.AllowFrom = "198.51.100.7"
	r.sys.containers = []string{"web-1a2b: Up 3 hours", "web-9f8e: Exited (0) 2 days ago"}
	r.install()
	p := Paths{r.root}
	os.WriteFile(p.Binary()+".prev", []byte("old"), 0o755)

	rep, err := r.uninstall(false, false)
	if err != nil {
		t.Fatal(err)
	}
	if !rep.Installed || !rep.Service || rep.Purge || rep.DryRun {
		t.Errorf("report: %+v", rep)
	}
	for _, gone := range []string{p.Unit(), p.Binary(), p.Binary() + ".prev"} {
		if exists(gone) {
			t.Errorf("%s must be removed", gone)
		}
	}
	for _, kept := range []string{p.Apps(), p.Token(), p.CAKey(), p.DataDir(), p.Meta()} {
		if !exists(kept) {
			t.Errorf("%s must be kept", kept)
		}
	}
	if len(r.sys.removed) != 0 || len(r.sys.ufwDels) != 0 {
		t.Error("a plain uninstall touches neither the account nor the firewall")
	}
	// The service is stopped before anything is deleted, and the manager is told afterwards.
	var calls []string
	for _, c := range r.sys.ctl {
		calls = append(calls, c[0])
	}
	stop := indexOf(calls, "disable")
	if stop < 0 || indexOf(calls[stop:], "daemon-reload") < 0 {
		t.Errorf("systemctl calls: %v", calls)
	}
	if len(rep.Containers) != 2 || !strings.Contains(joined(rep.Kept), "/etc/keelson") || !strings.Contains(joined(rep.Kept), "ufw rule") {
		t.Errorf("the apps' containers are reported, and what stays is explained: %+v", rep)
	}
}

func indexOf(l []string, s string) int {
	for i, v := range l {
		if v == s {
			return i
		}
	}
	return -1
}

func TestUninstallDryRunChangesNothing(t *testing.T) {
	r := newRig(t)
	r.sys.ufw = true
	r.opts.AllowFrom = "198.51.100.7"
	r.install()
	before := len(r.sys.ctl)

	rep, err := r.uninstall(true, true)
	if err != nil {
		t.Fatal(err)
	}
	p := Paths{r.root}
	for _, still := range []string{p.Unit(), p.Binary(), p.ConfDir(), p.DataDir()} {
		if !exists(still) {
			t.Errorf("a dry run must not remove %s", still)
		}
	}
	if len(r.sys.ctl) != before || len(r.sys.removed) != 0 || len(r.sys.ufwDels) != 0 {
		t.Errorf("a dry run must not run anything: %v %v %v", r.sys.ctl[before:], r.sys.removed, r.sys.ufwDels)
	}
	if !rep.DryRun || len(rep.Removed) < 5 || !strings.Contains(joined(rep.Removed), "the keelson account") {
		t.Errorf("it must still say what it would do: %+v", rep)
	}
}

func TestPurgeRemovesWhatTheInstallAddedAndTheAccount(t *testing.T) {
	r := newRig(t)
	r.sys.ufw = true
	r.opts.AllowFrom = "198.51.100.7"
	r.opts.WithNginx = true
	r.install()
	p := Paths{r.root}
	r.writeNginx("etc/nginx/keelson/upstreams.conf", "upstream keelson_web {\n    server 127.0.0.1:3000;\n}\n")

	rep, err := r.uninstall(true, false)
	if err != nil {
		t.Fatal(err)
	}
	for _, gone := range []string{p.ConfDir(), p.DataDir(), p.Sudoers(), p.NginxDir(), p.Unit(), p.Binary()} {
		if exists(gone) {
			t.Errorf("%s must be purged", gone)
		}
	}
	if len(r.sys.removed) != 1 || len(r.sys.ufwDels) != 1 || r.sys.ufwDels[0] != "198.51.100.7" {
		t.Errorf("purge removes the account and the rule it added: %v %v", r.sys.removed, r.sys.ufwDels)
	}
	if len(rep.Problems) != 0 {
		t.Errorf("problems: %v", rep.Problems)
	}
}

func TestPurgeKeepsTheNginxUpstreamsWhileNginxStillUsesThem(t *testing.T) {
	r := newRig(t)
	r.opts.WithNginx = true
	r.install()
	p := Paths{r.root}
	upstreams := r.writeNginx("etc/nginx/keelson/upstreams.conf", "upstream keelson_shop {\n    server 127.0.0.1:3001;\n}\n")
	site := r.writeNginx("etc/nginx/sites-available/shop", "server {\n  location / { proxy_pass http://keelson_shop; }\n}\n")
	if err := os.MkdirAll(filepath.Join(r.root, "etc/nginx/sites-enabled"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(site, filepath.Join(r.root, "etc/nginx/sites-enabled/shop")); err != nil {
		t.Fatal(err)
	}
	// The include line itself is not a use of an upstream.
	r.writeNginx("etc/nginx/nginx.conf", "http {\n  include /etc/nginx/keelson/*.conf;\n}\n")

	rep, err := r.uninstall(true, false)
	if err != nil {
		t.Fatal(err)
	}
	if !exists(upstreams) {
		t.Fatal("deleting the upstreams would make the next nginx reload fail with the site down")
	}
	if !strings.Contains(joined(rep.Kept), "/etc/nginx/keelson") || !strings.Contains(joined(rep.Kept), "sites-") {
		t.Errorf("the reason must name the configuration that uses it: %v", rep.Kept)
	}
	// What the removed account owned goes to root, so its number cannot later belong to someone else.
	if r.sys.owners[p.NginxDir()] != "root:root" || r.sys.owners[upstreams] != "root:root" {
		t.Errorf("the kept directory must be handed to root: %v", r.sys.owners)
	}
	if exists(p.ConfDir()) || len(r.sys.removed) != 1 {
		t.Error("the rest of the purge still happens")
	}
}

func TestPurgeLeavesFirewallRulesTheInstallDidNotWrite(t *testing.T) {
	r := newRig(t)
	r.sys.ufw = true
	r.opts.AllowFrom = "198.51.100.7"
	r.install()
	// The operator had written that rule first (or edited it since): it no longer carries our comment.
	r.sys.rules["198.51.100.7:7443"] = false

	rep, err := r.uninstall(true, false)
	if err != nil {
		t.Fatal(err)
	}
	if len(r.sys.ufwDels) != 0 || !strings.Contains(joined(rep.Kept), "not written by Keelson") {
		t.Errorf("a rule that is not ours stays: %v %v", r.sys.ufwDels, rep.Kept)
	}

	// With ufw off, nothing can be said about the rule and nothing is run.
	r2 := newRig(t)
	r2.sys.ufw = true
	r2.opts.AllowFrom = "198.51.100.7"
	r2.install()
	r2.sys.ufw = false
	rep, _ = r2.uninstall(true, false)
	if len(r2.sys.ufwDels) != 0 || !strings.Contains(joined(rep.Kept), "ufw is not active") {
		t.Errorf("inactive ufw: %v %v", r2.sys.ufwDels, rep.Kept)
	}
}

func TestInstallDoesNotClaimAFirewallRuleThatWasAlreadyThere(t *testing.T) {
	r := newRig(t)
	r.sys.ufw = true
	r.sys.rules = map[string]bool{"198.51.100.7:7443": false} // the operator's own
	r.opts.AllowFrom = "198.51.100.7"
	b := r.install()
	if len(r.sys.ufwAllows) != 0 || !strings.Contains(strings.Join(b.Notes, " "), "already allows") {
		t.Errorf("allows %v notes %v", r.sys.ufwAllows, b.Notes)
	}
	if strings.Contains(r.read("etc/keelson/install.json"), "198.51.100.7") {
		t.Error("a rule the install did not add must not be recorded, or a purge would delete it")
	}
}

func TestNothingIsRemovedWhenTheAgentCannotBeStopped(t *testing.T) {
	r := newRig(t)
	r.install()
	p := Paths{r.root}

	r.sys.stopErr = errors.New("Failed to stop keelson-agent.service: Interactive authentication required")
	if _, err := r.uninstall(true, false); err == nil || !strings.Contains(err.Error(), "nothing was removed") {
		t.Fatalf("want a refusal, got %v", err)
	}
	r.sys.stopErr, r.sys.stillActive = nil, true
	if _, err := r.uninstall(true, false); err == nil || !strings.Contains(err.Error(), "still running") {
		t.Fatalf("a service that is still active after the stop must refuse too, got %v", err)
	}
	for _, still := range []string{p.Unit(), p.Binary(), p.ConfDir(), p.DataDir()} {
		if !exists(still) {
			t.Errorf("%s must still be there: removing the program of a running agent leaves a crash loop", still)
		}
	}
	if len(r.sys.removed) != 0 {
		t.Error("the account must stay")
	}
}

func TestAFailingStepDoesNotStopTheOthersAndIsReported(t *testing.T) {
	r := newRig(t)
	r.install()
	p := Paths{r.root}
	r.sys.removeErr = errors.New("userdel: user keelson is currently used by process 123")

	rep, err := r.uninstall(true, false)
	if err == nil || !strings.Contains(err.Error(), "currently used") {
		t.Fatalf("want the failure, got %v", err)
	}
	if len(rep.Problems) != 1 || exists(p.ConfDir()) || exists(p.DataDir()) || exists(p.Unit()) {
		t.Errorf("everything else was done: %+v", rep)
	}
}

func TestUninstallOnAServerWithoutTheAgentIsHarmlessAndRepeatable(t *testing.T) {
	r := newRig(t)
	rep, err := r.uninstall(true, false)
	if err != nil || rep.Installed || len(rep.Removed) != 0 || len(r.sys.ctl) != 0 || len(r.sys.removed) != 0 {
		t.Errorf("nothing installed: %+v %v ctl=%v", rep, err, r.sys.ctl)
	}

	r.install()
	if _, err := r.uninstall(true, false); err != nil {
		t.Fatal(err)
	}
	again, err := r.uninstall(true, false)
	if err != nil || again.Installed || again.Service {
		t.Errorf("a second uninstall finds nothing: %+v %v", again, err)
	}
}

func TestParseUfwRule(t *testing.T) {
	status := `Status: active

To                         Action      From
--                         ------      ----
22/tcp                     ALLOW       Anywhere
7443/tcp                   ALLOW       198.51.100.7               # keelson-agent
7443/tcp                   ALLOW IN    203.0.113.9                # my own
7443                       ALLOW       192.0.2.1
7443/tcp (v6)              ALLOW       Anywhere (v6)
`
	for _, c := range []struct {
		from         string
		port         int
		exists, ours bool
	}{
		{"198.51.100.7", 7443, true, true},
		{"203.0.113.9", 7443, true, false}, // "ALLOW IN" on newer ufw, someone else's comment
		{"192.0.2.1", 7443, true, false},   // no "/tcp", no comment
		{"198.51.100.7", 8443, false, false},
		{"10.0.0.1", 7443, false, false},
	} {
		e, o := parseUfwRule(status, c.from, c.port)
		if e != c.exists || o != c.ours {
			t.Errorf("%s:%d: got (%v,%v), want (%v,%v)", c.from, c.port, e, o, c.exists, c.ours)
		}
	}
}
