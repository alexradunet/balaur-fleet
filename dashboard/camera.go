package main

// Live camera view: proxies the relay's MJPEG stream (a Unix socket) to the
// dashboard's own clients, the kiosk included, so there is one camera path for
// every screen. Only clients from cfg.CameraNets may watch; everyone sees how
// many are watching.

import (
	"context"
	"log"
	"net"
	"net/http"
	"net/http/httputil"
	"net/netip"
	"net/url"
	"sync/atomic"
)

type camera struct {
	nets    []netip.Prefix
	proxy   *httputil.ReverseProxy
	viewers atomic.Int32
}

func newCamera(cfg Config) *camera {
	if cfg.CameraStream == "" {
		return nil
	}
	c := &camera{}
	for _, s := range cfg.CameraNets {
		p, err := netip.ParsePrefix(s)
		if err != nil {
			log.Fatalf("cameraNets: %v", err)
		}
		c.nets = append(c.nets, p)
	}
	sock := cfg.CameraStream
	c.proxy = &httputil.ReverseProxy{
		Rewrite: func(r *httputil.ProxyRequest) {
			r.SetURL(&url.URL{Scheme: "http", Host: "camera"})
			r.Out.URL.Path = "/stream"
			r.Out.Header.Del("Cookie")
		},
		Transport: &http.Transport{
			DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
				return (&net.Dialer{}).DialContext(ctx, "unix", sock)
			},
		},
		FlushInterval: -1, // every JPEG part goes out as soon as it arrives
		ErrorHandler: func(w http.ResponseWriter, _ *http.Request, err error) {
			http.Error(w, "camera unavailable", http.StatusBadGateway)
		},
	}
	return c
}

// allowed: may this client watch? (nil camera: no camera configured.)
func (c *camera) allowed(r *http.Request) bool {
	if c == nil {
		return false
	}
	ap, err := netip.ParseAddrPort(r.RemoteAddr)
	if err != nil {
		return false
	}
	ip := ap.Addr().Unmap()
	for _, p := range c.nets {
		if p.Contains(ip) {
			return true
		}
	}
	return false
}

func (c *camera) Viewers() int {
	if c == nil {
		return 0
	}
	return int(c.viewers.Load())
}

func (c *camera) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if !c.allowed(r) {
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}
	c.viewers.Add(1)
	defer c.viewers.Add(-1)
	c.proxy.ServeHTTP(w, r)
}
