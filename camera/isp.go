package main

import (
	"image"
	"image/color"
	"math"
	"runtime"
)

// Processor turns an RGB-IR mosaic into a white-balanced, colour-corrected
// sRGB image at half resolution (one output pixel per 2x2 cell):
//
//	black level -> RGB-IR rebuild -> IR subtraction -> white balance -> CCM
//	-> saturation -> sRGB gamma
//
// These are the steps the Windows driver runs on the IPU's hardware ISP.
type Processor struct {
	cfa          *CFA
	cfg          Config
	black, scale float32
	ir           [3]float32
	ccm          [9]float32
	sat          float32
	gains        [3]float32
	lut          [lutSize]uint8
	rawView      bool
}

const lutSize = 4096

// Stats are gathered on a subsample of each frame, before white balance.
type Stats struct {
	SumR, SumG, SumB float64
	N                int     // unclipped samples
	SumY             float64 // raw cell mean (all 4 pixels): independent of the CFA layout and IR tuning
	Clipped, Total   int
}

func (s *Stats) add(o Stats) {
	s.SumR += o.SumR
	s.SumG += o.SumG
	s.SumB += o.SumB
	s.SumY += o.SumY
	s.N += o.N
	s.Clipped += o.Clipped
	s.Total += o.Total
}

func (s Stats) MeanG() float64 {
	if s.N == 0 {
		return 0
	}
	return s.SumG / float64(s.N)
}

// MeanY is what auto exposure steers on: the plain sensor level, so a wrong
// layout or IR coefficient can't drive exposure to its limits.
func (s Stats) MeanY() float64 {
	if s.Total == 0 {
		return 0
	}
	return s.SumY / float64(s.Total)
}

func (s Stats) ClipFrac() float64 {
	if s.Total == 0 {
		return 0
	}
	return float64(s.Clipped) / float64(s.Total)
}

func NewProcessor(cfg Config) (*Processor, error) {
	p := &Processor{gains: [3]float32{1, 1, 1}}
	for i := range p.lut {
		v := float64(i) / (lutSize - 1)
		if v <= 0.0031308 {
			v *= 12.92
		} else {
			v = 1.055*math.Pow(v, 1/2.4) - 0.055
		}
		p.lut[i] = uint8(math.Round(v * 255))
	}
	return p, p.Reconfigure(cfg)
}

// Reconfigure applies new tuning without losing the white-balance state.
func (p *Processor) Reconfigure(cfg Config) error {
	c, err := ParseCFA(cfg.CFA)
	if err != nil {
		return err
	}
	p.cfa, p.cfg = c, cfg
	p.black = float32(cfg.BlackLevel)
	p.scale = float32(1 / (cfg.WhiteLevel - cfg.BlackLevel))
	for i := range p.ir {
		p.ir[i] = float32(cfg.IRCoeffs[i])
		if cfg.View == "noir" {
			p.ir[i] = 0
		}
	}
	p.rawView = cfg.View == "raw"
	for i := range p.ccm {
		p.ccm[i] = float32(cfg.CCM[i])
	}
	p.sat = float32(cfg.Saturation)
	if cfg.AWBGains != nil {
		for i := range p.gains {
			p.gains[i] = float32(cfg.AWBGains[i])
		}
	}
	return nil
}

func (p *Processor) Gains() [3]float32 { return p.gains }

func (p *Processor) at(f *RawFrame, x, y int) float32 {
	return (float32(f.Pix[y*f.W+x]) - p.black) * p.scale
}

const clipLevel = 0.97

// cellMean is the black-subtracted mean of a cell's four pixels.
func (p *Processor) cellMean(f *RawFrame, cx, cy int) float32 {
	i := 2*cy*f.W + 2*cx
	s := float32(f.Pix[i]) + float32(f.Pix[i+1]) + float32(f.Pix[i+f.W]) + float32(f.Pix[i+f.W+1])
	return (s*0.25 - p.black) * p.scale
}

