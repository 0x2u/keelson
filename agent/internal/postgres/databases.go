package postgres

import (
	"context"
	"errors"
	"fmt"
	"os"
	"strings"

	"filippo.io/age"

	"github.com/0x2u/keelson/agent/internal/appenv"
	"github.com/0x2u/keelson/agent/internal/config"
	"github.com/0x2u/keelson/agent/internal/confmgr"
	"github.com/0x2u/keelson/agent/internal/store"
)

// CreateRequest asks for a database and a role for an app.
type CreateRequest struct {
	// App is the app the database is for; it must be in the apps file.
	App string `json:"app"`
	// Name names the entry of the apps file, the database and its role. Default: the app's name.
	Name string `json:"name"`
	// EnvKey is the variable that receives the URL. Default DATABASE_URL.
	EnvKey string `json:"env_key"`
	// Backup tunes the backups, which are always on. Absent: daily at 03:00, the newest 7, into
	// <data-dir>/backups, encrypted to a key pair the agent generates.
	Backup *BackupRequest `json:"backup"`
	// NewBackupKey replaces the backup recipients of a database that exists with a fresh key pair, whose private
	// half is returned once: for the client that lost the answer of the request that created the database.
	NewBackupKey bool `json:"new_backup_key"`
	// Actor is who asked, for the apps file's history. Set by the API, never read from the body.
	Actor string `json:"-"`
}

// BackupRequest is the optional part of a request that says how the database is backed up. Directory and S3 are
// alternatives; each is the destination the backup code already knows.
type BackupRequest struct {
	// Directory is the root of a local destination: the backups are <directory>/<name>/<name>-<time>.dump.age.
	Directory string `json:"directory"`
	S3        *S3    `json:"s3"`
	Keep      int    `json:"keep"`
	KeepDays  int    `json:"keep_days"`
	Schedule  string `json:"schedule"`
	Timezone  string `json:"timezone"`
	// Recipients are age public keys. None: the agent generates a key pair, keeps the public half and returns the
	// private half once.
	Recipients []string `json:"recipients"`
}

// S3 is an S3-compatible destination, as in the apps file.
type S3 struct {
	Endpoint      string `json:"endpoint"`
	Region        string `json:"region"`
	Bucket        string `json:"bucket"`
	Prefix        string `json:"prefix"`
	AccessKeyID   string `json:"access_key_id"`
	SecretKeyFile string `json:"secret_key_file"`
}

// Result is the answer of a request that created or changed a database. It holds no password: the URL is in the app's
// variables, where it stays.
type Result struct {
	Database DatabaseInfo `json:"database"`
	EnvKey   string       `json:"env_key"`
	// Created is false when the database existed and the request only completed it.
	Created bool `json:"created"`
	// RedeployRequired is always true: the app reads its variables when it starts.
	RedeployRequired bool `json:"redeploy_required"`
	// BackupKey is the age private key backups are readable with. It is returned once, when the agent generated the
	// key pair, and is kept nowhere: not in a file, not in the apps file, not in a log.
	BackupKey string `json:"backup_key,omitempty"`
	// BackupRecipient is its public half, the one in the apps file.
	BackupRecipient string `json:"backup_recipient,omitempty"`
}

// DatabaseInfo describes a managed database without a secret.
type DatabaseInfo struct {
	Name     string `json:"name"`
	App      string `json:"app"`
	Database string `json:"database"`
	User     string `json:"user"`
	// Host and Port are what the app connects to; Mode says how it reaches them: "network" (the instance's name on the
	// keelson network) or "host" (loopback, for an app on the host network).
	Host    string      `json:"host"`
	Port    int         `json:"port"`
	Mode    string      `json:"mode"`
	Network string      `json:"network"`
	Backup  *BackupInfo `json:"backup"`
}

// BackupInfo describes where a database is backed up.
type BackupInfo struct {
	Schedule    string `json:"schedule"`
	Destination string `json:"destination"`
	Keep        int    `json:"keep"`
	Recipients  int    `json:"recipients"`
}

func infoOf(db config.Database, app config.App, hostPort int) DatabaseInfo {
	host, port := config.ManagedPostgresContainer, config.ManagedPostgresPort
	if app.HostNetwork() {
		host, port = "127.0.0.1", hostPort
	}
	info := DatabaseInfo{Name: db.Name, App: db.App, Database: db.Database, User: db.User, Host: host, Port: port, Mode: mode(app), Network: db.Network}
	if b := db.Backups; b != nil {
		info.Backup = &BackupInfo{Schedule: b.Cron, Destination: b.DescribeDestinations(), Keep: b.KeepCount(), Recipients: len(b.Recipients)}
	}
	return info
}

