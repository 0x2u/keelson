package docker

import (
	"bufio"
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// Admin is a Client that can also change the engine: pull images and manage
// containers. The agent only builds one when deployments are enabled; the
// read-only API never holds an Admin.
type Admin struct {
	*Client
}

// NewAdmin returns an Admin that dials the engine on the given unix socket.
func NewAdmin(socketPath string) *Admin {
	return &Admin{Client: New(socketPath)}
}

// PortBinding publishes a container port on the host.
type PortBinding struct {
	HostIP        string
	HostPort      string
	ContainerPort string
	Proto         string // "tcp" or "udp"
}

// ContainerSpec describes a container to create.
type ContainerSpec struct {
	Name          string
	Image         string
	Env           []string
	Labels        map[string]string
	Cmd           []string
	Ports         []PortBinding
	Binds         []string
	NetworkMode   string
	RestartPolicy string
	StopTimeout   int // seconds
	// User, when set, is the "uid:gid" the container's process runs as (default: the image's user).
	User string
	// LogDriver, when set, is the logging driver and its rotation: max-size such as "10m" and the number of files.
	LogDriver  string
	LogMaxSize string
	LogMaxFile int
	// Memory caps the container's memory in bytes, with no swap beyond it; 0 means no cap.
	Memory int64
	// Healthcheck replaces the image's HEALTHCHECK; nil keeps it.
	Healthcheck *Healthcheck
	// ExtraNetworks are user-defined networks the container joins after it is created and before it starts, besides
	// NetworkMode. Create removes the container again when one cannot be joined.
	ExtraNetworks []string
}

// Healthcheck is a container's own health command.
type Healthcheck struct {
	// Test is the command, such as {"CMD-SHELL", "pg_isready"}.
	Test        []string
	Interval    time.Duration
	Timeout     time.Duration
	StartPeriod time.Duration
	Retries     int
}

// Pull pulls repo:ref, where ref is a tag or a sha256 digest. auth is the
// base64url X-Registry-Auth value, empty for anonymous pulls. progress
// receives the milestones of the pull, not every layer update.
func (a *Admin) Pull(ctx context.Context, repo, ref, auth string, progress func(string)) error {
	q := url.Values{"fromImage": {repo}, "tag": {ref}}
	var hdr map[string]string
	if auth != "" {
		hdr = map[string]string{"X-Registry-Auth": auth}
	}
	resp, err := request(ctx, a.hc, http.MethodPost, "/images/create", q, nil, hdr)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	// The engine answers 200 and reports failures inside the JSON stream.
	sc := bufio.NewScanner(resp.Body)
	sc.Buffer(make([]byte, 64<<10), 1<<20)
	for sc.Scan() {
		var m struct {
			Status string `json:"status"`
			Error  string `json:"error"`
		}
		if json.Unmarshal(sc.Bytes(), &m) != nil {
			continue
		}
		if m.Error != "" {
			return fmt.Errorf("pull %s:%s: %s", repo, ref, m.Error)
		}
		if progress != nil && (strings.HasPrefix(m.Status, "Pulling from") ||
			strings.HasPrefix(m.Status, "Digest:") || strings.HasPrefix(m.Status, "Status:")) {
			progress(m.Status)
		}
	}
	return sc.Err()
}

// RegistryAuth builds the X-Registry-Auth header value.
func RegistryAuth(server, username, password string) string {
	b, _ := json.Marshal(map[string]string{"username": username, "password": password, "serveraddress": server})
	return base64.URLEncoding.EncodeToString(b)
}

// Create creates a container and returns its ID.
func (a *Admin) Create(ctx context.Context, s ContainerSpec) (string, error) {
	if err := checkID(s.Name); err != nil {
		return "", err
	}
	exposed := map[string]struct{}{}
	bindings := map[string][]map[string]string{}
	for _, p := range s.Ports {
		key := p.ContainerPort + "/" + p.Proto
		exposed[key] = struct{}{}
		bindings[key] = append(bindings[key], map[string]string{"HostIp": p.HostIP, "HostPort": p.HostPort})
	}
	host := map[string]any{
		"PortBindings":  bindings,
		"Binds":         s.Binds,
		"RestartPolicy": map[string]string{"Name": s.RestartPolicy},
	}
	if s.NetworkMode != "" {
		host["NetworkMode"] = s.NetworkMode
	}
	if s.Memory > 0 {
		host["Memory"] = s.Memory
		host["MemorySwap"] = s.Memory // the same value: no swap beyond the cap
	}
	if s.LogDriver != "" {
		cfg := map[string]string{}
		if s.LogMaxSize != "" {
			cfg["max-size"] = s.LogMaxSize
		}
		if s.LogMaxFile > 0 {
			cfg["max-file"] = strconv.Itoa(s.LogMaxFile)
		}
		host["LogConfig"] = map[string]any{"Type": s.LogDriver, "Config": cfg}
	}
	body := map[string]any{
		"Image":        s.Image,
		"Env":          s.Env,
		"Labels":       s.Labels,
		"ExposedPorts": exposed,
		"HostConfig":   host,
		"StopTimeout":  s.StopTimeout,
	}
	if s.User != "" {
		body["User"] = s.User
	}
	if h := s.Healthcheck; h != nil {
		body["Healthcheck"] = map[string]any{
			"Test": h.Test, "Interval": h.Interval.Nanoseconds(), "Timeout": h.Timeout.Nanoseconds(),
			"StartPeriod": h.StartPeriod.Nanoseconds(), "Retries": h.Retries,
		}
	}
	if len(s.Cmd) > 0 {
		body["Cmd"] = s.Cmd
	}
	b, err := json.Marshal(body)
	if err != nil {
		return "", err
	}
	resp, err := request(ctx, a.hc, http.MethodPost, "/containers/create", url.Values{"name": {s.Name}}, bytes.NewReader(b),
		map[string]string{"Content-Type": "application/json"})
	if err != nil {
		return "", err
	}
	var out struct {
		ID string `json:"Id"`
	}
	err = json.NewDecoder(resp.Body).Decode(&out)
	resp.Body.Close()
	if err != nil {
		return "", err
	}
	for _, n := range s.ExtraNetworks {
		if err := a.ConnectNetwork(ctx, n, out.ID); err != nil {
			// A container that cannot reach what it was made to reach must not exist half-made.
			rmCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 15*time.Second)
			_ = a.act(rmCtx, http.MethodDelete, out.ID, "", url.Values{"force": {"1"}, "v": {"1"}})
			cancel()
			return "", fmt.Errorf("join network %s: %w", n, err)
		}
	}
	return out.ID, nil
}