// shade is one output pixel plus what the statistics need. In the "raw" view
// it is the grey cell mean, untouched by layout, IR, white balance or CCM.
func (p *Processor) shade(f *RawFrame, cx, cy int, st *Stats) (uint8, uint8, uint8) {
	if p.rawView {
		y := p.cellMean(f, cx, cy)
		if st != nil {
			st.sample(y, y, y, y, y >= clipLevel)
		}
		v := p.lut[p.lutIndex(y)]
		return v, v, v
	}
	r, g, b, _, clipped := p.cell(f, cx, cy)
	if st != nil {
		st.sample(r, g, b, p.cellMean(f, cx, cy), clipped)
	}
	return p.finish(r, g, b, clipped)
}

// cell rebuilds linear R, G, B (infrared already subtracted) and IR for one
// 2x2 cell. Green is the mean of the cell's two greens. The cell has red or
// blue; the other one is interpolated as a colour difference from the four
// neighbouring cells, which all carry it.
func (p *Processor) cell(f *RawFrame, cx, cy int) (r, g, b, ir float32, clipped bool) {
	cw, ch := f.W/2, f.H/2
	L := &p.cfa.cells[cy&1][cx&1]
	x0, y0 := 2*cx, 2*cy
	c := p.at(f, x0+L.colX, y0+L.colY)
	g = (p.at(f, x0+L.g[0][0], y0+L.g[0][1]) + p.at(f, x0+L.g[1][0], y0+L.g[1][1])) * 0.5
	ir = p.at(f, x0+L.irX, y0+L.irY)
	clipped = c >= clipLevel || g >= clipLevel

	var diff float32
	for n := 0; n < 4; n++ {
		nx, ny := cx, cy
		switch n {
		case 0:
			nx = cx - 1
		case 1:
			nx = cx + 1
		case 2:
			ny = cy - 1
		case 3:
			ny = cy + 1
		}
		// Reflect at the edges so the neighbour keeps the opposite parity.
		if nx < 0 {
			nx = 1
		} else if nx >= cw {
			nx = cw - 2
		}
		if ny < 0 {
			ny = 1
		} else if ny >= ch {
			ny = ch - 2
		}
		N := &p.cfa.cells[ny&1][nx&1]
		nx0, ny0 := 2*nx, 2*ny
		ng := (p.at(f, nx0+N.g[0][0], ny0+N.g[0][1]) + p.at(f, nx0+N.g[1][0], ny0+N.g[1][1])) * 0.5
		diff += p.at(f, nx0+N.colX, ny0+N.colY) - ng
	}
	other := g + diff*0.25
	if L.colCh == 0 {
		r, b = c, other
	} else {
		r, b = other, c
	}
	r -= p.ir[0] * ir
	g -= p.ir[1] * ir
	b -= p.ir[2] * ir
	return
}

func (p *Processor) lutIndex(v float32) int {
	i := int(v*(lutSize-1) + 0.5)
	if i < 0 {
		return 0
	}
	if i >= lutSize {
		return lutSize - 1
	}
	return i
}

// finish runs white balance, CCM, saturation and gamma on linear RGB.
func (p *Processor) finish(r, g, b float32, clipped bool) (uint8, uint8, uint8) {
	if clipped {
		return 255, 255, 255 // blown highlights stay white instead of turning magenta
	}
	r *= p.gains[0]
	g *= p.gains[1]
	b *= p.gains[2]
	m := &p.ccm
	R := m[0]*r + m[1]*g + m[2]*b
	G := m[3]*r + m[4]*g + m[5]*b
	B := m[6]*r + m[7]*g + m[8]*b
	if p.sat != 1 {
		y := 0.2126*R + 0.7152*G + 0.0722*B
		R = y + p.sat*(R-y)
		G = y + p.sat*(G-y)
		B = y + p.sat*(B-y)
	}
	return p.lut[p.lutIndex(R)], p.lut[p.lutIndex(G)], p.lut[p.lutIndex(B)]
}

func (st *Stats) sample(r, g, b, y float32, clipped bool) {
	st.Total++
	st.SumY += float64(y)
	if clipped {
		st.Clipped++
		return
	}
	st.SumR += float64(r)
	st.SumG += float64(g)
	st.SumB += float64(b)
	st.N++
}

// source maps an output pixel to its cell, centre-cropped and flipped.
func (p *Processor) source(f *RawFrame, outW, outH, x, y int) (int, int) {
	x0, y0 := (f.W/2-outW)/2, (f.H/2-outH)/2
	if p.cfg.FlipH {
		x = outW - 1 - x
	}
	if p.cfg.FlipV {
		y = outH - 1 - y
	}
	return x0 + x, y0 + y
}

