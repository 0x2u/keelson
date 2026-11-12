package config

import "strconv"

// BuildMachineIssues are the errors of a configuration on a machine that connects out to the dashboard (`keelson-agent
// connect`): a laptop that builds images and hands them over. Whoever holds the dashboard's credentials can write its
// configuration, so what the configuration can make the machine do is limited to that: it may say what it accepts to build
// (build_limits) and nothing else. An app, a job, a database or a proxy would run things, or serve traffic nobody can
// reach; none of it belongs on such a machine.
func BuildMachineIssues(c *Config) []Issue {
	var out []Issue
	add := func(path, msg string) { out = append(out, Issue{Severity: SeverityError, Path: path, Message: msg}) }
	const why = "a machine that connects to the dashboard only builds images: its configuration is build_limits and nothing else"
	if len(c.Apps) > 0 {
		add("apps["+c.Apps[0].Name+"]", why+" (it runs no apps)")
	}
	if len(c.Jobs) > 0 {
		add("jobs["+c.Jobs[0].Name+"]", why+" (it runs no jobs)")
	}
	if len(c.Databases) > 0 {
		add("databases["+strconv.Quote(c.Databases[0].Name)+"]", why+" (it has no databases)")
	}
	if c.Proxy != nil {
		add("proxy", why+" (it has no reverse proxy)")
	}
	if c.ManagedPostgres != nil {
		add("managed_postgres", why+" (it has no managed PostgreSQL)")
	}
	if c.Notifications != nil {
		add("notifications", why+" (it sends no notifications)")
	}
	if len(c.Registries) > 0 {
		add("registries", why+" (it pulls no images)")
	}
	return out
}
