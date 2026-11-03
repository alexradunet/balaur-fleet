package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"io"
	"math"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestWyomingRoundTrip(t *testing.T) {
	var buf bytes.Buffer
	in := Event{Type: "audio-chunk", Data: map[string]any{"rate": 16000.0, "width": 2.0}, Payload: []byte{1, 2, 3, 4}}
	if err := writeEvent(&buf, in); err != nil {
		t.Fatal(err)
	}
	// Older peers put data inline in the header.
	buf.WriteString(`{"type":"transcript","data":{"text":"salut"}}` + "\n")
	r := bufio.NewReader(&buf)
	out, err := readEvent(r)
	if err != nil {
		t.Fatal(err)
	}
	if out.Type != in.Type || out.Data["rate"] != 16000.0 || !bytes.Equal(out.Payload, in.Payload) {
		t.Fatalf("got %+v", out)
	}
	out, err = readEvent(r)
	if err != nil || strField(out.Data, "text") != "salut" {
		t.Fatalf("inline data: %+v %v", out, err)
	}
}

// fakeWyoming runs a one-connection server that answers with handle.
func fakeWyoming(t *testing.T, handle func(r *bufio.Reader, w net.Conn)) string {
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { l.Close() })
	go func() {
		c, err := l.Accept()
		if err != nil {
			return
		}
		defer c.Close()
		handle(bufio.NewReader(c), c)
	}()
	return l.Addr().String()
}

// fakeMistral answers the audio and conversations endpoints like the real API.
func fakeMistral(t *testing.T, speechAsJSON bool) *httptest.Server {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer k" {
			http.Error(w, "unauthorized", 401)
			return
		}
		switch r.URL.Path {
		case "/v1/audio/transcriptions":
			if err := r.ParseMultipartForm(1 << 20); err != nil {
				t.Errorf("multipart: %v", err)
			}
			f, _, err := r.FormFile("file")
			if err != nil {
				t.Errorf("no file: %v", err)
				return
			}
			b, _ := io.ReadAll(f)
			p, err := parseWAV(b)
			if err != nil || p.Rate != 16000 || len(p.Data) != 32000 {
				t.Errorf("uploaded wav: %+v %v", p.Rate, err)
			}
			if r.FormValue("model") != "voxtral" {
				t.Errorf("model %q", r.FormValue("model"))
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"text": " Cât e ceasul? ", "language": "ro"})
		case "/v1/audio/speech":
			var body map[string]any
			_ = json.NewDecoder(r.Body).Decode(&body)
			if body["input"] != "Bună" || body["voice_id"] != "v-ro" {
				t.Errorf("speech request %v", body)
			}
			wav := wavFile(make([]byte, 480), 24000, 1)
			if speechAsJSON {
				_ = json.NewEncoder(w).Encode(map[string]string{"audio_data": base64.StdEncoding.EncodeToString(wav)})
			} else {
				w.Header().Set("Content-Type", "audio/wav")
				_, _ = w.Write(wav)
			}
		case "/v1/conversations":
			_, _ = io.WriteString(w, `{"outputs":[{"type":"tool.execution","name":"web_search"},
				{"type":"message.output","content":[{"type":"text","text":"Steaua won 2-1."},{"type":"tool_reference","title":"Digi Sport"}]}]}`)
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(srv.Close)
	return srv
}

func TestMistralAudioAndSearch(t *testing.T) {
	for _, asJSON := range []bool{false, true} {
		m := newMistral(fakeMistral(t, asJSON).URL+"/v1", "k")
		tr, err := m.Transcribe(context.Background(), "voxtral", make([]byte, 32000), "")
		if err != nil || tr.Text != "Cât e ceasul?" || tr.Language != "ro" {
			t.Fatalf("transcribe: %+v %v", tr, err)
		}
		p, err := m.Speak(context.Background(), "tts", "v-ro", "Bună")
		if err != nil || p.Rate != 24000 || p.Channels != 1 || len(p.Data) != 480 {
			t.Fatalf("speak (json=%v): rate %d, %d bytes, %v", asJSON, p.Rate, len(p.Data), err)
		}
		res, err := m.WebSearch(context.Background(), "mistral-medium-latest", "scor steaua")
		if err != nil {
			t.Fatal(err)
		}
		if got := res.(map[string]any); got["answer"] != "Steaua won 2-1." || len(got["sources"].([]string)) != 1 {
			t.Fatalf("search: %v", got)
		}
	}
}

