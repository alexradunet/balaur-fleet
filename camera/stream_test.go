package main

import (
	"bufio"
	"context"
	"image/jpeg"
	"mime"
	"mime/multipart"
	"net"
	"net/http"
	"path/filepath"
	"testing"
	"time"
)

func TestStreamServesJPEGOnlyWhileWatched(t *testing.T) {
	const w, h = 64, 32
	sock := filepath.Join(t.TempDir(), "s.sock")
	s, err := ServeStream(sock, w, h)
	if err != nil {
		t.Fatal(err)
	}

	frame := make([]byte, w*h*2)
	for i := range frame {
		frame[i] = byte(i)
	}
	s.Offer(frame) // nobody watching: must not encode
	time.Sleep(50 * time.Millisecond)
	s.mu.Lock()
	seq := s.seq
	s.mu.Unlock()
	if seq != 0 {
		t.Fatalf("encoded %d frames without a viewer", seq)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	client := http.Client{Transport: &http.Transport{DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, "unix", sock)
	}}}
	req, _ := http.NewRequestWithContext(ctx, "GET", "http://camera/stream", nil)
	go func() { // keep producing like the capture loop
		for ctx.Err() == nil {
			s.Offer(frame)
			time.Sleep(10 * time.Millisecond)
		}
	}()
	resp, err := client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	_, params, err := mime.ParseMediaType(resp.Header.Get("Content-Type"))
	if err != nil {
		t.Fatal(err)
	}
	mr := multipart.NewReader(bufio.NewReader(resp.Body), params["boundary"])
	for i := 0; i < 2; i++ {
		part, err := mr.NextPart()
		if err != nil {
			t.Fatal(err)
		}
		img, err := jpeg.Decode(part)
		if err != nil {
			t.Fatal(err)
		}
		if b := img.Bounds(); b.Dx() != w || b.Dy() != h {
			t.Fatalf("got %v, want %dx%d", b, w, h)
		}
	}
}