// Frame renders the centre crop into YUYV (BT.601, limited range) and returns
// statistics for white balance and exposure.
func (p *Processor) Frame(f *RawFrame, outW, outH int, yuyv []byte) Stats {
	perWorker := make([]Stats, runtime.NumCPU())
	parallel(outH, func(lo, hi, w int) {
		st := &perWorker[w]
		for y := lo; y < hi; y++ {
			row := yuyv[y*outW*2 : (y+1)*outW*2]
			sampleRow := y%4 == 0
			for x := 0; x < outW; x += 2 {
				var rgb [2][3]int32
				for k := 0; k < 2; k++ {
					cx, cy := p.source(f, outW, outH, x+k, y)
					var s *Stats
					if sampleRow && (x+k)%4 == 0 {
						s = st
					}
					R, G, B := p.shade(f, cx, cy, s)
					rgb[k] = [3]int32{int32(R), int32(G), int32(B)}
				}
				y0 := 16 + (66*rgb[0][0]+129*rgb[0][1]+25*rgb[0][2]+128)>>8
				y1 := 16 + (66*rgb[1][0]+129*rgb[1][1]+25*rgb[1][2]+128)>>8
				ar, ag, ab := rgb[0][0]+rgb[1][0], rgb[0][1]+rgb[1][1], rgb[0][2]+rgb[1][2]
				u := 128 + (-38*ar-74*ag+112*ab+256)>>9
				v := 128 + (112*ar-94*ag-18*ab+256)>>9
				row[2*x], row[2*x+1], row[2*x+2], row[2*x+3] = byte(y0), clampByte(u), byte(y1), clampByte(v)
			}
		}
	})
	var total Stats
	for _, s := range perWorker {
		total.add(s)
	}
	return total
}

func clampByte(v int32) byte {
	if v < 0 {
		return 0
	}
	if v > 255 {
		return 255
	}
	return byte(v)
}

// Measure gathers statistics over the whole frame without rendering.
func (p *Processor) Measure(f *RawFrame) Stats {
	cw, ch := f.W/2, f.H/2
	perWorker := make([]Stats, runtime.NumCPU())
	parallel(ch/4, func(lo, hi, w int) {
		for y := lo * 4; y < hi*4; y += 4 {
			for x := 0; x < cw; x += 4 {
				p.shade(f, x, y, &perWorker[w])
			}
		}
	})
	var total Stats
	for _, s := range perWorker {
		total.add(s)
	}
	return total
}

func awbTarget(s Stats) ([3]float32, bool) {
	if s.N == 0 || s.SumR <= 0 || s.SumB <= 0 || s.SumG <= 0 {
		return [3]float32{}, false
	}
	clamp := func(v float64) float32 { return float32(math.Max(0.25, math.Min(4, v))) }
	return [3]float32{clamp(s.SumG / s.SumR), 1, clamp(s.SumG / s.SumB)}, true
}

// UpdateAWB moves the gains a step towards grey world (unless fixed in config).
func (p *Processor) UpdateAWB(s Stats) {
	if p.cfg.AWBGains != nil || p.rawView {
		return
	}
	t, ok := awbTarget(s)
	if !ok {
		return
	}
	for i := range p.gains {
		p.gains[i] += 0.15 * (t[i] - p.gains[i])
	}
}

// SetAWB jumps straight to grey world (one-shot renders).
func (p *Processor) SetAWB(s Stats) {
	if p.cfg.AWBGains != nil {
		return
	}
	if t, ok := awbTarget(s); ok {
		p.gains = t
	}
}

// Image renders the whole half-resolution frame (flips applied, no crop).
func (p *Processor) Image(f *RawFrame) *image.RGBA {
	cw, ch := f.W/2, f.H/2
	img := image.NewRGBA(image.Rect(0, 0, cw, ch))
	parallel(ch, func(lo, hi, _ int) {
		for y := lo; y < hi; y++ {
			for x := 0; x < cw; x++ {
				cx, cy := p.source(f, cw, ch, x, y)
				R, G, B := p.shade(f, cx, cy, nil)
				img.SetRGBA(x, y, color.RGBA{R, G, B, 255})
			}
		}
	})
	return img
}
