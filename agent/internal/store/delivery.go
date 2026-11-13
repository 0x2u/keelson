package store

import (
	"context"
	"math"
	"sort"
	"time"
)

// The four numbers a team is judged by (DORA): how often it deploys, how long a change takes to reach production, how
// often a change breaks it, and how long it takes to restore service. The agent can compute three of them from what it
// records: it sees every deployment and every outage of an app it watches. The fourth, the lead time of a change, needs
// the moment the code was written, which the agent only knows for a deployment the dashboard started from a commit (see
// Deployment.CommittedAt).
//
// They are computed over a window from the rows that are there: the deployments the agent keeps and the transitions of
// the last 30 days (AvailabilityRetention). A window longer than that gets a shorter restore time than the truth, so the
// answer says what it covered.

// MaxDeliveryWindow is the longest window Delivery accepts: the outage record does not go further back.
const MaxDeliveryWindow = AvailabilityRetention

// MaxSamples bounds the lists of durations an answer carries, so that a busy server does not answer with megabytes.
// The quantiles are computed over everything; the list is the newest MaxSamples of them.
const MaxSamples = 500

// Delivery is the delivery performance of this server, or of one app, over a window.
type Delivery struct {
	From time.Time `json:"from"`
	To   time.Time `json:"to"`
	Days float64   `json:"days"`
	// App is empty for the whole server.
	App string `json:"app,omitempty"`

	// Deployments counts the finished deployments of the window by outcome. Running ones are not counted: their
	// outcome is not known yet.
	Deployments DeploymentCounts `json:"deployments"`
	// PerDay is how many deployments reached production a day: the deployment frequency.
	PerDay float64 `json:"per_day"`
	// ChangeFailureRatio is the share of finished deployments that did not leave the new version serving (failed,
	// rolled back, or rolled back badly), between 0 and 1. Nil when nothing finished in the window.
	ChangeFailureRatio *float64 `json:"change_failure_ratio"`
	// Restore is how long the apps took to serve again after they went down.
	Restore RestoreTimes `json:"restore"`
	// LeadTime is how long a commit took to reach production, over the deployments that carry the time of their
	// commit (one the dashboard started from a repository).
	LeadTime LeadTimes `json:"lead_time"`
}

// DeploymentCounts is the outcome of the finished deployments of a window.
type DeploymentCounts struct {
	Total          int `json:"total"`
	Succeeded      int `json:"succeeded"`
	Failed         int `json:"failed"`
	RolledBack     int `json:"rolled_back"`
	RollbackFailed int `json:"rollback_failed"`
}

// RestoreTimes is how long the outages of the window lasted. An outage that was still going when the window ended is
// counted up to the end, so the number never shrinks a real incident.
type RestoreTimes struct {
	Incidents      int      `json:"incidents"`
	MedianSeconds  *float64 `json:"median_seconds"`
	LongestSeconds *float64 `json:"longest_seconds"`
	// Ongoing counts the outages that had not ended when the window did.
	Ongoing int `json:"ongoing"`
	// Seconds are the lengths themselves, sorted, at most MaxSamples: a reader that puts several servers together
	// needs the values, not each server's median.
	Seconds []float64 `json:"seconds"`
}

// LeadTimes is how long a change took to reach production, from the commit to the end of its deployment.
type LeadTimes struct {
	// Deployments is how many successful deployments of the window carried the time of their commit; the other
	// numbers are nil when it is zero. Covered says what share of the successful ones that is.
	Deployments   int      `json:"deployments"`
	Covered       *float64 `json:"covered"`
	MedianSeconds *float64 `json:"median_seconds"`
	P90Seconds    *float64 `json:"p90_seconds"`
	// Seconds are the lead times themselves, sorted, at most MaxSamples.
	Seconds []float64 `json:"seconds"`
}

