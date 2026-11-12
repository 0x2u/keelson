package databases

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"syscall"
	"time"

	"github.com/0x2u/keelson/agent/internal/config"
)

// tocEntry matches a line of "pg_restore --list" that names an object ("1259; 16385 ..."); the header lines start
// with a semicolon.
var tocEntry = regexp.MustCompile(`^\d+;`)

const (
	// spaceFactor is how many times the size of the last backup a free filesystem must hold before a dump starts: the plain
	// dump in staging, the encrypted copy beside it, and some margin for a database that grew.
	spaceFactorNum, spaceFactorDen = 5, 2
	// recentBackup is how young another backup of the database must be for a deployment to reuse it instead of dumping again.
	recentBackup = 2 * time.Minute
	// backupWait is how long a backup waits for another backup of the same database to end before it gives up.
	backupWait = 10 * time.Minute
)

// Backup dumps a database, checks the dump can be read, encrypts it, stores it, checks the stored copy and applies
// the retention rules. Nothing is stored unless the dump was verified. Every line it writes to out goes to the run
// output of the job; the summary is last, because the store keeps the tail of the output. It is the scheduled (and
// manual) backup: one backup of a database runs at a time, so a second one waits for the first.
func (s *Service) Backup(ctx context.Context, name string, out func(line string)) error {
	return s.runBackup(ctx, name, KindScheduled, out)
}

// BackupBeforeDeploy is the backup of a `backup` release step. It is the same backup, kept apart (keep_pre_deploy), and it
// reuses a backup of the database taken in the last two minutes by anyone else (the nightly one finishing as a deployment
// starts): a deployment never waits for a second dump of data that has not moved.
func (s *Service) BackupBeforeDeploy(ctx context.Context, name string, out func(line string)) error {
	return s.runBackup(ctx, name, KindPreDeploy, out)
}

func (s *Service) runBackup(ctx context.Context, name, kind string, out func(line string)) error {
	db, err := s.database(name)
	if err != nil {
		return err
	}
	if err := s.waitBackup(ctx, name, out); err != nil {
		return err
	}
	defer s.endBackup(name)
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	defer context.AfterFunc(s.ctx, cancel)() // the agent's shutdown cancels a backup in flight
	return s.doBackup(ctx, db, kind, out)
}

// waitBackup registers a backup of the database once no other one runs for it (two dumps at once only slow each other
// down and take twice the disk). A restore of the same database is refused at once, as before.
func (s *Service) waitBackup(ctx context.Context, name string, out func(string)) error {
	deadline := time.NewTimer(backupWait)
	defer deadline.Stop()
	told := false
	for {
		err := s.beginBackup(name)
		if !errors.Is(err, errBackupRunning) {
			return err
		}
		if !told {
			out("another backup of this database is running: waiting for it to end")
			told = true
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-deadline.C:
			return fmt.Errorf("backup of %s: %w", name, ErrBackupBusy)
		case <-time.After(250 * time.Millisecond):
		}
	}
}

