package postgres

import (
	"context"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
	"sync"

	"github.com/0x2u/keelson/agent/internal/config"
	"github.com/0x2u/keelson/agent/internal/docker"
	"github.com/0x2u/keelson/agent/internal/store"
)

// psql runs psql as the superuser in a throwaway container from the instance's own image (so its client is the
// server's version), on the instance's network, and returns what it printed. Every argument after the connection is
// the caller's; none carries a password. The superuser's password is PGPASSWORD for the seconds the container lives, as
// in the database code, and the output is scrubbed of it before it can reach an error.
func (m *Manager) psql(ctx context.Context, image, superPassword string, args ...string) ([]string, error) {
	ctx, cancel := context.WithTimeout(ctx, psqlTimeout)
	defer cancel()
	cmd := []string{
		"psql", "-h", config.ManagedPostgresContainer, "-p", fmt.Sprint(config.ManagedPostgresPort),
		"-U", config.ManagedPostgresSuperuser, "-d", "postgres", "--no-password", "-X", "-v", "ON_ERROR_STOP=1",
	}
	cmd = append(cmd, args...)
	var (
		mu    sync.Mutex
		lines []string
	)
	code, err := docker.RunThrowaway(ctx, m.eng, m.log, docker.ContainerSpec{
		Name:          "keelson-pgadmin-" + store.NewID(),
		Image:         image,
		Env:           []string{"PGCONNECT_TIMEOUT=10", "PGPASSWORD=" + superPassword},
		Labels:        map[string]string{jobLabel: "true", adminLabel: "true"},
		Cmd:           cmd,
		NetworkMode:   config.ManagedPostgresNetwork,
		RestartPolicy: "no",
		StopTimeout:   10,
	}, func(line string) {
		mu.Lock()
		lines = append(lines, line)
		mu.Unlock()
	})
	mu.Lock()
	defer mu.Unlock()
	switch {
	case ctx.Err() != nil:
		return lines, ctx.Err()
	case err != nil:
		return lines, &ServerError{Err: errors.New(m.scrub(err.Error(), superPassword))}
	case code != 0:
		return lines, &ServerError{Err: errors.New(m.scrub(failureLine(lines), superPassword))}
	}
	return lines, nil
}

// failureLine is what PostgreSQL said was wrong: its first ERROR line (the later lines of a failure echo the
// statement), else the last line printed.
func failureLine(lines []string) string {
	last := ""
	for _, l := range lines {
		t := strings.TrimSpace(l)
		if strings.HasPrefix(t, "ERROR:") || strings.Contains(t, "psql: error") {
			return t
		}
		if t != "" {
			last = t
		}
	}
	if last == "" {
		return "psql exited with an error and printed nothing"
	}
	return last
}

// A name that reaches SQL is quoted as an identifier and, in the one place it is a literal, as a string. Names are
// validated long before (a-z, 0-9, _ and -), so this is a second line of defence, not the first.
func ident(s string) string   { return `"` + strings.ReplaceAll(s, `"`, `""`) + `"` }
func literal(s string) string { return `'` + strings.ReplaceAll(s, `'`, `''`) + `'` }

// createRole creates the role if it is missing and, either way, gives it the password the file holds. The role may
// log in and create databases (a restore into a new database needs it), and nothing else.
func (m *Manager) createRole(ctx context.Context, image, superPassword, name, password string) error {
	verifier, err := scramVerifier(password)
	if err != nil {
		return err
	}
	_, err = m.psql(ctx, image, superPassword,
		"-c", fmt.Sprintf(`DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = %s) THEN CREATE ROLE %s LOGIN; END IF; END $$`, literal(name), ident(name)),
		"-c", fmt.Sprintf(`ALTER ROLE %s WITH LOGIN CREATEDB NOSUPERUSER NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %s`, ident(name), literal(verifier)),
	)
	return m.noSecret(err, password, verifier)
}

// setPassword gives an existing role a new password.
func (m *Manager) setPassword(ctx context.Context, image, superPassword, name, password string) error {
	verifier, err := scramVerifier(password)
	if err != nil {
		return err
	}
	_, err = m.psql(ctx, image, superPassword,
		"-c", fmt.Sprintf(`ALTER ROLE %s WITH PASSWORD %s`, ident(name), literal(verifier)))
	return m.noSecret(err, password, verifier)
}

// noSecret rewrites an error so that neither the password nor its verifier is in it.
func (m *Manager) noSecret(err error, secrets ...string) error {
	if err == nil {
		return nil
	}
	var se *ServerError
	if errors.As(err, &se) {
		return &ServerError{Err: errors.New(m.scrub(se.Err.Error(), secrets...))}
	}
	return errors.New(m.scrub(err.Error(), secrets...))
}

// createDatabase creates the database owned by the role of the same name, unless it exists, and closes it to every
// other role: by default anyone may connect to a new database.
func (m *Manager) createDatabase(ctx context.Context, image, superPassword, name string) error {
	_, err := m.psql(ctx, image, superPassword, "-c", fmt.Sprintf(`CREATE DATABASE %s OWNER %s`, ident(name), ident(name)))
	var se *ServerError
	if err != nil && !(errors.As(err, &se) && strings.Contains(se.Err.Error(), "already exists")) {
		return err
	}
	_, err = m.psql(ctx, image, superPassword, "-c", fmt.Sprintf(`REVOKE ALL ON DATABASE %s FROM PUBLIC`, ident(name)))
	return err
}

// dropDatabases drops every database the role owns (its own, and those a restore into a new database made for it) and
// then the role. A backup of them stays wherever it was stored.
func (m *Manager) dropDatabases(ctx context.Context, image, superPassword, name string) error {
	// Names come back hex-encoded: a database the role made may be named anything, a newline included.
	lines, err := m.psql(ctx, image, superPassword, "-At", "-c",
		fmt.Sprintf(`SELECT encode(convert_to(d.datname, 'UTF8'), 'hex') FROM pg_database d JOIN pg_roles r ON r.oid = d.datdba WHERE r.rolname = %s ORDER BY d.datname`, literal(name)))
	if err != nil {
		return err
	}
	args := []string{}
	for _, l := range lines {
		l = strings.TrimSpace(l)
		if l == "" {
			continue
		}
		raw, err := hex.DecodeString(l)
		if err != nil {
			return fmt.Errorf("the list of databases of role %s could not be read", name)
		}
		args = append(args, "-c", fmt.Sprintf(`DROP DATABASE IF EXISTS %s WITH (FORCE)`, ident(string(raw))))
	}
	args = append(args, "-c", fmt.Sprintf(`DROP ROLE IF EXISTS %s`, ident(name)))
	_, err = m.psql(ctx, image, superPassword, args...)
	return err
}

// serverInfo asks the server for its version and the size of all its databases.
func (m *Manager) serverInfo(ctx context.Context, image, superPassword string) (version string, size int64, err error) {
	lines, err := m.psql(ctx, image, superPassword, "-At", "-c",
		`SELECT current_setting('server_version') || '|' || (SELECT coalesce(sum(pg_database_size(datname)), 0) FROM pg_database)`)
	if err != nil {
		return "", 0, err
	}
	for i := len(lines) - 1; i >= 0; i-- {
		v, s, ok := strings.Cut(strings.TrimSpace(lines[i]), "|")
		if !ok {
			continue
		}
		var n int64
		if _, err := fmt.Sscanf(s, "%d", &n); err != nil {
			continue
		}
		v, _, _ = strings.Cut(v, " ")
		return v, n, nil
	}
	return "", 0, errors.New("the server's answer to the version query could not be read")
}
