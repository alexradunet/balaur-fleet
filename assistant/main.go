// duet-assistant: a private voice assistant for the Yoga Duet 7 home server.
//
// Wake word, speech-to-text and text-to-speech run on this machine (the
// openWakeWord, faster-whisper and Piper Wyoming servers); only the text of a
// request goes to the configured OpenAI-compatible model. Standard library only.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"
	_ "time/tzdata" // NixOS has no /usr/share/zoneinfo: carry the zones ($TZ) in the binary
)

func loadConfig() Config {
	var cfg Config
	cfg.Listen = "127.0.0.1:8770"
	cfg.Name = "Jarvis"
	cfg.DefaultLang = "ro"
	cfg.Audio.Input = "default"
	cfg.Audio.Output = "default"
	cfg.Audio.Card = "0"
	cfg.Audio.Volume = 70
	cfg.Wake.URI = "127.0.0.1:10400"
	cfg.Wake.Words = []string{"hey_jarvis"}
	cfg.STT.Model = "voxtral-mini-transcribe-3-0"
	cfg.TTS.Model = "voxtral-mini-tts-3-0"
	if path := os.Getenv("DUET_ASSISTANT_CONFIG"); path != "" {
		b, err := os.ReadFile(path)
		if err != nil {
			log.Fatalf("read config: %v", err)
		}
		if err := json.Unmarshal(b, &cfg); err != nil {
			log.Fatalf("parse config: %v", err)
		}
	}
	return cfg
}

// apiKey comes from systemd's LoadCredential= (never the store or the
// environment of other processes); $DUET_ASSISTANT_LLM_KEY for development.
func apiKey() string {
	if dir := os.Getenv("CREDENTIALS_DIRECTORY"); dir != "" {
		if b, err := os.ReadFile(filepath.Join(dir, "llm-key")); err == nil {
			return strings.TrimSpace(string(b))
		}
	}
	return os.Getenv("DUET_ASSISTANT_LLM_KEY")
}

func main() {
	log.SetFlags(0) // journald adds timestamps
	cfg := loadConfig()

	dir := os.Getenv("STATE_DIRECTORY")
	if dir == "" {
		dir = filepath.Join(os.TempDir(), "duet-assistant")
	}
	store, err := openStore(dir)
	if err != nil {
		log.Fatalf("state: %v", err)
	}
	key := apiKey()
	if key == "" {
		log.Printf("no LLM API key (run `sudo duet-assistant-login`); requests will fail unless the endpoint needs none")
	}
	a := newAssistant(cfg, store, newLLM(cfg.LLM.BaseURL, cfg.LLM.Model, key, cfg.LLM.Temperature))

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	if err := a.SetVolume(ctx, cfg.Audio.Volume); err != nil {
		log.Printf("volume: %v", err)
	}
	go a.run(ctx)

	srv := &http.Server{Addr: cfg.Listen, Handler: a.handler(), ReadHeaderTimeout: 5 * time.Second}
	go func() {
		<-ctx.Done()
		sctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		_ = srv.Shutdown(sctx)
	}()
	log.Printf("duet-assistant %q listening on %s (model %s, wake word %v)", cfg.Name, cfg.Listen, cfg.LLM.Model, cfg.Wake.Words)
	if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatal(err)
	}
}
