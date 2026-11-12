package confmgr

import (
	"os"
	"strings"

	"github.com/0x2u/keelson/agent/internal/config"
)

// ForceSuffix is appended to the apps file's path to name the marker that acknowledges a hand edit.
const ForceSuffix = ".force"

// blockingWarnings returns the warnings that must be acknowledged before a change is applied.
func blockingWarnings(warnings []config.Issue) []config.Issue {
	var out []config.Issue
	for _, w := range warnings {
		if blocking[w.Code] {
			out = append(out, w)
		}
	}
	return out
}

func ackText(needs []config.Issue) string {
	parts := make([]string, len(needs))
	for i, n := range needs {
		parts[i] = n.Message
	}
	return strings.Join(parts, "; ")
}

func (m *Manager) markerPath() string { return m.loc.File + ForceSuffix }

// acknowledged says whether the marker file holds the hash of exactly this version of the configuration (the SHA-256 of the
// apps file, or the hash of the whole bundle when there are project files): an acknowledgement covers one version, so a
// later edit, in any file, has to be acknowledged again.
func (m *Manager) acknowledged(hash string) bool {
	b, err := os.ReadFile(m.markerPath())
	if err != nil {
		return false
	}
	return strings.EqualFold(strings.TrimSpace(string(b)), hash)
}

// consumeMarker removes the marker once its version is applied, so it cannot cover a later round trip to the same text.
func (m *Manager) consumeMarker() {
	if err := os.Remove(m.markerPath()); err != nil && !os.IsNotExist(err) {
		m.log.Warn("could not remove the acknowledgement marker", "file", m.markerPath(), "err", err)
	}
}
