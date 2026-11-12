package databases

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/0x2u/keelson/agent/internal/config"
)

// The two vectors below are published by AWS: "get-vanilla" of the Signature Version 4 test suite, and the "GET
// Bucket Lifecycle" example of the S3 documentation (header signing with x-amz-content-sha256).
func TestSignatureV4MatchesTheAWSTestVectors(t *testing.T) {
	t.Run("get-vanilla", func(t *testing.T) {
		req, _ := http.NewRequest("GET", "https://example.amazonaws.com/", nil)
		s := signer{accessKey: "AKIDEXAMPLE", secretKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY", region: "us-east-1", service: "service"}
		s.sign(req, emptySHA256, time.Date(2015, 8, 30, 12, 36, 0, 0, time.UTC))
		want := "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31"
		if got := req.Header.Get("Authorization"); got != want {
			t.Errorf("Authorization\n got  %s\n want %s", got, want)
		}
	})
	t.Run("s3 get bucket lifecycle", func(t *testing.T) {
		req, _ := http.NewRequest("GET", "https://examplebucket.s3.amazonaws.com/?lifecycle", nil)
		req.Header.Set("X-Amz-Content-Sha256", emptySHA256)
		s := signer{accessKey: "AKIAIOSFODNN7EXAMPLE", secretKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", region: "us-east-1", service: "s3"}
		s.sign(req, emptySHA256, time.Date(2013, 5, 24, 0, 0, 0, 0, time.UTC))
		want := "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=fea454ca298b7da1c68078a5d1bdbfbbe0d65c699e0f91ac7a200a0136783543"
		if got := req.Header.Get("Authorization"); got != want {
			t.Errorf("Authorization\n got  %s\n want %s", got, want)
		}
	})
}

func TestEscaping(t *testing.T) {
	if got := escapePath("/b/keelson prod/shop/a+b~c.dump"); got != "/b/keelson%20prod/shop/a%2Bb~c.dump" {
		t.Errorf("path %q", got)
	}
	q := url.Values{"prefix": {"a b/c"}, "list-type": {"2"}}
	if got := canonicalQuery(q); got != "list-type=2&prefix=a%20b%2Fc" {
		t.Errorf("query %q", got)
	}
}

// fakeS3 is a path-style bucket in memory.
type fakeS3 struct {
	mu       sync.Mutex
	objects  map[string][]byte // "bucket/key"
	pageSize int
	requests []string
	auth     []string
	hashes   []string
	listed   []string // continuation tokens seen
	failPut  bool
	headLies bool
	// failFirst answers the first N uploads with a 503; puts counts the uploads received.
	failFirst int
	puts      int
}

func (f *fakeS3) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.requests = append(f.requests, r.Method+" "+r.URL.RequestURI())
	f.auth = append(f.auth, r.Header.Get("Authorization"))
	f.hashes = append(f.hashes, r.Header.Get("X-Amz-Content-Sha256"))
	path := strings.TrimPrefix(r.URL.Path, "/")
	switch {
	case r.Method == "PUT":
		f.puts++
		if f.puts <= f.failFirst {
			w.WriteHeader(503)
			io.WriteString(w, `<Error><Code>SlowDown</Code><Message>Please reduce your request rate.</Message></Error>`)
			return
		}
		if f.failPut {
			w.WriteHeader(403)
			io.WriteString(w, `<Error><Code>AccessDenied</Code><Message>Access Denied</Message></Error>`)
			return
		}
		if _, taken := f.objects[path]; taken && r.Header.Get("If-None-Match") == "*" {
			w.WriteHeader(412)
			io.WriteString(w, `<Error><Code>PreconditionFailed</Code><Message>At least one of the pre-conditions you specified did not hold</Message></Error>`)
			return
		}
		body, _ := io.ReadAll(r.Body)
		sum := sha256.Sum256(body)
		if hex.EncodeToString(sum[:]) != r.Header.Get("X-Amz-Content-Sha256") {
			w.WriteHeader(400)
			io.WriteString(w, `<Error><Code>XAmzContentSHA256Mismatch</Code><Message>bad hash</Message></Error>`)
			return
		}
		f.objects[path] = body
	case r.Method == "HEAD":
		b, ok := f.objects[path]
		if !ok {
			w.WriteHeader(404)
			return
		}
		n := len(b)
		if f.headLies {
			n++
		}
		w.Header().Set("Content-Length", fmt.Sprint(n))
	case r.Method == "GET" && r.URL.Query().Get("list-type") == "2":
		f.list(w, r, strings.TrimSuffix(path, "/"))
	case r.Method == "GET":
		b, ok := f.objects[path]
		if !ok {
			w.WriteHeader(404)
			io.WriteString(w, `<Error><Code>NoSuchKey</Code><Message>The specified key does not exist.</Message></Error>`)
			return
		}
		w.Write(b)
	case r.Method == "DELETE":
		delete(f.objects, path)
		w.WriteHeader(204)
	}
}

func (f *fakeS3) list(w http.ResponseWriter, r *http.Request, bucket string) {
	q := r.URL.Query()
	prefix := q.Get("prefix")
	var keys []string
	for p := range f.objects {
		if key, ok := strings.CutPrefix(p, bucket+"/"); ok && strings.HasPrefix(key, prefix) {
			keys = append(keys, key)
		}
	}
	sort.Strings(keys)
	start := 0
	if tok := q.Get("continuation-token"); tok != "" {
		f.listed = append(f.listed, tok)
		for i, k := range keys {
			if k == tok {
				start = i + 1
			}
		}
	}
	end := len(keys)
	truncated := false
	if f.pageSize > 0 && start+f.pageSize < end {
		end, truncated = start+f.pageSize, true
	}
	var b strings.Builder
	b.WriteString(`<?xml version="1.0"?><ListBucketResult>`)
	fmt.Fprintf(&b, "<IsTruncated>%t</IsTruncated>", truncated)
	if truncated {
		fmt.Fprintf(&b, "<NextContinuationToken>%s</NextContinuationToken>", keys[end-1])
	}
	for _, k := range keys[start:end] {
		fmt.Fprintf(&b, "<Contents><Key>%s</Key><Size>%d</Size></Contents>", k, len(f.objects[bucket+"/"+k]))
	}
	b.WriteString("</ListBucketResult>")
	io.WriteString(w, b.String())
}

func newTestS3(t *testing.T, prefix string) (*s3Client, *fakeS3) {
	t.Helper()
	f := &fakeS3{objects: map[string][]byte{}}
	srv := httptest.NewServer(f)
	t.Cleanup(srv.Close)
	c := newS3(config.S3Destination{Endpoint: srv.URL, Region: "eu-west-1", Bucket: "my-backups", Prefix: prefix, AccessKeyID: "AKIA"}, "secret", srv.Client())
	c.now = func() time.Time { return time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC) }
	return c, f
}

