package postgres

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/0x2u/keelson/agent/internal/config"
	"github.com/0x2u/keelson/agent/internal/docker"
)

// specHash identifies the settings an instance is created with. Only what the operator chooses counts: improving the
// server's own tuning in a later release must not recreate a container that holds everybody's databases.
func specHash(s config.PostgresSettings) string {
	sum := sha256.Sum256([]byte(fmt.Sprintf("%s|%d|%d", s.Image(), s.Port, s.MemoryBytes())))
	return hex.EncodeToString(sum[:8])
}

// serverArgs are the settings the server starts with, sized from the container's memory cap: conservative, for a server
// of a few gigabytes that has to leave most of its memory to the apps.
func serverArgs(memory int64) []string {
	const mb = 1 << 20
	m := memory / mb
	clamp := func(v, lo, hi int64) int64 { return min(max(v, lo), hi) }
	workMem, conns := int64(4), 100
	if m < 256 {
		workMem, conns = 2, 50
	}
	settings := []string{
		"listen_addresses=*",
		"password_encryption=scram-sha-256",
		fmt.Sprintf("max_connections=%d", conns),
		fmt.Sprintf("shared_buffers=%dMB", clamp(m/4, 32, 2048)),
		fmt.Sprintf("effective_cache_size=%dMB", clamp(m*3/4, 64, 8192)),
		fmt.Sprintf("work_mem=%dMB", workMem),
		fmt.Sprintf("maintenance_work_mem=%dMB", clamp(m/16, 16, 256)),
		"max_wal_size=1GB",
		// A failed statement is not repeated in the server's log: it may be an ALTER ROLE.
		"log_min_error_statement=panic",
	}
	args := []string{"postgres"}
	for _, s := range settings {
		args = append(args, "-c", s)
	}
	return args
}

// Instance is what the engine says about the instance's container.
type instance struct {
	detail *docker.Detail
	// hostPort is the loopback port it is published on, 0 when it is not published.
	hostPort int
}

func (i instance) running() bool { return i.detail != nil && i.detail.State.Running }

func instanceOf(d *docker.Detail) instance {
	in := instance{detail: d}
	for _, p := range d.ConfiguredPorts {
		if p.PrivatePort == config.ManagedPostgresPort {
			in.hostPort = int(p.PublicPort)
			break
		}
	}
	return in
}

// inspect returns the instance's container, or nil when there is none. A container of that name that is not the
// agent's is an error: it must not be started, removed or trusted.
func (m *Manager) inspect(ctx context.Context) (*docker.Detail, error) {
	d, err := m.eng.Inspect(ctx, config.ManagedPostgresContainer)
	switch {
	case err == nil:
		if d.Labels[instanceLabel] != "true" {
			return nil, ErrForeign
		}
		return d, nil
	case docker.IsNotFound(err):
		return nil, nil
	}
	return nil, err
}

// ensureInstance makes the instance exist, run and answer, creating whatever is missing: the network, the volume,
// the container. It never replaces a container that exists (the data is in the volume, but a restart is an outage)
// and never creates a second one. A container that was created and never started is the leftover of a crash between
// the two steps and is made again.
func (m *Manager) ensureInstance(ctx context.Context) (instance, error) {
	set := m.cfg.Config().PostgresSettings()
	d, err := m.inspect(ctx)
	if err != nil {
		return instance{}, err
	}
	if d != nil && d.State.Status == "created" {
		m.log.Warn("removing a managed PostgreSQL container that was created and never started")
		if err := m.eng.Remove(ctx, config.ManagedPostgresContainer); err != nil && !docker.IsNotFound(err) {
			return instance{}, err
		}
		d = nil
	}
	if d == nil {
		if d, err = m.createInstance(ctx, set); err != nil {
			return instance{}, err
		}
	}
	if !d.State.Running && !d.State.Restarting {
		if err := m.eng.Start(ctx, config.ManagedPostgresContainer); err != nil {
			return instance{}, m.wrapInstance("start %s: %v", config.ManagedPostgresContainer, err)
		}
	}
	if err := m.waitHealthy(ctx); err != nil {
		return instance{}, err
	}
	if d, err = m.inspect(ctx); err != nil || d == nil {
		if err == nil {
			err = m.wrapInstance("%s disappeared", config.ManagedPostgresContainer)
		}
		return instance{}, err
	}
	if want := specHash(set); d.Labels[specLabel] != want {
		m.warnDrift()
	}
	return instanceOf(d), nil
}

// warnDrift says once that the apps file asks for settings the running instance was not created with.
func (m *Manager) warnDrift() {
	m.mu.Lock()
	defer m.mu.Unlock()
	const msg = "the postgres section of the apps file differs from the settings the instance was created with; they apply only to a new container"
	if m.ensureWarned != msg {
		m.ensureWarned = msg
		m.log.Warn(msg)
	}
}