// CreateDatabase makes the database and the role, stores the URL in the app's variables and declares the database in
// the apps file. The order is the order in which a crash does the least harm, and every step can be repeated: the
// instance, the password file, the role and the database, the variable, and last the entry of the apps file, which
// is what the rest of the agent (backups, restores, the listing) goes by. A request repeated after a crash, or after a
// lost answer, finishes what the first started.
func (m *Manager) CreateDatabase(_ context.Context, req CreateRequest) (Result, error) {
	if req.Name == "" {
		req.Name = req.App
	}
	if req.EnvKey == "" {
		req.EnvKey = DefaultEnvKey
	}
	end, err := m.begin()
	if err != nil {
		return Result{}, err
	}
	defer end()
	ctx, cancel := m.opContext()
	defer cancel()

	cfg := m.cfg.Config()
	app, existing, err := m.checkCreate(cfg, req)
	if err != nil {
		return Result{}, err
	}
	var (
		prev     *config.Backups
		identity string
	)
	if existing != nil {
		prev = existing.Backups
	}
	backup, identity, err := m.backupSection(prev, req.Backup, req.NewBackupKey)
	if err != nil {
		return Result{}, err
	}
	entry := config.Database{
		Name: req.Name, Engine: config.EnginePostgres, Managed: true, App: req.App, EnvKey: req.EnvKey,
		Host: config.ManagedPostgresContainer, Port: config.ManagedPostgresPort, Database: req.Name, User: req.Name,
		PasswordFile: m.roleFile(req.Name), Version: cfg.PostgresSettings().Version, Network: config.ManagedPostgresNetwork,
		Backups: &backup,
	}
	if entry, err = entry.Validate(); err != nil {
		return Result{}, &RequestError{Msg: err.Error()}
	}
	if err := m.checkDestination(entry.Backups); err != nil {
		return Result{}, err
	}

	in, superPassword, err := m.ready(ctx)
	if err != nil {
		return Result{}, err
	}
	// The password is written before the role exists: a crash after the role was made must never lose it.
	password, err := readSecret(m.roleFile(req.Name))
	if err != nil {
		if !errors.Is(err, os.ErrNotExist) {
			return Result{}, fmt.Errorf("read the password of %s: %w", req.Name, err)
		}
		if password, err = generatePassword(); err != nil {
			return Result{}, err
		}
		if err := writeSecret(m.roleFile(req.Name), password); err != nil {
			return Result{}, fmt.Errorf("store the password of %s: %w", req.Name, err)
		}
	}
	image := in.detail.Image
	if err := m.createRole(ctx, image, superPassword, req.Name, password); err != nil {
		return Result{}, m.fail("create the role of "+req.Name, err, password, superPassword)
	}
	if err := m.createDatabase(ctx, image, superPassword, req.Name); err != nil {
		return Result{}, m.fail("create the database "+req.Name, err, password, superPassword)
	}
	url, err := appURL(app, in.hostPort, req.Name, password)
	if err != nil {
		return Result{}, err
	}
	if err := m.setVariable(req.App, req.EnvKey, url); err != nil {
		return Result{}, err
	}
	if err := m.declare(entry, req.Actor, "managed database "+req.Name); err != nil {
		return Result{}, err
	}
	m.forgetProbe()
	m.log.Info("managed database ready", "database", req.Name, "app", req.App, "env_key", req.EnvKey, "mode", mode(app), "created", existing == nil)
	res := Result{Database: infoOf(entry, app, in.hostPort), EnvKey: req.EnvKey, Created: existing == nil, RedeployRequired: true}
	if identity != "" {
		res.BackupKey = identity
		res.BackupRecipient = entry.Backups.Recipients[0]
	}
	return res, nil
}

