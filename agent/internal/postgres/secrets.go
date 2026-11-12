package postgres

import (
	"crypto/rand"
	"encoding/base64"
	"errors"
	"fmt"
	"io/fs"
	"net"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/0x2u/keelson/agent/internal/config"
)

func (m *Manager) stateDir() string { return filepath.Join(m.dir, stateDirName) }

// superFile holds the password of the instance's superuser.
func (m *Manager) superFile() string { return filepath.Join(m.stateDir(), "superuser.pw") }

// roleFile holds the password of a database's role. It is the password_file of the database's entry in the apps file,
// so the backup and restore code reads it like any other.
func (m *Manager) roleFile(name string) string {
	return filepath.Join(m.stateDir(), "roles", name+".pw")
}

// DefaultBackupDir is where the backups of managed databases go unless a request names a directory: the files of a
// database are then under <data-dir>/backups/<name>/.
func (m *Manager) defaultBackupDir() string { return filepath.Join(m.dir, "backups") }

// generatePassword returns 32 random bytes in the URL-safe alphabet: nothing in it needs quoting anywhere.
func generatePassword() (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}

// readSecret reads a secret file, without its trailing newline. An empty file is an error: a secret that is not
// there is never what was meant.
func readSecret(path string) (string, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	s := strings.TrimRight(string(b), "\r\n")
	if s == "" {
		return "", fmt.Errorf("%s is empty", path)
	}
	return s, nil
}

// writeSecret writes a secret file of mode 0600 in a private directory, so a reader never sees half of it and the
// mode is never wider than 0600, whatever the umask.
func writeSecret(path, secret string) error {
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(dir, ".secret-*")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	if err := tmp.Chmod(0o600); err != nil {
		tmp.Close()
		return err
	}
	if _, err := tmp.WriteString(secret + "\n"); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), path)
}

// superuserPassword returns the superuser's password. A server that has no instance yet gets a new one; one whose
// instance (or data) exists without the file cannot be helped by a new password, which the data would not match.
func (m *Manager) superuserPassword(dataExists bool) (string, error) {
	pw, err := readSecret(m.superFile())
	switch {
	case err == nil:
		return pw, nil
	case !errors.Is(err, fs.ErrNotExist):
		return "", fmt.Errorf("read the superuser password: %w", err)
	case dataExists:
		return "", ErrPasswordLost
	}
	if pw, err = generatePassword(); err != nil {
		return "", err
	}
	if err := writeSecret(m.superFile(), pw); err != nil {
		return "", fmt.Errorf("store the superuser password: %w", err)
	}
	return pw, nil
}

// connectionURL is the URL an app connects with. The password is percent-encoded, so a character such as @, :, / or #
// in it (a password the operator chose, not one the agent generated) cannot change which host or database the URL
// means.
func connectionURL(host string, port int, user, password, database string) string {
	u := url.URL{
		Scheme: "postgresql",
		User:   url.UserPassword(user, password),
		Host:   net.JoinHostPort(host, strconv.Itoa(port)),
		Path:   "/" + database,
	}
	return u.String()
}

// appURL is the URL of a database for an app: on the host network the instance is reached on loopback, through the
// port it is published on; on a Docker network, by the container's name.
func appURL(app config.App, hostPort int, name, password string) (string, error) {
	if app.HostNetwork() {
		if hostPort == 0 {
			return "", &InstanceError{Msg: "the instance is not published on a loopback port, which an app on the host network needs"}
		}
		return connectionURL("127.0.0.1", hostPort, name, password, name), nil
	}
	return connectionURL(config.ManagedPostgresContainer, config.ManagedPostgresPort, name, password, name), nil
}

// mode names how the app reaches the instance.
func mode(app config.App) string {
	if app.HostNetwork() {
		return "host"
	}
	return "network"
}
