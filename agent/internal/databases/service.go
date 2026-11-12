// Package databases backs up and restores the PostgreSQL servers an apps file declares. Every command runs in a
// throwaway container from the official image of the server's major version; the agent only moves files: it
// encrypts a dump to age public keys, keeps it in a local directory or an S3-compatible bucket, and decrypts it
// again only when an operator hands it the secret key for one restore.
package databases

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/0x2u/keelson/agent/internal/config"
	"github.com/0x2u/keelson/agent/internal/docker"
	"github.com/0x2u/keelson/agent/internal/schedule"
	"github.com/0x2u/keelson/agent/internal/store"
)

const (
	// jobLabel marks the throwaway containers so that leftovers of a crashed agent are removed at the next start,
	// like those of container jobs.
	jobLabel = "keelson.job"
	// probeImage runs the first query against a server whose version is not configured: any client can ask.
	probeImage = "postgres:17-alpine"

	versionCacheTTL = 10 * time.Minute
	liveCacheTTL    = time.Minute
	liveTimeout     = time.Minute
	restoreTimeout  = config.MaxBackupTimeout
	keepRestoreRuns = 50
	stagingDir      = "backup-staging"
)

// s3ResponseHeaderTimeout is how long an S3 store may take to answer once a request has been sent.
const s3ResponseHeaderTimeout = time.Minute

// Errors the API maps to answers.
var (
	ErrUnknownDatabase = errors.New("unknown database")
	ErrRestoreBusy     = errors.New("a restore is already running for this database")
	ErrTestBusy        = errors.New("a restore test is already running for this database")
	ErrBackupBusy      = errors.New("a backup is running for this database: wait for it to end")
	// errBackupRunning is beginBackup saying another backup of the database is under way: the caller waits for it.
	errBackupRunning = errors.New("another backup of this database is under way")
	ErrShuttingDown  = errors.New("the agent is shutting down")
)

// Failures of what the agent reaches out to. Their text names paths, hosts and what the server printed, so the API
// answers with the kind only and keeps the text in the agent's log.
var (
	ErrSecret      = errors.New("a secret file could not be read")
	ErrDestination = errors.New("the backup destination could not be read")
	ErrServer      = errors.New("the database server could not be queried")
)

// classified tags err with kind: errors.Is finds both, and the text is err's own.
type classified struct{ kind, err error }

func classify(kind, err error) error { return classified{kind, err} }

func (c classified) Error() string   { return c.err.Error() }
func (c classified) Unwrap() []error { return []error{c.kind, c.err} }

// RequestError is a restore request that cannot be accepted; nothing was started.
type RequestError struct{ Msg string }

func (e *RequestError) Error() string { return e.Msg }

// Engine is the part of the Docker engine the service needs.
type Engine interface {
	docker.Runner
	ListImages(ctx context.Context, repo string) ([]docker.Image, error)
	Pull(ctx context.Context, repo, ref, auth string, progress func(string)) error
}

// Options builds a Service.
type Options struct {
	Config  *config.Config
	Store   *store.Store
	Engine  Engine
	DataDir string
	Log     *slog.Logger
}

// Service runs backups and restores. It is safe for concurrent use.
type Service struct {
	eng   Engine
	store *store.Store
	dir   string
	log   *slog.Logger
	now   func() time.Time
	// cfg is replaced when the configuration is reloaded: read it through config().
	cfg atomic.Pointer[config.Config]
	// newDest builds the destination of a backup section; tests replace it.
	newDest func(config.BackupDestination) (Destination, error)
	// user is the "uid:gid" the throwaway containers run as, so they can write the staging directory.
	user string
	// sweepWait is the wait between attempts to drop the scratch databases of a crashed restore test; tests shorten it.
	sweepWait time.Duration

	// ctx ends when the agent shuts down: every backup and restore runs under it, so the throwaway container of
	// a run is removed before the process exits.
	ctx    context.Context
	cancel context.CancelFunc
	wg     sync.WaitGroup

	mu        sync.Mutex
	majors    map[string]cached[int]
	lives     map[string]cached[Live]
	liveFlies map[string]*liveFlight
	restoring map[string]bool
	// testing holds the databases a restore test is running for. A test only reads the live database, so a backup may run
	// beside it; a restore over it would change what it counts.
	testing map[string]bool
	backups map[string]int
	closed  bool
}