// Delivery computes the numbers over [from, to] for one app, or for every app when app is empty.
func (s *Store) Delivery(ctx context.Context, app string, from, to time.Time) (Delivery, error) {
	d := Delivery{From: from.UTC(), To: to.UTC(), Days: to.Sub(from).Hours() / 24, App: app}
	deps, err := s.finishedBetween(ctx, app, from, to)
	if err != nil {
		return Delivery{}, err
	}
	var leads []float64
	for _, dep := range deps {
		d.Deployments.Total++
		switch dep.Status {
		case StatusSucceeded:
			d.Deployments.Succeeded++
			if dep.CommittedAt != nil && dep.FinishedAt != nil {
				if lead := dep.FinishedAt.Sub(*dep.CommittedAt); lead >= 0 {
					leads = append(leads, lead.Seconds())
				}
			}
		case StatusFailed:
			d.Deployments.Failed++
		case StatusRolledBack:
			d.Deployments.RolledBack++
		case StatusRollbackFailed:
			d.Deployments.RollbackFailed++
		}
	}
	if days := d.Days; days > 0 {
		d.PerDay = float64(d.Deployments.Succeeded) / days
	}
	if d.Deployments.Total > 0 {
		ratio := float64(d.Deployments.Total-d.Deployments.Succeeded) / float64(d.Deployments.Total)
		d.ChangeFailureRatio = &ratio
	}
	d.LeadTime = leadTimes(leads, d.Deployments.Succeeded)
	if d.Restore, err = s.restoreTimes(ctx, app, from, to); err != nil {
		return Delivery{}, err
	}
	return d, nil
}

// finishedBetween returns the deployments that ended inside the window (phases are not read: nothing here needs them).
func (s *Store) finishedBetween(ctx context.Context, app string, from, to time.Time) ([]Deployment, error) {
	q := `SELECT ` + depColumns + ` FROM deployments WHERE finished_at IS NOT NULL AND finished_at >= ? AND finished_at <= ?`
	args := []any{from.UnixMilli(), to.UnixMilli()}
	if app != "" {
		q += ` AND app = ?`
		args = append(args, app)
	}
	rows, err := s.db.QueryContext(ctx, q+` ORDER BY finished_at`, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanDeployments(rows)
}

// restoreTimes measures the outages that touch the window, of one app or of every app that has been watched.
func (s *Store) restoreTimes(ctx context.Context, app string, from, to time.Time) (RestoreTimes, error) {
	apps := []string{app}
	if app == "" {
		var err error
		if apps, err = s.watchedApps(ctx); err != nil {
			return RestoreTimes{}, err
		}
	}
	out := RestoreTimes{}
	var lengths []float64
	for _, name := range apps {
		a, err := s.AppAvailability(ctx, name, from, to)
		if err != nil {
			return RestoreTimes{}, err
		}
		for _, inc := range a.Incidents {
			out.Incidents++
			if inc.End == nil {
				out.Ongoing++
			}
			lengths = append(lengths, float64(inc.DurationSeconds))
		}
	}
	out.Seconds = []float64{}
	if len(lengths) > 0 {
		sort.Float64s(lengths)
		out.MedianSeconds = new(quantile(lengths, 0.5))
		out.LongestSeconds = new(lengths[len(lengths)-1])
		out.Seconds = lastSamples(lengths)
	}
	return out, nil
}

// watchedApps lists the apps the availability record knows about.
func (s *Store) watchedApps(ctx context.Context) ([]string, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT DISTINCT app FROM app_transitions ORDER BY app`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var app string
		if err := rows.Scan(&app); err != nil {
			return nil, err
		}
		out = append(out, app)
	}
	return out, rows.Err()
}

func leadTimes(leads []float64, succeeded int) LeadTimes {
	out := LeadTimes{Deployments: len(leads), Seconds: []float64{}}
	if len(leads) == 0 {
		return out
	}
	sort.Float64s(leads)
	out.Seconds = lastSamples(leads)
	out.MedianSeconds = new(quantile(leads, 0.5))
	out.P90Seconds = new(quantile(leads, 0.9))
	if succeeded > 0 {
		out.Covered = new(float64(len(leads)) / float64(succeeded))
	}
	return out
}

// lastSamples is the end of a sorted slice, at most MaxSamples values, copied.
func lastSamples(sorted []float64) []float64 {
	if len(sorted) > MaxSamples {
		sorted = sorted[len(sorted)-MaxSamples:]
	}
	return append([]float64{}, sorted...)
}

// quantile is the linear-interpolated quantile of a sorted slice (at least one value).
func quantile(sorted []float64, q float64) float64 {
	if len(sorted) == 1 {
		return sorted[0]
	}
	pos := q * float64(len(sorted)-1)
	lo := int(math.Floor(pos))
	hi := int(math.Ceil(pos))
	return sorted[lo] + (sorted[hi]-sorted[lo])*(pos-float64(lo))
}
