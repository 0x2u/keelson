package docker

import (
	"context"
	"encoding/json"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"
)

// Port is a published or exposed container port.
type Port struct {
	IP          string `json:"ip,omitempty"`
	PrivatePort uint16 `json:"private_port"`
	PublicPort  uint16 `json:"public_port,omitempty"`
	Type        string `json:"type"`
}

// Container is the list view of a container.
type Container struct {
	ID      string            `json:"id"`
	Name    string            `json:"name"`
	Image   string            `json:"image"`
	ImageID string            `json:"image_id"`
	Command string            `json:"command"`
	Created int64             `json:"created"`
	State   string            `json:"state"`
	Status  string            `json:"status"`
	Labels  map[string]string `json:"labels"`
	Ports   []Port            `json:"ports"`
}

type rawContainer struct {
	ID      string            `json:"Id"`
	Names   []string          `json:"Names"`
	Image   string            `json:"Image"`
	ImageID string            `json:"ImageID"`
	Command string            `json:"Command"`
	Created int64             `json:"Created"`
	State   string            `json:"State"`
	Status  string            `json:"Status"`
	Labels  map[string]string `json:"Labels"`
	Ports   []struct {
		IP          string `json:"IP"`
		PrivatePort uint16 `json:"PrivatePort"`
		PublicPort  uint16 `json:"PublicPort"`
		Type        string `json:"Type"`
	} `json:"Ports"`
}

// ListContainers lists running containers, or all containers when all is set.
func (c *Client) ListContainers(ctx context.Context, all bool) ([]Container, error) {
	q := url.Values{}
	if all {
		q.Set("all", "1")
	}
	return c.list(ctx, q)
}

// ListByLabel lists all containers, running or not, that carry the label
// ("key" or "key=value").
func (c *Client) ListByLabel(ctx context.Context, label string) ([]Container, error) {
	filters, err := json.Marshal(map[string][]string{"label": {label}})
	if err != nil {
		return nil, err
	}
	return c.list(ctx, url.Values{"all": {"1"}, "filters": {string(filters)}})
}

func (c *Client) list(ctx context.Context, q url.Values) ([]Container, error) {
	var raw []rawContainer
	if err := c.getJSON(ctx, "/containers/json", q, &raw); err != nil {
		return nil, err
	}
	out := make([]Container, 0, len(raw))
	for _, r := range raw {
		ct := Container{
			ID:      r.ID,
			Image:   r.Image,
			ImageID: r.ImageID,
			Command: r.Command,
			Created: r.Created,
			State:   r.State,
			Status:  r.Status,
			Labels:  r.Labels,
			Ports:   make([]Port, 0, len(r.Ports)),
		}
		if len(r.Names) > 0 {
			ct.Name = strings.TrimPrefix(r.Names[0], "/")
		}
		if ct.Labels == nil {
			ct.Labels = map[string]string{}
		}
		for _, p := range r.Ports {
			ct.Ports = append(ct.Ports, Port{IP: p.IP, PrivatePort: p.PrivatePort, PublicPort: p.PublicPort, Type: p.Type})
		}
		out = append(out, ct)
	}
	return out, nil
}

// State is the runtime state of a container.
type State struct {
	Status     string     `json:"status"`
	Running    bool       `json:"running"`
	Paused     bool       `json:"paused"`
	Restarting bool       `json:"restarting"`
	OOMKilled  bool       `json:"oom_killed"`
	ExitCode   int        `json:"exit_code"`
	StartedAt  *time.Time `json:"started_at,omitempty"`
	FinishedAt *time.Time `json:"finished_at,omitempty"`
	// Health is "starting", "healthy" or "unhealthy"; empty when the image
	// defines no HEALTHCHECK.
	Health string `json:"health,omitempty"`
}

// Detail is the inspect view of a container. It deliberately omits the
// environment and mounts: environments routinely hold secrets.
type Detail struct {
	ID    string `json:"id"`
	Name  string `json:"name"`
	Image string `json:"image"`
	// ImageID is the engine's id of the image the container was created from (sha256:...), which stays the same
	// when its tag moves.
	ImageID      string    `json:"image_id"`
	Created      time.Time `json:"created"`
	TTY          bool      `json:"tty"`
	RestartCount int       `json:"restart_count"`
	State        State     `json:"state"`
	// Ports lists the container ports published on the host, with the host
	// port the engine assigned.
	Ports []Port `json:"ports"`
	// Env is the container's environment, for the agent's own use (reading the
	// port a container to be replaced listens on). It is never serialized:
	// environments routinely hold secrets.
	Env []string `json:"-"`
	// Labels, MemoryLimit (bytes, 0 = none), Networks (the names of the networks the container is on), Volumes (the
	// named volumes it mounts) and ConfiguredPorts (published ports as configured, which a stopped container still
	// has) are what the agent checks about a container of its own. They are not part of the API's view of a container.
	Labels          map[string]string `json:"-"`
	MemoryLimit     int64             `json:"-"`
	Networks        []string          `json:"-"`
	Volumes         []string          `json:"-"`
	ConfiguredPorts []Port            `json:"-"`
}

