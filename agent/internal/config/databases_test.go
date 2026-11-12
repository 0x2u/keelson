package config

import (
	"strings"
	"testing"
	"time"

	"filippo.io/age"
	"gopkg.in/yaml.v3"
)

func recipient(t *testing.T) string {
	t.Helper()
	id, err := age.GenerateX25519Identity()
	if err != nil {
		t.Fatal(err)
	}
	return id.Recipient().String()
}

// dbDoc is a database section with one broken or interesting value, around a valid backup.
func dbDoc(t *testing.T, db, backup string) string {
	t.Helper()
	if db == "" {
		db = "host: 127.0.0.1, database: shop, user: shop"
	}
	if backup == "" {
		backup = `schedule: "0 3 * * *", recipients: ["` + recipient(t) + `"], destination: {local: {dir: /var/backups/keelson}}`
	}
	return "databases:\n  - {name: shop, " + db + ", backup: {" + backup + "}}\n"
}

func TestDatabasesConfigDefaultsAndSynthesizedJob(t *testing.T) {
	r := recipient(t)
	c, issues := Parse([]byte(`
databases:
  - name: shop
    host: 127.0.0.1
    database: shop
    user: shop
    password_file: /etc/keelson/db-shop
    backup:
      schedule: "0 3 * * *"
      timezone: Europe/Paris
      recipients: ["` + r + `"]
      alert_after: 2
      paused: true
      destination:
        s3: {endpoint: "http://127.0.0.1:9000", region: eu-west-1, bucket: my-backups, prefix: keelson/prod, access_key_id: AKIA, secret_key_file: /etc/keelson/s3}
  - {name: scratch, host: db.internal, database: scratch, user: me, port: 5433, version: 16, network: backend, ssl_mode: require}
jobs:
  - {name: ping, schedule: "@daily", run: [true]}
`))
	if c == nil {
		t.Fatalf("%+v", issues)
	}
	shop, _ := c.Database("shop")
	if shop.Engine != "postgres" || shop.Port != 5432 || shop.Network != "host" {
		t.Errorf("database defaults: %+v", shop)
	}
	if b := shop.Backups; b.KeepCount() != DefaultBackupKeep || b.RunTimeout() != DefaultBackupTimeout || b.KeepDays != 0 {
		t.Errorf("backup defaults: %+v", b)
	}
	scratch, _ := c.Database("scratch")
	if scratch.Port != 5433 || scratch.Version != 16 || scratch.Network != "backend" || scratch.Backups != nil {
		t.Errorf("explicit values must be kept: %+v", scratch)
	}

	if len(c.Jobs) != 2 {
		t.Fatalf("want the user's job and one synthesized job (scratch has no backup), got %+v", c.Jobs)
	}
	j, ok := c.Job("backup-shop")
	if !ok || j.Kind() != "backup" || !j.Managed || j.Database != "shop" {
		t.Fatalf("synthesized job: %+v", j)
	}
	if j.Cron != "0 3 * * *" || j.Timezone != "Europe/Paris" || j.RunTimeout() != DefaultBackupTimeout || j.AlertThreshold() != 2 || !j.Paused {
		t.Errorf("the job must carry the backup's schedule, timezone, timeout, alert_after and paused: %+v", j)
	}
	if got := shop.Backups.Destinations[0].Describe(); got != "s3:my-backups/keelson/prod" {
		t.Errorf("destination %q", got)
	}
	if ping, _ := c.Job("ping"); ping.Managed || ping.Kind() != "host" {
		t.Errorf("a hand-written job is not managed: %+v", ping)
	}

	out, err := yaml.Marshal(j)
	if err != nil || strings.Contains(string(out), "database:") || strings.Contains(string(out), "managed") {
		t.Errorf("the synthesized job must not leak into a YAML document: %v\n%s", err, out)
	}
}

