package main

import (
	"encoding/binary"
	"fmt"
	"os"
	"regexp"
	"runtime"
	"strconv"
	"sync"
)

// RawFrame is a full-resolution 10-bit mosaic, one uint16 per pixel, stride W.
type RawFrame struct {
	W, H int
	Pix  []uint16
}

func newRawFrame(w, h int) *RawFrame { return &RawFrame{W: w, H: h, Pix: make([]uint16, w*h)} }

// parallel splits [0,n) into one stripe per CPU.
func parallel(n int, fn func(lo, hi, worker int)) int {
	workers := runtime.NumCPU()
	if workers > n {
		workers = n
	}
	if workers < 1 {
		workers = 1
	}
	var wg sync.WaitGroup
	for w := 0; w < workers; w++ {
		lo, hi := n*w/workers, n*(w+1)/workers
		wg.Add(1)
		go func(lo, hi, w int) {
			defer wg.Done()
			fn(lo, hi, w)
		}(lo, hi, w)
	}
	wg.Wait()
	return workers
}

// checkBuffer reports whether data holds f's rows at the given stride.
func (f *RawFrame) checkBuffer(data []byte, stride int, packed bool) error {
	rowBytes := f.W * 2
	if packed {
		rowBytes = f.W * 5 / 4
	}
	if stride < rowBytes || len(data) < stride*(f.H-1)+rowBytes {
		return fmt.Errorf("raw buffer too small: %d bytes, stride %d, for %dx%d", len(data), stride, f.W, f.H)
	}
	return nil
}

// Unpack converts a V4L2 buffer: either 16-bit little-endian (one pixel in
// the low 10 bits) or MIPI CSI-2 packed 10-bit (4 pixels in 5 bytes).
func (f *RawFrame) Unpack(data []byte, stride int, packed bool) error {
	if err := f.checkBuffer(data, stride, packed); err != nil {
		return err
	}
	rowBytes := f.W * 2
	if packed {
		rowBytes = f.W * 5 / 4
	}
	parallel(f.H, func(lo, hi, _ int) {
		for y := lo; y < hi; y++ {
			src := data[y*stride : y*stride+rowBytes]
			dst := f.Pix[y*f.W : (y+1)*f.W]
			if packed {
				for x, s := 0, 0; x+3 < f.W; x, s = x+4, s+5 {
					lsb := uint16(src[s+4])
					dst[x] = uint16(src[s])<<2 | lsb&3
					dst[x+1] = uint16(src[s+1])<<2 | (lsb>>2)&3
					dst[x+2] = uint16(src[s+2])<<2 | (lsb>>4)&3
					dst[x+3] = uint16(src[s+3])<<2 | (lsb>>6)&3
				}
			} else {
				for x := range dst {
					dst[x] = binary.LittleEndian.Uint16(src[2*x:]) & 0x3ff
				}
			}
		}
	})
	return nil
}

// Bytes is the headerless 16-bit little-endian dump used for snapshots.
func (f *RawFrame) Bytes() []byte {
	b := make([]byte, len(f.Pix)*2)
	for i, v := range f.Pix {
		binary.LittleEndian.PutUint16(b[2*i:], v)
	}
	return b
}

var sizeInName = regexp.MustCompile(`(\d{2,5})x(\d{2,5})`)

// loadRaw reads a headerless dump (ours, or `cam --file`). The layout is
// worked out from the file size: 16-bit, or packed 10-bit, plus row padding.
func loadRaw(path string, w, h int, format string) (*RawFrame, string, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, "", err
	}
	if w == 0 || h == 0 {
		if m := sizeInName.FindStringSubmatch(path); m != nil {
			w, _ = strconv.Atoi(m[1])
			h, _ = strconv.Atoi(m[2])
		} else {
			w, h = 2592, 1944
		}
	}
	if len(data)%h != 0 {
		return nil, "", fmt.Errorf("%s: %d bytes is not a whole number of %d rows; pass -width/-height", path, len(data), h)
	}
	stride := len(data) / h
	packed := false
	switch format {
	case "16":
	case "10p":
		packed = true
	case "auto":
		switch {
		case stride >= w*2:
		case stride >= w*5/4:
			packed = true
		default:
			return nil, "", fmt.Errorf("%s: %d bytes per row is too small for %d pixels", path, stride, w)
		}
	default:
		return nil, "", fmt.Errorf("unknown format %q (auto, 16, 10p)", format)
	}
	f := newRawFrame(w, h)
	desc := fmt.Sprintf("%dx%d, %d bytes/row, ", w, h, stride)
	if packed {
		desc += "packed 10-bit"
	} else {
		desc += "16-bit"
	}
	return f, desc, f.Unpack(data, stride, packed)
}