// checkCreate refuses what cannot be done, before anything is. It returns the app and the entry that exists.
func (m *Manager) checkCreate(cfg *config.Config, req CreateRequest) (config.App, *config.Database, error) {
	if !config.ValidName(req.App) {
		return config.App{}, nil, &RequestError{Msg: "app must be the name of an app of the apps file"}
	}
	app, ok := cfg.App(req.App)
	if !ok {
		return config.App{}, nil, ErrUnknownApp
	}
	if !config.ValidName(req.Name) {
		return config.App{}, nil, &RequestError{Msg: "name must match ^[a-z0-9][a-z0-9_-]{0,62}$"}
	}
	if !config.ValidEnvKey(req.EnvKey) {
		return config.App{}, nil, &RequestError{Msg: "env_key must be a variable name (letters, digits and underscores, not starting with a digit, not KEELSON_...)"}
	}
	if why := appenv.ReservedReason(app, req.EnvKey); why != "" {
		return config.App{}, nil, &RequestError{Msg: fmt.Sprintf("env_key %s is reserved: %s", req.EnvKey, why)}
	}
	if !app.HostNetwork() && !app.CanJoinNetworks() {
		return config.App{}, nil, &RequestError{Msg: fmt.Sprintf("app %s has network %q: its containers can neither join the %s network nor reach the host's loopback", app.Name, app.Network, config.ManagedPostgresNetwork)}
	}
	var existing *config.Database
	if db, ok := cfg.Database(req.Name); ok {
		switch {
		case !db.Managed:
			return config.App{}, nil, &ConflictError{Msg: fmt.Sprintf("a database named %s is declared in the apps file by hand: pick another name", req.Name)}
		case db.App != req.App:
			return config.App{}, nil, &ConflictError{Msg: fmt.Sprintf("database %s belongs to app %s", req.Name, db.App)}
		case db.EnvKey != req.EnvKey:
			return config.App{}, nil, &ConflictError{Msg: fmt.Sprintf("database %s already holds its URL in %s: delete it to start again", req.Name, db.EnvKey)}
		}
		existing = &db
	}
	for _, db := range cfg.ManagedDatabases() {
		if db.App == req.App && db.Name != req.Name {
			return config.App{}, nil, &ConflictError{Msg: fmt.Sprintf("app %s already has the managed database %s: an app has one, delete it to create another", req.App, db.Name)}
		}
	}
	return app, existing, nil
}

// backupSection builds the backup section of an entry from the one that exists (if any) and the request. When the
// agent generates a key pair it returns the private key, which the caller hands out once.
func (m *Manager) backupSection(prev *config.Backups, req *BackupRequest, newKey bool) (config.Backups, string, error) {
	keep := DefaultKeep
	b := config.Backups{
		Schedule: config.Schedule{Cron: DefaultSchedule}, Keep: &keep,
		Destinations: []config.BackupDestination{{Local: &config.LocalDestination{Dir: m.defaultBackupDir()}}},
	}
	if prev != nil {
		b = *prev
	}
	if req != nil {
		if req.Directory != "" && req.S3 != nil {
			return b, "", &RequestError{Msg: "backup: set a directory or s3, not both"}
		}
		if req.Schedule != "" {
			b.Cron = req.Schedule
		}
		if req.Timezone != "" {
			b.Timezone = req.Timezone
		}
		if req.Keep != 0 {
			keep := req.Keep
			b.Keep = &keep
		}
		if req.KeepDays != 0 {
			b.KeepDays = req.KeepDays
		}
		switch {
		case req.Directory != "":
			b.Destinations = []config.BackupDestination{{Local: &config.LocalDestination{Dir: req.Directory}}}
		case req.S3 != nil:
			b.Destinations = []config.BackupDestination{{S3: &config.S3Destination{
				Endpoint: req.S3.Endpoint, Region: req.S3.Region, Bucket: req.S3.Bucket, Prefix: req.S3.Prefix,
				AccessKeyID: req.S3.AccessKeyID, SecretKeyFile: req.S3.SecretKeyFile,
			}}}
		}
	}
	var identity string
	switch {
	case req != nil && len(req.Recipients) > 0:
		b.Recipients = req.Recipients
	case prev == nil || len(prev.Recipients) == 0 || newKey:
		id, err := age.GenerateX25519Identity()
		if err != nil {
			return b, "", err
		}
		b.Recipients, identity = []string{id.Recipient().String()}, id.String()
	}
	return b, identity, nil
}

// checkDestination makes sure every local destination can be written now, so that the first backup does not discover
// at 03:00 that the agent may not write there.
func (m *Manager) checkDestination(b *config.Backups) error {
	if b == nil {
		return nil
	}
	for _, d := range b.AllDestinations() {
		if d.Local == nil {
			continue
		}
		dir := d.Local.Dir
		if err := os.MkdirAll(dir, 0o700); err != nil {
			return &RequestError{Msg: fmt.Sprintf("the backup directory %s cannot be created by the agent: %v", dir, err)}
		}
		f, err := os.CreateTemp(dir, ".keelson-check-*")
		if err != nil {
			return &RequestError{Msg: fmt.Sprintf("the backup directory %s cannot be written by the agent: %v", dir, err)}
		}
		f.Close()
		if err := os.Remove(f.Name()); err != nil {
			return err
		}
	}
	return nil
}

