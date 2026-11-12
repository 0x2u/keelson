package install

import (
	"errors"
	"fmt"
)

// reuseInstalledSettings fills the options from what the installation remembers, replacing whatever was given: an
// upgrade changes the program, not how it is set up. Re-running an install with fewer flags than the first time (no
// --nginx, say) would otherwise quietly change the unit and take away the agent's right to reload nginx.
func (o *Options) reuseInstalledSettings() error {
	root := rootOrSlash(o.Root)
	m := readMeta(Paths{root})
	if m.Listen == "" || len(m.Hosts) == 0 {
		return fmt.Errorf("%w: nothing is installed at %s", errNotInstalled, Paths{root}.Meta())
	}
	o.Listen, o.Hosts, o.Name, o.WithNginx, o.AllowFrom = m.Listen, m.Hosts, m.Name, m.Nginx, ""
	return nil
}

var errNotInstalled = errors.New("the agent is not installed here: install it first, without --upgrade")
