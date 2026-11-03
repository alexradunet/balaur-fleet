package main

// Mistral's audio and search APIs, next to the OpenAI-compatible chat in llm.go:
//
//	POST /v1/audio/transcriptions   speech to text (Voxtral), multipart
//	POST /v1/audio/speech           text to speech (Voxtral TTS)
//	POST /v1/conversations          a one-off question with the web_search tool
//
// Only audio recorded after the wake word is sent; nothing is stored here.

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"math"
	"mime/multipart"
	"net/http"
	"net/textproto"
	"strings"
	"time"
)

type Mistral struct {
	base string
	key  string
	http *http.Client
}

func newMistral(baseURL, key string) *Mistral {
	return &Mistral{base: strings.TrimRight(baseURL, "/"), key: key, http: &http.Client{Timeout: 60 * time.Second}}
}

func (m *Mistral) do(req *http.Request) ([]byte, string, error) {
	t0 := time.Now()
	defer func() { log.Printf("mistral %s: %.2fs", req.URL.Path, time.Since(t0).Seconds()) }()
	if m.key != "" {
		req.Header.Set("Authorization", "Bearer "+m.key)
	}
	resp, err := m.http.Do(req)
	if err != nil {
		return nil, "", err
	}
	defer resp.Body.Close()
	b, err := io.ReadAll(io.LimitReader(resp.Body, 32<<20))
	if err != nil {
		return nil, "", err
	}
	if resp.StatusCode/100 != 2 {
		return nil, "", fmt.Errorf("%s %s: %s: %s", req.Method, req.URL.Path, resp.Status, truncate(string(b), 300))
	}
	return b, resp.Header.Get("Content-Type"), nil
}

func (m *Mistral) postJSON(ctx context.Context, path string, body any) ([]byte, string, error) {
	b, err := json.Marshal(body)
	if err != nil {
		return nil, "", err
	}
	req, err := http.NewRequestWithContext(ctx, "POST", m.base+path, bytes.NewReader(b))
	if err != nil {
		return nil, "", err
	}
	req.Header.Set("Content-Type", "application/json")
	return m.do(req)
}

// Transcript is what speech-to-text heard.
type Transcript struct {
	Text     string
	Language string // empty when not reported
}

// Transcribe sends 16 kHz mono 16-bit PCM. lang forces the language; empty
// lets the model detect it.
func (m *Mistral) Transcribe(ctx context.Context, model string, pcm []byte, lang string) (Transcript, error) {
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	var body bytes.Buffer
	w := multipart.NewWriter(&body)
	_ = w.WriteField("model", model)
	if lang != "" {
		_ = w.WriteField("language", lang)
	}
	h := textproto.MIMEHeader{}
	h.Set("Content-Disposition", `form-data; name="file"; filename="speech.wav"`)
	h.Set("Content-Type", "audio/wav")
	fw, err := w.CreatePart(h)
	if err != nil {
		return Transcript{}, err
	}
	if _, err := fw.Write(wavFile(pcm, micRate, 1)); err != nil {
		return Transcript{}, err
	}
	if err := w.Close(); err != nil {
		return Transcript{}, err
	}
	req, err := http.NewRequestWithContext(ctx, "POST", m.base+"/audio/transcriptions", &body)
	if err != nil {
		return Transcript{}, err
	}
	req.Header.Set("Content-Type", w.FormDataContentType())
	b, _, err := m.do(req)
	if err != nil {
		return Transcript{}, err
	}
	var out struct {
		Text     string `json:"text"`
		Language string `json:"language"`
	}
	if err := json.Unmarshal(b, &out); err != nil {
		return Transcript{}, fmt.Errorf("transcription: bad response: %w", err)
	}
	return Transcript{Text: strings.TrimSpace(out.Text), Language: out.Language}, nil
}

// Speak turns text into audio. The API returns either the audio file itself
// or JSON with it base64-encoded; both are accepted.
func (m *Mistral) Speak(ctx context.Context, model, voice, text string) (PCM, error) {
	ctx, cancel := context.WithTimeout(ctx, 60*time.Second)
	defer cancel()
	body := map[string]any{"model": model, "input": text, "response_format": "wav"}
	if voice != "" {
		body["voice_id"] = voice
	}
	b, ctype, err := m.postJSON(ctx, "/audio/speech", body)
	if err != nil {
		return PCM{}, err
	}
	if strings.Contains(ctype, "json") || (len(b) > 0 && b[0] == '{') {
		var j map[string]any
		if err := json.Unmarshal(b, &j); err != nil {
			return PCM{}, fmt.Errorf("speech: bad response: %w", err)
		}
		var enc string
		for _, k := range []string{"audio_data", "audio", "data"} {
			if s, ok := j[k].(string); ok && s != "" {
				enc = s
				break
			}
		}
		if enc == "" {
			return PCM{}, fmt.Errorf("speech: no audio in response: %s", truncate(string(b), 200))
		}
		if b, err = base64.StdEncoding.DecodeString(enc); err != nil {
			return PCM{}, fmt.Errorf("speech: %w", err)
		}
	}
	return parseWAV(b)
}