type cached[T any] struct {
	value T
	at    time.Time
}

// New returns a Service. It removes what a crashed agent left in the staging directory: the dump of a database,
// in the clear, must not outlive its run.
func New(o Options) *Service {
	if o.Log == nil {
		o.Log = slog.Default()
	}
	hc := newHTTPClient(s3ResponseHeaderTimeout)
	// The staging directory is bind-mounted: Docker reads a relative path as a volume name.
	dir, err := filepath.Abs(o.DataDir)
	if err != nil {
		dir = o.DataDir
	}
	ctx, cancel := context.WithCancel(context.Background())
	s := &Service{
		eng: o.Engine, store: o.Store, dir: dir, log: o.Log, now: time.Now, ctx: ctx, cancel: cancel,
		user: fmt.Sprintf("%d:%d", os.Getuid(), os.Getgid()), sweepWait: defaultSweepWait,
		majors: map[string]cached[int]{}, lives: map[string]cached[Live]{}, liveFlies: map[string]*liveFlight{}, restoring: map[string]bool{}, testing: map[string]bool{}, backups: map[string]int{},
		newDest: func(d config.BackupDestination) (Destination, error) { return newDestination(d, hc) },
	}
	s.cfg.Store(o.Config)
	if err := os.RemoveAll(filepath.Join(o.DataDir, stagingDir)); err != nil {
		s.log.Warn("could not clear the backup staging directory", "err", err)
	}
	return s
}

func (s *Service) config() *config.Config { return s.cfg.Load() }

// Prepare implements confmgr.Applier: databases can always follow a new configuration. A backup or a restore in
// progress finishes with the definition it started with.
func (s *Service) Prepare(_, next *config.Config) (func(), error) {
	return func() { s.cfg.Store(next) }, nil
}

// Shutdown cancels the backups and restores that are running and waits for them to end, up to the timeout. Their
// containers are removed and their runs recorded as failed before it returns true. Nothing new is accepted.
func (s *Service) Shutdown(timeout time.Duration) bool {
	s.mu.Lock()
	s.closed = true
	s.mu.Unlock()
	s.cancel()
	done := make(chan struct{})
	go func() { s.wg.Wait(); close(done) }()
	select {
	case <-done:
		return true
	case <-time.After(timeout):
		return false
	}
}

// beginBackup registers a backup of a database. A restore of the same database running now makes it refuse: a
// dump taken while the restore drops and recreates the tables would be half of each.
func (s *Service) beginBackup(name string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	switch {
	case s.closed:
		return ErrShuttingDown
	case s.restoring[name]:
		return fmt.Errorf("backup of %s refused: %w", name, ErrRestoreBusy)
	case s.backups[name] > 0:
		return errBackupRunning
	}
	s.backups[name]++
	s.wg.Add(1)
	return nil
}

func (s *Service) endBackup(name string) {
	s.mu.Lock()
	if s.backups[name]--; s.backups[name] <= 0 {
		delete(s.backups, name)
	}
	s.mu.Unlock()
	s.wg.Done()
}

func (s *Service) database(name string) (config.Database, error) {
	db, ok := s.config().Database(name)
	if !ok {
		return config.Database{}, ErrUnknownDatabase
	}
	return db, nil
}

// Busy reports whether a backup or a restore of the database is running now: dropping the database then would cut
// it short.
func (s *Service) Busy(name string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.restoring[name] || s.testing[name] || s.backups[name] > 0
}

// --- what the API shows ------------------------------------------------------------------------------------

// View describes a database for the API. It has no secret and no path to one.
type View struct {
	Name string `json:"name"`
	// Project is the database's label: written in the entry, or the project of the file it is in. Empty when neither says.
	Project     string      `json:"project,omitempty"`
	Engine      string      `json:"engine"`
	Host        string      `json:"host"`
	Port        int         `json:"port"`
	Database    string      `json:"database"`
	User        string      `json:"user"`
	Version     int         `json:"version"`
	Network     string      `json:"network"`
	HasPassword bool        `json:"has_password"`
	Backup      *BackupView `json:"backup"`
	// Managed, App and EnvKey describe a database the agent created (managed: true): the app it is for and the
	// variable that holds its URL. App and EnvKey are empty otherwise.
	Managed bool   `json:"managed"`
	App     string `json:"app"`
	EnvKey  string `json:"env_key"`
}