func (m *Manager) createInstance(ctx context.Context, set config.PostgresSettings) (*docker.Detail, error) {
	volumeExists, err := m.eng.VolumeExists(ctx, config.ManagedPostgresVolume)
	if err != nil {
		return nil, err
	}
	password, err := m.superuserPassword(volumeExists)
	if err != nil {
		return nil, err
	}
	if err := m.ensureImage(ctx, set.Image()); err != nil {
		return nil, err
	}
	labels := map[string]string{instanceLabel: "true"}
	if _, err := m.eng.EnsureNetwork(ctx, config.ManagedPostgresNetwork, labels); err != nil {
		return nil, m.wrapInstance("create the %s network: %v", config.ManagedPostgresNetwork, err)
	}
	if _, err := m.eng.EnsureVolume(ctx, config.ManagedPostgresVolume, labels); err != nil {
		return nil, m.wrapInstance("create the %s volume: %v", config.ManagedPostgresVolume, err)
	}
	memory := set.MemoryBytes()
	spec := docker.ContainerSpec{
		Name:  config.ManagedPostgresContainer,
		Image: set.Image(),
		Env: []string{
			"POSTGRES_USER=" + config.ManagedPostgresSuperuser,
			"POSTGRES_DB=postgres",
			"POSTGRES_PASSWORD_FILE=" + superSecretDir + "/" + superSecretName,
		},
		Labels:        map[string]string{instanceLabel: "true", specLabel: specHash(set)},
		Cmd:           serverArgs(memory),
		Ports:         []docker.PortBinding{{HostIP: "127.0.0.1", HostPort: strconv.Itoa(set.Port), ContainerPort: strconv.Itoa(config.ManagedPostgresPort), Proto: "tcp"}},
		Binds:         []string{config.ManagedPostgresVolume + ":" + dataMount},
		NetworkMode:   config.ManagedPostgresNetwork,
		RestartPolicy: "unless-stopped",
		StopTimeout:   60,
		LogDriver:     "json-file",
		LogMaxSize:    "10m",
		LogMaxFile:    3,
		Memory:        memory,
		Healthcheck: &docker.Healthcheck{
			Test:     []string{"CMD-SHELL", "pg_isready -q -U " + config.ManagedPostgresSuperuser + " -d postgres"},
			Interval: 10 * time.Second, Timeout: 5 * time.Second, StartPeriod: 30 * time.Second, Retries: 5,
		},
	}
	if _, err := m.eng.Create(ctx, spec); err != nil {
		return nil, m.wrapInstance("create %s: %v", config.ManagedPostgresContainer, err)
	}
	// From here on a failure removes the container again: one that exists without its password file, or without
	// having started, is a restart loop in waiting.
	undo := func() {
		rmCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 15*time.Second)
		defer cancel()
		_ = m.eng.Remove(rmCtx, config.ManagedPostgresContainer)
	}
	if err := m.eng.PutFile(ctx, config.ManagedPostgresContainer, superSecretDir, superSecretName, []byte(password), postgresUID, postgresUID, 0o400); err != nil {
		undo()
		return nil, m.wrapInstance("give %s its password file: %v", config.ManagedPostgresContainer, err)
	}
	if err := m.eng.Start(ctx, config.ManagedPostgresContainer); err != nil {
		undo()
		return nil, m.wrapInstance("start %s: %v", config.ManagedPostgresContainer, err)
	}
	m.log.Info("created the managed PostgreSQL", "container", config.ManagedPostgresContainer, "image", set.Image(), "port", set.Port, "memory", memory)
	d, err := m.eng.Inspect(ctx, config.ManagedPostgresContainer)
	if err != nil {
		return nil, err
	}
	return d, nil
}

// ensureImage pulls the image unless the engine has it, with the credentials the apps file gives its registry (the
// same rule as an app's image: Docker Hub is "docker.io").
func (m *Manager) ensureImage(ctx context.Context, image string) error {
	repo, tag, _ := strings.Cut(image, ":")
	if images, err := m.eng.ListImages(ctx, repo); err == nil {
		for _, img := range images {
			for _, t := range img.RepoTags {
				if t == image {
					return nil
				}
			}
		}
	}
	auth, err := m.registryAuth(repo)
	if err != nil {
		return m.wrapInstance("%v", err)
	}
	m.log.Info("pulling the PostgreSQL image", "image", image)
	if err := m.eng.Pull(ctx, repo, tag, auth, nil); err != nil {
		return m.wrapInstance("pull %s: %v", image, err)
	}
	return nil
}

// registryAuth returns the X-Registry-Auth value for the image's registry, "" when the apps file has no credentials for it.
func (m *Manager) registryAuth(image string) (string, error) {
	host := config.RegistryHost(image)
	for _, r := range m.cfg.Config().Registries {
		if r.Host != host {
			continue
		}
		pw, err := os.ReadFile(r.PasswordFile)
		if err != nil {
			return "", fmt.Errorf("read the registry password for %s", host)
		}
		return docker.RegistryAuth(host, r.Username, strings.TrimSpace(string(pw))), nil
	}
	return "", nil
}

// waitHealthy waits for the HEALTHCHECK to pass. A container that stops, or restarts in a loop, fails at once.
func (m *Manager) waitHealthy(ctx context.Context) error {
	deadline := m.now().Add(m.healthy)
	for {
		d, err := m.eng.Inspect(ctx, config.ManagedPostgresContainer)
		if err != nil {
			return err
		}
		switch {
		case d.State.Restarting:
			return m.wrapInstance("%s is restarting in a loop (exit code %d): see `docker logs %s`", config.ManagedPostgresContainer, d.State.ExitCode, config.ManagedPostgresContainer)
		case !d.State.Running:
			return m.wrapInstance("%s exited with code %d: see `docker logs %s`", config.ManagedPostgresContainer, d.State.ExitCode, config.ManagedPostgresContainer)
		case d.State.Health == "unhealthy":
			return m.wrapInstance("%s reports unhealthy: see `docker logs %s`", config.ManagedPostgresContainer, config.ManagedPostgresContainer)
		case d.State.Health == "healthy" || d.State.Health == "":
			return nil
		}
		if !m.now().Before(deadline) {
			return m.wrapInstance("%s is not healthy after %s", config.ManagedPostgresContainer, m.healthy)
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(m.pollEvery):
		}
	}
}