func writeTemp(t *testing.T, content string) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), "f")
	if err := os.WriteFile(p, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	return p
}

func TestS3PutVerifiesGetsListsAndDeletes(t *testing.T) {
	c, f := newTestS3(t, "keelson/prod")
	ctx := t.Context()

	src := writeTemp(t, "ciphertext bytes")
	if err := c.Put(ctx, "shop/shop-20260101T030000Z.dump.age", src); err != nil {
		t.Fatal(err)
	}
	if got := string(f.objects["my-backups/keelson/prod/shop/shop-20260101T030000Z.dump.age"]); got != "ciphertext bytes" {
		t.Fatalf("stored %q", got)
	}
	sum := sha256.Sum256([]byte("ciphertext bytes"))
	if f.hashes[0] != hex.EncodeToString(sum[:]) {
		t.Errorf("the PUT must carry the hash of its payload, got %q", f.hashes[0])
	}
	if f.requests[0] != "PUT /my-backups/keelson/prod/shop/shop-20260101T030000Z.dump.age" || !strings.HasPrefix(f.requests[1], "HEAD ") {
		t.Errorf("requests: %v", f.requests)
	}
	if !strings.Contains(f.auth[0], "Credential=AKIA/20260102/eu-west-1/s3/aws4_request") || !strings.Contains(f.auth[0], "SignedHeaders=host;x-amz-content-sha256;x-amz-date") {
		t.Errorf("authorization %q", f.auth[0])
	}

	dst := filepath.Join(t.TempDir(), "got")
	if err := c.Get(ctx, "shop/shop-20260101T030000Z.dump.age", dst); err != nil {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(dst); string(b) != "ciphertext bytes" {
		t.Errorf("downloaded %q", b)
	}

	objs, err := c.List(ctx, "shop/")
	if err != nil || len(objs) != 1 || objs[0].Key != "shop/shop-20260101T030000Z.dump.age" || objs[0].Size != 16 {
		t.Errorf("keys are relative to the prefix: %+v %v", objs, err)
	}

	if err := c.Delete(ctx, "shop/shop-20260101T030000Z.dump.age"); err != nil || len(f.objects) != 0 {
		t.Errorf("%v %v", err, f.objects)
	}
	if err := c.Get(ctx, "shop/missing", dst); err == nil || !strings.Contains(err.Error(), "NoSuchKey") {
		t.Errorf("a refusal carries the store's code: %v", err)
	}
}

func TestS3ListFollowsEveryPage(t *testing.T) {
	c, f := newTestS3(t, "")
	f.pageSize = 2
	for i := 1; i <= 5; i++ {
		f.objects[fmt.Sprintf("my-backups/shop/shop-2026010%dT030000Z.dump.age", i)] = []byte("x")
	}
	f.objects["my-backups/other/x"] = []byte("y")

	objs, err := c.List(t.Context(), "shop/")
	if err != nil || len(objs) != 5 {
		t.Fatalf("want 5 objects over 3 pages, got %d (%v)", len(objs), err)
	}
	if len(f.listed) != 2 {
		t.Errorf("want 2 continuation requests, got %v", f.listed)
	}
	if objs[0].Key != "shop/shop-20260101T030000Z.dump.age" || objs[4].Key != "shop/shop-20260105T030000Z.dump.age" {
		t.Errorf("%+v", objs)
	}
	for _, r := range f.requests {
		if !strings.Contains(r, "prefix=shop%2F") || !strings.Contains(r, "list-type=2") {
			t.Errorf("list request %q", r)
		}
	}
}

func TestS3UploadFailuresAreReported(t *testing.T) {
	c, f := newTestS3(t, "")
	src := writeTemp(t, "data")

	f.failPut = true
	if err := c.Put(t.Context(), "shop/x", src); err == nil || !strings.Contains(err.Error(), "403") || !strings.Contains(err.Error(), "AccessDenied") {
		t.Errorf("a refused upload must say why: %v", err)
	}
	f.failPut = false
	f.headLies = true
	if err := c.Put(t.Context(), "shop/x", src); err == nil || !strings.Contains(err.Error(), "verify the upload") {
		t.Errorf("a size that differs after the upload must fail it: %v", err)
	}
}

func TestS3SecretIsReadFromItsFileAtEveryRun(t *testing.T) {
	secret := writeTemp(t, "first\n")
	d := config.BackupDestination{S3: &config.S3Destination{Endpoint: "https://s3.example.com", Region: "r", Bucket: "bucket", AccessKeyID: "A", SecretKeyFile: secret}}
	dest, err := newDestination(d, http.DefaultClient)
	if err != nil || dest.(*s3Client).signer.secretKey != "first" {
		t.Fatalf("%v %+v", err, dest)
	}
	os.WriteFile(secret, []byte("rotated\n"), 0o600)
	dest, _ = newDestination(d, http.DefaultClient)
	if dest.(*s3Client).signer.secretKey != "rotated" {
		t.Error("a rotated secret must be used by the next run")
	}
	os.WriteFile(secret, nil, 0o600)
	if _, err := newDestination(d, http.DefaultClient); err == nil {
		t.Error("an empty secret file is an error")
	}
}

func TestS3PutNeverReplacesAnObject(t *testing.T) {
	c, f := newTestS3(t, "")
	key := "shop/shop-20260101T030000Z.dump.age"
	if err := c.Put(t.Context(), key, writeTemp(t, "first")); err != nil {
		t.Fatal(err)
	}
	err := c.Put(t.Context(), key, writeTemp(t, "second"))
	if !errors.Is(err, ErrExists) {
		t.Fatalf("a taken key is ErrExists (412 on If-None-Match), got %v", err)
	}
	if got := string(f.objects["my-backups/"+key]); got != "first" {
		t.Errorf("the object was replaced: %q", got)
	}
	// Any other refusal is not a conflict.
	f.failPut = true
	if err := c.Put(t.Context(), "shop/other", writeTemp(t, "x")); err == nil || errors.Is(err, ErrExists) {
		t.Errorf("a 403 is not a conflict: %v", err)
	}
}

func TestS3ClientDoesNotFollowRedirects(t *testing.T) {
	var elsewhere atomic.Int32
	other := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { elsewhere.Add(1) }))
	t.Cleanup(other.Close)
	var origin atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		origin.Add(1)
		http.Redirect(w, r, other.URL+r.URL.Path, http.StatusTemporaryRedirect)
	}))
	t.Cleanup(srv.Close)

	c := newS3(config.S3Destination{Endpoint: srv.URL, Region: "r", Bucket: "b", AccessKeyID: "A"}, "secret", newHTTPClient(time.Minute))
	src := writeTemp(t, "ciphertext")
	for name, call := range map[string]func() error{
		"put":    func() error { return c.Put(t.Context(), "shop/x", src) },
		"get":    func() error { return c.Get(t.Context(), "shop/x", filepath.Join(t.TempDir(), "o")) },
		"list":   func() error { _, err := c.List(t.Context(), "shop/"); return err },
		"delete": func() error { return c.Delete(t.Context(), "shop/x") },
	} {
		err := call()
		if err == nil || !strings.Contains(err.Error(), "307") || !strings.Contains(err.Error(), "redirects are not followed") {
			t.Errorf("%s: a redirect is an error that says so: %v", name, err)
		}
	}
	if elsewhere.Load() != 0 {
		t.Errorf("the client followed a redirect %d times", elsewhere.Load())
	}
}