// BackupView describes a database's backup section and its job.
type BackupView struct {
	Schedule    string     `json:"schedule"`
	Timezone    string     `json:"timezone"`
	Keep        int        `json:"keep"`
	KeepDays    int        `json:"keep_days"`
	Paused      bool       `json:"paused"`
	Destination string     `json:"destination"`
	Recipients  int        `json:"recipients"`
	Job         string     `json:"job"`
	NextRun     *time.Time `json:"next_run"`
	LastRun     *LastRun   `json:"last_run"`
}

// LastRun is how the latest run of a backup job went.
type LastRun struct {
	ID         string     `json:"id"`
	Status     string     `json:"status"`
	StartedAt  time.Time  `json:"started_at"`
	FinishedAt *time.Time `json:"finished_at"`
	Detail     string     `json:"detail"`
}

// Databases lists every configured database.
func (s *Service) Databases(ctx context.Context) ([]View, error) {
	cfg := s.config()
	out := make([]View, 0, len(cfg.Databases))
	for _, d := range cfg.Databases {
		v := View{
			Name: d.Name, Project: d.Project, Engine: d.Engine, Host: d.Host, Port: d.Port, Database: d.Database, User: d.User,
			Version: d.Version, Network: d.Network, HasPassword: d.PasswordFile != "",
			Managed: d.Managed, App: d.App, EnvKey: d.EnvKey,
		}
		if b := d.Backups; b != nil {
			tz := b.Timezone
			if tz == "" {
				tz = "UTC"
			}
			job := config.BackupJobName(d.Name)
			bv := &BackupView{
				Schedule: b.Cron, Timezone: tz, Keep: b.KeepCount(), KeepDays: b.KeepDays, Paused: b.Paused,
				Destination: b.DescribeDestinations(), Recipients: len(b.Recipients), Job: job,
			}
			if sched, err := schedule.Parse(b.Cron, b.Location()); err == nil && !b.Paused {
				next := sched.Next(s.now()).UTC()
				bv.NextRun = &next
			}
			runs, err := s.store.JobRuns(ctx, job, 1)
			if err != nil {
				return nil, err
			}
			if len(runs) > 0 {
				r := runs[0]
				bv.LastRun = &LastRun{ID: r.ID, Status: r.Status, StartedAt: r.StartedAt, FinishedAt: r.FinishedAt, Detail: r.Detail}
			}
			v.Backup = bv
		}
		out = append(out, v)
	}
	return out, nil
}

// Backups lists the backups of a database, newest first, from the destination. A database without a backup
// section has none.
func (s *Service) Backups(ctx context.Context, name string) ([]Backup, error) {
	db, err := s.database(name)
	if err != nil {
		return nil, err
	}
	if db.Backups == nil {
		return []Backup{}, nil
	}
	dests, err := s.newDests(db.Backups)
	if err != nil {
		return nil, err
	}
	// The first destination is the one the operator listed first: the list shows what it holds. Every destination holds
	// every backup (a backup that did not reach all of them failed), so any one tells the same story.
	objects, err := dests[0].dest.List(ctx, db.Name+"/")
	if err != nil {
		return nil, classify(ErrDestination, err)
	}
	return append([]Backup{}, backupsOf(db.Name, objects)...), nil
}

// Restores returns the recent restore runs of a database, newest first.
func (s *Service) Restores(ctx context.Context, name string, limit int) ([]store.JobRun, error) {
	if _, err := s.database(name); err != nil {
		return nil, err
	}
	return s.store.JobRuns(ctx, restoreJobName(name), limit)
}

func restoreJobName(database string) string { return config.RestoreJobName(database) }

// Live is what the server itself says.
type Live struct {
	ServerVersion string `json:"server_version"`
	SizeBytes     int64  `json:"size_bytes"`
	ClientImage   string `json:"client_image"`
}

// liveFlight is a probe in progress: everyone who asks for the same server meanwhile waits for its answer.
type liveFlight struct {
	done chan struct{}
	live Live
	err  error
}

