package main

import (
	"bytes"
	"log"
	"math"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
	"unsafe"
)

// mosaic renders a scene through an RGB-IR filter: colour pixels see their
// colour plus `leak` times the infrared, IR pixels see only the infrared.
func mosaic(cfa string, w, h int, leak float64, scene func(cx, cy int) [4]float64) *RawFrame {
	p := normaliseCFA(cfa)
	f := newRawFrame(w, h)
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			s := scene(x/2, y/2)
			var v float64
			switch p[(y%4)*4+x%4] {
			case 'R':
				v = s[0] + leak*s[3]
			case 'G':
				v = s[1] + leak*s[3]
			case 'B':
				v = s[2] + leak*s[3]
			case 'I':
				v = s[3]
			}
			f.Pix[y*w+x] = uint16(math.Round(64 + v*(1023-64)))
		}
	}
	return f
}

func flat(c [4]float64) func(int, int) [4]float64 { return func(int, int) [4]float64 { return c } }

func testConfig(cfa string) Config {
	c := defaultConfig()
	c.CFA = cfa
	c.AWBGains = &[3]float64{1, 1, 1}
	return c
}

func TestRebuildRecoversColours(t *testing.T) {
	const cfa = "BGRG/GIGI/RGBG/GIGI"
	for _, want := range [][4]float64{
		{0.6, 0.2, 0.1, 0.2}, // red under some IR
		{0.1, 0.2, 0.6, 0.3}, // blue
		{0.1, 0.5, 0.1, 0.0}, // green, no IR
		{0.3, 0.3, 0.3, 0.4}, // grey under strong IR
	} {
		f := mosaic(cfa, 32, 24, 1, flat(want))
		p, err := NewProcessor(testConfig(cfa))
		if err != nil {
			t.Fatal(err)
		}
		for _, c := range [][2]int{{0, 0}, {5, 3}, {15, 11}, {8, 6}} {
			r, g, b, ir, _ := p.cell(f, c[0], c[1])
			got := [4]float64{float64(r), float64(g), float64(b), float64(ir)}
			for i := range got {
				if math.Abs(got[i]-want[i]) > 0.005 {
					t.Errorf("scene %v cell %v: got %.3f", want, c, got)
					break
				}
			}
		}
	}
}

func TestWrongLayoutSwapsRedAndBlue(t *testing.T) {
	f := mosaic("BGRG/GIGI/RGBG/GIGI", 32, 24, 1, flat([4]float64{0.6, 0.2, 0.1, 0.2}))
	p, _ := NewProcessor(testConfig("RGBG/GIGI/BGRG/GIGI"))
	r, _, b, _, _ := p.cell(f, 4, 4)
	if r > b {
		t.Fatalf("a wrong layout should not recover red: r=%.3f b=%.3f", r, b)
	}
}

func TestCandidateCFAs(t *testing.T) {
	cs := candidateCFAs()
	if len(cs) != 8 {
		t.Fatalf("want 8 distinct layouts, got %d", len(cs))
	}
	for _, bad := range []string{"BGRG/GIGI/BGRG/GIGI", "RGGB/RGGB/RGGB/RGGB", "BGRG"} {
		if _, err := ParseCFA(bad); err == nil {
			t.Errorf("%s should be rejected", bad)
		}
	}
}

func TestAnalyzeFindsIR(t *testing.T) {
	for _, c := range candidateCFAs() {
		// Varied colours so red and blue positions differ; IR weaker than visible.
		f := mosaic(c.Pattern, 64, 48, 1, func(cx, cy int) [4]float64 {
			if (cx/8+cy/8)%2 == 0 {
				return [4]float64{0.7, 0.4, 0.15, 0.05}
			}
			return [4]float64{0.2, 0.35, 0.5, 0.05}
		})
		a := analyzeRaw(f, 64)
		if !a.matches(c) {
			t.Errorf("%s: analysis did not find the IR pixels:\n%s", c, a.text)
		}
	}
}

func TestAWBNeutralisesTint(t *testing.T) {
	const cfa = "BGRG/GIGI/RGBG/GIGI"
	f := mosaic(cfa, 64, 48, 1, flat([4]float64{0.2, 0.3, 0.12, 0.1})) // a grey wall under warm light
	cfg := testConfig(cfa)
	cfg.AWBGains = nil
	p, _ := NewProcessor(cfg)
	p.SetAWB(p.Measure(f))
	R, G, B := p.finish(p.cellRGB(f, 10, 10))
	if absDiff(R, G) > 2 || absDiff(B, G) > 2 {
		t.Fatalf("grey should come out grey, got %d,%d,%d", R, G, B)
	}
}

