package postgres

import (
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/0x2u/keelson/agent/internal/config"
	"github.com/0x2u/keelson/agent/internal/confmgr"
	"github.com/0x2u/keelson/agent/internal/store"
)

func managedEntry(name, app string) config.Database {
	return config.Database{
		Name: name, Engine: config.EnginePostgres, Host: config.ManagedPostgresContainer, Port: config.ManagedPostgresPort,
		Database: name, User: name, Network: config.ManagedPostgresNetwork, PasswordFile: "/var/lib/keelson/postgres/roles/" + name,
		Managed: true, App: app, EnvKey: "DATABASE_URL",
	}
}

// A managed database of an app that belongs to a project goes into that project's file, and the drop removes it from there.
func TestManagedDatabaseIsDeclaredInTheFileOfItsAppsProject(t *testing.T) {
	dir := t.TempDir()
	apps := filepath.Join(dir, "apps.yaml")
	os.WriteFile(apps, []byte("apps:\n  - {name: web, image: ghcr.io/me/web}\n  - {name: shop, project: shop, image: ghcr.io/me/shop}\n"), 0o640)
	loc := config.DefaultLocation(apps)
	os.MkdirAll(loc.ProjectsDir, 0o700)
	os.WriteFile(loc.ProjectPath("shop"), []byte("apps:\n  - {name: shop-admin, image: ghcr.io/me/admin}\n"), 0o640)
	st, err := store.Open(filepath.Join(dir, "a.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	cfg, err := config.LoadFrom(loc)
	if err != nil {
		t.Fatal(err)
	}
	mgr, err := confmgr.New(apps, st, cfg, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err != nil {
		t.Fatal(err)
	}
	m := &Manager{cfg: mgr}

	// shop-admin is in the project file (project shop): its database goes there.
	if err := m.declare(managedEntry("shop-admin", "shop-admin"), "dashboard", "managed database shop-admin"); err != nil {
		t.Fatal(err)
	}
	// web has no project: the apps file.
	if err := m.declare(managedEntry("web", "web"), "dashboard", "managed database web"); err != nil {
		t.Fatal(err)
	}
	project, _ := os.ReadFile(loc.ProjectPath("shop"))
	main, _ := os.ReadFile(apps)
	if !strings.Contains(string(project), "database:") || !strings.Contains(string(project), "shop-admin") || strings.Contains(string(main), "shop-admin") {
		t.Errorf("project file:\n%s\nmain:\n%s", project, main)
	}
	if !strings.Contains(string(main), "database:") || strings.Contains(string(main), "databases:") {
		t.Errorf("main:\n%s", main)
	}
	if db, ok := mgr.Config().Database("shop-admin"); !ok || db.Project != "shop" || !db.Managed {
		t.Errorf("%+v", db)
	}
}
