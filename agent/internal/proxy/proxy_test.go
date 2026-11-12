package proxy

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/0x2u/keelson/agent/internal/config"
)

func TestBuildConfigRoutesHostsToUpstreams(t *testing.T) {
	cfg := BuildConfig(config.Proxy{}, []Route{
		{Hosts: []string{"b.example.com"}, Upstream: "127.0.0.1:2"},
		{Hosts: []string{"a.example.com", "www.a.example.com"}, Upstream: "127.0.0.1:1"},
	})
	b, _ := json.Marshal(cfg)

	var got struct {
		Apps struct {
			HTTP struct {
				Servers map[string]struct {
					Listen []string `json:"listen"`
					Routes []struct {
						Match []struct {
							Host []string `json:"host"`
						} `json:"match"`
						Handle []struct {
							Handler   string `json:"handler"`
							Upstreams []struct {
								Dial string `json:"dial"`
							} `json:"upstreams"`
						} `json:"handle"`
						Terminal bool `json:"terminal"`
					} `json:"routes"`
				} `json:"servers"`
			} `json:"http"`
			TLS json.RawMessage `json:"tls"`
		} `json:"apps"`
	}
	if err := json.Unmarshal(b, &got); err != nil {
		t.Fatal(err)
	}
	// A JSON-configured Caddy server without "listen" binds no port at all.
	if l := got.Apps.HTTP.Servers["keelson"].Listen; len(l) != 1 || l[0] != ":443" {
		t.Errorf("the server must listen on :443, got %v", l)
	}
	routes := got.Apps.HTTP.Servers["keelson"].Routes
	if len(routes) != 2 {
		t.Fatalf("want 2 routes, got %s", b)
	}
	// Sorted by first host, whatever the input order.
	if routes[0].Match[0].Host[0] != "a.example.com" || routes[0].Match[0].Host[1] != "www.a.example.com" ||
		routes[0].Handle[0].Handler != "reverse_proxy" || routes[0].Handle[0].Upstreams[0].Dial != "127.0.0.1:1" || !routes[0].Terminal {
		t.Errorf("unexpected first route: %+v", routes[0])
	}
	if routes[1].Handle[0].Upstreams[0].Dial != "127.0.0.1:2" {
		t.Errorf("unexpected second route: %+v", routes[1])
	}
	if got.Apps.TLS != nil {
		t.Errorf("no TLS automation expected by default: %s", got.Apps.TLS)
	}
}

func TestBuildConfigIsDeterministicAndDoesNotReorderItsInput(t *testing.T) {
	in := []Route{{Hosts: []string{"z.example.com"}, Upstream: "z:1"}, {Hosts: []string{"a.example.com"}, Upstream: "a:1"}}
	first, _ := json.Marshal(BuildConfig(config.Proxy{}, in))
	second, _ := json.Marshal(BuildConfig(config.Proxy{}, in))
	if string(first) != string(second) {
		t.Error("equal inputs must give identical configuration")
	}
	if in[0].Hosts[0] != "z.example.com" {
		t.Error("the caller's slice must not be reordered")
	}
}

func TestBuildConfigWithNoRoutesIsAValidEmptyServer(t *testing.T) {
	b, _ := json.Marshal(BuildConfig(config.Proxy{}, nil))
	if !strings.Contains(string(b), `"routes":[]`) {
		t.Errorf("an empty route list must serialize as [], not null: %s", b)
	}
}

func TestBuildConfigIssuers(t *testing.T) {
	internal, _ := json.Marshal(BuildConfig(config.Proxy{TLS: "internal"}, nil))
	if !strings.Contains(string(internal), `"module":"internal"`) {
		t.Errorf("internal CA not configured: %s", internal)
	}
	acme, _ := json.Marshal(BuildConfig(config.Proxy{ACMEEmail: "ops@example.com"}, nil))
	if !strings.Contains(string(acme), `"module":"acme"`) || !strings.Contains(string(acme), "ops@example.com") {
		t.Errorf("ACME contact not configured: %s", acme)
	}
	both, _ := json.Marshal(BuildConfig(config.Proxy{TLS: "internal", ACMEEmail: "ops@example.com"}, nil))
	if strings.Contains(string(both), "acme") {
		t.Errorf("internal must win over ACME: %s", both)
	}
}

