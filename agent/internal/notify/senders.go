package notify

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"html"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"strings"
	"syscall"
	"time"
)

var httpClient = &http.Client{Timeout: sendTimeout}

// redact turns a transport error into one that is safe to log: Go puts the
// full URL in it, and the URL of a webhook or of the Telegram API carries a
// secret (a token in the path).
func redact(err error) error {
	var ue *url.Error
	if errors.As(err, &ue) {
		return fmt.Errorf("%s request failed: %w", strings.ToLower(ue.Op), ue.Err)
	}
	return err
}

// rejection is a channel that answered and refused the message (a status that is not 2xx, a bot that said not ok), as
// opposed to one that could not be reached.
type rejection struct{ msg string }

func (r rejection) Error() string { return r.msg }

// Reason names why a delivery failed without quoting the error, which may carry a URL or a token: "timeout", "refused" (nothing
// listens there), "rejected" (the channel answered no) or "other".
func Reason(err error) string {
	var rej rejection
	var timeout interface{ Timeout() bool }
	switch {
	case errors.As(err, &rej):
		return "rejected"
	case errors.Is(err, context.DeadlineExceeded) || errors.As(err, &timeout) && timeout.Timeout():
		return "timeout"
	case errors.Is(err, syscall.ECONNREFUSED):
		return "refused"
	}
	return "other"
}

// Webhook posts events as JSON.
type Webhook struct {
	url    string
	secret string
	host   string
}

// NewWebhook returns a sender for url. A non-empty secret signs the body.
func NewWebhook(rawURL, secret string) *Webhook {
	host := "webhook"
	if u, err := url.Parse(rawURL); err == nil && u.Host != "" {
		host = u.Host
	}
	return &Webhook{url: rawURL, secret: secret, host: host}
}

// Name identifies the channel without revealing the secret URL path.
func (w *Webhook) Name() string { return "webhook " + w.host }

// Signature returns the value of X-Keelson-Signature for a body.
func Signature(secret string, body []byte) string {
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write(body)
	return "sha256=" + hex.EncodeToString(mac.Sum(nil))
}

// Send posts the event. Any 2xx answer is success.
func (w *Webhook) Send(ctx context.Context, e Event) error {
	body, err := json.Marshal(e)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, w.url, bytes.NewReader(body))
	if err != nil {
		return redact(err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", "keelson-agent")
	req.Header.Set("X-Keelson-Event", e.Type)
	if w.secret != "" {
		req.Header.Set("X-Keelson-Signature", Signature(w.secret, body))
	}
	resp, err := httpClient.Do(req)
	if err != nil {
		return redact(err)
	}
	defer resp.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 1<<16))
	if resp.StatusCode/100 != 2 {
		return rejection{fmt.Sprintf("answered %d", resp.StatusCode)}
	}
	return nil
}

// Telegram sends events to a chat through a bot.
type Telegram struct {
	api    string
	token  string
	chatID string
}

// NewTelegram returns a sender using the Bot API at api.
func NewTelegram(api, token, chatID string) *Telegram {
	return &Telegram{api: strings.TrimRight(api, "/"), token: token, chatID: chatID}
}

// Name identifies the channel.
func (t *Telegram) Name() string { return "telegram" }

var icons = map[string]string{SeverityInfo: "✅", SeverityWarning: "⚠️", SeverityCritical: "🔥"}

// Text renders an event as Telegram HTML. Every dynamic part is escaped: an
// error message or an image tag must not be able to inject markup.
func Text(e Event) string {
	var b strings.Builder
	icon := icons[e.Severity]
	if icon == "" {
		icon = "ℹ️"
	}
	fmt.Fprintf(&b, "%s <b>%s</b>", icon, html.EscapeString(e.Title))
	where := html.EscapeString(e.Server)
	if e.Ref != "" {
		where += " · <code>" + html.EscapeString(e.Ref) + "</code>"
	}
	if where != "" {
		b.WriteString("\n" + where)
	}
	if e.Message != "" {
		b.WriteString("\n" + html.EscapeString(e.Message))
	}
	return b.String()
}

// Send posts the message with sendMessage.
func (t *Telegram) Send(ctx context.Context, e Event) error {
	payload, err := json.Marshal(map[string]any{
		"chat_id":                  t.chatID,
		"text":                     Text(e),
		"parse_mode":               "HTML",
		"disable_web_page_preview": true,
	})
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, t.api+"/bot"+t.token+"/sendMessage", bytes.NewReader(payload))
	if err != nil {
		return redact(err)
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := httpClient.Do(req)
	if err != nil {
		return redact(err)
	}
	defer resp.Body.Close()

	var out struct {
		OK          bool   `json:"ok"`
		Description string `json:"description"`
	}
	_ = json.NewDecoder(io.LimitReader(resp.Body, 1<<16)).Decode(&out)
	if resp.StatusCode != http.StatusOK || !out.OK {
		msg := out.Description
		if msg == "" {
			msg = fmt.Sprintf("status %d", resp.StatusCode)
		}
		return rejection{"telegram: " + msg}
	}
	return nil
}

// RunHeartbeat pings url every interval until ctx ends, starting at once. The
// external service alerts when the pings stop, which is how a dead server or a
// dead agent gets noticed: nothing local can report its own death.
func RunHeartbeat(ctx context.Context, rawURL string, every time.Duration, log *slog.Logger) {
	ping := func() {
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, rawURL, nil)
		if err != nil {
			log.Warn("heartbeat failed", "err", redact(err))
			return
		}
		req.Header.Set("User-Agent", "keelson-agent")
		resp, err := httpClient.Do(req)
		if err != nil {
			if ctx.Err() == nil {
				log.Warn("heartbeat failed", "err", redact(err))
			}
			return
		}
		_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 1<<16))
		resp.Body.Close()
		if resp.StatusCode/100 != 2 {
			log.Warn("heartbeat failed", "status", resp.StatusCode)
		}
	}

	ping()
	t := time.NewTicker(every)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			ping()
		}
	}
}
