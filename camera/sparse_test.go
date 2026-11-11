package main

import (
	"math"
	"testing"
)

// pack10 is the MIPI CSI-2 packed form of a frame (4 pixels in 5 bytes), rows padded to stride.
func pack10(f *RawFrame, stride int) []byte {
	data := make([]byte, stride*f.H)
	for y := 0; y < f.H; y++ {
		for x := 0; x < f.W; x += 4 {
			s := y*stride + x*5/4
			var lsb byte
			for k := 0; k < 4; k++ {
				v := f.Pix[y*f.W+x+k]
				data[s+k] = byte(v >> 2)
				lsb |= byte(v&3) << (2 * k)
			}
			data[s+4] = lsb
		}
	}
	return data
}

// texturedScene has a gradient, coloured patches, a bright lamp and some
// fine texture, so that a sparse sample has something to get wrong.
func texturedScene(cx, cy int) [4]float64 {
	s := [4]float64{0.10 + 0.20*float64(cx)/1296, 0.14 + 0.10*float64(cy)/972, 0.08, 0.05}
	switch {
	case cx > 300 && cx < 500 && cy > 200 && cy < 400:
		s = [4]float64{0.55, 0.20, 0.10, 0.08}
	case cx > 800 && cx < 1000 && cy > 500 && cy < 700:
		s = [4]float64{0.10, 0.25, 0.60, 0.08}
	case cx > 1000 && cx < 1200 && cy > 130 && cy < 300:
		s = [4]float64{1, 1, 1, 0} // clipped (and still within 10 bits)
	}
	if (cx/3+cy/3)%2 == 0 {
		s[0] = math.Min(s[0]*1.05, 1)
		s[1] = math.Min(s[1]*1.05, 1)
	}
	return s
}

func closeTo(t *testing.T, what string, got, want, tol float64) {
	t.Helper()
	if math.Abs(got-want) > tol {
		t.Errorf("%s: sparse %.4f, full %.4f (tolerance %.4f)", what, got, want, tol)
	}
}

// What the idle relay measures from a sparse sample must match what the full
// path measures on the rendered frame: auto exposure, white balance and the
// motion grid steer on it.
func TestSparseSampleMatchesFullPath(t *testing.T) {
	const cfa = "GIGI/RGBG/GIGI/BGRG"
	const w, h, outW, outH = 2592, 1944, 1280, 720
	f := mosaic(cfa, w, h, 1, texturedScene)
	for _, packed := range []bool{false, true} {
		for _, flip := range []bool{false, true} {
			for _, view := range []string{"color", "raw"} {
				cfg := testConfig(cfa)
				cfg.AWBGains = nil
				cfg.FlipH, cfg.FlipV, cfg.View = flip, flip, view
				p, err := NewProcessor(cfg)
				if err != nil {
					t.Fatal(err)
				}
				p.SetDigitalGain(1.5)
				frame := make([]byte, outW*outH*2)
				full := p.Frame(f, outW, outH, frame)
				m := NewMotion(12, 0.01)
				m.Update(frame, outW, outH)

				data, stride := f.Bytes(), w*2
				if packed {
					stride = w*5/4 + 16
					data = pack10(f, stride)
				}
				// Nothing but the sample may be read: start from an empty frame.
				sparse := newRawFrame(w, h)
				grid := make([]float32, motionCols*motionRows)
				got, err := p.Sample(sparse, data, stride, packed, outW, outH, grid)
				if err != nil {
					t.Fatal(err)
				}

				name := map[bool]string{false: "16-bit", true: "packed"}[packed]
				if flip {
					name += " flipped"
				}
				name += " " + view
				closeTo(t, name+" MeanY", got.MeanY(), full.MeanY(), 0.01*full.MeanY()+0.002)
				closeTo(t, name+" MeanG", got.MeanG(), full.MeanG(), 0.02*full.MeanG()+0.002)
				closeTo(t, name+" ClipFrac", got.ClipFrac(), full.ClipFrac(), 0.005)
				if view == "color" {
					a, _ := awbTarget(got)
					b, _ := awbTarget(full)
					for i := range a {
						closeTo(t, name+" awb gain", float64(a[i]), float64(b[i]), 0.03*float64(b[i]))
					}
				}
				// A cell is the mean of its samples, so the cells an edge runs through differ by
				// the sampling (the full path samples a different set); a wrong crop, flip or
				// offset would move every cell.
				var sum float64
				far := 0
				for i := range grid {
					d := math.Abs(float64(grid[i] - m.cur[i]))
					sum += d
					if d > 12 {
						far++
					}
				}
				if mean := sum / float64(len(grid)); mean > 2 || far > len(grid)/30 {
					t.Errorf("%s: motion grid differs by %.2f luma levels on average, %d of %d cells by more than the motion threshold", name, mean, far, len(grid))
				}
			}
		}
	}
}

// Idle and active frames feed the same motion detector: a stationary scene
// must not read as movement, and a new object must.
func TestSparseGridDrivesMotion(t *testing.T) {
	const cfa = "GIGI/RGBG/GIGI/BGRG"
	const w, h, outW, outH = 2592, 1944, 1280, 720
	p, _ := NewProcessor(testConfig(cfa))
	m := NewMotion(12, 0.01)
	grid := make([]float32, motionCols*motionRows)
	raw := newRawFrame(w, h)
	observe := func(scene func(cx, cy int) [4]float64) bool {
		data := mosaic(cfa, w, h, 1, scene).Bytes()
		if _, err := p.Sample(raw, data, w*2, false, outW, outH, grid); err != nil {
			t.Fatal(err)
		}
		return m.UpdateGrid(grid)
	}
	for i := 0; i < 5; i++ {
		if observe(texturedScene) {
			t.Fatalf("frame %d: a still scene reported as movement", i)
		}
	}
	withPerson := func(cx, cy int) [4]float64 {
		if cx > 500 && cx < 700 && cy > 300 && cy < 500 {
			return [4]float64{0.9, 0.5, 0.4, 0.1}
		}
		return texturedScene(cx, cy)
	}
	observe(withPerson)
	if !observe(withPerson) {
		t.Fatalf("an object entering the picture was not seen (peak %.3f)", m.Peak())
	}
}

func TestSampleRejectsShortBuffer(t *testing.T) {
	p, _ := NewProcessor(testConfig("GIGI/RGBG/GIGI/BGRG"))
	f := newRawFrame(64, 48)
	grid := make([]float32, motionCols*motionRows)
	if _, err := p.Sample(f, make([]byte, 100), 128, false, 32, 24, grid); err == nil {
		t.Fatal("a buffer too short for the frame must be an error, not a panic")
	}
}

func BenchmarkSample(b *testing.B) {
	const cfa = "GIGI/RGBG/GIGI/BGRG"
	f := mosaic(cfa, 2592, 1944, 1, texturedScene)
	p, _ := NewProcessor(testConfig(cfa))
	data := f.Bytes()
	raw := newRawFrame(2592, 1944)
	grid := make([]float32, motionCols*motionRows)
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		p.Sample(raw, data, 2592*2, false, 1280, 720, grid)
	}
}
