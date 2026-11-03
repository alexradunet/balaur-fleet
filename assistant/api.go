package main

// HTTP API on localhost. The dashboard proxies it under /api/assistant/.

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"time"
)

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func readJSON(w http.ResponseWriter, r *http.Request, v any) bool {
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 16<<10)).Decode(v); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "bad request"})
		return false
	}
	return true
}

func fail(w http.ResponseWriter, err error) {
	writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
}

func (a *Assistant) handler() http.Handler {
	mux := http.NewServeMux()
	ok := func(w http.ResponseWriter) { writeJSON(w, http.StatusOK, a.Status()) }

	// GET /status?wait=1 holds the request until something changes (max 25 s).
	mux.HandleFunc("GET /status", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("wait") != "" {
			select {
			case <-a.Changed():
			case <-time.After(25 * time.Second):
			case <-r.Context().Done():
				return
			}
		}
		ok(w)
	})

	mux.HandleFunc("POST /chat", func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Text  string `json:"text"`
			Speak bool   `json:"speak"`
		}
		if !readJSON(w, r, &body) {
			return
		}
		if strings.TrimSpace(body.Text) == "" {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "empty"})
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), 3*time.Minute)
		defer cancel()
		reply, err := a.Ask(ctx, body.Text, body.Speak)
		if err != nil {
			fail(w, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]string{"reply": reply})
	})

	mux.HandleFunc("POST /mute", func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Muted bool `json:"muted"`
		}
		if !readJSON(w, r, &body) {
			return
		}
		a.SetMuted(body.Muted)
		ok(w)
	})

	mux.HandleFunc("POST /stop", func(w http.ResponseWriter, r *http.Request) {
		a.Stop()
		ok(w)
	})

	mux.HandleFunc("POST /volume", func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Percent int `json:"percent"`
		}
		if !readJSON(w, r, &body) {
			return
		}
		if err := a.SetVolume(r.Context(), body.Percent); err != nil {
			fail(w, err)
			return
		}
		ok(w)
	})

	mux.HandleFunc("POST /lists/{list}/items", func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Text string `json:"text"`
		}
		if !readJSON(w, r, &body) {
			return
		}
		if _, err := a.store.AddItems(r.PathValue("list"), []string{body.Text}, "", ""); err != nil {
			fail(w, err)
			return
		}
		ok(w)
	})

	mux.HandleFunc("POST /lists/{list}/items/{id}/done", func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Done bool `json:"done"`
		}
		if !readJSON(w, r, &body) {
			return
		}
		if _, err := a.store.SetDone(r.PathValue("list"), r.PathValue("id"), body.Done); err != nil {
			fail(w, err)
			return
		}
		ok(w)
	})

	mux.HandleFunc("DELETE /lists/{list}/items/{id}", func(w http.ResponseWriter, r *http.Request) {
		if _, _, err := a.store.RemoveItems(r.PathValue("list"), []string{r.PathValue("id")}); err != nil {
			fail(w, err)
			return
		}
		ok(w)
	})

	mux.HandleFunc("POST /lists/{list}/clear-done", func(w http.ResponseWriter, r *http.Request) {
		if err := a.store.ClearDone(r.PathValue("list")); err != nil {
			fail(w, err)
			return
		}
		ok(w)
	})

	mux.HandleFunc("DELETE /reminders/{id}", func(w http.ResponseWriter, r *http.Request) {
		if _, err := a.store.DeleteReminder(r.PathValue("id")); err != nil {
			fail(w, err)
			return
		}
		ok(w)
	})

	mux.HandleFunc("POST /memories", func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Fact string `json:"fact"`
		}
		if !readJSON(w, r, &body) || strings.TrimSpace(body.Fact) == "" {
			return
		}
		if _, err := a.store.Remember(body.Fact); err != nil {
			fail(w, err)
			return
		}
		ok(w)
	})

	mux.HandleFunc("DELETE /memories/{id}", func(w http.ResponseWriter, r *http.Request) {
		if _, err := a.store.Forget(r.PathValue("id")); err != nil {
			fail(w, err)
			return
		}
		ok(w)
	})

	mux.HandleFunc("DELETE /timers/{id}", func(w http.ResponseWriter, r *http.Request) {
		a.timers.cancel(r.PathValue("id"), "", false)
		a.notify()
		ok(w)
	})

	return mux
}
