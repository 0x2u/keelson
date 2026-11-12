package deploy

import (
	"context"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/0x2u/keelson/agent/internal/config"
	"github.com/0x2u/keelson/agent/internal/notify"
	"github.com/0x2u/keelson/agent/internal/proxy"
)

// driftingProxy is a fakeProxy that also answers the drift check, as the real Caddy driver does.
type driftingProxy struct {
	fakeProxy
	drifted atomic.Bool
}

func (p *driftingProxy) Drifted(context.Context, []proxy.Route) bool { return p.drifted.Load() }

// newDriftHarness is a proxied app behind a proxy whose drift the test controls, with the events captured.
func newDriftHarness(t *testing.T) (*harness, *driftingProxy, *captured) {
	t.Helper()
	h := newProxiedHarness(t)
	px := &driftingProxy{}
	h.d.pxMu.Lock()
	h.d.proxy = px
	h.d.pxMu.Unlock()
	h.px = &px.fakeProxy
	return h, px, h.capture()
}

func driftEvents(c *captured) []notify.Event {
	var out []notify.Event
	for _, e := range c.all() {
		if e.Type == config.EventProxyDrifted {
			out = append(out, e)
		}
	}
	return out
}

func TestAProxyThatNoLongerServesWhatWasAppliedIsSaidOnceAndPutBack(t *testing.T) {
	h, px, c := newDriftHarness(t)
	h.deploy("v1")
	applied := len(px.calls)
	if err := h.d.Reconcile(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(px.calls) != applied || len(driftEvents(c)) != 0 {
		t.Fatalf("a proxy that serves what it should is left alone and says nothing: %d applies, %+v", len(px.calls)-applied, driftEvents(c))
	}

	px.drifted.Store(true)
	if err := h.d.Reconcile(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(px.calls) != applied+1 {
		t.Errorf("drift is corrected: %d applies", len(px.calls)-applied)
	}
	ev := driftEvents(c)
	if len(ev) != 1 {
		t.Fatalf("drift is announced: %+v", ev)
	}
	if ev[0].Severity != notify.SeverityWarning || !strings.Contains(ev[0].Message, "1 route(s) again") {
		t.Errorf("unexpected event: %+v", ev[0])
	}

	// The reconciler runs every few seconds: a drift that lasts must not send a message each time.
	for range 3 {
		if err := h.d.Reconcile(context.Background()); err != nil {
			t.Fatal(err)
		}
	}
	if n := len(driftEvents(c)); n != 1 {
		t.Errorf("%d messages for one lasting drift", n)
	}

	// Once it is quiet again, the next drift is news.
	px.drifted.Store(false)
	if err := h.d.Reconcile(context.Background()); err != nil {
		t.Fatal(err)
	}
	px.drifted.Store(true)
	if err := h.d.Reconcile(context.Background()); err != nil {
		t.Fatal(err)
	}
	if n := len(driftEvents(c)); n != 2 {
		t.Errorf("a new drift is announced: %d messages", n)
	}
}

func TestALastingDriftIsSaidAgainAfterTheSilence(t *testing.T) {
	h, px, c := newDriftHarness(t)
	h.deploy("v1")
	now := time.Now()
	h.d.now = func() time.Time { return now }
	px.drifted.Store(true)
	if err := h.d.Reconcile(context.Background()); err != nil {
		t.Fatal(err)
	}
	now = now.Add(driftSilence + time.Minute)
	if err := h.d.Reconcile(context.Background()); err != nil {
		t.Fatal(err)
	}
	if n := len(driftEvents(c)); n != 2 {
		t.Errorf("a drift that is still there an hour later is said again: %d messages", n)
	}
}