func TestParseWAVFloat(t *testing.T) {
	var b bytes.Buffer
	le := binary.LittleEndian
	data := []float32{0, 0.5, -1}
	b.WriteString("RIFF")
	_ = binary.Write(&b, le, uint32(0xFFFFFFFF))
	b.WriteString("WAVEfmt ")
	for _, v := range []any{uint32(16), uint16(3), uint16(1), uint32(24000), uint32(96000), uint16(4), uint16(32)} {
		_ = binary.Write(&b, le, v)
	}
	b.WriteString("data")
	_ = binary.Write(&b, le, uint32(0xFFFFFFFF)) // streamed: unknown length
	_ = binary.Write(&b, le, data)
	p, err := parseWAV(b.Bytes())
	if err != nil || len(p.Data) != 6 || int16(le.Uint16(p.Data[2:])) != math.MaxInt16/2 {
		t.Fatalf("%v %v", p.Data, err)
	}
}

func tone(amp float64, d time.Duration) [][]byte {
	var frames [][]byte
	samples := int(d.Seconds() * micRate)
	var cur []byte
	for i := 0; i < samples; i++ {
		v := int16(amp * math.Sin(2*math.Pi*300*float64(i)/micRate))
		cur = binary.LittleEndian.AppendUint16(cur, uint16(v))
		if len(cur) == frameBytes {
			frames = append(frames, cur)
			cur = nil
		}
	}
	return frames
}

func TestVAD(t *testing.T) {
	var frames [][]byte
	frames = append(frames, tone(150, 500*time.Millisecond)...)   // room noise
	frames = append(frames, tone(3000, 1500*time.Millisecond)...) // speech
	frames = append(frames, tone(150, 2*time.Second)...)          // silence again
	ch := make(chan []byte, len(frames))
	for _, f := range frames {
		ch <- f
	}
	var floor noiseFloor
	floor.update(150 / math.Sqrt2)
	pcm, ok, _, _ := recordUtterance(context.Background(), ch, &floor, defaultVAD)
	if !ok {
		t.Fatal("speech not detected")
	}
	got := time.Duration(len(pcm)/2) * time.Second / micRate
	// 1.5 s speech + up to 0.4 s lead-in + ~0.9 s trailing silence.
	if got < 2*time.Second || got > 3*time.Second {
		t.Fatalf("utterance length %v", got)
	}

	// Only noise: gives up after the start timeout.
	ch = make(chan []byte, 200)
	for _, f := range tone(150, 6*time.Second) {
		ch <- f
	}
	if _, ok, _, _ := recordUtterance(context.Background(), ch, &floor, defaultVAD); ok {
		t.Fatal("noise taken for speech")
	}
}

func TestStore(t *testing.T) {
	dir := t.TempDir()
	s, err := openStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.AddItems("cumpărături", []string{"Lapte", "ouă", "lapte"}, "", ""); err != nil {
		t.Fatal(err)
	}
	if _, err := s.AddItems("Tasks", []string{"duce gunoiul"}, "Alex", ""); err != nil {
		t.Fatal(err)
	}
	if n := len(s.Lists()["shopping"]); n != 2 {
		t.Fatalf("shopping has %d items, want 2 (no duplicate)", n)
	}
	removed, missing, err := s.RemoveItems("shopping", []string{"oua", "pâine"})
	if err != nil || len(removed) != 1 || len(missing) != 1 {
		t.Fatalf("remove: %v %v %v", removed, missing, err)
	}
	if _, err := s.Remember("Alex likes coffee without sugar."); err != nil {
		t.Fatal(err)
	}
	_, _ = s.AddReminder(Reminder{Text: "pastila", At: time.Now().Add(-time.Minute), Repeat: "daily"})
	_, _ = s.AddReminder(Reminder{Text: "once", At: time.Now().Add(-time.Minute)})
	due := s.TakeDue(time.Now())
	if len(due) != 2 || len(s.Reminders()) != 1 || !s.Reminders()[0].At.After(time.Now()) {
		t.Fatalf("due=%v left=%v", due, s.Reminders())
	}

	// Everything survives a reopen; no temp files are left behind.
	s2, err := openStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(s2.Lists()["shopping"]) != 1 || len(s2.Lists()["tasks"]) != 1 || len(s2.Memories()) != 1 || len(s2.Reminders()) != 1 {
		t.Fatalf("reload: %+v %+v", s2.Lists(), s2.Memories())
	}
	entries, _ := os.ReadDir(dir)
	for _, e := range entries {
		if strings.HasPrefix(e.Name(), ".tmp") {
			t.Fatalf("leftover %s", filepath.Join(dir, e.Name()))
		}
	}
}