func TestDatabasesConfigRejectsWhatIsWrong(t *testing.T) {
	r := recipient(t)
	okBackup := `schedule: "0 3 * * *", recipients: ["` + r + `"]`
	local := `destination: {local: {dir: /var/backups}}`
	s3 := func(fields string) string {
		base := map[string]string{"endpoint": "https://s3.eu-west-1.amazonaws.com", "region": "eu-west-1", "bucket": "my-backups", "access_key_id": "AKIA", "secret_key_file": "/etc/keelson/s3"}
		for _, kv := range strings.Split(fields, ";") {
			if k, v, ok := strings.Cut(kv, "="); ok {
				if v == "" {
					delete(base, k)
				} else {
					base[k] = v
				}
			}
		}
		var parts []string
		for k, v := range base {
			parts = append(parts, k+": '"+v+"'")
		}
		return "destination: {s3: {" + strings.Join(parts, ", ") + "}}"
	}
	conn := "host: 127.0.0.1, database: shop, user: shop"

	cases := map[string]struct{ db, backup, want string }{
		"engine":             {conn + ", engine: mysql", "", "only postgres"},
		"no host":            {"database: shop, user: shop", "", "host is required"},
		"host with space":    {"host: 'a b', database: shop, user: shop", "", "host is required"},
		"port too high":      {conn + ", port: 70000", "", "port must be"},
		"no database":        {"host: h, user: shop", "", "database is required"},
		"database as option": {"host: h, user: shop, database: '-x'", "", "database is required"},
		"no user":            {"host: h, database: shop", "", "user is required"},
		"relative password":  {conn + ", password_file: pw", "", "password_file must be an absolute"},
		"ssl mode":           {conn + ", ssl_mode: maybe", "", "ssl_mode"},
		"version too old":    {conn + ", version: 9", "", "version must be"},
		"version too new":    {conn + ", version: 100", "", "version must be"},
		"network":            {conn + ", network: 'a b'", "", "network"},
		"bad schedule":       {conn, `schedule: "61 * * * *", recipients: ["` + r + `"], ` + local, "schedule"},
		"bad timezone":       {conn, okBackup + `, timezone: Mars/Base, ` + local, "timezone"},
		"no recipients":      {conn, `schedule: "0 3 * * *", ` + local, "recipients is required"},
		"not an age key":     {conn, `schedule: "0 3 * * *", recipients: ["ssh-ed25519 AAAA"], ` + local, "not an age X25519 public key"},
		"a secret key":       {conn, `schedule: "0 3 * * *", recipients: ["AGE-SECRET-KEY-1QQQ"], ` + local, "not an age X25519 public key"},
		"negative keep":      {conn, okBackup + ", keep: -1, " + local, "keep must be at least 1"},
		"negative keep_days": {conn, okBackup + ", keep_days: -1, " + local, "keep_days"},
		"timeout too long":   {conn, okBackup + ", timeout: 7h, " + local, "timeout must be"},
		"negative alert":     {conn, okBackup + ", alert_after: -1, " + local, "alert_after"},
		"no destination":     {conn, okBackup, "exactly one of local or s3"},
		"both destinations":  {conn, okBackup + `, destination: {local: {dir: /b}, s3: {endpoint: "https://x.com"}}`, "exactly one of local or s3"},
		"relative local dir": {conn, okBackup + `, destination: {local: {dir: backups}}`, "absolute path"},
		"http endpoint":      {conn, okBackup + ", " + s3("endpoint=http://s3.example.com"), "must be https"},
		"endpoint path":      {conn, okBackup + ", " + s3("endpoint=https://s3.example.com/bucket"), "bare scheme"},
		"no region":          {conn, okBackup + ", " + s3("region="), "region is required"},
		"no bucket":          {conn, okBackup + ", " + s3("bucket="), "bucket"},
		"prefix slash":       {conn, okBackup + ", " + s3("prefix=/keelson"), "slash"},
		"prefix dotdot":      {conn, okBackup + ", " + s3("prefix=a/../b"), "segments"},
		"no access key":      {conn, okBackup + ", " + s3("access_key_id="), "access_key_id"},
		"relative secret":    {conn, okBackup + ", " + s3("secret_key_file=s3secret"), "secret_key_file"},
	}
	for name, tc := range cases {
		doc := "databases:\n  - {name: shop, " + tc.db
		if tc.backup != "" {
			doc += ", backup: {" + tc.backup + "}"
		}
		doc += "}\n"
		c, issues := Parse([]byte(doc))
		issues = errorsOnly(issues)
		if c != nil || len(issues) != 1 {
			t.Errorf("%s: want one issue, got config=%v issues=%+v", name, c != nil, issues)
			continue
		}
		if issues[0].Path != "databases[shop]" || !strings.Contains(issues[0].Message, tc.want) || issues[0].Line != 2 {
			t.Errorf("%s: want %q at databases[shop] line 2, got %+v", name, tc.want, issues[0])
		}
	}

	for name, doc := range map[string]string{
		"bad name":     "databases:\n  - {name: 'My DB', host: h, database: d, user: u}\n",
		"duplicate":    "databases:\n  - {name: a, host: h, database: d, user: u}\n  - {name: a, host: h, database: d, user: u}\n",
		"unknown key":  "databases:\n  - {name: a, host: h, database: d, user: u, backup: {path_style: true}}\n",
		"password key": "databases:\n  - {name: a, host: h, database: d, user: u, password: secret}\n",
	} {
		if c, issues := Parse([]byte(doc)); c != nil || len(issues) == 0 {
			t.Errorf("%s: want an error", name)
		}
	}

	if c, issues := Parse([]byte(dbDoc(t, "", "") + "  - {name: b, host: h, database: d, user: u}\n")); c == nil {
		t.Errorf("a valid pair of databases must pass: %+v", issues)
	}
}

