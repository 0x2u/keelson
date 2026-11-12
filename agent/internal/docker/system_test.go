package docker

import (
	"context"
	"io"
	"net/http"
	"testing"
)

func TestDiskUsageSummarisesWhatCanBeReclaimed(t *testing.T) {
	f := &fakeEngine{handler: func(w http.ResponseWriter, r *http.Request) {
		io.WriteString(w, `{
		  "LayersSize": 900,
		  "Images": [
		    {"Id":"sha256:used","RepoTags":["o/web:v2"],"Created":3,"Size":500,"SharedSize":100,"Containers":1},
		    {"Id":"sha256:old","RepoTags":["o/web:v1"],"Created":1,"Size":500,"SharedSize":400,"Containers":0},
		    {"Id":"sha256:dangling","RepoTags":null,"Created":2,"Size":300,"SharedSize":-1,"Containers":0},
		    {"Id":"sha256:unknown","RepoTags":["x:y"],"Created":4,"Size":700,"SharedSize":0,"Containers":-1}
		  ],
		  "Containers": [{"SizeRw": 10}, {"SizeRw": -1}, {"SizeRw": 5}],
		  "Volumes": [
		    {"UsageData": {"Size": 1000, "RefCount": 1}},
		    {"UsageData": {"Size": -1, "RefCount": 0}},
		    {"UsageData": {"Size": 50, "RefCount": 0}}
		  ],
		  "BuildCache": [{"Size": 70, "InUse": true}, {"Size": 30, "InUse": false}]
		}`)
	}}
	u, err := newClient(t, f).DiskUsage(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if u.Images.Count != 4 || u.Images.Size != 900 {
		t.Errorf("images: %+v", u.Images)
	}
	// Only the two images no container uses count; a count of -1 means "not measured" and is never offered for removal.
	if u.Images.Unused != 2 || u.Images.Reclaimable != 100+300 {
		t.Errorf("unused %d reclaimable %d", u.Images.Unused, u.Images.Reclaimable)
	}
	if len(u.Images.Largest) != 2 || u.Images.Largest[0].ID != "sha256:dangling" || u.Images.Largest[1].Size != 100 {
		t.Errorf("largest: %+v", u.Images.Largest)
	}
	if u.Containers.Count != 3 || u.Containers.Size != 15 {
		t.Errorf("containers: %+v", u.Containers)
	}
	if u.Volumes.Count != 3 || u.Volumes.Size != 1050 || u.Volumes.Unused != 2 {
		t.Errorf("volumes: %+v", u.Volumes)
	}
	if u.BuildCache.Size != 100 || u.BuildCache.Reclaimable != 30 {
		t.Errorf("build cache: %+v", u.BuildCache)
	}
	if got := f.requests()[0]; got != "GET /system/df" {
		t.Errorf("request %q", got)
	}
}

func TestDiskUsageListsAtMostTwentyUnusedImages(t *testing.T) {
	f := &fakeEngine{handler: func(w http.ResponseWriter, r *http.Request) {
		io.WriteString(w, `{"Images":[`)
		for i := 0; i < 25; i++ {
			if i > 0 {
				io.WriteString(w, ",")
			}
			io.WriteString(w, `{"Id":"i","Size":10,"SharedSize":0,"Containers":0}`)
		}
		io.WriteString(w, `]}`)
	}}
	u, err := newClient(t, f).DiskUsage(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if u.Images.Unused != 25 || u.Images.Reclaimable != 250 || len(u.Images.Largest) != maxUnusedImages {
		t.Errorf("%d unused, %d reclaimable, %d listed", u.Images.Unused, u.Images.Reclaimable, len(u.Images.Largest))
	}
}

func TestInfoNormalisesTheEnginePlatform(t *testing.T) {
	for _, tc := range []struct{ arch, wantArch string }{{"x86_64", "amd64"}, {"aarch64", "arm64"}, {"arm64", "arm64"}, {"amd64", "amd64"}, {"armv7l", ""}, {"", ""}} {
		f := &fakeEngine{handler: func(w http.ResponseWriter, r *http.Request) {
			io.WriteString(w, `{"OSType":"Linux","Architecture":"`+tc.arch+`"}`)
		}}
		i, err := newClient(t, f).Info(context.Background())
		if err != nil {
			t.Fatal(err)
		}
		if i.Arch != tc.wantArch || i.OSType != "linux" {
			t.Errorf("%q: %s/%s, want linux/%s", tc.arch, i.OSType, i.Arch, tc.wantArch)
		}
	}
}

func TestInfoReadsEngineAndHostFacts(t *testing.T) {
	f := &fakeEngine{handler: func(w http.ResponseWriter, r *http.Request) {
		io.WriteString(w, `{"Name":"vps","ServerVersion":"27.1.1","OperatingSystem":"Debian 13","NCPU":2,"MemTotal":2000000000,"DockerRootDir":"/var/lib/docker","Containers":5,"ContainersRunning":3,"Images":9}`)
	}}
	i, err := newClient(t, f).Info(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if i.Version != "27.1.1" || i.CPUs != 2 || i.RootDir != "/var/lib/docker" || i.Running != 3 || i.Images != 9 || i.MemTotal != 2000000000 {
		t.Errorf("%+v", i)
	}
}
