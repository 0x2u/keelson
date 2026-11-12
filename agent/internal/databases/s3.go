package databases

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"sort"
	"strings"
	"syscall"
	"time"

	"github.com/0x2u/keelson/agent/internal/config"
)

const (
	// maxS3Put is the largest object one PUT can carry on S3. Multipart upload is not implemented.
	maxS3Put      = 5 << 30
	maxErrorBody  = 2048
	emptySHA256   = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
	algorithmV4   = "AWS4-HMAC-SHA256"
	amzDateLayout = "20060102T150405Z"
)

// newHTTPClient is the client of the S3 destinations. It never follows a redirect: the credentials are signed for
// one endpoint, and a store that answers with a Location is misconfigured (wrong region or endpoint), which the
// operator must hear about rather than have the agent send a backup somewhere else. The 3xx answer is returned as
// it is and request() turns it into an error. There is no overall timeout, because an upload of several GiB has
// none worth guessing (the context of the run bounds it); what is bounded is the time to connect, to negotiate TLS
// and to wait for the store's answer once the request has been sent.
func newHTTPClient(responseHeaderTimeout time.Duration) *http.Client {
	return &http.Client{
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
		Transport: &http.Transport{
			Proxy:                 http.ProxyFromEnvironment,
			DialContext:           (&net.Dialer{Timeout: 30 * time.Second, KeepAlive: 30 * time.Second}).DialContext,
			ForceAttemptHTTP2:     true,
			TLSHandshakeTimeout:   15 * time.Second,
			ResponseHeaderTimeout: responseHeaderTimeout,
			IdleConnTimeout:       90 * time.Second,
			MaxIdleConns:          4,
		},
	}
}

// s3Client talks to an S3-compatible store with path-style addressing (endpoint/bucket/key), the form every
// implementation accepts, using only the standard library.
type s3Client struct {
	endpoint url.URL
	bucket   string
	prefix   string
	signer   signer
	hc       *http.Client
	now      func() time.Time
}

func newS3(d config.S3Destination, secret string, hc *http.Client) *s3Client {
	u, _ := url.Parse(d.Endpoint) // validated by config
	return &s3Client{
		endpoint: *u, bucket: d.Bucket, prefix: d.Prefix,
		signer: signer{accessKey: d.AccessKeyID, secretKey: secret, region: d.Region, service: "s3"},
		hc:     hc, now: time.Now,
	}
}

// objectKey is the key in the bucket of a destination key.
func (c *s3Client) objectKey(key string) string {
	if c.prefix == "" {
		return key
	}
	return c.prefix + "/" + key
}

func (c *s3Client) request(ctx context.Context, method, objectKey string, query url.Values, extra http.Header, body io.Reader, size int64, payloadHash string) (*http.Response, error) {
	u := c.endpoint
	u.Path = "/" + c.bucket
	if objectKey != "" {
		u.Path += "/" + objectKey
	}
	u.RawPath = escapePath(u.Path)
	u.RawQuery = canonicalQuery(query)
	req, err := http.NewRequestWithContext(ctx, method, u.String(), body)
	if err != nil {
		return nil, err
	}
	req.ContentLength = size
	req.Header.Set("User-Agent", "keelson-agent")
	req.Header.Set("X-Amz-Content-Sha256", payloadHash)
	for k, v := range extra {
		req.Header[k] = v
	}
	c.signer.sign(req, payloadHash, c.now())

	resp, err := c.hc.Do(req)
	if err != nil {
		var ue *url.Error
		if errors.As(err, &ue) {
			return nil, fmt.Errorf("%s %s: %w", method, c.endpoint.Host, ue.Err)
		}
		return nil, err
	}
	if resp.StatusCode/100 == 3 {
		resp.Body.Close()
		return nil, fmt.Errorf("s3 %s: %s: the store redirected the request and redirects are not followed: check the endpoint and the region", method, resp.Status)
	}
	if resp.StatusCode/100 != 2 {
		defer resp.Body.Close()
		return nil, s3Error(method, resp)
	}
	return resp, nil
}

// s3Error builds the error of a refused request from the XML the store sends with it.
func s3Error(method string, resp *http.Response) error {
	var e struct {
		Code    string `xml:"Code"`
		Message string `xml:"Message"`
	}
	b, _ := io.ReadAll(io.LimitReader(resp.Body, maxErrorBody))
	err := error(&s3StatusError{status: resp.StatusCode, msg: fmt.Sprintf("s3 %s: %s", method, resp.Status)})
	if xml.Unmarshal(b, &e) == nil && e.Code != "" {
		err = &s3StatusError{status: resp.StatusCode, msg: fmt.Sprintf("s3 %s: %s %s: %s", method, resp.Status, e.Code, e.Message)}
	}
	// Only a PUT carries If-None-Match, so these answers mean the key is taken (412), or is being written by
	// another request at this very moment (409 ConditionalRequestConflict on AWS).
	if method == http.MethodPut && (resp.StatusCode == http.StatusPreconditionFailed || resp.StatusCode == http.StatusConflict && e.Code == "ConditionalRequestConflict") {
		return fmt.Errorf("%w: %w", ErrExists, err)
	}
	return err
}