func (p *Processor) cellRGB(f *RawFrame, cx, cy int) (float32, float32, float32, bool) {
	r, g, b, _, c := p.cell(f, cx, cy)
	return r, g, b, c
}

func absDiff(a, b uint8) int {
	if a > b {
		return int(a - b)
	}
	return int(b - a)
}

func TestFrameYUYV(t *testing.T) {
	const cfa = "BGRG/GIGI/RGBG/GIGI"
	f := mosaic(cfa, 2592, 1944, 1, flat([4]float64{0.18, 0.18, 0.18, 0.1}))
	p, _ := NewProcessor(testConfig(cfa))
	out := make([]byte, 1280*720*2)
	st := p.Frame(f, 1280, 720, out)
	if st.N == 0 || math.Abs(st.MeanG()-0.18) > 0.01 {
		t.Fatalf("stats: %+v mean %.3f", st, st.MeanG())
	}
	for i := 0; i < len(out); i += 4 {
		if absDiff(out[i+1], 128) > 1 || absDiff(out[i+3], 128) > 1 {
			t.Fatalf("grey should have neutral chroma, got U=%d V=%d at %d", out[i+1], out[i+3], i)
		}
	}
	// 18% grey -> sRGB ~118 -> limited-range luma ~117
	if out[0] < 110 || out[0] > 125 {
		t.Fatalf("luma %d for 18%% grey", out[0])
	}
}

func TestUnpackPacked(t *testing.T) {
	w, h := 8, 2
	want := []uint16{0, 1, 2, 3, 1023, 512, 511, 700, 5, 6, 7, 8, 9, 10, 11, 12}
	stride := 16 // padded rows
	data := make([]byte, stride*h)
	for y := 0; y < h; y++ {
		for x := 0; x < w; x += 4 {
			s := y*stride + x*5/4
			var lsb byte
			for k := 0; k < 4; k++ {
				v := want[y*w+x+k]
				data[s+k] = byte(v >> 2)
				lsb |= byte(v&3) << (2 * k)
			}
			data[s+4] = lsb
		}
	}
	f := newRawFrame(w, h)
	if err := f.Unpack(data, stride, true); err != nil {
		t.Fatal(err)
	}
	for i := range want {
		if f.Pix[i] != want[i] {
			t.Fatalf("pixel %d: got %d want %d", i, f.Pix[i], want[i])
		}
	}
}

type fakeSensor struct{ exp, gain int32 }

func (s *fakeSensor) Range(id uint32) (int32, int32, error) {
	if id == cidExposure {
		return 4, 2012, nil
	}
	return 128, 2047, nil
}
func (s *fakeSensor) Get(id uint32) (int32, error) {
	switch id {
	case cidExposure:
		return s.exp, nil
	case cidAnalogueGain:
		return s.gain, nil
	}
	return 72, nil // vblank: 1944 + 72 = 2016 lines per frame
}
func (s *fakeSensor) Set(id uint32, v int32) error {
	if id == cidExposure {
		s.exp = v
	} else {
		s.gain = v
	}
	return nil
}

func TestAEBrightensAndAvoidsFlicker(t *testing.T) {
	cfg := defaultConfig()
	s := &fakeSensor{exp: 200, gain: 128}
	ae := NewAE(s, &cfg)
	frame := time.Second / 30
	for i := 0; i < 4; i++ {
		ae.Update(0.02, 0, frame)
	}
	if s.exp <= 200 {
		t.Fatalf("dark scene should lengthen exposure, got %d", s.exp)
	}
	lineTime := frame.Seconds() / 2016
	period := 0.01 / lineTime
	if float64(s.exp) >= period {
		if r := math.Mod(float64(s.exp), period); r > 1 && period-r > 1 {
			t.Fatalf("exposure %d lines is not a multiple of a 10 ms light pulse (%.1f lines)", s.exp, period)
		}
	}
	for i := 0; i < 80; i++ {
		ae.Update(0.9, 0.2, frame)
	}
	if s.gain != 128 {
		t.Fatalf("bright scene should drop gain to 1x first, got %d", s.gain)
	}
}

