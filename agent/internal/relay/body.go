package relay

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"sync"
)

// requestBody is the body of a request the dashboard did not put in the line (an image archive): it is fetched from
// GET /api/relay/request/{id}/body at the first Read, so a handler that refuses the request without reading it costs
// nothing, and it is read at the pace of the handler: the TCP connection's own flow control is the backpressure. It is
// bound to the request's context, so a cancel from the dashboard, the end of the connection and the end of the request
// all abort the fetch; Close does as well.
type requestBody struct {
	parent     context.Context
	client     *http.Client
	url        string
	credential string

	// ctx is the fetch's: the parent, and Close.
	ctx    context.Context
	cancel context.CancelFunc

	mu     sync.Mutex
	body   io.ReadCloser // nil until the first Read, and when the fetch failed
	err    error         // why there is no body; every Read repeats it
	closed bool
}

func newRequestBody(ctx context.Context, client *http.Client, url, credential string) *requestBody {
	b := &requestBody{parent: ctx, client: client, url: url, credential: credential}
	b.ctx, b.cancel = context.WithCancel(ctx)
	return b
}

func (b *requestBody) Read(p []byte) (int, error) {
	body, err := b.open()
	n := 0
	if err == nil {
		n, err = body.Read(p)
	}
	if err != nil && err != io.EOF {
		// A request that was cancelled says why, rather than "context canceled".
		if cause := context.Cause(b.parent); cause != nil {
			err = cause
		}
	}
	return n, err
}

// open fetches the body the first time.
func (b *requestBody) open() (io.Reader, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	switch {
	case b.closed:
		return nil, http.ErrBodyReadAfterClose
	case b.err != nil:
		return nil, b.err
	case b.body == nil:
		b.body, b.err = b.fetch()
		if b.err != nil {
			return nil, b.err
		}
	}
	return b.body, nil
}

func (b *requestBody) fetch() (io.ReadCloser, error) {
	req, err := http.NewRequestWithContext(b.ctx, http.MethodGet, b.url, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+b.credential)
	// An archive is already compressed: the bytes must arrive as sent, whatever the client would negotiate.
	req.Header.Set("Accept-Encoding", "identity")
	resp, err := b.client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("the request body could not be fetched from the dashboard: %s", reason(err))
	}
	if resp.StatusCode != http.StatusOK {
		resp.Body.Close()
		return nil, fmt.Errorf("the dashboard refused the request body: %s", resp.Status)
	}
	return resp.Body, nil
}

// Close abandons the fetch, wherever it is.
func (b *requestBody) Close() error {
	b.cancel() // before the lock: it unblocks a fetch that holds it
	b.mu.Lock()
	defer b.mu.Unlock()
	b.closed = true
	if b.body != nil {
		return b.body.Close()
	}
	return nil
}
