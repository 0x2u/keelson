package config

import (
	"fmt"
	"time"
)

// Drain bounds. A reverse proxy needs milliseconds to finish a reload; the rest is for requests already under way.
const (
	DefaultDrain = 5 * time.Second
	MaxDrain     = 5 * time.Minute
)

// DrainFor is how long to wait between the traffic switch and stopping the previous version. Loading a file always
// sets it (5s unless the file says otherwise); an App built by hand has none.
func (a App) DrainFor() time.Duration {
	if a.Drain == nil {
		return 0
	}
	return a.Drain.Std()
}

func validateDrain(a *App) error {
	if a.Drain == nil {
		a.Drain = D(DefaultDrain)
		return nil
	}
	if a.Drain.Std() < 0 || a.Drain.Std() > MaxDrain {
		return fmt.Errorf("drain must be between 0s and %s", MaxDrain)
	}
	return nil
}
