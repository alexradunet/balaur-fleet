package main

import (
	"fmt"
	"math"
	"time"
)

// V4L2 control ids the ov5675 driver exposes on its subdev node.
const (
	cidExposure     = 0x00980911 // V4L2_CID_EXPOSURE, in lines
	cidVBlank       = 0x009e0901 // V4L2_CID_VBLANK
	cidAnalogueGain = 0x009e0903 // V4L2_CID_ANALOGUE_GAIN, minimum = 1x
)

// Controls is the sensor subdev, or a fake in tests.
type Controls interface {
	Range(id uint32) (min, max int32, err error)
	Get(id uint32) (int32, error)
	Set(id uint32, v int32) error
}

// AE is a small auto-exposure loop: exposure time first (rounded to whole
// mains half-cycles so lights don't flicker), then analogue gain.
type AE struct {
	c              Controls
	cfg            *Config
	expMin, expMax int32
	gMin, gMax     int32
	exp, gain      int32
	frameLines     int32
	frames         int
	Disabled       string
}

func NewAE(c Controls, cfg *Config) *AE {
	a := &AE{c: c, cfg: cfg}
	var err error
	if a.expMin, a.expMax, err = c.Range(cidExposure); err != nil {
		a.Disabled = fmt.Sprintf("no exposure control: %v", err)
		return a
	}
	if a.gMin, a.gMax, err = c.Range(cidAnalogueGain); err != nil {
		a.Disabled = fmt.Sprintf("no analogue gain control: %v", err)
		return a
	}
	if a.gMin < 1 {
		a.gMin = 1
	}
	if a.exp, err = c.Get(cidExposure); err != nil {
		a.exp = a.expMax / 2
	}
	if a.gain, err = c.Get(cidAnalogueGain); err != nil {
		a.gain = a.gMin
	}
	a.frameLines = a.expMax + 4
	if vb, err := c.Get(cidVBlank); err == nil {
		a.frameLines = int32(cfg.Height) + vb
	}
	return a
}

func (a *AE) String() string {
	if a.Disabled != "" {
		return "ae off (" + a.Disabled + ")"
	}
	return fmt.Sprintf("exposure %d/%d lines, gain %.2fx", a.exp, a.expMax, float64(a.gain)/float64(a.gMin))
}

// Update runs every few frames (the sensor applies new values with a delay).
// meanY is the raw sensor level (Stats.MeanY), not the processed colour.
func (a *AE) Update(meanY, clipFrac float64, frameDur time.Duration) {
	a.frames++
	if a.Disabled != "" || a.frames%4 != 0 {
		return
	}
	if meanY < 1e-4 {
		meanY = 1e-4
	}
	ratio := a.cfg.AETarget / meanY
	if clipFrac > 0.02 && ratio > 0.85 {
		ratio = 0.85 // highlights blowing out: back off even if the mean looks fine
	}
	if ratio > 0.92 && ratio < 1.08 {
		return
	}
	ratio = math.Pow(math.Max(0.25, math.Min(4, ratio)), 0.7)

	total := float64(a.exp) * float64(a.gain) / float64(a.gMin) * ratio
	lines := math.Max(float64(a.expMin), math.Min(float64(a.expMax), total))
	if a.cfg.AntiFlicker > 0 && frameDur > 0 && a.frameLines > 0 {
		lineTime := frameDur.Seconds() / float64(a.frameLines)
		period := 1 / (2 * float64(a.cfg.AntiFlicker)) / lineTime // lines per light pulse
		if lines >= period {
			lines = math.Floor(lines/period) * period
		}
	}
	lines = math.Max(float64(a.expMin), math.Round(lines))
	gMax := math.Min(float64(a.gMax), a.cfg.MaxGain*float64(a.gMin))
	gain := math.Max(float64(a.gMin), math.Min(gMax, total/lines*float64(a.gMin)))

	if e := int32(lines); e != a.exp && a.c.Set(cidExposure, e) == nil {
		a.exp = e
	}
	if g := int32(math.Round(gain)); g != a.gain && a.c.Set(cidAnalogueGain, g) == nil {
		a.gain = g
	}
}