// doBackup is the backup itself, with the database already registered as being backed up (or restored, for the safety
// backup a restore takes before it overwrites anything).
func (s *Service) doBackup(ctx context.Context, db config.Database, kind string, out func(line string)) error {
	b := db.Backups
	if b == nil {
		return fmt.Errorf("database %s has no backup section", db.Name)
	}
	started := s.now()

	password, err := readPassword(db)
	if err != nil {
		return err
	}
	dests, err := s.newDests(b)
	if err != nil {
		return err
	}
	existing, err := dests[0].dest.List(ctx, db.Name+"/")
	if err != nil {
		return classify(ErrDestination, err)
	}
	known := backupsOf(db.Name, existing)
	if kind == KindPreDeploy && len(known) > 0 && started.Sub(known[0].CreatedAt) >= 0 && started.Sub(known[0].CreatedAt) < recentBackup {
		out(fmt.Sprintf("reusing %s, taken %s ago: the data has not moved since", known[0].Key, started.Sub(known[0].CreatedAt).Round(time.Second)))
		return nil
	}
	image, err := s.clientImage(ctx, db, password)
	if err != nil {
		return err
	}
	if err := s.ensureImage(ctx, image, out); err != nil {
		return err
	}
	dir, cleanup, err := s.stage()
	if err != nil {
		return err
	}
	defer cleanup()
	if err := s.requireSpace(dir, b, known); err != nil {
		return err
	}

	out(fmt.Sprintf("dumping %s (%s:%d) with %s", db.Database, db.Host, db.Port, image))
	dump := filepath.Join(dir, "dump")
	dumpCmd := append([]string{"pg_dump"}, conn(db, db.Database)...)
	dumpCmd = append(dumpCmd, "--format=custom", "--compress=6", "--no-owner", "--no-privileges", "--file", "/out/dump")
	lines, err := s.pg(ctx, db, password, image, []string{dir + ":/out"}, dumpCmd)
	for _, l := range lines {
		out(l)
	}
	if err != nil {
		return fmt.Errorf("dump: %w", err)
	}
	dumped := s.now()
	info, err := os.Stat(dump)
	if err != nil {
		return fmt.Errorf("dump: %w", err)
	}
	if info.Size() == 0 {
		return errors.New("dump: pg_dump wrote an empty file")
	}

	entries, err := s.verifyDump(ctx, db, password, image, dir)
	if err != nil {
		return err
	}

	encrypted := filepath.Join(dir, "dump.age")
	encSize, err := encryptFile(dump, encrypted, b.Recipients)
	if err != nil {
		return fmt.Errorf("encrypt: %w", err)
	}
	if err := os.Remove(dump); err != nil { // the plaintext does not wait for the end of the run
		return fmt.Errorf("remove the plaintext dump: %w", err)
	}

	key, err := putNew(ctx, dests, db.Name, kind, started, encrypted, out)
	if err != nil {
		return fmt.Errorf("upload %s: %w", key, err)
	}
	uploaded := s.now()

	var retention []string
	for _, d := range dests {
		summary := s.applyRetention(ctx, d.dest, db, key, out)
		if len(dests) > 1 {
			summary = d.name + ": " + summary
		}
		retention = append(retention, summary)
	}

	out(fmt.Sprintf("backup %s: %d objects in the dump, %s plain, %s encrypted; dump %s, upload %s, upload verified; %s",
		key, entries, size(info.Size()), size(encSize), dumped.Sub(started).Round(time.Second), uploaded.Sub(dumped).Round(time.Second), strings.Join(retention, "; ")))
	return nil
}

// requireSpace refuses a dump that the disk could not hold: Postgres and Docker share the volume the staging directory and
// a local destination live on, and a backup that fills it takes the database down with it. The room needed is a multiple of
// the last backup's size (with none to compare with, nothing is known and nothing is refused).
func (s *Service) requireSpace(staging string, b *config.Backups, known []Backup) error {
	if len(known) == 0 || known[0].SizeBytes == 0 {
		return nil
	}
	need := uint64(known[0].SizeBytes) * spaceFactorNum / spaceFactorDen
	paths := []string{staging}
	for _, d := range b.AllDestinations() {
		if d.Local != nil {
			paths = append(paths, d.Local.Dir)
		}
	}
	for _, p := range paths {
		free, err := freeSpace(p)
		if err != nil {
			continue // not measurable here: the dump will fail by itself if the disk is full
		}
		if free < need {
			return fmt.Errorf("not enough free space on %s: %s free, and a backup needs about %s (2.5 times the last one, %s): free some, or the dump would fill the disk the database shares", p, size(int64(free)), size(int64(need)), size(known[0].SizeBytes))
		}
	}
	return nil
}

// freeSpace is freeBytes; a variable so that a test can say how much room there is.
var freeSpace = freeBytes

// freeBytes is the space an unprivileged process can still use on the filesystem holding path (or, for a directory that
// does not exist yet, the nearest parent that does).
func freeBytes(path string) (uint64, error) {
	for {
		var st syscall.Statfs_t
		err := syscall.Statfs(path, &st)
		if err == nil {
			return uint64(st.Bavail) * uint64(st.Bsize), nil
		}
		parent := filepath.Dir(path)
		if !os.IsNotExist(err) || parent == path {
			return 0, err
		}
		path = parent
	}
}

// maxKeyAttempts bounds how many keys putNew tries.
const maxKeyAttempts = 10

// namedDest is a destination with the name an operator knows it by.
type namedDest struct {
	dest Destination
	name string
}

