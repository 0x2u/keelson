package install

import (
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// installerFiles is every regular file the installer itself writes under /etc/keelson, for a direct install or for a
// connected one (the enrolment codes in EnrollDir are the agent's and root's own and are treated as the installer's
// too). A purge deletes these as part of removing the agent; anything else under /etc/keelson was put there by the
// operator (a database password file, a bot token, an env file the apps file names) and is kept unless
// --purge-operator-files is given. A test installs for real, both ways, and compares, so this list cannot drift from
// what install.go and connect.go write.
func (p Paths) installerFiles() []string {
	return []string{p.Apps(), p.Token(), p.DeploySecret(), p.Relay(), p.CACert(), p.CAKey(), p.ServerCert(), p.ServerKey(), p.Meta()}
}

// operatorFiles lists what is under /etc/keelson and was not written by the installer, sorted.
func operatorFiles(p Paths) []string {
	own := map[string]bool{}
	for _, f := range p.installerFiles() {
		own[f] = true
	}
	enroll := p.EnrollDir() + string(filepath.Separator)
	var found []string
	_ = filepath.WalkDir(p.ConfDir(), func(path string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() || own[path] || strings.HasPrefix(path, enroll) {
			return nil
		}
		found = append(found, path)
		return nil
	})
	sort.Strings(found)
	return found
}

// postgresState says what a purge destroys of the managed PostgreSQL and its local backups, from the layout
// internal/postgres keeps under the data directory. Only names and sizes are read, never contents.
func postgresState(root string, p Paths) (lines []string) {
	state := filepath.Join(p.DataDir(), "postgres")
	var passwords []string
	var size int64
	add := func(path string, info fs.FileInfo) {
		passwords = append(passwords, path)
		size += info.Size()
	}
	if info, err := os.Lstat(filepath.Join(state, "superuser.pw")); err == nil && info.Mode().IsRegular() {
		add(filepath.Join(state, "superuser.pw"), info)
	}
	if entries, err := os.ReadDir(filepath.Join(state, "roles")); err == nil {
		for _, e := range entries {
			if info, err := e.Info(); err == nil && info.Mode().IsRegular() {
				add(filepath.Join(state, "roles", e.Name()), info)
			}
		}
	}
	if len(passwords) > 0 {
		names := make([]string, len(passwords))
		for i, f := range passwords {
			names[i] = displayPath(root, f)
		}
		lines = append(lines, fmt.Sprintf("the managed PostgreSQL password files (the superuser's and every role's, %d file(s), %d bytes): %s. The managed PostgreSQL data cannot be used or recovered without them", len(passwords), size, strings.Join(names, ", ")))
	}
	var n int
	var total int64
	_ = filepath.WalkDir(filepath.Join(p.DataDir(), "backups"), func(_ string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return nil
		}
		if info, err := d.Info(); err == nil {
			n++
			total += info.Size()
		}
		return nil
	})
	if n > 0 {
		lines = append(lines, fmt.Sprintf("%s: %d local backup file(s), %d bytes, deleted with the data directory: nothing else holds them unless they are copied elsewhere", displayPath(root, filepath.Join(p.DataDir(), "backups")), n, total))
	}
	return lines
}

// removeInstallerConfig deletes /etc/keelson's own files and leaves the operator's: a directory that still holds
// one stays, which is expected and not an error.
func removeInstallerConfig(dryRun bool, p Paths) error {
	if dryRun {
		return nil
	}
	var first error
	for _, f := range p.installerFiles() {
		if err := os.Remove(f); err != nil && !os.IsNotExist(err) && first == nil {
			first = err
		}
	}
	if err := os.RemoveAll(p.EnrollDir()); err != nil && first == nil {
		first = err
	}
	// Deepest first; os.Remove refuses a directory that still holds an operator's file, which is the point.
	for _, d := range []string{p.TLSDir(), p.ConfigDir(), p.ConfDir()} {
		_ = os.Remove(d)
	}
	return first
}
