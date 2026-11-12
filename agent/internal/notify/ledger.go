package notify

import (
	"encoding/json"
	"errors"
	"log/slog"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// KeepHistory is how many events the history keeps; the newest win.
const KeepHistory = 200

// Delivery statuses of an event in the history.
const (
	// StatusDelivered: every channel got it.
	StatusDelivered = "delivered"
	// StatusPartial: some channels got it, others did not.
	StatusPartial = "partial"
	// StatusFailed: no channel got it, after the retries.
	StatusFailed = "failed"
	// StatusDropped: the queue was full and the event was thrown away before it was tried.
	StatusDropped = "dropped"
	// StatusNoChannel: the event is selected but no webhook or Telegram chat is configured.
	StatusNoChannel = "no_channel"
	// StatusSuppressed: the agent decided not to send it (a restart loop sends one agent.started a minute).
	StatusSuppressed = "suppressed"
)

// Record is one emitted event with how its delivery ended. It is what the history keeps and the API lists. The
// channels that failed are named without the error: an error may quote a URL that carries a token.
type Record struct {
	Event
	Status         string   `json:"status"`
	FailedChannels []string `json:"failed_channels,omitempty"`
}

// Delivered reports whether the event reached at least one channel.
func (r Record) Delivered() bool { return r.Status == StatusDelivered || r.Status == StatusPartial }

// JobAlert is what the scheduler remembers of the job.failed alert of a failure streak: when it was last raised and
// whether it got through. It lives here, next to the history, so a restart of the agent neither forgets an alert
// that never arrived nor repeats one that did.
type JobAlert struct {
	At        time.Time `json:"at"`
	Delivered bool      `json:"delivered"`
}

// Ledger is the agent's memory of its notifications: the last events with their delivery status and the alert state of
// every job. It is kept in one small file in the data directory, rewritten at every change (a few events an hour).
// A Ledger without a path keeps everything in memory.
type Ledger struct {
	path string
	log  *slog.Logger

	mu     sync.Mutex
	events []Record // oldest first
	jobs   map[string]JobAlert
}

type ledgerFile struct {
	Events []Record            `json:"events"`
	Jobs   map[string]JobAlert `json:"jobs,omitempty"`
}

// OpenLedger loads the ledger at path, or starts an empty one when there is no file yet. A file that cannot be read
// is set aside as "<path>.corrupt" and the ledger starts empty: losing the history must never stop the agent.
func OpenLedger(path string, log *slog.Logger) *Ledger {
	if log == nil {
		log = slog.Default()
	}
	l := &Ledger{path: path, log: log, jobs: map[string]JobAlert{}}
	if path == "" {
		return l
	}
	b, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return l
	}
	var f ledgerFile
	if err == nil {
		err = json.Unmarshal(b, &f)
	}
	if err != nil {
		log.Warn("notification history unreadable: starting a new one", "file", path, "err", err)
		_ = os.Rename(path, path+".corrupt")
		return l
	}
	l.events = f.Events
	if len(l.events) > KeepHistory {
		l.events = l.events[len(l.events)-KeepHistory:]
	}
	if f.Jobs != nil {
		l.jobs = f.Jobs
	}
	return l
}

// Add records an event.
func (l *Ledger) Add(r Record) {
	if l == nil {
		return
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	l.events = append(l.events, r)
	if len(l.events) > KeepHistory {
		l.events = append([]Record(nil), l.events[len(l.events)-KeepHistory:]...)
	}
	l.saveLocked()
}

// Events returns the newest events first, at most limit of them.
func (l *Ledger) Events(limit int) []Record {
	if l == nil {
		return nil
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	n := min(limit, len(l.events))
	out := make([]Record, 0, n)
	for i := len(l.events) - 1; i >= 0 && len(out) < n; i-- {
		out = append(out, l.events[i])
	}
	return out
}

// Count returns how many events of the type were raised since the time.
func (l *Ledger) Count(eventType string, since time.Time) int {
	if l == nil {
		return 0
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	n := 0
	for _, r := range l.events {
		if r.Type == eventType && !r.Time.Before(since) {
			n++
		}
	}
	return n
}

// Last returns the newest event of the type.
func (l *Ledger) Last(eventType string) (Record, bool) {
	if l == nil {
		return Record{}, false
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	for i := len(l.events) - 1; i >= 0; i-- {
		if l.events[i].Type == eventType {
			return l.events[i], true
		}
	}
	return Record{}, false
}

// JobAlert returns the alert state of a job's current failure streak.
func (l *Ledger) JobAlert(job string) (JobAlert, bool) {
	if l == nil {
		return JobAlert{}, false
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	a, ok := l.jobs[job]
	return a, ok
}

// SetJobAlert records that job.failed was raised for the job at a.At, and whether it got through.
func (l *Ledger) SetJobAlert(job string, a JobAlert) {
	if l == nil {
		return
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	l.jobs[job] = a
	l.saveLocked()
}

// ClearJobAlert forgets the alert of a job: its streak is over.
func (l *Ledger) ClearJobAlert(job string) {
	if l == nil {
		return
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	if _, ok := l.jobs[job]; !ok {
		return
	}
	delete(l.jobs, job)
	l.saveLocked()
}

// saveLocked writes the file through a rename, so a crash leaves the old one or the new one, never half of it.
// A write that fails is logged: the notification itself already went out.
func (l *Ledger) saveLocked() {
	if l.path == "" {
		return
	}
	b, err := json.Marshal(ledgerFile{Events: l.events, Jobs: l.jobs})
	if err == nil {
		tmp := l.path + ".tmp"
		if err = os.MkdirAll(filepath.Dir(l.path), 0o755); err == nil {
			if err = os.WriteFile(tmp, b, 0o600); err == nil {
				err = os.Rename(tmp, l.path)
			}
		}
	}
	if err != nil {
		l.log.Warn("could not save the notification history", "file", l.path, "err", err)
	}
}