// ready brings the instance up and returns it with the superuser's password.
func (m *Manager) ready(ctx context.Context) (instance, string, error) {
	in, err := m.ensureInstance(ctx)
	if err != nil {
		return instance{}, "", err
	}
	pw, err := readSecret(m.superFile())
	if err != nil {
		return instance{}, "", fmt.Errorf("read the superuser password: %w", err)
	}
	return in, pw, nil
}

// fail turns an error of a command run against the server into one the log can hold.
func (m *Manager) fail(what string, err error, secrets ...string) error {
	if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		return err
	}
	return fmt.Errorf("%s: %w", what, m.noSecret(err, secrets...))
}

// setVariable stores the URL in the app's variables (scope app).
func (m *Manager) setVariable(app, key, url string) error {
	_, err := m.env.Apply(app, appenv.Change{Scope: appenv.ScopeApp, Set: map[string]string{key: url}})
	return m.envError(err)
}

func (m *Manager) envError(err error) error {
	var invalid *appenv.InvalidError
	var unknown *appenv.UnknownAppError
	switch {
	case errors.As(err, &invalid):
		var msgs []string
		for _, is := range invalid.Issues {
			msgs = append(msgs, is.Message)
		}
		return &RequestError{Msg: "the variable cannot be stored: " + strings.Join(msgs, "; ")}
	case errors.As(err, &unknown):
		return ErrUnknownApp
	}
	return err
}

// declare writes the database into the apps file (the database key of its app), through the same manager the API
// uses: validated, versioned, applied. It goes into the file that holds the app.
func (m *Manager) declare(db config.Database, actor, comment string) error {
	entry := entryMap(db)
	_, err := confmgr.EditBundle(m.cfg, "", false, confmgr.Meta{Source: store.SourceAPI, Actor: actor, Comment: comment}, func(b *config.Bundle) ([]config.Issue, error) {
		return b.SetAppDatabase(db.App, entry)
	})
	return err
}

// entryMap is the database key of the app as the apps file holds it: only what means something, in the file's own keys.
func entryMap(db config.Database) map[string]any {
	m := map[string]any{"password_file": db.PasswordFile}
	if db.Name != db.App {
		m["name"] = db.Name
	}
	if db.EnvKey != config.DefaultDatabaseEnvKey {
		m["env_key"] = db.EnvKey
	}
	if db.Backups != nil {
		m["backups"] = backupMap(*db.Backups)
	}
	return m
}

func backupMap(b config.Backups) map[string]any {
	m := map[string]any{"schedule": b.Cron, "recipients": b.Recipients, "keep": b.KeepCount()}
	if b.Timezone != "" {
		m["timezone"] = b.Timezone
	}
	if b.KeepDays > 0 {
		m["keep_days"] = b.KeepDays
	}
	if keepPre := b.KeepPreDeployCount(); keepPre > 0 && keepPre != config.DefaultBackupKeepPreDeploy {
		m["keep_pre_deploy"] = keepPre
	}
	if t := b.RunTimeout(); t != 0 && t != config.DefaultBackupTimeout {
		m["timeout"] = t.String()
	}
	if n := b.AlertThreshold(); n > 1 {
		m["alert_after"] = n
	}
	if b.Paused {
		m["paused"] = true
	}
	list := make([]any, len(b.Destinations))
	for i, d := range b.Destinations {
		list[i] = destinationMap(d)
	}
	m["destinations"] = list
	return m
}

func destinationMap(d config.BackupDestination) map[string]any {
	switch {
	case d.Local != nil:
		return map[string]any{"local": map[string]any{"dir": d.Local.Dir}}
	case d.S3 != nil:
		s := d.S3
		dest := map[string]any{"endpoint": s.Endpoint, "region": s.Region, "bucket": s.Bucket, "access_key_id": s.AccessKeyID, "secret_key_file": s.SecretKeyFile}
		if s.Prefix != "" {
			dest["prefix"] = s.Prefix
		}
		return map[string]any{"s3": dest}
	}
	return map[string]any{}
}

// DropRequest asks for a database to be dropped. Confirm must be its name.
type DropRequest struct {
	Name    string `json:"-"`
	Confirm string `json:"confirm"`
	Actor   string `json:"-"`
}