func (c *s3Client) Put(ctx context.Context, key, src string) error {
	f, err := os.Open(src)
	if err != nil {
		return err
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return err
	}
	if info.Size() > maxS3Put {
		return fmt.Errorf("the backup is %d bytes: more than the 5 GiB one S3 upload can carry", info.Size())
	}
	h := sha256.New()
	if _, err := io.Copy(h, &ctxReader{ctx, f}); err != nil {
		return err
	}
	if _, err := f.Seek(0, io.SeekStart); err != nil {
		return err
	}
	// If-None-Match: * makes the store refuse the PUT when the key exists (412), so a backup never replaces an
	// object. AWS S3 honors it; a store that does not know the header ignores it and keeps last-writer-wins, so
	// there the guarantee is only as good as the store's.
	create := http.Header{"If-None-Match": {"*"}}
	sum := hex.EncodeToString(h.Sum(nil))
	var resp *http.Response
	for attempt := 0; ; attempt++ {
		if _, err := f.Seek(0, io.SeekStart); err != nil {
			return err
		}
		resp, err = c.request(ctx, http.MethodPut, c.objectKey(key), nil, create, io.NopCloser(&ctxReader{ctx, f}), info.Size(), sum)
		if err == nil {
			break
		}
		// A store that answers 5xx, or a connection that drops, is worth another try; a refusal (403, 412, 4xx) is not, and
		// the run's own timeout bounds the whole upload.
		if attempt+1 >= putAttempts || !retryablePut(err) || ctx.Err() != nil {
			return err
		}
		select {
		case <-ctx.Done():
			return err
		case <-time.After(putBackoff << (2 * attempt)):
		}
	}
	resp.Body.Close()

	head, err := c.request(ctx, http.MethodHead, c.objectKey(key), nil, nil, nil, 0, emptySHA256)
	if err != nil {
		return fmt.Errorf("verify the upload: %w", err)
	}
	head.Body.Close()
	if head.ContentLength != info.Size() {
		return fmt.Errorf("verify the upload: the store reports %d bytes, %d were sent", head.ContentLength, info.Size())
	}
	return nil
}

func (c *s3Client) Get(ctx context.Context, key, dst string) error {
	body, err := c.Open(ctx, key)
	if err != nil {
		return err
	}
	defer body.Close()
	return copyToFile(ctx, body, dst)
}

func (c *s3Client) Open(ctx context.Context, key string) (io.ReadCloser, error) {
	resp, err := c.request(ctx, http.MethodGet, c.objectKey(key), nil, nil, nil, 0, emptySHA256)
	if err != nil {
		return nil, err
	}
	return resp.Body, nil
}

func (c *s3Client) Delete(ctx context.Context, key string) error {
	resp, err := c.request(ctx, http.MethodDelete, c.objectKey(key), nil, nil, nil, 0, emptySHA256)
	if err != nil {
		return err
	}
	return resp.Body.Close()
}

type listResult struct {
	IsTruncated           bool   `xml:"IsTruncated"`
	NextContinuationToken string `xml:"NextContinuationToken"`
	Contents              []struct {
		Key  string `xml:"Key"`
		Size int64  `xml:"Size"`
	} `xml:"Contents"`
}

// List pages through ListObjectsV2 until the store says it is done.
func (c *s3Client) List(ctx context.Context, prefix string) ([]Object, error) {
	root := c.objectKey("")
	var out []Object
	token := ""
	for {
		q := url.Values{"list-type": {"2"}, "prefix": {root + prefix}}
		if token != "" {
			q.Set("continuation-token", token)
		}
		resp, err := c.request(ctx, http.MethodGet, "", q, nil, nil, 0, emptySHA256)
		if err != nil {
			return nil, err
		}
		var page listResult
		err = xml.NewDecoder(resp.Body).Decode(&page)
		resp.Body.Close()
		if err != nil {
			return nil, fmt.Errorf("s3 list: unreadable answer: %w", err)
		}
		for _, o := range page.Contents {
			out = append(out, Object{Key: strings.TrimPrefix(o.Key, root), Size: o.Size})
		}
		if !page.IsTruncated {
			return out, nil
		}
		if page.NextContinuationToken == "" {
			return nil, errors.New("s3 list: the store reports a truncated listing without a continuation token")
		}
		token = page.NextContinuationToken
	}
}