func TestBuildConfigLoadsTheGivenCertificatesAndKeepsTheIssuer(t *testing.T) {
	cfg := config.Proxy{
		ACMEEmail:    "ops@example.com",
		Certificates: []config.Certificate{{CertFile: "/etc/ssl/a.pem", KeyFile: "/etc/ssl/a.key"}, {CertFile: "/etc/ssl/b.pem", KeyFile: "/etc/ssl/b.key"}},
	}
	b, _ := json.Marshal(BuildConfig(cfg, nil))
	var got struct {
		Apps struct {
			TLS struct {
				Certificates struct {
					LoadFiles []map[string]string `json:"load_files"`
				} `json:"certificates"`
				Automation map[string]any `json:"automation"`
			} `json:"tls"`
		} `json:"apps"`
	}
	if err := json.Unmarshal(b, &got); err != nil {
		t.Fatal(err)
	}
	files := got.Apps.TLS.Certificates.LoadFiles
	if len(files) != 2 || files[0]["certificate"] != "/etc/ssl/a.pem" || files[1]["key"] != "/etc/ssl/b.key" {
		t.Errorf("certificates not loaded in order: %s", b)
	}
	if got.Apps.TLS.Automation == nil {
		t.Errorf("the issuer must survive next to the certificates: %s", b)
	}
	none, _ := json.Marshal(BuildConfig(config.Proxy{}, nil))
	if strings.Contains(string(none), `"tls"`) {
		t.Errorf("no tls app when nothing is configured: %s", none)
	}
}

func TestBuildConfigWritesAnAccessLogOnlyWhenAsked(t *testing.T) {
	b, _ := json.Marshal(BuildConfig(config.Proxy{AccessLog: "/data/access.log"}, nil))
	var got struct {
		Apps struct {
			HTTP struct {
				Servers map[string]struct {
					Logs map[string]string `json:"logs"`
				} `json:"servers"`
			} `json:"http"`
		} `json:"apps"`
		Logging struct {
			Logs map[string]struct {
				Writer  map[string]string `json:"writer"`
				Encoder map[string]string `json:"encoder"`
				Include []string          `json:"include"`
				Exclude []string          `json:"exclude"`
			} `json:"logs"`
		} `json:"logging"`
	}
	if err := json.Unmarshal(b, &got); err != nil {
		t.Fatal(err)
	}
	name := got.Apps.HTTP.Servers["keelson"].Logs["default_logger_name"]
	if d := got.Logging.Logs["default"]; len(d.Exclude) != 1 || d.Exclude[0] != "http.log.access."+name {
		t.Errorf("Caddy's default logger must not take the access entries as well: %s", b)
	}
	l, ok := got.Logging.Logs[name]
	if name == "" || !ok || l.Writer["output"] != "file" || l.Writer["filename"] != "/data/access.log" || l.Encoder["format"] != "json" || len(l.Include) != 1 || l.Include[0] != "http.log.access."+name {
		t.Errorf("the server must name a logger that writes JSON lines to the file, and only collect that server's entries: %s", b)
	}
	none, _ := json.Marshal(BuildConfig(config.Proxy{}, nil))
	if strings.Contains(string(none), `"logging"`) || strings.Contains(string(none), `"logs"`) {
		t.Errorf("no access log unless asked: %s", none)
	}
}

func TestApplyPostsTheConfigurationToLoad(t *testing.T) {
	var method, path, ctype string
	var body []byte
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		method, path, ctype = r.Method, r.URL.Path, r.Header.Get("Content-Type")
		body, _ = io.ReadAll(r.Body)
	}))
	defer srv.Close()

	c := New(config.Proxy{Admin: srv.URL + "/"})
	if err := c.Apply(context.Background(), []Route{{Hosts: []string{"a.example.com"}, Upstream: "127.0.0.1:1"}}); err != nil {
		t.Fatal(err)
	}
	if method != "POST" || path != "/load" || ctype != "application/json" || !strings.Contains(string(body), "127.0.0.1:1") {
		t.Errorf("unexpected request: %s %s %s %s", method, path, ctype, body)
	}
}

func TestApplyReportsCaddyErrors(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(400)
		io.WriteString(w, "loading config: invalid host")
	}))
	defer srv.Close()
	err := New(config.Proxy{Admin: srv.URL}).Apply(context.Background(), nil)
	if err == nil || !strings.Contains(err.Error(), "invalid host") {
		t.Errorf("want Caddy's message, got %v", err)
	}

	srv.Close()
	if err := New(config.Proxy{Admin: srv.URL}).Apply(context.Background(), nil); err == nil {
		t.Error("an unreachable admin API must be an error")
	}
}
