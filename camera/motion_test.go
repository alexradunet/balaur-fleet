package main

import (
	"math/rand"
	"testing"
)

// yuyvScene fills a w x h YUYV frame: a gradient background scaled by
// `exposure`, sensor-like noise, and an optional bright square at (sx, sy).
func yuyvScene(rng *rand.Rand, w, h int, exposure float64, sx, sy, size int) []byte {
	f := make([]byte, w*h*2)
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			v := (60 + 80*float64(x)/float64(w)) * exposure
			if size > 0 && x >= sx && x < sx+size && y >= sy && y < sy+size {
				v = 230
			}
			v += rng.NormFloat64() * 6
			f[2*(y*w+x)] = clampByte(int32(v))
			f[2*(y*w+x)+1] = 128
		}
	}
	return f
}

func TestMotionIgnoresNoiseAndExposure(t *testing.T) {
	const w, h = 320, 180
	rng := rand.New(rand.NewSource(1))
	m := NewMotion(12, 0.01)
	for i := 0; i < 30; i++ {
		// Auto exposure walking the whole picture up by a third.
		exp := 1 + 0.33*float64(i)/30
		if m.Update(yuyvScene(rng, w, h, exp, 0, 0, 0), w, h) {
			t.Fatalf("frame %d: noise/exposure change reported as movement (peak %.3f)", i, m.Peak())
		}
	}
}

func TestMotionSeesAMovingObject(t *testing.T) {
	const w, h = 320, 180
	rng := rand.New(rand.NewSource(2))
	m := NewMotion(12, 0.01)
	for i := 0; i < 10; i++ {
		m.Update(yuyvScene(rng, w, h, 1, 0, 0, 0), w, h)
	}
	seen := false
	for i := 0; i < 10 && !seen; i++ {
		// A 30 px square (~1.5% of the picture) moving 15 px a frame.
		seen = m.Update(yuyvScene(rng, w, h, 1, 20+15*i, 60, 30), w, h)
	}
	if !seen {
		t.Fatalf("moving object not detected (peak %.3f)", m.Peak())
	}
}

func TestMotionNeedsTwoFrames(t *testing.T) {
	const w, h = 320, 180
	rng := rand.New(rand.NewSource(3))
	m := NewMotion(12, 0.01)
	for i := 0; i < 10; i++ {
		m.Update(yuyvScene(rng, w, h, 1, 0, 0, 0), w, h)
	}
	if m.Update(yuyvScene(rng, w, h, 1, 100, 60, 40), w, h) {
		t.Fatal("a single changed frame already counted as movement")
	}
}
