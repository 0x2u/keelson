package config

import (
	"errors"
	"fmt"
	"net"
	"net/url"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"filippo.io/age"
)

const (
	EnginePostgres = "postgres"

	DefaultBackupKeep = 14
	// DefaultBackupKeepPreDeploy is how many pre-deploy backups (and as many pre-restore ones) are kept apart from
	// the scheduled ones: a deployment's backup must never push a nightly one out of keep.
	DefaultBackupKeepPreDeploy = 5
	// MaxBackupDestinations bounds the destinations of one database: every one of them is written, verified and
	// pruned at each backup.
	MaxBackupDestinations = 4
	DefaultDatabasePort   = 5432
	DefaultDatabaseNet    = "host"
	DefaultBackupTimeout  = 30 * time.Minute
	MaxBackupTimeout      = 6 * time.Hour

	backupJobPrefix  = "backup-"
	restoreJobPrefix = "restore-"
	minPostgresMajor = 10
	maxPostgresMajor = 99
)

var (
	// dbIdentPattern is what the agent accepts as the name of a PostgreSQL database or role: it ends up in a
	// command line, where a leading dash or a space would change its meaning.
	dbIdentPattern = regexp.MustCompile(`^[A-Za-z0-9_][A-Za-z0-9_.-]{0,62}$`)
	hostPattern    = regexp.MustCompile(`^[A-Za-z0-9_][A-Za-z0-9_.:-]*$`)
	networkPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.-]*$`)
	bucketPattern  = regexp.MustCompile(`^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$`)
	sslModes       = map[string]bool{"": true, "disable": true, "allow": true, "prefer": true, "require": true, "verify-ca": true, "verify-full": true}
)

// Database is an existing PostgreSQL server the agent can see, back up and restore. Nothing here is a secret: the
// password and the S3 secret key stay in files. The databases the agent creates itself are not written here: they are
// the database of an app (App.Database), and Config.Databases lists them too once the file is parsed.
type Database struct {
	Name string `yaml:"name"`
	// Project groups the database with the others of a project in the dashboard (see Job.Project). Optional.
	Project  string `yaml:"project"`
	Engine   string `yaml:"engine"`
	Host     string `yaml:"host"`
	Port     int    `yaml:"port"`
	Database string `yaml:"database"`
	User     string `yaml:"user"`
	// PasswordFile holds the password; it is read at every run, so a rotation needs no restart.
	PasswordFile string `yaml:"password_file"`
	// SSLMode is PGSSLMODE: disable, allow, prefer, require, verify-ca or verify-full.
	SSLMode string `yaml:"ssl_mode"`
	// Version is the PostgreSQL major version of the client tools; empty means the server's.
	Version int `yaml:"version"`
	// Network is the Docker network of the throwaway containers that reach the server; default host.
	Network string   `yaml:"network"`
	Backups *Backups `yaml:"backups"`

	// Managed marks a database the agent created on its own PostgreSQL instance (see POST /v1/postgres/databases): a
	// database and a role named like the entry, the instance's host and network, the password in PasswordFile. They
	// are declared by App.Database; App is the app the database was created for and EnvKey the variable holding its
	// URL. The three keys are also read from the legacy `managed: true` entry of a file that could not be migrated
	// (see legacy.go).
	Managed bool   `yaml:"managed"`
	App     string `yaml:"app"`
	EnvKey  string `yaml:"env_key"`

	// synthesized marks an entry made from App.Database.
	synthesized bool
}

// Backups says when a database is backed up, how long backups are kept and where they go.
type Backups struct {
	Schedule `yaml:",inline"`
	// Recipients are age X25519 public keys: the backup can only be read with one of the matching secret keys,
	// which the agent never holds.
	Recipients []string `yaml:"recipients"`
	// Keep is how many of the newest backups are kept; default 14.
	Keep *int `yaml:"keep"`
	// KeepDays also deletes the backups older than that many days; 0 = off. The newest backup is never deleted.
	KeepDays int `yaml:"keep_days"`
	// KeepPreDeploy is how many backups taken before a deployment (a `backup` release step) are kept, apart from keep:
	// the same count applies to the safety backups taken before an overwrite restore. Default 5.
	KeepPreDeploy *int `yaml:"keep_pre_deploy"`
	// Destinations are the places backups go; every one must succeed.
	Destinations []BackupDestination `yaml:"destinations"`
}

// AppDatabase is the database the agent creates on its own PostgreSQL instance for an app: a database and a role of
// the app's name, the URL stored in the variable EnvKey of the app, the password in PasswordFile.
type AppDatabase struct {
	// Name is the name of the database and of its role; default: the name of the app.
	Name string `yaml:"name"`
	// EnvKey is the variable that holds its URL; default DATABASE_URL.
	EnvKey string `yaml:"env_key"`
	// PasswordFile is the file the agent keeps the role's password in. Absolute path.
	PasswordFile string   `yaml:"password_file"`
	Backups      *Backups `yaml:"backups"`
}

// Keys of the app's database.
const (
	// DefaultDatabaseEnvKey is the variable that holds the URL of an app's database.
	DefaultDatabaseEnvKey = "DATABASE_URL"
)

// KeepCount is how many of the newest scheduled backups are kept.
func (b Backups) KeepCount() int {
	if b.Keep == nil {
		return DefaultBackupKeep
	}
	return *b.Keep
}

// KeepPreDeployCount is how many pre-deploy backups are kept.
func (b Backups) KeepPreDeployCount() int {
	if b.KeepPreDeploy == nil {
		return DefaultBackupKeepPreDeploy
	}
	return *b.KeepPreDeploy
}

// Clone returns a copy that shares nothing with b.
func (b *Backups) Clone() *Backups {
	if b == nil {
		return nil
	}
	c := *b
	c.Recipients = append([]string(nil), b.Recipients...)
	c.Destinations = append([]BackupDestination(nil), b.Destinations...)
	if b.Keep != nil {
		v := *b.Keep
		c.Keep = &v
	}
	if b.KeepPreDeploy != nil {
		v := *b.KeepPreDeploy
		c.KeepPreDeploy = &v
	}
	if b.Timeout != nil {
		v := *b.Timeout
		c.Timeout = &v
	}
	if b.AlertAfter != nil {
		v := *b.AlertAfter
		c.AlertAfter = &v
	}
	if b.RealertAfter != nil {
		v := *b.RealertAfter
		c.RealertAfter = &v
	}
	return &c
}

// BackupDestination is exactly one of a local directory or an S3-compatible bucket.
type BackupDestination struct {
	Local *LocalDestination `yaml:"local"`
	S3    *S3Destination    `yaml:"s3"`
}

// LocalDestination is a directory on the agent's host.
type LocalDestination struct {
	Dir string `yaml:"dir"`
}

// S3Destination is a bucket reached path-style (endpoint/bucket/key).
type S3Destination struct {
	Endpoint string `yaml:"endpoint"`
	Region   string `yaml:"region"`
	Bucket   string `yaml:"bucket"`
	Prefix   string `yaml:"prefix"`
	// AccessKeyID is an identifier, not a secret; the secret key is read from SecretKeyFile at every run.
	AccessKeyID   string `yaml:"access_key_id"`
	SecretKeyFile string `yaml:"secret_key_file"`
}

// Database returns the database with the given name.
func (c *Config) Database(name string) (Database, bool) {
	for _, d := range c.Databases {
		if d.Name == name {
			return d, true
		}
	}
	return Database{}, false
}

// Validate checks a database the way the apps file is checked and returns it with the defaults filled in, so a caller
// that builds an entry can have it refused before it changes anything.
func (d Database) Validate() (Database, error) {
	d.Backups = d.Backups.Clone()
	return d, validateDatabase(&d)
}

// BackupJobName is the name of the job that backs up a database.
func BackupJobName(database string) string { return backupJobPrefix + database }

// RestoreJobName is the name the runs of a database's restores are recorded under.
func RestoreJobName(database string) string { return restoreJobPrefix + database }

// Describe names the destination without anything secret: "local:/dir" or "s3:bucket/prefix".
func (d BackupDestination) Describe() string {
	switch {
	case d.Local != nil:
		return "local:" + d.Local.Dir
	case d.S3 != nil:
		return "s3:" + strings.TrimSuffix(d.S3.Bucket+"/"+d.S3.Prefix, "/")
	}
	return ""
}

// databaseIssues validates every database and reports one issue per broken database.
func (c *Config) databaseIssues() []Issue {
	var out []Issue
	seen := map[string]bool{}
	keys := map[string]string{} // "app/env_key" -> the database that owns it
	for i := range c.Databases {
		d := &c.Databases[i]
		err := validateDatabase(d)
		if err == nil && seen[d.Name] {
			err = errors.New("duplicate name")
		}
		if err == nil && d.Managed {
			k := d.App + "/" + d.EnvKey
			if other, dup := keys[k]; dup {
				err = fmt.Errorf("env_key %s of app %s already holds the URL of database %s", d.EnvKey, d.App, other)
			}
			keys[k] = d.Name
		}
		seen[d.Name] = true
		if err != nil {
			if d.synthesized {
				out = append(out, Issue{Severity: SeverityError, Path: "apps[" + d.App + "].database", Message: fmt.Sprintf("app %q: database: %v", d.App, err)})
				continue
			}
			out = append(out, Issue{Severity: SeverityError, Path: "databases[" + d.Name + "]", Message: fmt.Sprintf("database %q: %v", d.Name, err)})
		}
	}
	return out
}

func validateDatabase(d *Database) error {
	if !namePattern.MatchString(d.Name) {
		return fmt.Errorf("name must match %s", namePattern)
	}
	if d.Project != "" && !namePattern.MatchString(d.Project) {
		return fmt.Errorf("project must match %s", namePattern)
	}
	switch d.Engine {
	case "":
		d.Engine = EnginePostgres
	case EnginePostgres:
	default:
		return fmt.Errorf("engine %q is not supported: only %s", d.Engine, EnginePostgres)
	}
	if !hostPattern.MatchString(d.Host) {
		return errors.New("host is required (a name or an address, no spaces)")
	}
	switch {
	case d.Port == 0:
		d.Port = DefaultDatabasePort
	case d.Port < 1 || d.Port > 65535:
		return errors.New("port must be between 1 and 65535")
	}
	if !dbIdentPattern.MatchString(d.Database) {
		return fmt.Errorf("database is required and must match %s", dbIdentPattern)
	}
	if !dbIdentPattern.MatchString(d.User) {
		return fmt.Errorf("user is required and must match %s", dbIdentPattern)
	}
	if d.PasswordFile != "" && !filepath.IsAbs(d.PasswordFile) {
		return errors.New("password_file must be an absolute path")
	}
	if !sslModes[d.SSLMode] {
		return fmt.Errorf("ssl_mode %q must be one of disable, allow, prefer, require, verify-ca, verify-full", d.SSLMode)
	}
	if d.Version != 0 && (d.Version < minPostgresMajor || d.Version > maxPostgresMajor) {
		return fmt.Errorf("version must be a PostgreSQL major version between %d and %d", minPostgresMajor, maxPostgresMajor)
	}
	switch {
	case d.Network == "":
		d.Network = DefaultDatabaseNet
	case !networkPattern.MatchString(d.Network):
		return fmt.Errorf("network %q is not a valid Docker network name", d.Network)
	}
	if err := validateManaged(d); err != nil {
		return err
	}
	if d.Backups != nil {
		if err := validateBackups(d.Backups); err != nil {
			return fmt.Errorf("backups: %w", err)
		}
	}
	return nil
}

// validateManaged holds a managed entry to exactly what the agent writes: the agent drops and re-passwords the role
// and the database an entry names, so a hand-edited entry must not be able to point that at another database.
func validateManaged(d *Database) error {
	if !d.Managed {
		if d.App != "" || d.EnvKey != "" {
			return errors.New("app and env_key belong to managed databases (managed: true)")
		}
		return nil
	}
	switch {
	case !namePattern.MatchString(d.App):
		return fmt.Errorf("a managed database needs the app it was created for (app must match %s)", namePattern)
	case !ValidEnvKey(d.EnvKey):
		return errors.New("a managed database needs env_key, the variable that holds its URL (letters, digits and underscores, not KEELSON_...)")
	case d.Database != d.Name || d.User != d.Name:
		return errors.New("a managed database has the same name, database and user")
	case d.Host != ManagedPostgresContainer || d.Port != ManagedPostgresPort || d.Network != ManagedPostgresNetwork:
		return fmt.Errorf("a managed database lives on host %s, port %d, network %s", ManagedPostgresContainer, ManagedPostgresPort, ManagedPostgresNetwork)
	case d.PasswordFile == "":
		return errors.New("a managed database needs password_file: the file the agent keeps its password in")
	case d.Name == "postgres" || d.Name == ManagedPostgresSuperuser || strings.HasPrefix(d.Name, "pg_") || strings.HasPrefix(d.Name, "template"):
		return fmt.Errorf("%q is reserved by PostgreSQL or by the agent", d.Name)
	}
	return nil
}

func validateBackups(b *Backups) error {
	if err := b.Schedule.validate(backupLimits); err != nil {
		return err
	}
	if len(b.Recipients) == 0 {
		return errors.New("recipients is required: at least one age public key (age1...), so a backup is never stored in the clear")
	}
	for _, r := range b.Recipients {
		if _, err := age.ParseX25519Recipient(r); err != nil {
			return fmt.Errorf("recipient %q is not an age X25519 public key (age1...)", r)
		}
	}
	switch {
	case b.Keep == nil:
		n := DefaultBackupKeep
		b.Keep = &n
	case *b.Keep < 1:
		return errors.New("keep must be at least 1")
	}
	if b.KeepDays < 0 {
		return errors.New("keep_days must not be negative")
	}
	switch {
	case b.KeepPreDeploy == nil:
		n := DefaultBackupKeepPreDeploy
		b.KeepPreDeploy = &n
	case *b.KeepPreDeploy < 1:
		return errors.New("keep_pre_deploy must be at least 1")
	}
	return validateDestinations(b)
}

// validateDestinations accepts a list of one to MaxBackupDestinations places, no place twice: a backup written twice to
// one directory would only fail on its own key.
func validateDestinations(b *Backups) error {
	switch {
	case len(b.Destinations) == 0:
		return errors.New("destinations: set at least one place, each exactly one of local or s3")
	case len(b.Destinations) > MaxBackupDestinations:
		return fmt.Errorf("destinations: at most %d", MaxBackupDestinations)
	}
	seen := map[string]bool{}
	for i, d := range b.Destinations {
		if err := validateDestination(d); err != nil {
			return fmt.Errorf("destinations[%d]: %w", i, err)
		}
		if seen[d.Describe()] {
			return fmt.Errorf("destinations[%d]: %s is listed twice", i, d.Describe())
		}
		seen[d.Describe()] = true
	}
	return nil
}

// AllDestinations is every place a backup is written.
func (b Backups) AllDestinations() []BackupDestination { return b.Destinations }

// DescribeDestinations names every destination without anything secret, joined by ", ".
func (b Backups) DescribeDestinations() string {
	names := make([]string, len(b.Destinations))
	for i, d := range b.Destinations {
		names[i] = d.Describe()
	}
	return strings.Join(names, ", ")
}

func validateDestination(d BackupDestination) error {
	switch {
	case d.Local != nil && d.S3 != nil, d.Local == nil && d.S3 == nil:
		return errors.New("destination: set exactly one of local or s3")
	case d.Local != nil:
		if !filepath.IsAbs(d.Local.Dir) {
			return errors.New("destination local dir must be an absolute path")
		}
		return nil
	}
	return validateS3(d.S3)
}

func validateS3(s *S3Destination) error {
	u, err := url.Parse(s.Endpoint)
	switch {
	case err != nil || u.Host == "" || (u.Scheme != "https" && u.Scheme != "http"):
		return fmt.Errorf("destination s3 endpoint %q must be an https URL", s.Endpoint)
	case u.Scheme == "http" && !loopbackHost(u.Hostname()):
		return fmt.Errorf("destination s3 endpoint %q must be https: plain http is only accepted for a loopback host", s.Endpoint)
	case (u.Path != "" && u.Path != "/") || u.RawQuery != "" || u.User != nil:
		return fmt.Errorf("destination s3 endpoint %q must be a bare scheme://host[:port]", s.Endpoint)
	}
	if s.Region == "" {
		return errors.New("destination s3 region is required")
	}
	if !bucketPattern.MatchString(s.Bucket) {
		return fmt.Errorf("destination s3 bucket is required and must match %s", bucketPattern)
	}
	if s.Prefix != "" {
		if strings.HasPrefix(s.Prefix, "/") || strings.HasSuffix(s.Prefix, "/") || strings.Contains(s.Prefix, "//") {
			return errors.New("destination s3 prefix must not start or end with a slash")
		}
		for _, seg := range strings.Split(s.Prefix, "/") {
			if seg == "." || seg == ".." {
				return errors.New("destination s3 prefix must not contain . or .. segments")
			}
		}
	}
	if s.AccessKeyID == "" {
		return errors.New("destination s3 access_key_id is required")
	}
	if !filepath.IsAbs(s.SecretKeyFile) {
		return errors.New("destination s3 secret_key_file is required and must be an absolute path")
	}
	return nil
}

func loopbackHost(host string) bool {
	if host == "localhost" {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

// backupJobs returns the job of every database that has a backups section. The scheduler runs them like any job; they
// are never part of the YAML document.
func (c *Config) backupJobs() []Job {
	var out []Job
	for _, d := range c.Databases {
		if d.Backups == nil {
			continue
		}
		out = append(out, Job{
			Name: BackupJobName(d.Name), Schedule: d.Backups.Schedule, Database: d.Name, Managed: true, Project: d.Project,
		})
	}
	return out
}

// appDatabaseIssues validates the database of every app that has one, and lists it in Databases (after the ones the
// file declares) as the managed entry the rest of the agent works with. It can run again on a configuration it already
// ran on: the entries it made before are replaced.
func (c *Config) appDatabaseIssues() []Issue {
	declared := make([]Database, 0, len(c.Databases))
	for _, d := range c.Databases {
		if !d.synthesized {
			declared = append(declared, d)
		}
	}
	c.Databases = declared
	var out []Issue
	version := c.PostgresSettings().Version
	for i := range c.Apps {
		a := &c.Apps[i]
		if a.Database == nil {
			continue
		}
		d := a.Database
		if d.Name == "" {
			d.Name = a.Name
		}
		if d.EnvKey == "" {
			d.EnvKey = DefaultDatabaseEnvKey
		}
		switch {
		case a.Parent != "":
			out = append(out, Issue{Severity: SeverityError, Path: "apps[" + a.Name + "].database", Message: fmt.Sprintf("app %q: database: an instance of a preview has no database", a.Name)})
			continue
		case d.PasswordFile == "":
			out = append(out, Issue{Severity: SeverityError, Path: "apps[" + a.Name + "].database", Message: fmt.Sprintf("app %q: database: password_file is required: the file the agent keeps its password in", a.Name)})
			continue
		}
		c.Databases = append(c.Databases, Database{
			Name: d.Name, Project: effectiveProject(*a), Engine: EnginePostgres, Host: ManagedPostgresContainer, Port: ManagedPostgresPort,
			Database: d.Name, User: d.Name, PasswordFile: d.PasswordFile, Version: version, Network: ManagedPostgresNetwork,
			Backups: d.Backups, Managed: true, App: a.Name, EnvKey: d.EnvKey, synthesized: true,
		})
	}
	return out
}

// Synthesized says the entry was made from the database of an app (App.Database), not declared in databases.
func (d Database) Synthesized() bool { return d.synthesized }