// putNew stores the file under the key of a backup of the given kind taken at t, in every destination, and returns the key
// it used. A backup never replaces an object (Put refuses with ErrExists), and a taken key is rare: the clock was set back,
// or someone copied a file in. Then the next second is tried, up to maxKeyAttempts keys, and the run fails if they are all
// taken. The key stays in the naming scheme, so listing, restore and retention treat it like any other backup.
//
// The same key is used everywhere. When a later destination fails, the copies already stored are removed again: a backup
// that is not where it was promised to be is not a backup of record.
func putNew(ctx context.Context, dests []namedDest, database, kind string, t time.Time, src string, out func(string)) (string, error) {
	var key string
	stored := false
	for i := range maxKeyAttempts {
		key = BackupKeyOf(database, kind, t.Add(time.Duration(i)*time.Second))
		err := dests[0].dest.Put(ctx, key, src)
		if errors.Is(err, ErrExists) {
			out(fmt.Sprintf("%s already exists and is kept: trying the next second", key))
			continue
		}
		if err != nil {
			return key, err
		}
		stored = true
		break
	}
	if !stored {
		return key, fmt.Errorf("%d keys in a row are taken: %w", maxKeyAttempts, ErrExists)
	}
	for i, d := range dests[1:] {
		if err := d.dest.Put(ctx, key, src); err != nil {
			for _, done := range dests[:i+1] {
				if derr := done.dest.Delete(context.WithoutCancel(ctx), key); derr != nil {
					out(fmt.Sprintf("could not remove the copy in %s after the failure in %s: %v", done.name, d.name, derr))
				}
			}
			return key, fmt.Errorf("%s: %w", d.name, err)
		}
	}
	return key, nil
}

// verifyDump reads the dump back with pg_restore: a file pg_restore cannot read, one with nothing in it, and one that is cut
// short are not backups. First its table of contents is listed, then all of its data is read (to /dev/null): the list alone
// comes from the head of the file, and a dump truncated at 60% still listed. It returns the number of objects listed.
func (s *Service) verifyDump(ctx context.Context, db config.Database, password, image, dir string) (int, error) {
	lines, err := s.pg(ctx, db, password, image, []string{dir + ":/out:ro"}, []string{"pg_restore", "--list", "/out/dump"})
	if err != nil {
		return 0, fmt.Errorf("verify the dump: %w", err)
	}
	entries := 0
	for _, l := range lines {
		if tocEntry.MatchString(l) {
			entries++
		}
	}
	if entries == 0 {
		return 0, errors.New("verify the dump: pg_restore lists no object in it")
	}
	if _, err := s.pg(ctx, db, password, image, []string{dir + ":/out:ro"}, []string{"pg_restore", "-f", "/dev/null", "/out/dump"}); err != nil {
		return 0, fmt.Errorf("verify the dump: its data cannot be read to the end (%w)", err)
	}
	return entries, nil
}

// applyRetention deletes the backups the retention rules no longer keep: the scheduled ones by keep and keep_days, the ones
// taken before a deployment or before a restore by keep_pre_deploy, each kind apart so that one never pushes another out. The
// backup just made (fresh) is never deleted, whatever its date says: the date comes from the clock, and a clock set back would
// otherwise make the new backup the oldest. A failure here never fails the backup: it is reported in the output.
func (s *Service) applyRetention(ctx context.Context, dest Destination, db config.Database, fresh string, out func(string)) string {
	objects, err := dest.List(ctx, db.Name+"/")
	if err != nil {
		out("retention: could not list the backups: " + err.Error())
		return "retention skipped"
	}
	backups := backupsOf(db.Name, objects)
	var failed []string
	deleted := 0
	drop := expired(ofKind(backups, KindScheduled), db.Backups.KeepCount(), db.Backups.KeepDays, s.now())
	keepPre := db.Backups.KeepPreDeployCount()
	if keepPre <= 0 {
		keepPre = config.DefaultBackupKeepPreDeploy
	}
	for _, kind := range []string{KindPreDeploy, KindPreRestore} {
		drop = append(drop, expired(ofKind(backups, kind), keepPre, 0, s.now())...)
	}
	for _, e := range drop {
		if e.Key == fresh {
			continue
		}
		if err := dest.Delete(ctx, e.Key); err != nil {
			out(fmt.Sprintf("retention: could not delete %s: %v", e.Key, err))
			failed = append(failed, e.Key)
			continue
		}
		deleted++
	}
	summary := fmt.Sprintf("retention kept %d, deleted %d", len(backups)-deleted, deleted)
	if len(failed) > 0 {
		summary += fmt.Sprintf(", %d could not be deleted", len(failed))
	}
	return summary
}

// size formats a byte count for a person.
func size(n int64) string {
	const unit = 1024
	if n < unit {
		return fmt.Sprintf("%d B", n)
	}
	div, exp := int64(unit), 0
	for m := n / unit; m >= unit; m /= unit {
		div *= unit
		exp++
	}
	return strings.TrimSuffix(fmt.Sprintf("%.1f", float64(n)/float64(div)), ".0") + " " + string("KMGTPE"[exp]) + "iB"
}