func TestStructSizes(t *testing.T) {
	for name, got := range map[string]uintptr{
		"v4l2_capability":        unsafe.Sizeof(v4l2Capability{}),
		"v4l2_format":            unsafe.Sizeof(v4l2Format{}),
		"v4l2_pix_format":        unsafe.Sizeof(v4l2PixFormat{}),
		"v4l2_pix_format_mplane": unsafe.Sizeof(v4l2PixFormatMplane{}),
		"v4l2_requestbuffers":    unsafe.Sizeof(v4l2RequestBuffers{}),
		"v4l2_buffer":            unsafe.Sizeof(v4l2Buffer{}),
		"v4l2_plane":             unsafe.Sizeof(v4l2Plane{}),
		"v4l2_control":           unsafe.Sizeof(v4l2Control{}),
		"v4l2_queryctrl":         unsafe.Sizeof(v4l2Queryctrl{}),
		"v4l2_subdev_format":     unsafe.Sizeof(v4l2SubdevFormat{}),
		"media_v2_topology":      unsafe.Sizeof(mediaTopology{}),
		"media_v2_entity":        unsafe.Sizeof(mediaEntity{}),
		"media_v2_interface":     unsafe.Sizeof(mediaInterface{}),
		"media_v2_pad":           unsafe.Sizeof(mediaPad{}),
		"media_v2_link":          unsafe.Sizeof(mediaLink{}),
		"media_link_desc":        unsafe.Sizeof(mediaLinkDesc{}),
	} {
		want := map[string]uintptr{
			"v4l2_capability": 104, "v4l2_format": 208, "v4l2_pix_format": 48,
			"v4l2_pix_format_mplane": 192, "v4l2_requestbuffers": 20, "v4l2_buffer": 88,
			"v4l2_plane": 64, "v4l2_control": 8, "v4l2_queryctrl": 68, "v4l2_subdev_format": 88,
			"media_v2_topology": 72, "media_v2_entity": 96, "media_v2_interface": 112,
			"media_v2_pad": 32, "media_v2_link": 40, "media_link_desc": 52,
		}[name]
		if got != want {
			t.Errorf("%s: %d bytes, kernel has %d", name, got, want)
		}
	}
	// The ioctl numbers encode the struct size in bits 16..29.
	for req, size := range map[uintptr]uintptr{
		vidiocSFmt: 208, vidiocReqbufs: 20, vidiocDqbuf: 88, vidiocQueryctrl: 68,
		vidiocSubdevSFmt: 88, mediaIocGTopology: 72, mediaIocSetupLink: 52, vidiocQuerycap: 104,
	} {
		if (req>>16)&0x3fff != size {
			t.Errorf("ioctl 0x%x encodes size %d, want %d", req, (req>>16)&0x3fff, size)
		}
	}
}

func BenchmarkFrame(b *testing.B) {
	const cfa = "BGRG/GIGI/RGBG/GIGI"
	f := mosaic(cfa, 2592, 1944, 1, func(cx, cy int) [4]float64 {
		return [4]float64{float64(cx%97) / 97, float64(cy%89) / 89, 0.3, 0.1}
	})
	p, _ := NewProcessor(testConfig(cfa))
	out := make([]byte, 1280*720*2)
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		p.Frame(f, 1280, 720, out)
	}
}

func BenchmarkUnpack16(b *testing.B) {
	data := make([]byte, 2592*2*1944)
	f := newRawFrame(2592, 1944)
	for i := 0; i < b.N; i++ {
		f.Unpack(data, 2592*2, false)
	}
}