func TestDetectLang(t *testing.T) {
	cases := map[string]string{
		"Adaugă lapte pe lista de cumpărături": "ro",
		"cat e ceasul":                        "ro",
		"What's the weather tomorrow?":        "en",
		"Set a timer for ten minutes":         "en",
		"Bună dimineața! Astăzi va fi soare.": "ro",
	}
	for in, want := range cases {
		if got := detectLang(in); got != want {
			t.Errorf("detectLang(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestSentencesAndSpoken(t *testing.T) {
	got := sentences("Gata. Am adăugat 2.5 kg de mere! Mai vrei ceva?")
	if len(got) != 3 || got[1] != "Am adăugat 2.5 kg de mere!" {
		t.Fatalf("%q", got)
	}
	if s := spoken("<think>hmm</think>**Sure!**\n- one\n- two [link](http://x)"); s != "Sure! one two link" {
		t.Fatalf("%q", s)
	}
}

// The model asks for a tool, gets the result, then answers.
func TestConverseToolLoop(t *testing.T) {
	round := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/chat/completions" || r.Header.Get("Authorization") != "Bearer k" {
			http.Error(w, "bad", 400)
			return
		}
		b, _ := io.ReadAll(r.Body)
		var req struct {
			Messages []Message `json:"messages"`
			Tools    []any     `json:"tools"`
		}
		_ = json.Unmarshal(b, &req)
		round++
		var msg map[string]any
		switch round {
		case 1:
			if len(req.Tools) == 0 || req.Messages[0].Role != "system" {
				t.Errorf("first request: %d tools, first role %s", len(req.Tools), req.Messages[0].Role)
			}
			msg = map[string]any{"role": "assistant", "content": nil, "tool_calls": []any{map[string]any{
				"id": "c1", "type": "function",
				"function": map[string]any{"name": "house_list_add", "arguments": `{"list":"shopping","items":["lapte"]}`},
			}}}
		default:
			last := req.Messages[len(req.Messages)-1]
			if last.Role != "tool" || !strings.Contains(last.Content, "lapte") {
				t.Errorf("tool result not passed back: %+v", last)
			}
			msg = map[string]any{"role": "assistant", "content": "Am pus lapte pe listă."}
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"choices": []any{map[string]any{"message": msg}}})
	}))
	defer srv.Close()

	store, err := openStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	var cfg Config
	cfg.Name = "Jarvis"
	cfg.DefaultLang = "ro"
	a := newAssistant(cfg, store, newLLM(srv.URL+"/v1/", "m", "k", nil))
	reply, err := a.converse(context.Background(), "pune lapte pe lista de cumpărături", &turn{lang: "ro"})
	if err != nil {
		t.Fatal(err)
	}
	if reply != "Am pus lapte pe listă." || round != 2 {
		t.Fatalf("reply %q after %d rounds", reply, round)
	}
	if items := store.Lists()["shopping"]; len(items) != 1 || items[0].Text != "lapte" {
		t.Fatalf("list: %+v", items)
	}
	if len(a.history) != 4 { // user, assistant(tool call), tool, assistant
		t.Fatalf("history has %d messages", len(a.history))
	}
}

func TestIsStopAndNoise(t *testing.T) {
	for _, s := range []string{"Stop.", "gata!", "Lasă", "never mind", "Mulțumesc."} {
		if !isStop(s) {
			t.Errorf("isStop(%q) = false", s)
		}
	}
	if isStop("stop the music in the kitchen") {
		t.Error("long sentence taken as stop")
	}
	if !isNoise("Mulțumesc pentru vizionare!") || isNoise("Cât e ceasul?") {
		t.Error("noise filter")
	}
}

func TestLooksRoOrEn(t *testing.T) {
	for in, want := range map[string]bool{
		"Bir sonraki videoda görüşürüz.":    false, // what Whisper made of "Cât e ceasul?"
		"Cât e ceasul?":                     true,
		"What's the weather like tomorrow?": true,
		"Adaugă lapte și ouă pe listă.":     true,
		"Ciao, come stai oggi amico":        false,
		"Mihai":                             true,
	} {
		if got := looksRoOrEn(in); got != want {
			t.Errorf("looksRoOrEn(%q) = %v, want %v", in, got, want)
		}
	}
}

func TestWakeStream(t *testing.T) {
	addr := fakeWyoming(t, func(r *bufio.Reader, w net.Conn) {
		ev, _ := readEvent(r)
		if ev.Type != "detect" {
			t.Errorf("first event %q", ev.Type)
		}
		for i := 0; i < 4; i++ { // audio-start, then chunks
			if _, err := readEvent(r); err != nil {
				return
			}
		}
		_ = writeEvent(w, Event{Type: "detection", Data: map[string]any{"name": "hey_jarvis"}})
		_, _ = io.Copy(io.Discard, r)
	})
	ws, err := openWakeStream(context.Background(), addr, []string{"hey_jarvis"})
	if err != nil {
		t.Fatal(err)
	}
	defer ws.close()
	for i := 0; i < 3; i++ {
		if err := ws.feed(make([]byte, frameBytes)); err != nil {
			t.Fatal(err)
		}
	}
	select {
	case n := <-ws.hits:
		if n != "hey_jarvis" {
			t.Fatalf("detected %q", n)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("no detection")
	}
}
