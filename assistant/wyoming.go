package main

// A minimal client for the Wyoming protocol (github.com/rhasspy/wyoming), which
// the local openWakeWord server speaks over TCP. Only the wake word is
// detected on this machine; speech goes to Mistral (mistral.go).
//
// Every event is one JSON header line, then `data_length` bytes of JSON data,
// then `payload_length` bytes of binary payload (raw PCM for audio chunks):
//
//	{"type":"audio-chunk","version":"1.9.0","data_length":40,"payload_length":2560}\n
//	{"rate":16000,"width":2,"channels":1}<2560 bytes of PCM>

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"strings"
	"time"
)

const wyomingVersion = "1.9.0"

type Event struct {
	Type    string
	Data    map[string]any
	Payload []byte
}

type eventHeader struct {
	Type          string         `json:"type"`
	Version       string         `json:"version,omitempty"`
	Data          map[string]any `json:"data,omitempty"` // older peers inline the data here
	DataLength    int            `json:"data_length,omitempty"`
	PayloadLength int            `json:"payload_length,omitempty"`
}

const maxWyomingPart = 16 << 20

func writeEvent(w io.Writer, ev Event) error {
	var data []byte
	if len(ev.Data) > 0 {
		var err error
		if data, err = json.Marshal(ev.Data); err != nil {
			return err
		}
	}
	h, err := json.Marshal(eventHeader{
		Type:          ev.Type,
		Version:       wyomingVersion,
		DataLength:    len(data),
		PayloadLength: len(ev.Payload),
	})
	if err != nil {
		return err
	}
	buf := make([]byte, 0, len(h)+1+len(data)+len(ev.Payload))
	buf = append(buf, h...)
	buf = append(buf, '\n')
	buf = append(buf, data...)
	buf = append(buf, ev.Payload...)
	_, err = w.Write(buf)
	return err
}

func readEvent(r *bufio.Reader) (Event, error) {
	line, err := r.ReadBytes('\n')
	if err != nil {
		return Event{}, err
	}
	var h eventHeader
	if err := json.Unmarshal(line, &h); err != nil {
		return Event{}, fmt.Errorf("wyoming header: %w", err)
	}
	if h.DataLength < 0 || h.DataLength > maxWyomingPart || h.PayloadLength < 0 || h.PayloadLength > maxWyomingPart {
		return Event{}, errors.New("wyoming: event too large")
	}
	ev := Event{Type: h.Type, Data: h.Data}
	if ev.Data == nil {
		ev.Data = map[string]any{}
	}
	if h.DataLength > 0 {
		b := make([]byte, h.DataLength)
		if _, err := io.ReadFull(r, b); err != nil {
			return Event{}, err
		}
		var extra map[string]any
		if err := json.Unmarshal(b, &extra); err != nil {
			return Event{}, fmt.Errorf("wyoming data: %w", err)
		}
		for k, v := range extra {
			ev.Data[k] = v
		}
	}
	if h.PayloadLength > 0 {
		ev.Payload = make([]byte, h.PayloadLength)
		if _, err := io.ReadFull(r, ev.Payload); err != nil {
			return Event{}, err
		}
	}
	return ev, nil
}

// wyConn is one connection to a Wyoming server.
type wyConn struct {
	c    net.Conn
	r    *bufio.Reader
	stop func() bool
}

// dialWyoming accepts "host:port" or "tcp://host:port".
func dialWyoming(ctx context.Context, uri string) (*wyConn, error) {
	addr := strings.TrimPrefix(uri, "tcp://")
	d := net.Dialer{Timeout: 3 * time.Second}
	c, err := d.DialContext(ctx, "tcp", addr)
	if err != nil {
		return nil, err
	}
	// Unblock reads and writes when the context ends.
	stop := context.AfterFunc(ctx, func() { _ = c.SetDeadline(time.Unix(1, 0)) })
	return &wyConn{c: c, r: bufio.NewReaderSize(c, 64<<10), stop: stop}, nil
}

func (w *wyConn) send(ev Event) error  { return writeEvent(w.c, ev) }
func (w *wyConn) recv() (Event, error) { return readEvent(w.r) }
func (w *wyConn) close()               { w.stop(); _ = w.c.Close() }

func audioFormat(rate, width, channels int) map[string]any {
	return map[string]any{"rate": rate, "width": width, "channels": channels}
}

func intField(m map[string]any, k string, def int) int {
	if f, ok := m[k].(float64); ok {
		return int(f)
	}
	return def
}

func strField(m map[string]any, k string) string {
	s, _ := m[k].(string)
	return s
}

// PCM is a run of raw little-endian 16-bit audio with its format.
type PCM struct {
	Rate, Channels int
	Data           []byte
}

// wakeStream feeds microphone audio to an openWakeWord server.
type wakeStream struct {
	w      *wyConn
	format map[string]any
	hits   chan string
}

func openWakeStream(ctx context.Context, uri string, names []string) (*wakeStream, error) {
	w, err := dialWyoming(ctx, uri)
	if err != nil {
		return nil, err
	}
	s := &wakeStream{w: w, format: audioFormat(16000, 2, 1), hits: make(chan string, 4)}
	ns := make([]any, len(names))
	for i, n := range names {
		ns[i] = n
	}
	if err := w.send(Event{Type: "detect", Data: map[string]any{"names": ns}}); err != nil {
		w.close()
		return nil, err
	}
	if err := w.send(Event{Type: "audio-start", Data: s.format}); err != nil {
		w.close()
		return nil, err
	}
	go func() {
		defer close(s.hits)
		for {
			ev, err := w.recv()
			if err != nil {
				return
			}
			if ev.Type == "detection" {
				select {
				case s.hits <- strField(ev.Data, "name"):
				default:
				}
			}
		}
	}()
	return s, nil
}

func (s *wakeStream) feed(pcm []byte) error {
	return s.w.send(Event{Type: "audio-chunk", Data: s.format, Payload: pcm})
}

func (s *wakeStream) close() { s.w.close() }
