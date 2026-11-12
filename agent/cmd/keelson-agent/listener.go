package main

import (
	"net"
	"net/http"
	"sync"
	"time"
)

const (
	// tlsHandshakeTimeout is how long a new connection has to finish its TLS handshake and send its first request byte.
	// Go's server leaves a stalled handshake alone, so a few hundred idle sockets would hold the agent's whole budget.
	tlsHandshakeTimeout = 10 * time.Second
	// maxConns caps the connections the agent holds at once; a connection past it waits in the kernel's backlog.
	maxConns = 256
)

// handshakeDeadline is an http.Server.ConnState hook: a connection must be active (its handshake done, a request on
// its way) within d of being accepted. After that the server's own timeouts apply.
func handshakeDeadline(d time.Duration) func(net.Conn, http.ConnState) {
	return func(c net.Conn, s http.ConnState) {
		switch s {
		case http.StateNew:
			_ = c.SetDeadline(time.Now().Add(d))
		case http.StateActive:
			_ = c.SetDeadline(time.Time{})
		}
	}
}

// capListener limits how many accepted connections are open at once: Accept waits for a slot, which a closing
// connection gives back.
func capListener(ln net.Listener, max int) net.Listener {
	return &cappedListener{Listener: ln, slots: make(chan struct{}, max), done: make(chan struct{})}
}

type cappedListener struct {
	net.Listener
	slots chan struct{}
	done  chan struct{}
	once  sync.Once
}

func (l *cappedListener) Accept() (net.Conn, error) {
	select {
	case l.slots <- struct{}{}:
	case <-l.done:
		return nil, net.ErrClosed
	}
	c, err := l.Listener.Accept()
	if err != nil {
		<-l.slots
		return nil, err
	}
	return &cappedConn{Conn: c, release: func() { <-l.slots }}, nil
}

func (l *cappedListener) Close() error {
	l.once.Do(func() { close(l.done) })
	return l.Listener.Close()
}

type cappedConn struct {
	net.Conn
	once    sync.Once
	release func()
}

func (c *cappedConn) Close() error {
	err := c.Conn.Close()
	c.once.Do(c.release)
	return err
}