// DropDatabase drops the database and its role (and any database the role made, such as a restore into a new one),
// removes the variable, the password file and the entry of the apps file. The backups are not touched. The entry goes
// last, so a request repeated after a crash finds it and finishes the job.
func (m *Manager) DropDatabase(_ context.Context, req DropRequest) error {
	if req.Confirm != req.Name {
		return &RequestError{Msg: "confirm must be the name of the database: " + req.Name}
	}
	end, err := m.begin()
	if err != nil {
		return err
	}
	defer end()
	ctx, cancel := m.opContext()
	defer cancel()

	db, err := m.managed(req.Name)
	if err != nil {
		return err
	}
	if m.busy(db.Name) {
		return &ConflictError{Msg: "a backup or a restore of " + db.Name + " is running: wait for it to end"}
	}
	d, err := m.inspect(ctx)
	if err != nil {
		return err
	}
	if d != nil {
		in, superPassword, err := m.ready(ctx)
		if err != nil {
			return err
		}
		if err := m.dropDatabases(ctx, in.detail.Image, superPassword, db.Name); err != nil {
			return m.fail("drop the database "+db.Name, err, superPassword)
		}
	} else {
		m.log.Warn("the managed PostgreSQL does not exist: nothing to drop on the server", "database", db.Name)
	}
	if _, err := m.env.Apply(db.App, appenv.Change{Scope: appenv.ScopeApp, Unset: []string{db.EnvKey}}); err != nil {
		var unknown *appenv.UnknownAppError
		if !errors.As(err, &unknown) { // an app that left the apps file has nothing to unset
			return m.envError(err)
		}
	}
	if err := os.Remove(m.roleFile(db.Name)); err != nil && !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("remove the password file of %s: %w", db.Name, err)
	}
	// Removing the database removes its backup job, which the manager asks to acknowledge: the confirmation of this
	// request is that acknowledgement.
	if _, err := confmgr.EditBundle(m.cfg, "", true, confmgr.Meta{Source: store.SourceAPI, Actor: req.Actor, Comment: "dropped managed database " + db.Name}, func(b *config.Bundle) ([]config.Issue, error) {
		return nil, b.DeleteAppDatabase(db.App)
	}); err != nil {
		return err
	}
	m.forgetProbe()
	m.log.Info("managed database dropped", "database", db.Name, "app", db.App)
	return nil
}

// managed returns the managed database of the name from the apps file.
func (m *Manager) managed(name string) (config.Database, error) {
	db, ok := m.cfg.Config().Database(name)
	switch {
	case !ok:
		return config.Database{}, ErrUnknownDatabase
	case !db.Managed:
		return config.Database{}, &RequestError{Msg: fmt.Sprintf("database %s is declared by hand, not created by the agent: it is changed in the apps file", name)}
	}
	return db, nil
}

// RotatePassword gives the role a new password and stores the new URL in the app's variable. The app keeps its old
// connections until they close and cannot open new ones until it is redeployed with the new variable: redeploy at
// once.
func (m *Manager) RotatePassword(_ context.Context, name, actor string) (Result, error) {
	end, err := m.begin()
	if err != nil {
		return Result{}, err
	}
	defer end()
	ctx, cancel := m.opContext()
	defer cancel()

	db, err := m.managed(name)
	if err != nil {
		return Result{}, err
	}
	app, ok := m.cfg.Config().App(db.App)
	if !ok {
		return Result{}, &RequestError{Msg: fmt.Sprintf("app %s of database %s is not in the apps file", db.App, db.Name)}
	}
	if m.busy(db.Name) {
		// A backup or restore authenticates again at every step, with the password it read at its start.
		return Result{}, &ConflictError{Msg: "a backup or a restore of " + db.Name + " is running: wait for it to end"}
	}
	in, superPassword, err := m.ready(ctx)
	if err != nil {
		return Result{}, err
	}
	password, err := generatePassword()
	if err != nil {
		return Result{}, err
	}
	// The file first: the backups read it, and a rotation that stops half way must leave them able to log in once the
	// rotation is repeated, not before the role has changed.
	if err := writeSecret(m.roleFile(db.Name), password); err != nil {
		return Result{}, fmt.Errorf("store the password of %s: %w", db.Name, err)
	}
	if err := m.setPassword(ctx, in.detail.Image, superPassword, db.Name, password); err != nil {
		return Result{}, m.fail("change the password of "+db.Name, err, password, superPassword)
	}
	url, err := appURL(app, in.hostPort, db.Name, password)
	if err != nil {
		return Result{}, err
	}
	if err := m.setVariable(db.App, db.EnvKey, url); err != nil {
		return Result{}, err
	}
	m.log.Info("managed database password rotated", "database", db.Name, "app", db.App)
	return Result{Database: infoOf(db, app, in.hostPort), EnvKey: db.EnvKey, Created: false, RedeployRequired: true}, nil
}

// forgetProbe drops the remembered size: it is no longer what the server holds.
func (m *Manager) forgetProbe() {
	m.mu.Lock()
	m.probe = nil
	m.mu.Unlock()
}
