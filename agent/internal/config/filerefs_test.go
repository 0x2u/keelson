package config

import (
	"slices"
	"testing"
)

func TestFileRefsListsEveryFileTheConfigurationNamesAndNotTheOnesTheAgentWrites(t *testing.T) {
	cfg, issues := Parse([]byte(`
registries:
  - {host: ghcr.io, username: me, password_file: /etc/keelson/ghcr}
apps:
  - {name: web, image: ghcr.io/me/web, env_file: /srv/web/.env}
  - {name: api, image: ghcr.io/me/api}
notifications:
  telegram: {bot_token_file: /etc/keelson/tg, chat_id: "1"}
`))
	if cfg == nil {
		t.Fatal(LoadIssues(issues))
	}
	var got []string
	for _, r := range cfg.FileRefs() {
		got = append(got, r.Where+"="+r.Path)
	}
	want := []string{
		"registries[ghcr.io].password_file=/etc/keelson/ghcr",
		"apps[web].env_file=/srv/web/.env",
		"notifications.telegram.bot_token_file=/etc/keelson/tg",
	}
	if !slices.Equal(got, want) {
		t.Errorf("got %v\nwant %v", got, want)
	}

	nginx, issues := Parse([]byte("proxy: {type: nginx, upstreams_file: /etc/nginx/keelson-upstreams.conf, reload: [systemctl, reload, nginx]}\napps:\n  - {name: web, image: x}\n"))
	if nginx == nil {
		t.Fatal(LoadIssues(issues))
	}
	if refs := nginx.FileRefs(); len(refs) != 0 {
		t.Errorf("upstreams_file is written by the agent, not read: %v", refs)
	}
}

func TestFileRefsSaysWhichFilesAreSecrets(t *testing.T) {
	if (FileRef{Key: "env_file"}).Secret() || (FileRef{Key: "cert_file"}).Secret() {
		t.Error("an env_file and a certificate are not credentials")
	}
	for _, key := range []string{"password_file", "secret_file", "bot_token_file", "key_file", "secret_key_file"} {
		if !(FileRef{Key: key}).Secret() {
			t.Errorf("%s holds a credential", key)
		}
	}
}
