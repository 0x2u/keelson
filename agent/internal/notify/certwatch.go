package notify

import (
	"context"
	"crypto/tls"
	"fmt"
	"log/slog"
	"math"
	"net"
	"slices"
	"time"

	"github.com/0x2u/keelson/agent/internal/config"
)

// The certificate watch. Nothing else in the agent notices a certificate that is about to expire: Caddy renews its own
// and says so in its log, a certificate file the operator installed (a Cloudflare origin certificate) is never renewed,
// and a renewal that fails leaves a site that will stop answering in a fortnight with nothing to show for it.
const (
	// CertEvery is how often every name is looked at. A certificate changes rarely and a check opens a TLS handshake
	// per name.
	CertEvery = 6 * time.Hour
	// CertFirstCheck is the wait before the first round, so that the proxy of a server that just started is up.
	CertFirstCheck = 2 * time.Minute
	// certTimeout bounds one handshake.
	certTimeout = 10 * time.Second
	// CertHTTPSPort is the port the proxy serves TLS on.
	CertHTTPSPort = 443
)

// CertWarnSteps are the thresholds, in days, a certificate's remaining life crosses: the warning is raised again at
// each of them, so a renewal that never happens is said more loudly as the day approaches instead of every day.
var CertWarnSteps = []int{7, 3, 1, 0}

// CertProbe reads the certificate the proxy on this server serves for a name. It returns when the certificate expires.
type CertProbe func(ctx context.Context, host string) (time.Time, error)

// LocalCertProbe asks the proxy on this machine, on 127.0.0.1:443, which certificate it serves for the name (SNI). It
// is what a visitor would be given, without DNS, Cloudflare or the network in the way. The certificate is not verified:
// the watch is about the date, and a development setup serves Caddy's own local CA.
func LocalCertProbe(ctx context.Context, host string) (time.Time, error) {
	d := tls.Dialer{NetDialer: &net.Dialer{}, Config: &tls.Config{ServerName: host, InsecureSkipVerify: true, MinVersion: tls.VersionTLS12}}
	conn, err := d.DialContext(ctx, "tcp", fmt.Sprintf("127.0.0.1:%d", CertHTTPSPort))
	if err != nil {
		return time.Time{}, err
	}
	defer conn.Close()
	certs := conn.(*tls.Conn).ConnectionState().PeerCertificates
	if len(certs) == 0 {
		return time.Time{}, fmt.Errorf("%s served no certificate", host)
	}
	return certs[0].NotAfter, nil
}

// CertNames lists the names the proxy of this server serves: the domains of every proxied app and the hosts of every
// site. A name is listed once, in a stable order.
func CertNames(c *config.Config) []string {
	if c == nil || c.Proxy == nil {
		return nil
	}
	seen := map[string]bool{}
	var out []string
	add := func(hosts []string) {
		for _, h := range hosts {
			if h != "" && !seen[h] {
				seen[h] = true
				out = append(out, h)
			}
		}
	}
	for _, a := range c.Apps {
		if a.Proxied() {
			add(a.Domains)
		}
	}
	for _, s := range c.Proxy.Sites {
		add(s.Hosts)
	}
	slices.Sort(out)
	return out
}

// CertWatcher raises certificate.expiring for a name whose certificate is about to run out, and certificate.renewed
// once a new one is served. A name that cannot be reached raises nothing: a proxy that is down, a name served
// elsewhere or a server with no TLS at all must not look like an expiry (the app watch and the proxy watch are what
// say a proxy is broken).
type CertWatcher struct {
	names func() []string
	probe CertProbe
	emit  func(Event)
	// warnDays is how long before the end the first warning goes out.
	warnDays func() int
	log      *slog.Logger
	now      func() time.Time

	// warned is the step (in days) each name was last warned at; a name that is fine is not in it.
	warned map[string]int
}

// NewCertWatcher returns a watcher over the names of names(), probed with probe.
func NewCertWatcher(names func() []string, probe CertProbe, warnDays func() int, emit func(Event), log *slog.Logger) *CertWatcher {
	if log == nil {
		log = slog.Default()
	}
	return &CertWatcher{names: names, probe: probe, warnDays: warnDays, emit: emit, log: log, now: time.Now, warned: map[string]int{}}
}

// Run makes a round after CertFirstCheck and then every CertEvery, until ctx ends.
func (w *CertWatcher) Run(ctx context.Context) {
	t := time.NewTimer(CertFirstCheck)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
		w.Check(ctx)
		t.Reset(CertEvery)
	}
}

// Check looks at every name once.
func (w *CertWatcher) Check(ctx context.Context) {
	names := w.names()
	live := map[string]bool{}
	for _, host := range names {
		live[host] = true
		w.checkOne(ctx, host)
	}
	for host := range w.warned {
		if !live[host] {
			delete(w.warned, host) // the name is not served from here any more
		}
	}
}

func (w *CertWatcher) checkOne(ctx context.Context, host string) {
	pctx, cancel := context.WithTimeout(ctx, certTimeout)
	defer cancel()
	notAfter, err := w.probe(pctx, host)
	if err != nil {
		if ctx.Err() == nil {
			w.log.Debug("certificate not read", "host", host, "err", err)
		}
		return
	}
	left := notAfter.Sub(w.now())
	days := daysLeft(left)
	if days >= w.warnDays() {
		if step, had := w.warned[host]; had {
			delete(w.warned, host)
			w.emit(Event{
				Type: config.EventCertificateRenewed, Severity: SeverityInfo,
				Title:   "The certificate of " + host + " was renewed",
				Message: fmt.Sprintf("It now runs until %s (%d days). It had %d days left when it was last reported.", notAfter.UTC().Format(time.DateOnly), days, step),
			})
		}
		return
	}
	step := nextStep(days, w.warnDays())
	if last, had := w.warned[host]; had && last <= step {
		return // already said at this step or a shorter one
	}
	w.warned[host] = step
	severity := SeverityWarning
	if days <= 3 {
		severity = SeverityCritical
	}
	w.emit(Event{
		Type: config.EventCertificateExpiring, Severity: severity,
		Title:   certTitle(host, left),
		Message: fmt.Sprintf("The certificate the proxy serves for %s expires on %s. Check that renewal works: without it the site stops answering over HTTPS.", host, notAfter.UTC().Format(time.DateTime)+" UTC"),
	})
}

// daysLeft is how many days a certificate still has, rounded up: a certificate that ends in 23 hours has one day
// left, not none, and "expires in 8 days" must not become the seven-day step a minute later.
func daysLeft(left time.Duration) int { return int(math.Ceil(left.Hours() / 24)) }

func certTitle(host string, left time.Duration) string {
	switch days := daysLeft(left); {
	case left <= 0:
		return "The certificate of " + host + " has expired"
	case days == 0:
		return "The certificate of " + host + " expires today"
	case days == 1:
		return "The certificate of " + host + " expires tomorrow"
	default:
		return fmt.Sprintf("The certificate of %s expires in %d days", host, days)
	}
}

// nextStep is the step a certificate with that many days left falls in: the first warning is at the configured number
// of days, then at each of CertWarnSteps below it.
func nextStep(days, warnDays int) int {
	step := warnDays
	for _, s := range CertWarnSteps {
		if days <= s && s < step {
			step = s
		}
	}
	return step
}
