package deploy

import (
	"fmt"
	"reflect"

	"github.com/0x2u/keelson/agent/internal/config"
	"github.com/0x2u/keelson/agent/internal/confmgr"
)

// config is the configuration in force. A deployment reads it once and works on its copy of the app, so a
// reload in the middle of one does not change what it is doing.
func (d *Deployer) config() *config.Config { return d.cfg.Load() }

// proxyDriver is the reverse proxy in force, nil when there is none.
func (d *Deployer) proxyDriver() Proxy {
	d.pxMu.RLock()
	defer d.pxMu.RUnlock()
	return d.proxy
}

// SetProxyFactory tells the deployer how to build the proxy driver for a proxy section, which a reload may change.
func (d *Deployer) SetProxyFactory(f func(*config.Proxy) Proxy) { d.proxyFactory = f }

// Prepare implements confmgr.Applier. A change is refused while it would pull the floor from under a deployment:
// removing an app that is being deployed, or changing the proxy during any deployment.
func (d *Deployer) Prepare(old, next *config.Config) (func(), error) {
	d.mu.Lock()
	var running []string
	for app, active := range d.active {
		if active {
			running = append(running, app)
		}
	}
	d.mu.Unlock()

	for _, app := range running {
		if _, ok := next.App(app); ok {
			continue
		}
		// A preview instance is not an app of the file: it follows its template, whose removal waits for it too.
		if parent, _, isPreview := config.ParsePreviewName(app); isPreview {
			if _, ok := next.Previews(parent); ok {
				continue
			}
			return nil, &confmgr.BusyError{Reason: fmt.Sprintf("a preview of %s (%s) is running: wait for it to finish before removing the previews template or the app", parent, app)}
		}
		return nil, &confmgr.BusyError{Reason: fmt.Sprintf("a deployment of %s is running: wait for it to finish before removing the app", app)}
	}
	proxyChanged := !reflect.DeepEqual(old.Proxy, next.Proxy)
	if proxyChanged && len(running) > 0 {
		return nil, &confmgr.BusyError{Reason: "a deployment is running: wait for it to finish before changing the proxy"}
	}
	var px Proxy
	if proxyChanged && next.Proxy != nil {
		if d.proxyFactory == nil {
			return nil, fmt.Errorf("this agent cannot change its proxy while running: restart it")
		}
		px = d.proxyFactory(next.Proxy)
	}
	return func() {
		d.cfg.Store(next)
		if !proxyChanged {
			return
		}
		d.pxMu.Lock()
		d.proxy = px
		d.pxMu.Unlock()
		// Whatever the old proxy was told says nothing about the new one: the next reconcile pushes every route.
		d.proxyMu.Lock()
		d.appliedSet = false
		d.proxyMu.Unlock()
	}, nil
}
