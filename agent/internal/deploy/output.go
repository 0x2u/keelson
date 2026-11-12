package deploy

import (
	"context"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/0x2u/keelson/agent/internal/docker"
)

const (
	// OutputLevel is the level of the deployment events that hold a failed container's own output, one per line.
	// Readers show them apart from the progress log: they are the app's stdout and stderr, not the agent's words.
	OutputLevel = "output"

	// maxOutputLines and maxOutputBytes bound what is kept of a failed container's output (its end: that is where
	// the cause is). maxOutputLine cuts a single endless line.
	maxOutputLines = 200
	maxOutputBytes = 32 << 10
	maxOutputLine  = 4 << 10
)

// outputTimeout bounds reading the logs: a stuck engine must not hold a deployment, whose container is removed
// right after. It is a variable for the tests.
var outputTimeout = 10 * time.Second

// recordOutput stores the end of a failed container's output as deployment events of level "output", before the
// container is removed. It never fails the deployment: a container that is gone or whose logs cannot be read is
// told in a warning, and the wait is bounded. The app's output is stored as it is: it is the app's own.
func (d *Deployer) recordOutput(id, name string) {
	ctx, cancel := context.WithTimeout(context.Background(), outputTimeout)
	defer cancel()

	var lines []string
	err := d.eng.Logs(ctx, name, docker.LogOptions{Tail: "200"}, func(l docker.LogLine) error {
		lines = append(lines, l.Line)
		if len(lines) > 2*maxOutputLines { // Tail bounds the engine's answer; a fake or an old engine may not
			lines = lines[len(lines)-maxOutputLines:]
		}
		return nil
	})
	switch {
	case docker.IsNotFound(err):
		return // never created: nothing ran
	case err != nil && len(lines) == 0:
		d.event(id, "warn", "could not read the output of %s: %v", name, err)
		return
	}
	lines, cut := boundOutput(lines)
	if len(lines) == 0 {
		d.event(id, "info", "%s printed no output", name)
		return
	}
	head := "last output of " + name + ":"
	if cut {
		head = "last output of " + name + " (older lines are not kept):"
	}
	d.event(id, "info", "%s", head)
	for _, l := range lines {
		d.event(id, OutputLevel, "%s", l)
	}
}

// boundOutput keeps the last maxOutputLines lines that fit in maxOutputBytes, each cut to maxOutputLine, and says
// whether it dropped anything.
func boundOutput(lines []string) ([]string, bool) {
	cut := false
	if len(lines) > maxOutputLines {
		lines, cut = lines[len(lines)-maxOutputLines:], true
	}
	total, keep := 0, len(lines)
	for i := len(lines) - 1; i >= 0; i-- {
		lines[i] = cutLine(lines[i])
		total += len(lines[i]) + 1
		if total > maxOutputBytes {
			keep, cut = len(lines)-1-i, true
			break
		}
	}
	return lines[len(lines)-keep:], cut
}

// cutLine shortens a line to maxOutputLine bytes without splitting a character, and drops NULs and invalid UTF-8,
// which an event cannot carry.
func cutLine(s string) string {
	s = strings.ToValidUTF8(strings.ReplaceAll(s, "\x00", ""), "\uFFFD")
	if len(s) <= maxOutputLine {
		return s
	}
	n := maxOutputLine
	for n > 0 && !utf8.RuneStart(s[n]) {
		n--
	}
	return s[:n] + "…"
}
