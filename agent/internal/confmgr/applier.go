// Package confmgr owns the apps file at run time: it validates and writes changes, keeps their history,
// and applies a new configuration to the running agent without a restart.
package confmgr

import "github.com/0x2u/keelson/agent/internal/config"

// BusyError says a change cannot be applied right now, for a reason that goes away by itself (a
// deployment that has to finish first). Nothing was changed.
type BusyError struct{ Reason string }

func (e *BusyError) Error() string { return e.Reason }

// Applier is a part of the agent that follows the configuration.
//
// Prepare checks that next can be applied now and returns the function that does it. Nothing changes
// until that function runs, so the manager can ask every applier first and apply only when all agreed.
// The function cannot fail: everything that can fail belongs in Prepare.
type Applier interface {
	Prepare(old, next *config.Config) (apply func(), err error)
}
