package main

// Live view: the processed frames as an MJPEG stream on a Unix socket, which
// the dashboard proxies to the kiosk and to remote browsers alike. Frames are
// only JPEG-encoded while somebody is watching, on their own goroutine, so the
// capture loop (exposure, motion) never waits for a viewer.

import (
	"bytes"
	"context"
	"fmt"
	"image"
	"image/jpeg"
	"log"
	"mime/multipart"
	"net"
	"net/http"
	"net/textproto"
	"os"
	"os/user"
	"strconv"
	"sync"
	"time"
)

const (
	streamFPS     = 15
	streamQuality = 75
)

type Stream struct {
	w, h int

	mu      sync.Mutex
	cond    *sync.Cond
	viewers int
	busy    bool // encoder is working on a frame
	last    time.Time
	img     *image.YCbCr // frame handed to the encoder
	jpg     []byte       // latest encoded frame
	seq     uint64
	pending chan struct{}
}

// ServeStream listens on path (mode 0660, group "video") and serves
// GET /stream (multipart MJPEG) and GET /snapshot.jpg.
func ServeStream(path string, w, h int) (*Stream, error) {
	_ = os.Remove(path)
	ln, err := net.Listen("unix", path)
	if err != nil {
		return nil, err
	}
	if g, err := user.LookupGroup("video"); err == nil {
		if gid, err := strconv.Atoi(g.Gid); err == nil {
			_ = os.Chown(path, -1, gid)
		}
	}
	if err := os.Chmod(path, 0o660); err != nil {
		ln.Close()
		return nil, err
	}
	s := &Stream{w: w, h: h, img: image.NewYCbCr(image.Rect(0, 0, w, h), image.YCbCrSubsampleRatio422), pending: make(chan struct{}, 1)}
	s.cond = sync.NewCond(&s.mu)
	go s.encode()

	mux := http.NewServeMux()
	mux.HandleFunc("GET /stream", s.serveMJPEG)
	mux.HandleFunc("GET /snapshot.jpg", s.serveSnapshot)
	go func() { log.Printf("stream: %v", http.Serve(ln, mux)) }()
	return s, nil
}

func (s *Stream) String() string {
	return fmt.Sprintf("live view %dx%d @ %d fps", s.w, s.h, streamFPS)
}

// Offer hands a YUYV frame to the encoder if someone is watching, the encoder
// is idle and the frame-rate cap allows it. Cheap otherwise.
func (s *Stream) Offer(yuyv []byte) {
	s.mu.Lock()
	if s.viewers == 0 || s.busy || time.Since(s.last) < time.Second/streamFPS {
		s.mu.Unlock()
		return
	}
	s.busy, s.last = true, time.Now()
	s.mu.Unlock()

	// YUYV is 4:2:2 already: split the planes, no colour conversion.
	img := s.img
	for y := 0; y < s.h; y++ {
		row := yuyv[y*s.w*2 : (y+1)*s.w*2]
		yo, co := y*img.YStride, y*img.CStride
		for x := 0; x < s.w/2; x++ {
			p := row[x*4 : x*4+4]
			img.Y[yo+2*x], img.Cb[co+x], img.Y[yo+2*x+1], img.Cr[co+x] = p[0], p[1], p[2], p[3]
		}
	}
	s.pending <- struct{}{}
}

func (s *Stream) encode() {
	var buf bytes.Buffer
	for range s.pending {
		buf.Reset()
		err := jpeg.Encode(&buf, s.img, &jpeg.Options{Quality: streamQuality})
		s.mu.Lock()
		if err == nil {
			s.jpg = append(s.jpg[:0:0], buf.Bytes()...)
			s.seq++
			s.cond.Broadcast()
		}
		s.busy = false
		s.mu.Unlock()
	}
}

// next waits for a frame newer than seq (or the request ending).
func (s *Stream) next(r *http.Request, seq uint64) ([]byte, uint64, bool) {
	stop := context.AfterFunc(r.Context(), func() { s.mu.Lock(); s.cond.Broadcast(); s.mu.Unlock() })
	defer stop()
	s.mu.Lock()
	defer s.mu.Unlock()
	for s.seq == seq && r.Context().Err() == nil {
		s.cond.Wait()
	}
	return s.jpg, s.seq, r.Context().Err() == nil
}

func (s *Stream) watch(d int) {
	s.mu.Lock()
	s.viewers += d
	s.mu.Unlock()
}

func (s *Stream) serveMJPEG(w http.ResponseWriter, r *http.Request) {
	s.watch(1)
	defer s.watch(-1)
	mw := multipart.NewWriter(w)
	w.Header().Set("Content-Type", "multipart/x-mixed-replace; boundary="+mw.Boundary())
	w.Header().Set("Cache-Control", "no-store")
	flush := http.NewResponseController(w)
	var seq uint64
	for {
		jpg, n, ok := s.next(r, seq)
		if !ok {
			return
		}
		seq = n
		part, err := mw.CreatePart(textproto.MIMEHeader{
			"Content-Type":   {"image/jpeg"},
			"Content-Length": {strconv.Itoa(len(jpg))},
		})
		if err == nil {
			_, err = part.Write(jpg)
		}
		if err == nil {
			err = flush.Flush()
		}
		if err != nil {
			return
		}
	}
}

func (s *Stream) serveSnapshot(w http.ResponseWriter, r *http.Request) {
	s.watch(1)
	defer s.watch(-1)
	s.mu.Lock()
	seq := s.seq
	s.mu.Unlock()
	jpg, _, ok := s.next(r, seq)
	if !ok {
		return
	}
	w.Header().Set("Content-Type", "image/jpeg")
	w.Header().Set("Cache-Control", "no-store")
	_, _ = w.Write(jpg)
}
