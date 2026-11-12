package docker

import (
	"archive/tar"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"
)

// resourceName is what the agent accepts as the name of a network or a volume it creates: the engine's own rule.
var resourceName = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$`)

// ErrInvalidName is returned for a network or volume name that could not be one.
var ErrInvalidName = errors.New("docker: invalid network or volume name")

func checkResourceName(name string) error {
	if !resourceName.MatchString(name) {
		return ErrInvalidName
	}
	return nil
}

// EnsureNetwork creates the user-defined bridge network name unless it exists, and reports whether it did. Labels
// are applied to a network that is created, never to one that was already there.
func (a *Admin) EnsureNetwork(ctx context.Context, name string, labels map[string]string) (created bool, err error) {
	if err := checkResourceName(name); err != nil {
		return false, err
	}
	resp, err := a.get(ctx, "/networks/"+url.PathEscape(name), nil)
	if err == nil {
		resp.Body.Close()
		return false, nil
	}
	if !IsNotFound(err) {
		return false, err
	}
	b, err := json.Marshal(map[string]any{"Name": name, "Driver": "bridge", "CheckDuplicate": true, "Labels": labels})
	if err != nil {
		return false, err
	}
	resp, err = request(ctx, a.hc, http.MethodPost, "/networks/create", nil, bytes.NewReader(b), map[string]string{"Content-Type": "application/json"})
	if err != nil {
		var de *Error
		if errors.As(err, &de) && de.Status == http.StatusConflict {
			return false, nil // created meanwhile
		}
		return false, err
	}
	resp.Body.Close()
	return true, nil
}

// ConnectNetwork joins a container to a network. A container that is already on it is not an error.
func (a *Admin) ConnectNetwork(ctx context.Context, network, container string) error {
	if err := checkResourceName(network); err != nil {
		return err
	}
	if err := checkID(container); err != nil {
		return err
	}
	b, err := json.Marshal(map[string]string{"Container": container})
	if err != nil {
		return err
	}
	resp, err := request(ctx, a.hc, http.MethodPost, "/networks/"+url.PathEscape(network)+"/connect", nil, bytes.NewReader(b), map[string]string{"Content-Type": "application/json"})
	if err != nil {
		var de *Error
		if errors.As(err, &de) && strings.Contains(de.Message, "already exists in network") {
			return nil
		}
		return err
	}
	return resp.Body.Close()
}

// VolumeExists reports whether a named volume exists.
func (c *Client) VolumeExists(ctx context.Context, name string) (bool, error) {
	if err := checkResourceName(name); err != nil {
		return false, err
	}
	resp, err := c.get(ctx, "/volumes/"+url.PathEscape(name), nil)
	switch {
	case err == nil:
		resp.Body.Close()
		return true, nil
	case IsNotFound(err):
		return false, nil
	}
	return false, err
}

// EnsureVolume creates the named volume unless it exists, and reports whether it did. A volume made here is always
// named: a container that mounts it by name never leaves an anonymous one behind.
func (a *Admin) EnsureVolume(ctx context.Context, name string, labels map[string]string) (created bool, err error) {
	exists, err := a.VolumeExists(ctx, name)
	if err != nil || exists {
		return false, err
	}
	b, err := json.Marshal(map[string]any{"Name": name, "Labels": labels})
	if err != nil {
		return false, err
	}
	resp, err := request(ctx, a.hc, http.MethodPost, "/volumes/create", nil, bytes.NewReader(b), map[string]string{"Content-Type": "application/json"})
	if err != nil {
		return false, err
	}
	resp.Body.Close()
	return true, nil
}

// PutFile writes one file into a container that has not started yet (or is running), at dir/name, owned by uid:gid
// with the given mode. The file lives in the container's own layer: it is part of no image and of no inspect output,
// and it goes with the container. dir must already exist in the image, or be below a directory that does.
func (a *Admin) PutFile(ctx context.Context, container, dir, name string, data []byte, uid, gid int, mode int64) error {
	if err := checkID(container); err != nil {
		return err
	}
	if !strings.HasPrefix(dir, "/") || strings.Contains(dir, "..") || strings.ContainsAny(name, "/\x00") || name == "" {
		return fmt.Errorf("docker: invalid path %q/%q", dir, name)
	}
	var buf bytes.Buffer
	tw := tar.NewWriter(&buf)
	// Entries are relative to /: every directory of the path is listed so that one the image lacks is created.
	var path string
	for _, part := range strings.Split(strings.Trim(dir, "/"), "/") {
		path += part + "/"
		if err := tw.WriteHeader(&tar.Header{Typeflag: tar.TypeDir, Name: path, Mode: 0o755, ModTime: time.Unix(0, 0)}); err != nil {
			return err
		}
	}
	hdr := &tar.Header{Typeflag: tar.TypeReg, Name: path + name, Mode: mode, Uid: uid, Gid: gid, Size: int64(len(data)), ModTime: time.Unix(0, 0)}
	if err := tw.WriteHeader(hdr); err != nil {
		return err
	}
	if _, err := tw.Write(data); err != nil {
		return err
	}
	if err := tw.Close(); err != nil {
		return err
	}
	resp, err := request(ctx, a.hc, http.MethodPut, "/containers/"+url.PathEscape(container)+"/archive", url.Values{"path": {"/"}}, &buf, map[string]string{"Content-Type": "application/x-tar"})
	if err != nil {
		return err
	}
	return resp.Body.Close()
}