// signer signs requests with AWS Signature Version 4. It signs the host, x-amz-date and, when the request carries
// it, x-amz-content-sha256: enough for every request the agent sends.
type signer struct {
	accessKey, secretKey, region, service string
}

func (s signer) sign(req *http.Request, payloadHash string, t time.Time) {
	t = t.UTC()
	amzDate, day := t.Format(amzDateLayout), t.Format("20060102")
	req.Header.Set("X-Amz-Date", amzDate)

	host := req.Host
	if host == "" {
		host = req.URL.Host
	}
	headers := map[string]string{"host": host, "x-amz-date": amzDate}
	if v := req.Header.Get("X-Amz-Content-Sha256"); v != "" {
		headers["x-amz-content-sha256"] = v
	}
	names := make([]string, 0, len(headers))
	for n := range headers {
		names = append(names, n)
	}
	sort.Strings(names)
	var canonicalHeaders strings.Builder
	for _, n := range names {
		canonicalHeaders.WriteString(n + ":" + strings.TrimSpace(headers[n]) + "\n")
	}
	signed := strings.Join(names, ";")

	canonical := strings.Join([]string{
		req.Method, req.URL.EscapedPath(), canonicalQuery(req.URL.Query()), canonicalHeaders.String(), signed, payloadHash,
	}, "\n")
	scope := day + "/" + s.region + "/" + s.service + "/aws4_request"
	sum := sha256.Sum256([]byte(canonical))
	toSign := algorithmV4 + "\n" + amzDate + "\n" + scope + "\n" + hex.EncodeToString(sum[:])

	key := hmacSHA256([]byte("AWS4"+s.secretKey), day)
	key = hmacSHA256(key, s.region)
	key = hmacSHA256(key, s.service)
	key = hmacSHA256(key, "aws4_request")
	signature := hex.EncodeToString(hmacSHA256(key, toSign))

	req.Header.Set("Authorization", fmt.Sprintf("%s Credential=%s/%s, SignedHeaders=%s, Signature=%s", algorithmV4, s.accessKey, scope, signed, signature))
}

func hmacSHA256(key []byte, data string) []byte {
	m := hmac.New(sha256.New, key)
	m.Write([]byte(data))
	return m.Sum(nil)
}

// canonicalQuery encodes parameters sorted by name, with the escaping SigV4 asks for (a space is %20, never +).
func canonicalQuery(q url.Values) string {
	keys := make([]string, 0, len(q))
	for k := range q {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	var parts []string
	for _, k := range keys {
		vals := append([]string(nil), q[k]...)
		sort.Strings(vals)
		for _, v := range vals {
			parts = append(parts, escape(k)+"="+escape(v))
		}
	}
	return strings.Join(parts, "&")
}

// escapePath escapes each segment of a path once, as S3 does not double-encode.
func escapePath(p string) string {
	segs := strings.Split(p, "/")
	for i, s := range segs {
		segs[i] = escape(s)
	}
	return strings.Join(segs, "/")
}

func escape(s string) string {
	const hexDigits = "0123456789ABCDEF"
	var b strings.Builder
	for i := range len(s) {
		c := s[i]
		if c >= 'A' && c <= 'Z' || c >= 'a' && c <= 'z' || c >= '0' && c <= '9' || c == '-' || c == '_' || c == '.' || c == '~' {
			b.WriteByte(c)
			continue
		}
		b.WriteByte('%')
		b.WriteByte(hexDigits[c>>4])
		b.WriteByte(hexDigits[c&15])
	}
	return b.String()
}

// s3StatusError is a request the store answered with a status that is not success.
type s3StatusError struct {
	status int
	msg    string
}

func (e *s3StatusError) Error() string { return e.msg }

const putAttempts = 3

// putBackoff is the first wait between two attempts to upload (then four times as long); a variable so tests do not wait.
var putBackoff = time.Second

// retryablePut says whether a failed upload may succeed when sent again: the store failed (5xx, 429) or the connection did.
// A key that is taken is not an error to retry.
func retryablePut(err error) bool {
	if errors.Is(err, ErrExists) {
		return false
	}
	var se *s3StatusError
	if errors.As(err, &se) {
		return se.status >= 500 || se.status == http.StatusTooManyRequests || se.status == http.StatusRequestTimeout
	}
	var ne net.Error
	return errors.As(err, &ne) || errors.Is(err, io.ErrUnexpectedEOF) || errors.Is(err, io.EOF) || errors.Is(err, syscall.ECONNRESET)
}