func TestAnalyzeCommand(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("STATE_DIRECTORY", dir)
	f := mosaic("GIGI/RGBG/GIGI/BGRG", 64, 48, 1, func(cx, cy int) [4]float64 {
		if cx < 16 {
			return [4]float64{0.7, 0.3, 0.1, 0.05}
		}
		return [4]float64{0.1, 0.3, 0.7, 0.05}
	})
	path := dir + "/snap-64x48.raw16"
	if err := os.WriteFile(path, f.Bytes(), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := cmdAnalyze([]string{path}); err != nil {
		t.Fatal(err)
	}
	pngs, _ := filepath.Glob(path + ".cfa-*.png")
	if len(pngs) != 8 {
		t.Fatalf("want 8 candidate images, got %v", pngs)
	}
}

// A wrong layout puts "IR" on bright colour pixels; the subtraction then
// blackens the image. Exposure must still see the real scene level.
func TestMeanYIgnoresLayoutAndIR(t *testing.T) {
	scene := flat([4]float64{0.2, 0.2, 0.2, 0.05})
	f := mosaic("BGRG/GIGI/RGBG/GIGI", 2592, 1944, 1, scene)
	want := (0.2+0.05)*3/4 + 0.05/4 // cell mean: 3 colour pixels with leak + 1 IR pixel
	for _, cfa := range []string{"BGRG/GIGI/RGBG/GIGI", "GIGI/BGRG/GIGI/RGBG", "IGIG/GRGB/IGIG/GBGR"} {
		for _, view := range []string{"color", "raw", "noir"} {
			cfg := testConfig(cfa)
			cfg.View = view
			p, err := NewProcessor(cfg)
			if err != nil {
				t.Fatal(err)
			}
			st := p.Frame(f, 1280, 720, make([]byte, 1280*720*2))
			if math.Abs(st.MeanY()-want) > 0.005 {
				t.Errorf("cfa %s view %s: MeanY %.3f, want %.3f", cfa, view, st.MeanY(), want)
			}
		}
	}
}

func TestRawViewIsGrey(t *testing.T) {
	const cfa = "BGRG/GIGI/RGBG/GIGI"
	f := mosaic(cfa, 2592, 1944, 1, flat([4]float64{0.6, 0.1, 0.05, 0.3})) // strongly coloured
	cfg := testConfig("GIGI/BGRG/GIGI/RGBG")                               // and the wrong layout
	cfg.View = "raw"
	p, _ := NewProcessor(cfg)
	out := make([]byte, 1280*720*2)
	st := p.Frame(f, 1280, 720, out)
	if absDiff(out[1], 128) > 1 || absDiff(out[3], 128) > 1 {
		t.Fatalf("raw view should be grey, U=%d V=%d", out[1], out[3])
	}
	if out[0] < 60 {
		t.Fatalf("raw view should show the scene level %.2f, luma %d", st.MeanY(), out[0])
	}
	cfg.View = "sepia"
	if err := cfg.validate(); err == nil {
		t.Fatal("unknown view should be rejected")
	}
}

func TestNoirViewSkipsIRSubtraction(t *testing.T) {
	const cfa = "BGRG/GIGI/RGBG/GIGI"
	f := mosaic(cfa, 32, 24, 1, flat([4]float64{0.2, 0.2, 0.2, 0.3}))
	cfg := testConfig(cfa)
	cfg.View = "noir"
	p, _ := NewProcessor(cfg)
	_, g, _, _, _ := p.cell(f, 4, 4)
	if math.Abs(float64(g)-0.5) > 0.005 {
		t.Fatalf("noir keeps the IR in green: got %.3f want 0.5", g)
	}
}

func TestDiagnosticsExplainBlack(t *testing.T) {
	var buf bytes.Buffer
	log.SetOutput(&buf)
	defer log.SetOutput(os.Stderr)
	cfg := testConfig("BGRG/GIGI/RGBG/GIGI")
	p, _ := NewProcessor(cfg)
	ae := &AE{Disabled: "test"}

	dark := newRawFrame(64, 48)
	for i := range dark.Pix {
		dark.Pix[i] = 64
	}
	logDiagnostics(1, dark, p, &cfg, ae)
	if !strings.Contains(buf.String(), "no signal") {
		t.Fatalf("an all-black frame should be reported as no signal:\n%s", buf.String())
	}

	buf.Reset()
	f := mosaic("GIGI/RGBG/GIGI/BGRG", 64, 48, 1, func(cx, cy int) [4]float64 {
		if cx < 16 {
			return [4]float64{0.7, 0.3, 0.1, 0.05}
		}
		return [4]float64{0.1, 0.3, 0.7, 0.05}
	})
	logDiagnostics(90, f, p, &cfg, ae)
	if !strings.Contains(buf.String(), "WARNING cfa BGRG/GIGI/RGBG/GIGI") || !strings.Contains(buf.String(), "GIGI/RGBG/GIGI/BGRG") {
		t.Fatalf("a wrong layout should be flagged with the right candidates:\n%s", buf.String())
	}
}