// act sends a mutating request with no body and treats 304 (already in the
// requested state) as success.
func (a *Admin) act(ctx context.Context, method, id, suffix string, q url.Values) error {
	if err := checkID(id); err != nil {
		return err
	}
	resp, err := request(ctx, a.hc, method, "/containers/"+url.PathEscape(id)+suffix, q, nil, nil)
	if err != nil {
		var de *Error
		if errors.As(err, &de) && de.Status == http.StatusNotModified {
			return nil
		}
		return err
	}
	_, _ = io.Copy(io.Discard, resp.Body)
	return resp.Body.Close()
}

// Start starts a container.
func (a *Admin) Start(ctx context.Context, id string) error {
	return a.act(ctx, http.MethodPost, id, "/start", nil)
}

// Stop stops a container, killing it after timeoutSec seconds.
func (a *Admin) Stop(ctx context.Context, id string, timeoutSec int) error {
	return a.act(ctx, http.MethodPost, id, "/stop", url.Values{"t": {strconv.Itoa(timeoutSec)}})
}

// Rename renames a container.
func (a *Admin) Rename(ctx context.Context, id, newName string) error {
	if err := checkID(newName); err != nil {
		return err
	}
	return a.act(ctx, http.MethodPost, id, "/rename", url.Values{"name": {newName}})
}

// Remove force-removes a container. Volumes are kept: an app's data must survive its container.
func (a *Admin) Remove(ctx context.Context, id string) error {
	return a.act(ctx, http.MethodDelete, id, "", url.Values{"force": {"1"}})
}

// RemoveThrowaway force-removes a container that was only ever meant to run once, together with its anonymous
// volumes: an image such as postgres declares a VOLUME, so each run would leave one behind. Named volumes and bind
// mounts are never removed. It must not be used for an app's container.
func (a *Admin) RemoveThrowaway(ctx context.Context, id string) error {
	return a.act(ctx, http.MethodDelete, id, "", url.Values{"force": {"1"}, "v": {"1"}})
}

// Wait blocks until the container stops and returns its exit code. The
// context bounds the wait: cancel it to stop waiting (the container itself is
// not touched).
func (a *Admin) Wait(ctx context.Context, id string) (int, error) {
	if err := checkID(id); err != nil {
		return 0, err
	}
	resp, err := request(ctx, a.hc, http.MethodPost, "/containers/"+url.PathEscape(id)+"/wait", url.Values{"condition": {"not-running"}}, nil, nil)
	if err != nil {
		return 0, err
	}
	defer resp.Body.Close()
	var out struct {
		StatusCode int `json:"StatusCode"`
		Error      *struct {
			Message string `json:"Message"`
		} `json:"Error"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return 0, err
	}
	if out.Error != nil && out.Error.Message != "" {
		return out.StatusCode, fmt.Errorf("docker: %s", out.Error.Message)
	}
	return out.StatusCode, nil
}
