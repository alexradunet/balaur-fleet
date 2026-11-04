package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
)

// Config is the tuning for the RGB-IR pipeline. Defaults come from
// defaultConfig, then /etc/duet-camera.json (written by NixOS), then the
// optional live-tuning overlay in the state directory (reloaded on SIGHUP).
type Config struct {
	Sensor  string `json:"sensor"`  // media entity name prefix of the sensor
	Capture string `json:"capture"` // exact ISYS capture entity name; "" = pick automatically

	Width     int `json:"width"` // sensor mode (full resolution: binning mixes IR into colour)
	Height    int `json:"height"`
	OutWidth  int `json:"outWidth"` // webcam size, centre-cropped from the half-resolution image
	OutHeight int `json:"outHeight"`

	CFA        string      `json:"cfa"`        // 4x4 colour filter layout, rows separated by '/'
	BlackLevel float64     `json:"blackLevel"` // in 10-bit raw units
	WhiteLevel float64     `json:"whiteLevel"`
	IRCoeffs   [3]float64  `json:"irCoeffs"` // R,G,B -= k * IR
	CCM        [9]float64  `json:"ccm"`      // row-major 3x3, applied after white balance
	AWBGains   *[3]float64 `json:"awbGains"` // fixed gains; null = automatic (grey world)
	Saturation float64     `json:"saturation"`
	FlipH      bool        `json:"flipH"`
	FlipV      bool        `json:"flipV"`
	// "color" (default); "raw" = grey cell mean, no layout/IR/colour processing
	// (shows whether capture and exposure work); "noir" = colour, no IR subtraction.
	View string `json:"view"`

	AETarget float64 `json:"aeTarget"` // mean linear sensor level to aim for
	MaxGain  float64 `json:"maxGain"`  // analogue gain ceiling, in multiples of 1x
	// Software gain ceiling, used only once exposure and analogue gain are maxed out.
	MaxDigitalGain float64 `json:"maxDigitalGain"`
	AntiFlicker    int     `json:"antiFlicker"` // mains frequency in Hz (50/60), 0 = off

	// Movement detection, reported through $DUET_MOTION_FILE.
	MotionThreshold float64 `json:"motionThreshold"` // luma change (of 255) that counts for one cell
	MotionArea      float64 `json:"motionArea"`      // fraction of the picture that must change

	// Frames per second processed while nobody has the webcam open (motion
	// reporting and exposure keep working). 0 = none.
	IdleFPS float64 `json:"idleFps"`
}

func defaultConfig() Config {
	return Config{
		Sensor:    "ov5675",
		Width:     2592,
		Height:    1944,
		OutWidth:  1280,
		OutHeight: 720,
		// Measured on the Duet (tile statistics in the relay log, 2026-11-03):
		// IR at odd columns of even rows. Which of the two colour pixels is red
		// is still to be confirmed by eye; the other choice is GIGI/BGRG/GIGI/RGBG.
		CFA:        "GIGI/RGBG/GIGI/BGRG",
		BlackLevel: 64,
		WhiteLevel: 1023,
		IRCoeffs:   [3]float64{1, 1, 1},
		// The sensor's colour filters overlap a lot (red light also reaches the
		// green and blue pixels), so raw RGB is pale; identity looked nearly
		// grey on the Duet. A typical small-sensor matrix undoes the crosstalk.
		// Rows sum to 1 so white-balanced greys stay grey.
		CCM: [9]float64{
			1.75, -0.55, -0.20,
			-0.35, 1.65, -0.30,
			0.00, -0.70, 1.70,
		},
		Saturation:     1,
		View:           "color",
		AETarget:       0.18,
		MaxGain:        8,
		MaxDigitalGain: 2,
		AntiFlicker:    50,
		// 32x18 grid: 1% is about 6 cells, a hand or a head entering the picture.
		MotionThreshold: 12,
		MotionArea:      0.01,
		IdleFPS:         3,
	}
}

// A variable so tests don't depend on the config of the machine they run on.
var systemConfigPath = "/etc/duet-camera.json"

func stateDir() string {
	if d := os.Getenv("STATE_DIRECTORY"); d != "" {
		return d
	}
	return "/var/lib/duet-camera"
}

func overlayPath() string { return stateDir() + "/tuning.json" }

// loadConfig layers the given files over the defaults; missing files are skipped.
func loadConfig(paths ...string) (Config, error) {
	cfg := defaultConfig()
	for _, p := range paths {
		data, err := os.ReadFile(p)
		if errors.Is(err, fs.ErrNotExist) {
			continue
		}
		if err != nil {
			return cfg, err
		}
		dec := json.NewDecoder(bytes.NewReader(data))
		dec.DisallowUnknownFields()
		if err := dec.Decode(&cfg); err != nil {
			return cfg, fmt.Errorf("%s: %w", p, err)
		}
	}
	return cfg, cfg.validate()
}

func (c *Config) validate() error {
	if _, err := ParseCFA(c.CFA); err != nil {
		return err
	}
	switch {
	case c.View != "color" && c.View != "raw" && c.View != "noir":
		return fmt.Errorf("view %q: want color, raw or noir", c.View)
	case c.Width%4 != 0 || c.Height%4 != 0 || c.Width <= 0 || c.Height <= 0:
		return fmt.Errorf("sensor size %dx%d must be a positive multiple of 4", c.Width, c.Height)
	case c.OutWidth%2 != 0 || c.OutWidth > c.Width/2 || c.OutHeight > c.Height/2 || c.OutWidth <= 0 || c.OutHeight <= 0:
		return fmt.Errorf("output %dx%d must be even and fit in %dx%d", c.OutWidth, c.OutHeight, c.Width/2, c.Height/2)
	case c.WhiteLevel <= c.BlackLevel:
		return fmt.Errorf("whiteLevel %v must be above blackLevel %v", c.WhiteLevel, c.BlackLevel)
	case c.AETarget <= 0 || c.AETarget >= 1:
		return fmt.Errorf("aeTarget %v must be between 0 and 1", c.AETarget)
	case c.MaxGain < 1:
		return fmt.Errorf("maxGain %v must be at least 1", c.MaxGain)
	case c.MaxDigitalGain < 1:
		return fmt.Errorf("maxDigitalGain %v must be at least 1", c.MaxDigitalGain)
	case c.MotionThreshold <= 0:
		return fmt.Errorf("motionThreshold %v must be above 0", c.MotionThreshold)
	case c.IdleFPS < 0 || c.IdleFPS > 30:
		return fmt.Errorf("idleFps %v must be between 0 and 30", c.IdleFPS)
	case c.MotionArea <= 0 || c.MotionArea > 1:
		return fmt.Errorf("motionArea %v must be above 0 and at most 1", c.MotionArea)
	}
	return nil
}