// Live asks the server for its version and the size of the database. The answer is kept for a minute, and one
// probe at a time runs per server: concurrent callers (several dashboards loading the page) share it instead of
// each starting a container. The probe runs under the agent's context, not under a caller's, so a caller that goes
// away does not fail the others.
func (s *Service) Live(ctx context.Context, name string) (Live, error) {
	db, err := s.database(name)
	if err != nil {
		return Live{}, err
	}
	key := connectionKey(db)
	s.mu.Lock()
	if c, ok := s.lives[key]; ok && s.now().Sub(c.at) < liveCacheTTL {
		s.mu.Unlock()
		return c.value, nil
	}
	f, running := s.liveFlies[key]
	if !running {
		if s.closed {
			s.mu.Unlock()
			return Live{}, ErrShuttingDown
		}
		f = &liveFlight{done: make(chan struct{})}
		s.liveFlies[key] = f
		s.wg.Add(1)
		go s.probeLive(db, key, f)
	}
	s.mu.Unlock()

	select {
	case <-f.done:
		return f.live, f.err
	case <-ctx.Done():
		return Live{}, ctx.Err()
	}
}

// probeLive runs the probe of a flight, remembers a good answer and wakes the callers.
func (s *Service) probeLive(db config.Database, key string, f *liveFlight) {
	defer s.wg.Done()
	f.live, f.err = s.probe(db, key)
	s.mu.Lock()
	delete(s.liveFlies, key)
	s.mu.Unlock()
	close(f.done)
}

func (s *Service) probe(db config.Database, key string) (Live, error) {
	ctx, cancel := context.WithTimeout(s.ctx, liveTimeout)
	defer cancel()
	password, err := readPassword(db)
	if err != nil {
		return Live{}, err
	}
	image := probeImage
	if db.Version != 0 {
		image = versionImage(db.Version)
	}
	info, err := s.queryServer(ctx, db, password, image)
	if err != nil {
		return Live{}, classify(ErrServer, err)
	}
	live := Live{ServerVersion: info.version, SizeBytes: info.sizeBytes, ClientImage: versionImage(info.major)}
	if db.Version != 0 {
		live.ClientImage = image
	}
	s.mu.Lock()
	s.lives[key] = cached[Live]{live, s.now()}
	if db.Version == 0 {
		s.majors[key] = cached[int]{info.major, s.now()}
	}
	s.mu.Unlock()
	return live, nil
}

// --- throwaway containers ----------------------------------------------------------------------------------

func versionImage(major int) string { return fmt.Sprintf("postgres:%d-alpine", major) }

// connectionKey names a connection without its secret: it keys what is remembered about a server.
func connectionKey(db config.Database) string {
	return strings.Join([]string{db.Name, db.Host, strconv.Itoa(db.Port), db.Database, db.User, db.Network, db.SSLMode}, "|")
}

// readPassword reads the password file now, so a rotated password is used by the next run.
func readPassword(db config.Database) (string, error) {
	if db.PasswordFile == "" {
		return "", nil
	}
	p, err := readSecretFile(db.PasswordFile)
	if err != nil {
		return "", classify(ErrSecret, fmt.Errorf("read the password of %s: %w", db.Name, err))
	}
	return p, nil
}

// conn is the connection arguments of psql, pg_dump and pg_restore.
func conn(db config.Database, dbname string) []string {
	return []string{"-h", db.Host, "-p", strconv.Itoa(db.Port), "-U", db.User, "-d", dbname, "--no-password"}
}

// pg runs one command in a throwaway container from image, on the database's network, and returns what it
// printed. A non-zero exit is an error that ends with the last line of the output, which is where PostgreSQL
// says why. binds mount the staging directory. The password is the container's PGPASSWORD for the seconds the
// command runs: it is in no argument and in no file.
func (s *Service) pg(ctx context.Context, db config.Database, password, image string, binds, cmd []string) ([]string, error) {
	env := []string{"PGCONNECT_TIMEOUT=15"}
	if password != "" {
		env = append(env, "PGPASSWORD="+password)
	}
	if db.SSLMode != "" {
		env = append(env, "PGSSLMODE="+db.SSLMode)
	}
	var (
		mu    sync.Mutex
		lines []string
		last  string
	)
	code, err := docker.RunThrowaway(ctx, s.eng, s.log, docker.ContainerSpec{
		Name:          fmt.Sprintf("keelson-db-%s-%s", db.Name, store.NewID()),
		Image:         image,
		Env:           env,
		Labels:        map[string]string{jobLabel: "true", "keelson.database": db.Name},
		Cmd:           cmd,
		Binds:         binds,
		NetworkMode:   db.Network,
		RestartPolicy: "no",
		StopTimeout:   10,
		User:          s.user,
	}, func(line string) {
		mu.Lock()
		defer mu.Unlock()
		lines = append(lines, line)
		if t := strings.TrimSpace(line); t != "" {
			last = t
		}
	})
	mu.Lock()
	defer mu.Unlock()
	switch {
	case ctx.Err() != nil:
		return lines, ctx.Err()
	case err != nil:
		return lines, err
	case code != 0:
		return lines, fmt.Errorf("%s exited with code %d: %s", cmd[0], code, last)
	}
	return lines, nil
}

