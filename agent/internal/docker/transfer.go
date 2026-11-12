package docker

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
)

// SaveImage streams an image as the engine saves it (what `docker save` writes): a tar archive. The caller closes the
// reader. It is a read: Client has it, and Admin through Client.
func (c *Client) SaveImage(ctx context.Context, ref string) (io.ReadCloser, error) {
	if !imageRef.MatchString(ref) {
		return nil, ErrInvalidImageRef
	}
	resp, err := c.get(ctx, "/images/"+ref+"/get", nil)
	if err != nil {
		return nil, err
	}
	return resp.Body, nil
}

// LoadImage loads an archive written by SaveImage. The engine answers 200 and reports a failure inside its JSON stream,
// so the stream is read to the end.
func (a *Admin) LoadImage(ctx context.Context, archive io.Reader) error {
	resp, err := request(ctx, a.hc, http.MethodPost, "/images/load", url.Values{"quiet": {"1"}}, archive, map[string]string{"Content-Type": "application/x-tar"})
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	sc := bufio.NewScanner(resp.Body)
	sc.Buffer(make([]byte, 64<<10), 1<<20)
	for sc.Scan() {
		var m struct {
			Error string `json:"error"`
		}
		if json.Unmarshal(sc.Bytes(), &m) == nil && m.Error != "" {
			return fmt.Errorf("load image: %s", m.Error)
		}
	}
	return sc.Err()
}
