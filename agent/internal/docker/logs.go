package docker

import (
	"bytes"
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"net/url"
	"strings"
	"time"
)

const (
	// maxFrame bounds a single multiplexed frame; the engine emits frames of
	// a few KiB, so anything larger is a corrupt stream.
	maxFrame = 1 << 24
	// maxLine bounds a line with no newline; longer output is cut into
	// several lines instead of growing memory without limit.
	maxLine = 1 << 20
)

// LogLine is one line of container output.
type LogLine struct {
	// Time is the engine timestamp; zero when it could not be parsed.
	Time   time.Time `json:"time"`
	Stream string    `json:"stream"` // "stdout" or "stderr"
	Line   string    `json:"line"`
}

// LogOptions selects which logs to read.
type LogOptions struct {
	Follow bool
	Tail   string // "all" or a number of lines; empty means the engine default (all)
	Since  string // unix timestamp as accepted by the engine; empty means no limit
}

// Logs streams a container's logs to fn, line by line. fn may return ErrStop
// to end the stream early. With Follow unset it returns when the existing
// logs are exhausted.
func (c *Client) Logs(ctx context.Context, id string, opt LogOptions, fn func(LogLine) error) error {
	d, err := c.Inspect(ctx, id) // the framing of the stream depends on the TTY setting
	if err != nil {
		return err
	}
	q := url.Values{"stdout": {"1"}, "stderr": {"1"}, "timestamps": {"1"}}
	if opt.Follow {
		q.Set("follow", "1")
	}
	if opt.Tail != "" {
		q.Set("tail", opt.Tail)
	}
	if opt.Since != "" {
		q.Set("since", opt.Since)
	}
	resp, err := c.get(ctx, "/containers/"+url.PathEscape(id)+"/logs", q)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	err = streamLogs(resp.Body, d.TTY, fn)
	if errors.Is(err, ErrStop) {
		return nil
	}
	return err
}

func streamLogs(r io.Reader, tty bool, fn func(LogLine) error) error {
	emitter := func(stream string) func(string) error {
		return func(s string) error { return fn(parseLine(stream, s)) }
	}
	if tty {
		// A TTY container has a single, unframed output stream.
		var lb lineBuf
		emit := emitter("stdout")
		buf := make([]byte, 32<<10)
		for {
			n, err := r.Read(buf)
			if n > 0 {
				if e := lb.write(buf[:n], emit); e != nil {
					return e
				}
			}
			if err == io.EOF {
				return lb.flush(emit)
			}
			if err != nil {
				return err
			}
		}
	}

	var out, errb lineBuf
	emitOut, emitErr := emitter("stdout"), emitter("stderr")
	err := demux(r, func(stream string, p []byte) error {
		if stream == "stderr" {
			return errb.write(p, emitErr)
		}
		return out.write(p, emitOut)
	})
	if err != nil {
		return err
	}
	if err := out.flush(emitOut); err != nil {
		return err
	}
	return errb.flush(emitErr)
}

// demux reads the engine's multiplexed stream: 8-byte header (stream type,
// three zero bytes, big-endian payload size) followed by the payload.
func demux(r io.Reader, emit func(stream string, payload []byte) error) error {
	var hdr [8]byte
	var payload []byte
	for {
		if _, err := io.ReadFull(r, hdr[:]); err != nil {
			if err == io.EOF {
				return nil
			}
			return err
		}
		size := binary.BigEndian.Uint32(hdr[4:])
		if size > maxFrame {
			return fmt.Errorf("docker: log frame of %d bytes exceeds limit", size)
		}
		if cap(payload) < int(size) {
			payload = make([]byte, size)
		}
		payload = payload[:size]
		if _, err := io.ReadFull(r, payload); err != nil {
			return err
		}
		switch hdr[0] {
		case 1:
			if err := emit("stdout", payload); err != nil {
				return err
			}
		case 2:
			if err := emit("stderr", payload); err != nil {
				return err
			}
		}
		// Other stream types (stdin echo) carry no log output.
	}
}

// lineBuf turns arbitrary chunks into lines.
type lineBuf struct{ buf []byte }

func (l *lineBuf) write(p []byte, emit func(string) error) error {
	l.buf = append(l.buf, p...)
	consumed := 0
	for {
		i := bytes.IndexByte(l.buf[consumed:], '\n')
		if i < 0 {
			break
		}
		line := bytes.TrimSuffix(l.buf[consumed:consumed+i], []byte{'\r'})
		consumed += i + 1
		if err := emit(string(line)); err != nil {
			return err
		}
	}
	n := copy(l.buf, l.buf[consumed:])
	l.buf = l.buf[:n]
	if len(l.buf) > maxLine {
		line := string(l.buf)
		l.buf = l.buf[:0]
		return emit(line)
	}
	return nil
}

func (l *lineBuf) flush(emit func(string) error) error {
	if len(l.buf) == 0 {
		return nil
	}
	line := string(bytes.TrimSuffix(l.buf, []byte{'\r'}))
	l.buf = l.buf[:0]
	return emit(line)
}

// parseLine splits the RFC 3339 timestamp the engine prepends to each line.
func parseLine(stream, s string) LogLine {
	ll := LogLine{Stream: stream, Line: s}
	ts, rest, found := strings.Cut(s, " ")
	if t, err := time.Parse(time.RFC3339Nano, ts); err == nil {
		ll.Time = t
		if found {
			ll.Line = rest
		} else {
			ll.Line = ""
		}
	}
	return ll
}
