package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"sync"
	"time"
)

// sseWriter writes Server-Sent Events. Writes are serialized because the
// keep-alive goroutine writes concurrently with the handler.
type sseWriter struct {
	mu sync.Mutex
	w  http.ResponseWriter
	rc *http.ResponseController
}

func newSSE(w http.ResponseWriter) *sseWriter {
	h := w.Header()
	h.Set("Content-Type", "text/event-stream")
	h.Set("Cache-Control", "no-cache")
	h.Set("X-Accel-Buffering", "no") // do not let nginx buffer the stream
	w.WriteHeader(http.StatusOK)
	s := &sseWriter{w: w, rc: http.NewResponseController(w)}
	_ = s.rc.Flush()
	return s
}

func (s *sseWriter) send(event string, v any) error {
	b, err := json.Marshal(v)
	if err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, err := fmt.Fprintf(s.w, "event: %s\ndata: %s\n\n", event, b); err != nil {
		return err
	}
	return s.rc.Flush()
}

// keepAlive sends a comment line periodically so idle streams are not cut by
// proxies. The returned function stops it and waits until it has exited; it
// must run before the handler returns.
func (s *sseWriter) keepAlive(ctx context.Context, every time.Duration) (stop func()) {
	ctx, cancel := context.WithCancel(ctx)
	done := make(chan struct{})
	go func() {
		defer close(done)
		t := time.NewTicker(every)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				s.mu.Lock()
				_, err := fmt.Fprint(s.w, ": ping\n\n")
				if err == nil {
					err = s.rc.Flush()
				}
				s.mu.Unlock()
				if err != nil {
					return
				}
			}
		}
	}()
	return func() {
		cancel()
		<-done
	}
}