// WebSearch asks a question with Mistral's web_search tool and returns the
// answer with its sources, for the main model to phrase.
func (m *Mistral) WebSearch(ctx context.Context, model, query string) (any, error) {
	b, _, err := m.postJSON(ctx, "/conversations", map[string]any{
		"model":        model,
		"inputs":       query,
		"tools":        []map[string]string{{"type": "web_search"}},
		"store":        false,
		"instructions": "Search the web and answer factually and briefly (a few sentences), with dates and numbers where relevant.",
	})
	if err != nil {
		return nil, err
	}
	var out struct {
		Outputs []struct {
			Type    string          `json:"type"`
			Content json.RawMessage `json:"content"`
		} `json:"outputs"`
	}
	if err := json.Unmarshal(b, &out); err != nil {
		return nil, fmt.Errorf("web search: bad response: %w", err)
	}
	var text strings.Builder
	var sources []string
	for _, o := range out.Outputs {
		if o.Type != "message.output" {
			continue
		}
		var s string
		if json.Unmarshal(o.Content, &s) == nil {
			text.WriteString(s)
			continue
		}
		var chunks []struct {
			Type  string `json:"type"`
			Text  string `json:"text"`
			Title string `json:"title"`
		}
		if json.Unmarshal(o.Content, &chunks) == nil {
			for _, c := range chunks {
				switch c.Type {
				case "text":
					text.WriteString(c.Text)
				case "tool_reference":
					if c.Title != "" {
						sources = append(sources, c.Title)
					}
				}
			}
		}
	}
	if text.Len() == 0 {
		return nil, errors.New("web search: no answer")
	}
	return map[string]any{"answer": strings.TrimSpace(text.String()), "sources": sources}, nil
}

// wavFile wraps 16-bit PCM in a WAV header.
func wavFile(pcm []byte, rate, channels int) []byte {
	var b bytes.Buffer
	le := binary.LittleEndian
	b.WriteString("RIFF")
	_ = binary.Write(&b, le, uint32(36+len(pcm)))
	b.WriteString("WAVEfmt ")
	_ = binary.Write(&b, le, uint32(16))
	_ = binary.Write(&b, le, uint16(1)) // PCM
	_ = binary.Write(&b, le, uint16(channels))
	_ = binary.Write(&b, le, uint32(rate))
	_ = binary.Write(&b, le, uint32(rate*channels*2))
	_ = binary.Write(&b, le, uint16(channels*2))
	_ = binary.Write(&b, le, uint16(16))
	b.WriteString("data")
	_ = binary.Write(&b, le, uint32(len(pcm)))
	b.Write(pcm)
	return b.Bytes()
}

// parseWAV reads 16-bit integer or 32-bit float WAV into 16-bit PCM. A data
// chunk with an unknown length (streamed WAV) runs to the end of the file.
func parseWAV(b []byte) (PCM, error) {
	le := binary.LittleEndian
	if len(b) < 12 || string(b[:4]) != "RIFF" || string(b[8:12]) != "WAVE" {
		return PCM{}, errors.New("speech: not a WAV file")
	}
	var format, channels, bits int
	var rate int
	for p := 12; p+8 <= len(b); {
		id, size := string(b[p:p+4]), int(le.Uint32(b[p+4:]))
		body := b[p+8:]
		if size < 0 || size > len(body) {
			size = len(body)
		}
		switch id {
		case "fmt ":
			if size < 16 {
				return PCM{}, errors.New("speech: short fmt chunk")
			}
			format, channels = int(le.Uint16(body)), int(le.Uint16(body[2:]))
			rate, bits = int(le.Uint32(body[4:])), int(le.Uint16(body[14:]))
			if format == 0xFFFE && size >= 26 { // WAVE_FORMAT_EXTENSIBLE: real format in the sub-GUID
				format = int(le.Uint16(body[24:]))
			}
		case "data":
			data := body[:size]
			switch {
			case format == 1 && bits == 16:
				return PCM{Rate: rate, Channels: channels, Data: data[:len(data)/2*2]}, nil
			case format == 3 && bits == 32:
				out := make([]byte, 0, len(data)/2)
				for i := 0; i+4 <= len(data); i += 4 {
					f := math.Float32frombits(le.Uint32(data[i:]))
					v := int16(math.Max(-1, math.Min(1, float64(f))) * math.MaxInt16)
					out = le.AppendUint16(out, uint16(v))
				}
				return PCM{Rate: rate, Channels: channels, Data: out}, nil
			}
			return PCM{}, fmt.Errorf("speech: unsupported WAV (format %d, %d bits)", format, bits)
		}
		p += 8 + size + size%2
	}
	return PCM{}, errors.New("speech: WAV without data")
}
