package config

import (
	"errors"
	"fmt"
	"regexp"
	"strings"
)

// The managed PostgreSQL: one container per server, a database and a role per app. These names are fixed: they are
// what the agent recognises as its own, and what an app's URL points at.
const (
	// ManagedPostgresContainer is the instance's container, and the host an app on a Docker network connects to.
	ManagedPostgresContainer = "keelson-postgres"
	// ManagedPostgresNetwork is the user-defined network the instance lives on; apps with a managed database join it.
	ManagedPostgresNetwork = "keelson"
	// ManagedPostgresVolume is the named volume holding the data. It is never removed by the agent.
	ManagedPostgresVolume = "keelson-postgres-data"
	// ManagedPostgresSuperuser is the instance's superuser role. The agent connects with it to create roles and databases.
	ManagedPostgresSuperuser = "keelson"

	// ManagedPostgresPort is the port PostgreSQL listens on inside the container (and the port of the network URL).
	ManagedPostgresPort = 5432

	DefaultPostgresMajor  = 16
	MinPostgresMajor      = 14
	MaxPostgresMajor      = 17
	DefaultPostgresPort   = 5442
	DefaultPostgresMemory = 512 << 20
	minPostgresMemory     = 128 << 20
	maxPostgresMemory     = 1 << 40
)

// envKeyPattern is what appenv accepts as the name of a variable (config cannot import appenv).
var envKeyPattern = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]{0,127}$`)

// ValidEnvKey reports whether s may name the variable a managed database's URL is stored under.
func ValidEnvKey(s string) bool {
	return envKeyPattern.MatchString(s) && !strings.HasPrefix(s, "KEELSON_")
}

// ManagedPostgres are the choices of the managed PostgreSQL instance (the managed_postgres section), set once when the
// instance is created. Every key left out is its default. Changing them later does not touch a container that exists:
// see docs/reference/databases.md.
type ManagedPostgres struct {
	// Version is the PostgreSQL major version, run as postgres:<version>-alpine. Default 16.
	Version *int `yaml:"version"`
	// Port is the loopback port the instance is published on, for apps on the host network. Default 5442.
	Port *int `yaml:"port"`
	// Memory caps the container, such as "512m" or "1g". Default 512m; the server's settings follow it.
	Memory *Size `yaml:"memory"`
}

// PostgresSettings are the settings of the managed PostgreSQL with every default filled in.
type PostgresSettings struct {
	Version int
	Port    int
	Memory  Size
}

// PostgresSettings returns the settings of the managed PostgreSQL with the defaults filled in.
func (c *Config) PostgresSettings() PostgresSettings {
	p := PostgresSettings{Version: DefaultPostgresMajor, Port: DefaultPostgresPort, Memory: DefaultPostgresMemory}
	if m := c.ManagedPostgres; m != nil {
		if m.Version != nil {
			p.Version = *m.Version
		}
		if m.Port != nil {
			p.Port = *m.Port
		}
		if m.Memory != nil {
			p.Memory = *m.Memory
		}
	}
	return p
}

// Image is the image of the instance.
func (p PostgresSettings) Image() string { return fmt.Sprintf("postgres:%d-alpine", p.Version) }

// MemoryBytes is the memory cap in bytes.
func (p PostgresSettings) MemoryBytes() int64 { return p.Memory.Bytes() }

func validateManagedPostgres(p *ManagedPostgres) error {
	if p == nil {
		return nil
	}
	if p.Version != nil && (*p.Version < MinPostgresMajor || *p.Version > MaxPostgresMajor) {
		return fmt.Errorf("managed_postgres: version must be a major version between %d and %d", MinPostgresMajor, MaxPostgresMajor)
	}
	if p.Port != nil && (*p.Port < 1024 || *p.Port > 65535) {
		return errors.New("managed_postgres: port must be between 1024 and 65535")
	}
	if p.Memory != nil {
		switch n := p.Memory.Bytes(); {
		case n < minPostgresMemory:
			return errors.New("managed_postgres: memory must be at least 128m")
		case n > maxPostgresMemory:
			return errors.New("managed_postgres: memory is too large")
		}
	}
	return nil
}

// ManagedDatabases returns the databases the agent created (the database of an app), in file order.
func (c *Config) ManagedDatabases() []Database {
	var out []Database
	for _, d := range c.Databases {
		if d.Managed {
			out = append(out, d)
		}
	}
	return out
}

// ManagedDatabaseKeys returns the names of the variables that hold the URLs of the app's managed databases: the
// ones a build argument must never carry.
func (c *Config) ManagedDatabaseKeys(app string) []string {
	var keys []string
	for _, d := range c.Databases {
		if d.Managed && d.App == app {
			keys = append(keys, d.EnvKey)
		}
	}
	return keys
}

// HostNetwork reports whether the app shares the server's network: it reaches the managed PostgreSQL on loopback.
func (a App) HostNetwork() bool { return a.Network == "host" }

// CanJoinNetworks reports whether the app's containers can be attached to a user-defined network: not with the
// host's network, none, or another container's.
func (a App) CanJoinNetworks() bool {
	return a.Network != "host" && a.Network != "none" && !strings.HasPrefix(a.Network, "container:")
}

// ExtraNetworks lists the Docker networks the containers of an app join besides the one its file gives them: the
// managed PostgreSQL's, when the app has a managed database. An app on the host network reaches the instance on
// loopback instead, and the instance of a preview never gets a database.
func (c *Config) ExtraNetworks(a App) []string {
	if a.Parent != "" || !a.CanJoinNetworks() || a.Network == ManagedPostgresNetwork {
		return nil
	}
	for _, d := range c.Databases {
		if d.Managed && d.App == a.Name {
			return []string{ManagedPostgresNetwork}
		}
	}
	return nil
}
