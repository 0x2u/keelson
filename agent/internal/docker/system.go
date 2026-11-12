package docker

import (
	"context"
	"sort"
	"strings"
)

// EngineInfo is what the engine says about itself and the machine it runs on.
type EngineInfo struct {
	Name       string `json:"name"`
	Version    string `json:"version"`
	OS         string `json:"os"`
	CPUs       int    `json:"cpus"`
	MemTotal   int64  `json:"mem_total"`
	RootDir    string `json:"root_dir"`
	Containers int    `json:"containers"`
	Running    int    `json:"running"`
	Images     int    `json:"images"`
	// OSType and Arch are the platform the engine builds for and runs ("linux", "amd64" or "arm64"); empty when the
	// engine does not say or says one the agent does not know. They are reported at the top of GET /v1/system, not here.
	OSType string `json:"-"`
	Arch   string `json:"-"`
}

// NormalizeArch maps the names engines and image configs use for a CPU architecture ("x86_64", "aarch64", "amd64",
// "arm64") to "amd64" or "arm64", and anything else to "".
func NormalizeArch(s string) string {
	switch strings.ToLower(s) {
	case "amd64", "x86_64":
		return "amd64"
	case "arm64", "aarch64":
		return "arm64"
	}
	return ""
}

// Info reads the engine's /info.
func (c *Client) Info(ctx context.Context) (*EngineInfo, error) {
	var raw struct {
		Name              string `json:"Name"`
		ServerVersion     string `json:"ServerVersion"`
		OperatingSystem   string `json:"OperatingSystem"`
		NCPU              int    `json:"NCPU"`
		MemTotal          int64  `json:"MemTotal"`
		DockerRootDir     string `json:"DockerRootDir"`
		Containers        int    `json:"Containers"`
		ContainersRunning int    `json:"ContainersRunning"`
		Images            int    `json:"Images"`
		OSType            string `json:"OSType"`
		Architecture      string `json:"Architecture"`
	}
	if err := c.getJSON(ctx, "/info", nil, &raw); err != nil {
		return nil, err
	}
	return &EngineInfo{
		Name: raw.Name, Version: raw.ServerVersion, OS: raw.OperatingSystem, CPUs: raw.NCPU, MemTotal: raw.MemTotal,
		RootDir: raw.DockerRootDir, Containers: raw.Containers, Running: raw.ContainersRunning, Images: raw.Images,
		OSType: strings.ToLower(raw.OSType), Arch: NormalizeArch(raw.Architecture),
	}, nil
}

// maxUnusedImages bounds the list of unused images sent to the dashboard.
const maxUnusedImages = 20

// UnusedImage is a local image no container uses.
type UnusedImage struct {
	ID      string   `json:"id"`
	Tags    []string `json:"tags"`
	Created int64    `json:"created"`
	// Size is what removing the image frees: its size without the layers other images share.
	Size int64 `json:"size"`
}

// DiskUsage is the engine's own accounting of the disk it uses, summarised.
type DiskUsage struct {
	Images struct {
		Count  int `json:"count"`
		Unused int `json:"unused"`
		// Size counts shared layers once.
		Size int64 `json:"size"`
		// Reclaimable is the sum of the unused images' own sizes: removing all of them frees at least that much.
		Reclaimable int64 `json:"reclaimable"`
		// Largest are the biggest unused images (at most maxUnusedImages), biggest first.
		Largest []UnusedImage `json:"largest"`
	} `json:"images"`
	Containers struct {
		Count int `json:"count"`
		// Size is the sum of the containers' writable layers.
		Size int64 `json:"size"`
	} `json:"containers"`
	Volumes struct {
		Count  int   `json:"count"`
		Unused int   `json:"unused"`
		Size   int64 `json:"size"`
	} `json:"volumes"`
	BuildCache struct {
		Count       int   `json:"count"`
		Size        int64 `json:"size"`
		Reclaimable int64 `json:"reclaimable"`
	} `json:"build_cache"`
}

// DiskUsage reads /system/df. The engine measures every layer and volume, which can take seconds on a busy host.
func (c *Client) DiskUsage(ctx context.Context) (*DiskUsage, error) {
	var raw struct {
		LayersSize int64 `json:"LayersSize"`
		Images     []struct {
			ID         string   `json:"Id"`
			RepoTags   []string `json:"RepoTags"`
			Created    int64    `json:"Created"`
			Size       int64    `json:"Size"`
			SharedSize int64    `json:"SharedSize"`
			Containers int64    `json:"Containers"`
		} `json:"Images"`
		Containers []struct {
			SizeRw int64 `json:"SizeRw"`
		} `json:"Containers"`
		Volumes []struct {
			UsageData *struct {
				Size     int64 `json:"Size"`
				RefCount int64 `json:"RefCount"`
			} `json:"UsageData"`
		} `json:"Volumes"`
		BuildCache []struct {
			Size  int64 `json:"Size"`
			InUse bool  `json:"InUse"`
		} `json:"BuildCache"`
	}
	if err := c.getJSON(ctx, "/system/df", nil, &raw); err != nil {
		return nil, err
	}

	var u DiskUsage
	u.Images.Count = len(raw.Images)
	u.Images.Size = atLeastZero(raw.LayersSize)
	for _, img := range raw.Images {
		if img.Containers != 0 { // -1 means the engine did not count: treat it as used, never offer it for removal
			continue
		}
		own := img.Size
		if img.SharedSize >= 0 && img.SharedSize <= own {
			own -= img.SharedSize
		}
		own = atLeastZero(own)
		u.Images.Unused++
		u.Images.Reclaimable += own
		u.Images.Largest = append(u.Images.Largest, UnusedImage{ID: img.ID, Tags: img.RepoTags, Created: img.Created, Size: own})
	}
	sort.SliceStable(u.Images.Largest, func(i, j int) bool { return u.Images.Largest[i].Size > u.Images.Largest[j].Size })
	if len(u.Images.Largest) > maxUnusedImages {
		u.Images.Largest = u.Images.Largest[:maxUnusedImages]
	}
	if u.Images.Largest == nil {
		u.Images.Largest = []UnusedImage{}
	}

	u.Containers.Count = len(raw.Containers)
	for _, ct := range raw.Containers {
		u.Containers.Size += atLeastZero(ct.SizeRw)
	}

	u.Volumes.Count = len(raw.Volumes)
	for _, v := range raw.Volumes {
		if v.UsageData == nil {
			continue
		}
		u.Volumes.Size += atLeastZero(v.UsageData.Size)
		if v.UsageData.RefCount == 0 {
			u.Volumes.Unused++
		}
	}

	u.BuildCache.Count = len(raw.BuildCache)
	for _, b := range raw.BuildCache {
		u.BuildCache.Size += atLeastZero(b.Size)
		if !b.InUse {
			u.BuildCache.Reclaimable += atLeastZero(b.Size)
		}
	}
	return &u, nil
}

// atLeastZero maps the engine's -1 ("not measured") to nothing rather than a negative size.
func atLeastZero(n int64) int64 {
	if n < 0 {
		return 0
	}
	return n
}
