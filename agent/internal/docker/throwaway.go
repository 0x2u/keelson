package docker

import (
	"context"
	"fmt"
	"log/slog"
	"time"
)

// logsDrainWait is how long RunThrowaway waits for the last output lines once the container has exited.
const logsDrainWait = 5 * time.Second

// Runner is the part of the engine RunThrowaway needs.
type Runner interface {
	Create(ctx context.Context, spec ContainerSpec) (string, error)
	Start(ctx context.Context, id string) error
	// RemoveThrowaway removes the container with its anonymous volumes.
	RemoveThrowaway(ctx context.Context, id string) error
	Wait(ctx context.Context, id string) (int, error)
	Logs(ctx context.Context, id string, opt LogOptions, fn func(LogLine) error) error
}

// RunThrowaway creates a container from spec, runs it to the end, streams its output to out and removes it with its anonymous volumes,
// whatever happened. It returns the exit code; ctx bounds the whole run.
func RunThrowaway(ctx context.Context, eng Runner, log *slog.Logger, spec ContainerSpec, out func(line string)) (int, error) {
	if _, err := eng.Create(ctx, spec); err != nil {
		return 0, fmt.Errorf("create container: %w", err)
	}
	defer func() {
		rmCtx, rmCancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer rmCancel()
		if err := eng.RemoveThrowaway(rmCtx, spec.Name); err != nil && !IsNotFound(err) {
			log.Warn("could not remove a throwaway container", "container", spec.Name, "err", err)
		}
	}()
	if err := eng.Start(ctx, spec.Name); err != nil {
		return 0, fmt.Errorf("start container: %w", err)
	}

	logsDone := make(chan struct{})
	go func() {
		defer close(logsDone)
		// The stream ends by itself when the container exits.
		_ = eng.Logs(ctx, spec.Name, LogOptions{Follow: true, Tail: "all"}, func(l LogLine) error {
			out(l.Line)
			return nil
		})
	}()

	code, err := eng.Wait(ctx, spec.Name)
	if err != nil {
		return 0, err
	}
	select {
	case <-logsDone:
	case <-time.After(logsDrainWait):
	}
	return code, nil
}
