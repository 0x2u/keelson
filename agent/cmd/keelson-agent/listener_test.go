package main

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"io"
	"math/big"
	"net"
	"net/http"
	"testing"
	"time"
)

func selfSigned(t *testing.T) tls.Certificate {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	tpl := &x509.Certificate{
		SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "127.0.0.1"},
		NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(time.Hour),
		IPAddresses: []net.IP{net.ParseIP("127.0.0.1")},
	}
	der, err := x509.CreateCertificate(rand.Reader, tpl, tpl, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	return tls.Certificate{Certificate: [][]byte{der}, PrivateKey: key}
}

// A socket that connects and says nothing must be closed, not held until the process ends.
func TestStalledTLSHandshakeIsCutOff(t *testing.T) {
	raw, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	srv := &http.Server{
		Handler:   http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { io.WriteString(w, "ok") }),
		ConnState: handshakeDeadline(150 * time.Millisecond),
	}
	go srv.Serve(tls.NewListener(raw, &tls.Config{Certificates: []tls.Certificate{selfSigned(t)}, MinVersion: tls.VersionTLS13}))
	t.Cleanup(func() { srv.Close() })

	idle, err := net.Dial("tcp", raw.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer idle.Close()
	idle.SetReadDeadline(time.Now().Add(3 * time.Second))
	start := time.Now()
	if _, err := idle.Read(make([]byte, 1)); err == nil {
		t.Fatal("unexpected data")
	} else if ne, ok := err.(net.Error); ok && ne.Timeout() {
		t.Fatalf("the agent still holds a socket that never started a handshake after %s", time.Since(start))
	}

	// A client that does handshake and ask is served, and may then idle on its keep-alive connection longer than d.
	client := &http.Client{Transport: &http.Transport{TLSClientConfig: &tls.Config{InsecureSkipVerify: true}}}
	url := "https://" + raw.Addr().String() + "/"
	for range 2 {
		resp, err := client.Get(url)
		if err != nil {
			t.Fatal(err)
		}
		body, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		if string(body) != "ok" {
			t.Fatalf("body %q", body)
		}
		time.Sleep(300 * time.Millisecond)
	}
}

func TestConnectionCapMakesAcceptWaitForASlot(t *testing.T) {
	raw, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	ln := capListener(raw, 2)
	defer ln.Close()
	var dials []net.Conn
	for range 3 {
		c, err := net.Dial("tcp", raw.Addr().String())
		if err != nil {
			t.Fatal(err)
		}
		dials = append(dials, c)
		defer c.Close()
	}
	var held []net.Conn
	for range 2 {
		c, err := ln.Accept()
		if err != nil {
			t.Fatal(err)
		}
		held = append(held, c)
	}
	third := make(chan net.Conn, 1)
	go func() {
		c, err := ln.Accept()
		if err == nil {
			third <- c
		}
	}()
	select {
	case <-third:
		t.Fatal("a third connection was accepted past the cap")
	case <-time.After(200 * time.Millisecond):
	}
	held[0].Close()
	held[0].Close() // closing twice must not give two slots back
	select {
	case c := <-third:
		c.Close()
	case <-time.After(3 * time.Second):
		t.Fatal("a closed connection must free its slot")
	}
	_ = dials
}

func TestClosingTheListenerReleasesAWaitingAccept(t *testing.T) {
	raw, _ := net.Listen("tcp", "127.0.0.1:0")
	ln := capListener(raw, 1)
	c, _ := net.Dial("tcp", raw.Addr().String())
	defer c.Close()
	if _, err := ln.Accept(); err != nil {
		t.Fatal(err)
	}
	errc := make(chan error, 1)
	go func() { _, err := ln.Accept(); errc <- err }()
	time.Sleep(50 * time.Millisecond)
	ln.Close()
	select {
	case err := <-errc:
		if err == nil {
			t.Fatal("want an error")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("Accept must return when the listener closes")
	}
}