type rawInspect struct {
	ID           string    `json:"Id"`
	Image        string    `json:"Image"`
	Name         string    `json:"Name"`
	Created      time.Time `json:"Created"`
	RestartCount int       `json:"RestartCount"`
	Config       struct {
		Image  string            `json:"Image"`
		Tty    bool              `json:"Tty"`
		Env    []string          `json:"Env"`
		Labels map[string]string `json:"Labels"`
	} `json:"Config"`
	State struct {
		Status     string    `json:"Status"`
		Running    bool      `json:"Running"`
		Paused     bool      `json:"Paused"`
		Restarting bool      `json:"Restarting"`
		OOMKilled  bool      `json:"OOMKilled"`
		ExitCode   int       `json:"ExitCode"`
		StartedAt  time.Time `json:"StartedAt"`
		FinishedAt time.Time `json:"FinishedAt"`
		Health     *struct {
			Status string `json:"Status"`
		} `json:"Health"`
	} `json:"State"`
	NetworkSettings struct {
		Ports    map[string][]rawBinding `json:"Ports"`
		Networks map[string]struct{}     `json:"Networks"`
	} `json:"NetworkSettings"`
	HostConfig struct {
		Memory       int64                   `json:"Memory"`
		PortBindings map[string][]rawBinding `json:"PortBindings"`
	} `json:"HostConfig"`
	Mounts []struct {
		Type string `json:"Type"`
		Name string `json:"Name"`
	} `json:"Mounts"`
}

type rawBinding struct {
	HostIP   string `json:"HostIp"`
	HostPort string `json:"HostPort"`
}

// publishedPorts flattens the engine's "3000/tcp" -> bindings map. Ports that
// are exposed but not published have no bindings and are left out.
func publishedPorts(m map[string][]rawBinding) []Port {
	var out []Port
	for key, bindings := range m {
		priv, proto, _ := strings.Cut(key, "/")
		pn, err := strconv.ParseUint(priv, 10, 16)
		if err != nil {
			continue
		}
		for _, b := range bindings {
			hn, err := strconv.ParseUint(b.HostPort, 10, 16)
			if err != nil {
				continue
			}
			out = append(out, Port{IP: b.HostIP, PrivatePort: uint16(pn), PublicPort: uint16(hn), Type: proto})
		}
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].PrivatePort != out[j].PrivatePort {
			return out[i].PrivatePort < out[j].PrivatePort
		}
		return out[i].PublicPort < out[j].PublicPort
	})
	return out
}
func nonZero(t time.Time) *time.Time {
	if t.IsZero() || t.Year() <= 1 {
		return nil
	}
	return &t
}

// Inspect returns the detail view of one container, by ID or name.
func (c *Client) Inspect(ctx context.Context, id string) (*Detail, error) {
	if err := checkID(id); err != nil {
		return nil, err
	}
	var r rawInspect
	if err := c.getJSON(ctx, "/containers/"+url.PathEscape(id)+"/json", nil, &r); err != nil {
		return nil, err
	}
	d := &Detail{
		ID:           r.ID,
		Name:         strings.TrimPrefix(r.Name, "/"),
		Image:        r.Config.Image,
		ImageID:      r.Image,
		Created:      r.Created,
		TTY:          r.Config.Tty,
		RestartCount: r.RestartCount,
		State: State{
			Status:     r.State.Status,
			Running:    r.State.Running,
			Paused:     r.State.Paused,
			Restarting: r.State.Restarting,
			OOMKilled:  r.State.OOMKilled,
			ExitCode:   r.State.ExitCode,
			StartedAt:  nonZero(r.State.StartedAt),
			FinishedAt: nonZero(r.State.FinishedAt),
		},
	}
	if r.State.Health != nil {
		d.State.Health = r.State.Health.Status
	}
	d.Ports = publishedPorts(r.NetworkSettings.Ports)
	d.Env = r.Config.Env
	d.Labels = r.Config.Labels
	d.MemoryLimit = r.HostConfig.Memory
	d.ConfiguredPorts = publishedPorts(r.HostConfig.PortBindings)
	for n := range r.NetworkSettings.Networks {
		d.Networks = append(d.Networks, n)
	}
	sort.Strings(d.Networks)
	for _, m := range r.Mounts {
		if m.Type == "volume" && m.Name != "" {
			d.Volumes = append(d.Volumes, m.Name)
		}
	}
	return d, nil
}
