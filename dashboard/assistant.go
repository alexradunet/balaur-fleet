package main

// The voice assistant (duet-assistant, assistant/) runs its own API on
// localhost; the Assistant tab reaches it through /api/assistant/*.

import (
	"net/http"
	"net/http/httputil"
	"net/url"
	"strings"
)

type AssistantConfig struct {
	URL string `json:"url"` // e.g. http://127.0.0.1:8770
}

func registerAssistant(mux *http.ServeMux, cfg *AssistantConfig) bool {
	if cfg == nil || cfg.URL == "" {
		return false
	}
	target, err := url.Parse(cfg.URL)
	if err != nil {
		return false
	}
	proxy := &httputil.ReverseProxy{
		Rewrite: func(r *httputil.ProxyRequest) {
			r.SetURL(target)
			r.Out.URL.Path = strings.TrimPrefix(r.In.URL.Path, "/api/assistant")
			r.Out.URL.RawPath = ""
			r.Out.Header.Del("Origin")
		},
		ErrorHandler: func(w http.ResponseWriter, r *http.Request, err error) {
			http.Error(w, "assistant unavailable", http.StatusBadGateway)
		},
	}
	mux.HandleFunc("/api/assistant/", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && !sameOrigin(r) {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		proxy.ServeHTTP(w, r)
	})
	return true
}