// ensureImage pulls image unless the engine already has it. Registries are anonymous: the images are the
// official PostgreSQL ones.
func (s *Service) ensureImage(ctx context.Context, image string, progress func(string)) error {
	repo, tag, _ := strings.Cut(image, ":")
	if images, err := s.eng.ListImages(ctx, repo); err == nil {
		for _, img := range images {
			for _, t := range img.RepoTags {
				if t == image {
					return nil
				}
			}
		}
	}
	if progress != nil {
		progress("pulling " + image)
	}
	if err := s.eng.Pull(ctx, repo, tag, "", progress); err != nil {
		return fmt.Errorf("pull %s: %w", image, err)
	}
	return nil
}

type serverInfo struct {
	major     int
	version   string
	sizeBytes int64
}

// queryServer asks the server for its version and the size of the database with a client of the given image.
func (s *Service) queryServer(ctx context.Context, db config.Database, password, image string) (serverInfo, error) {
	if err := s.ensureImage(ctx, image, nil); err != nil {
		return serverInfo{}, err
	}
	const query = `select current_setting('server_version_num') || '|' || current_setting('server_version') || '|' || pg_database_size(current_database())`
	lines, err := s.pg(ctx, db, password, image, nil, append([]string{"psql"}, append(conn(db, db.Database), "-X", "-At", "-v", "ON_ERROR_STOP=1", "-c", query)...))
	if err != nil {
		return serverInfo{}, err
	}
	for i := len(lines) - 1; i >= 0; i-- {
		parts := strings.SplitN(strings.TrimSpace(lines[i]), "|", 3)
		if len(parts) != 3 {
			continue
		}
		num, err1 := strconv.Atoi(parts[0])
		size, err2 := strconv.ParseInt(parts[2], 10, 64)
		if err1 != nil || err2 != nil || num < 100000 {
			continue
		}
		version, _, _ := strings.Cut(parts[1], " ")
		return serverInfo{major: num / 10000, version: version, sizeBytes: size}, nil
	}
	return serverInfo{}, errors.New("the server's answer to the version query could not be read")
}

// clientImage is the image of the client tools for a database: its configured version, or the server's major
// version, found with one query and remembered for ten minutes. A newer pg_dump reads an older server, never the
// reverse, which is why the client follows the server.
func (s *Service) clientImage(ctx context.Context, db config.Database, password string) (string, error) {
	if db.Version != 0 {
		return versionImage(db.Version), nil
	}
	key := connectionKey(db)
	s.mu.Lock()
	c, ok := s.majors[key]
	s.mu.Unlock()
	if ok && s.now().Sub(c.at) < versionCacheTTL {
		return versionImage(c.value), nil
	}
	info, err := s.queryServer(ctx, db, password, probeImage)
	if err != nil {
		return "", fmt.Errorf("detect the server version: %w", err)
	}
	s.mu.Lock()
	s.majors[key] = cached[int]{info.major, s.now()}
	s.mu.Unlock()
	return versionImage(info.major), nil
}

// stage creates a private directory for one run and returns it with the function that removes it.
func (s *Service) stage() (string, func(), error) {
	dir := filepath.Join(s.dir, stagingDir, store.NewID())
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", nil, fmt.Errorf("create the staging directory: %w", err)
	}
	return dir, func() {
		if err := os.RemoveAll(dir); err != nil {
			s.log.Warn("could not remove a staging directory", "dir", dir, "err", err)
		}
	}, nil
}

// newDests builds every destination of a backup section, in the order they are listed.
func (s *Service) newDests(b *config.Backups) ([]namedDest, error) {
	all := b.AllDestinations()
	out := make([]namedDest, 0, len(all))
	for _, d := range all {
		dest, err := s.newDest(d)
		if err != nil {
			return nil, err
		}
		out = append(out, namedDest{dest: dest, name: d.Describe()})
	}
	return out, nil
}