func TestS3ClientGivesUpOnAStoreThatNeverAnswers(t *testing.T) {
	release := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { <-release }))
	t.Cleanup(func() { close(release); srv.Close() })
	c := newS3(config.S3Destination{Endpoint: srv.URL, Region: "r", Bucket: "b", AccessKeyID: "A"}, "secret", newHTTPClient(100*time.Millisecond))
	start := time.Now()
	if _, err := c.List(t.Context(), "shop/"); err == nil || time.Since(start) > 5*time.Second {
		t.Errorf("a store that sends no answer must time out: %v after %s", err, time.Since(start))
	}
}

// A store that answers 5xx for a moment must not cost a backup that took twenty minutes to make; a refusal is final.
func TestS3UploadIsTriedAgainAfterAServerErrorButNotAfterARefusalOrAnExistingKey(t *testing.T) {
	was := putBackoff
	t.Cleanup(func() { putBackoff = was })
	putBackoff = time.Millisecond
	src := writeTemp(t, "ciphertext")

	c, f := newTestS3(t, "")
	f.failFirst = 2
	if err := c.Put(t.Context(), "shop/a", src); err != nil {
		t.Fatalf("two 503s then a success must succeed: %v", err)
	}
	if f.puts != 3 || string(f.objects["my-backups/shop/a"]) != "ciphertext" {
		t.Errorf("%d uploads, stored %q", f.puts, f.objects["my-backups/shop/a"])
	}

	c, f = newTestS3(t, "")
	f.failFirst = 100
	if err := c.Put(t.Context(), "shop/a", src); err == nil || !strings.Contains(err.Error(), "503") {
		t.Fatalf("a store that keeps failing fails the upload: %v", err)
	}
	if f.puts != putAttempts {
		t.Errorf("%d attempts, want %d", f.puts, putAttempts)
	}

	c, f = newTestS3(t, "")
	f.failPut = true // 403
	if err := c.Put(t.Context(), "shop/a", src); err == nil {
		t.Fatal("a refused upload fails")
	}
	if f.puts != 1 {
		t.Errorf("a refusal is not retried: %d attempts", f.puts)
	}

	c, f = newTestS3(t, "")
	f.objects["my-backups/shop/a"] = []byte("old")
	if err := c.Put(t.Context(), "shop/a", src); !errors.Is(err, ErrExists) {
		t.Fatalf("%v", err)
	}
	if f.puts != 1 || string(f.objects["my-backups/shop/a"]) != "old" {
		t.Errorf("a taken key is neither retried nor replaced: %d attempts, %q", f.puts, f.objects["my-backups/shop/a"])
	}
}
