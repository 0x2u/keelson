package deploy

import (
	"context"
	"time"

	"github.com/0x2u/keelson/agent/internal/config"
)

// drain waits between the traffic switch and the stop of the previous version.
//
// A reload only signals the proxy: for a few milliseconds a worker that has not yet taken the new configuration can
// still send a request to the old upstream. Stopping the old container at that instant turns those requests into
// 502s (seen against a real nginx under a request every 20 ms: three in 1,648). Waiting a moment first is what makes
// the switch lossless; it also lets requests already under way on the old version complete.
func (d *Deployer) drain(ctx context.Context, id string, a config.App) {
	wait := a.DrainFor()
	if wait <= 0 {
		return
	}
	d.event(id, "info", "letting the previous version finish what it is serving (%s)", wait)
	timer := time.NewTimer(wait)
	defer timer.Stop()
	select {
	case <-timer.C:
	case <-ctx.Done():
	}
}
