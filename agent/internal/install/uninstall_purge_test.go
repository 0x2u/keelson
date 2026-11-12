package install

import (
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// put writes a file under the rig's root, making its directories.
func (r *rig) put(rel, content string) string {
	r.t.Helper()
	path := filepath.Join(r.root, rel)
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		r.t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		r.t.Fatal(err)
	}
	return path
}

func (r *rig) installWithOperatorState() {
	r.install()
	r.put("etc/keelson/db-shop-password", "hunter2-do-not-print")
	r.put("etc/keelson/telegram-token", "123:abc-do-not-print")
	r.put("etc/keelson/config/shop.env", "A=b")
	r.put("var/lib/keelson/postgres/superuser.pw", "super-do-not-print")
	r.put("var/lib/keelson/postgres/roles/shop.pw", "role-do-not-print")
	r.put("var/lib/keelson/postgres/roles/blog.pw", "role-do-not-print")
	r.put("var/lib/keelson/backups/shop/shop-20261030.dump.age", "0123456789")
	r.put("var/lib/keelson/backups/blog/blog-20261030.dump.age", "01234")
}

// The installer's file list must be exactly what a real install writes under /etc/keelson, direct or connected, or a
// purge would keep the installer's own files (or delete an operator's).
func TestInstallerFilesAreExactlyWhatTheInstallWrites(t *testing.T) {
	r := newRig(t)
	r.install()
	c, g := connectRig(t)
	if _, err := c.connect(g); err != nil {
		t.Fatal(err)
	}
	p := Paths{r.root}
	own := map[string]bool{}
	for _, f := range p.installerFiles() {
		own[f] = true
		rel, _ := filepath.Rel(r.root, f)
		if !exists(f) && !exists(filepath.Join(c.root, rel)) {
			t.Errorf("%s is in the installer's list but neither kind of install writes it", f)
		}
	}
	_ = filepath.WalkDir(p.ConfDir(), func(path string, d fs.DirEntry, err error) error {
		if err == nil && !d.IsDir() && !own[path] && !strings.HasPrefix(path, p.EnrollDir()+string(filepath.Separator)) {
			t.Errorf("the install writes %s, which the installer's list does not name", path)
		}
		return nil
	})
	if got := operatorFiles(p); len(got) != 0 {
		t.Errorf("a fresh install has no operator files: %v", got)
	}
}

func TestDryRunPurgeListsWhatItWouldDestroyWithoutPrintingContents(t *testing.T) {
	r := newRig(t)
	r.installWithOperatorState()
	p := Paths{r.root}

	rep, err := r.uninstall(true, true)
	if err != nil {
		t.Fatal(err)
	}
	removed := joined(rep.Removed)
	for _, want := range []string{
		"postgres/superuser.pw", "postgres/roles/shop.pw", "postgres/roles/blog.pw",
		"3 file(s)", "cannot be used or recovered",
		"/var/lib/keelson/backups: 2 local backup file(s), 15 bytes",
	} {
		if !strings.Contains(removed, want) {
			t.Errorf("the dry run must say %q:\n%s", want, removed)
		}
	}
	if all := joined(rep.Removed) + joined(rep.Kept); strings.Contains(all, "do-not-print") {
		t.Errorf("file contents leaked into the report: %s", all)
	}
	for _, still := range []string{p.DataDir(), p.ConfDir(), filepath.Join(r.root, "etc/keelson/db-shop-password")} {
		if !exists(still) {
			t.Errorf("a dry run must not remove %s", still)
		}
	}
}

func TestPurgeKeepsAndListsOperatorFilesUnlessAskedToDeleteThem(t *testing.T) {
	r := newRig(t)
	r.installWithOperatorState()
	p := Paths{r.root}

	rep, err := r.uninstall(true, true) // the dry run says the same as the real thing
	if err != nil {
		t.Fatal(err)
	}
	kept := joined(rep.Kept)
	for _, f := range []string{"/etc/keelson/db-shop-password", "/etc/keelson/telegram-token", "/etc/keelson/config/shop.env"} {
		if !strings.Contains(kept, f+": operator-added file, kept: pass --purge-operator-files to delete") {
			t.Errorf("%s must be listed as kept:\n%s", f, kept)
		}
	}

	rep, err = r.uninstall(true, false)
	if err != nil || len(rep.Problems) != 0 {
		t.Fatalf("keeping the operator's files is not a failure: %v %+v", err, rep.Problems)
	}
	for _, kept := range []string{"etc/keelson/db-shop-password", "etc/keelson/telegram-token", "etc/keelson/config/shop.env"} {
		if !exists(filepath.Join(r.root, kept)) {
			t.Errorf("%s must be kept without --purge-operator-files", kept)
		}
	}
	for _, gone := range append(p.installerFiles(), p.EnrollDir(), p.TLSDir(), p.DataDir(), p.Unit(), p.Binary()) {
		if exists(gone) {
			t.Errorf("the installer's own %s must still be deleted", gone)
		}
	}
	if !strings.Contains(joined(rep.Kept), "operator-added file") || len(r.sys.removed) != 1 {
		t.Errorf("the report shows what stayed and the rest of the purge ran: %+v", rep)
	}
	if r.sys.owners[p.ConfDir()] != "root:root" || r.sys.owners[filepath.Join(r.root, "etc/keelson/db-shop-password")] != "root:root" {
		t.Errorf("what stays is handed to root, as the account is gone: %v", r.sys.owners)
	}
}

func TestPurgeOperatorFilesDeletesThem(t *testing.T) {
	r := newRig(t)
	r.installWithOperatorState()
	p := Paths{r.root}

	rep, err := Uninstall(Options{Root: r.root, Sys: r.sys}, UninstallOptions{Purge: true, PurgeOperatorFiles: true})
	if err != nil {
		t.Fatal(err)
	}
	if exists(p.ConfDir()) || exists(p.DataDir()) {
		t.Error("with --purge-operator-files /etc/keelson goes entirely")
	}
	if strings.Contains(joined(rep.Kept), "operator-added") || !strings.Contains(joined(rep.Removed), "/etc/keelson/telegram-token: operator-added file") {
		t.Errorf("the deleted operator files are reported as removed: %+v", rep)
	}
}

func TestPurgeOperatorFilesWithoutPurgeIsRejected(t *testing.T) {
	r := newRig(t)
	r.install()
	before := len(r.sys.ctl)
	_, err := Uninstall(Options{Root: r.root, Sys: r.sys}, UninstallOptions{PurgeOperatorFiles: true})
	if err == nil || !strings.Contains(err.Error(), "--purge") {
		t.Fatalf("want a refusal, got %v", err)
	}
	if !exists(Paths{r.root}.Unit()) || len(r.sys.ctl) != before {
		t.Error("nothing may be touched")
	}
}

func TestPlainUninstallIgnoresOperatorFiles(t *testing.T) {
	r := newRig(t)
	r.installWithOperatorState()
	rep, err := r.uninstall(false, false)
	if err != nil || strings.Contains(joined(rep.Kept), "operator-added") {
		t.Fatalf("without --purge nothing changes: %v %v", err, rep.Kept)
	}
	if !exists(filepath.Join(r.root, "etc/keelson/db-shop-password")) || !exists(Paths{r.root}.Meta()) {
		t.Error("everything stays without --purge")
	}
}