func TestABackupJobNameCannotBeTakenByAJob(t *testing.T) {
	doc := dbDoc(t, "", "") + "jobs:\n  - {name: backup-shop, schedule: '@daily', run: [x]}\n"
	c, issues := Parse([]byte(doc))
	issues = errorsOnly(issues)
	if c != nil || len(issues) != 1 || issues[0].Path != "jobs[backup-shop]" || !strings.Contains(issues[0].Message, "duplicate name") {
		t.Fatalf("want one duplicate-name issue on the hand-written job, got %+v", issues)
	}

	// Without a backup section the database owns no job name.
	free := "databases:\n  - {name: shop, host: h, database: d, user: u}\njobs:\n  - {name: backup-shop, schedule: '@daily', run: [x]}\n"
	if c, issues := Parse([]byte(free)); c == nil {
		t.Errorf("a database without backup synthesizes nothing: %+v", issues)
	}
}

func TestSetAndDeleteDatabase(t *testing.T) {
	r := recipient(t)
	db := map[string]any{
		"name": "shop", "host": "127.0.0.1", "database": "shop", "user": "shop",
		"backups": map[string]any{
			"schedule": "0 3 * * *", "recipients": []any{r},
			"destinations": []any{map[string]any{"local": map[string]any{"dir": "/var/backups/keelson"}}},
		},
	}
	out, issues, err := SetDatabase([]byte(sample), "shop", db)
	if err != nil || len(issues) != 0 {
		t.Fatalf("%v %+v", err, issues)
	}
	c, iss := Parse(out)
	if c == nil {
		t.Fatalf("%+v\n%s", iss, out)
	}
	if shop, ok := c.Database("shop"); !ok || shop.Backups == nil || shop.Backups.Destinations[0].Local.Dir != "/var/backups/keelson" {
		t.Errorf("%+v\n%s", shop, out)
	}
	if !strings.Contains(string(out), "# The shop.") || strings.Index(string(out), "name: shop\n    host") < 0 {
		t.Errorf("the rest of the document keeps its comments and the keys are in a tidy order:\n%s", out)
	}
	if _, _, err := SetDatabase(out, "other", db); err == nil {
		t.Error("a body name different from the path must be refused")
	}

	// The synthesized job is not in the document: it can be neither deleted nor replaced as a job.
	if _, err := DeleteJob(out, "backup-shop"); err == nil {
		t.Error("deleting a synthesized job from the document must fail")
	}
	job := map[string]any{"name": "backup-shop", "schedule": "@daily", "run": []any{"x"}}
	replaced, _, err := SetJob(out, "backup-shop", job)
	if err != nil {
		t.Fatal(err)
	}
	if c, issues := Parse(replaced); c != nil || len(issues) != 1 || !strings.Contains(issues[0].Message, "duplicate name") {
		t.Errorf("a job named like the synthesized one must be refused: %+v", issues)
	}

	out, err = DeleteDatabase(out, "shop")
	if err != nil || strings.Contains(string(out), "databases:") {
		t.Errorf("%v\n%s", err, out)
	}
	if _, err := DeleteDatabase(out, "shop"); err == nil {
		t.Error("deleting what is not there is an error")
	}
	if c, _ := Parse(out); c == nil || len(c.Databases) != 0 {
		t.Errorf("deleting the database removes its job: %+v", c)
	}
}

func TestBackupTimeoutBounds(t *testing.T) {
	r := recipient(t)
	ok := `databases:
  - {name: shop, host: h, database: d, user: u, backup: {schedule: '@daily', recipients: ["` + r + `"], destination: {local: {dir: /b}}, timeout: 6h}}
`
	c, issues := Parse([]byte(ok))
	if c == nil {
		t.Fatalf("%+v", issues)
	}
	if j, _ := c.Job("backup-shop"); j.RunTimeout() != 6*time.Hour {
		t.Errorf("timeout %s", j.Timeout)
	}
}

func TestARestoreJobNameCannotBeTakenByAJob(t *testing.T) {
	doc := dbDoc(t, "", "") + "jobs:\n  - {name: restore-shop, schedule: '@daily', run: [x]}\n"
	c, issues := Parse([]byte(doc))
	issues = errorsOnly(issues)
	if c != nil || len(issues) != 1 || issues[0].Path != "jobs[restore-shop]" || !strings.Contains(issues[0].Message, "duplicate name") {
		t.Fatalf("want one duplicate-name issue on the hand-written job, got %+v", issues)
	}
}
