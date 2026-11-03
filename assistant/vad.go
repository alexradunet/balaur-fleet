package main

// End-of-speech detection by energy: an adaptive noise floor plus a margin.
// Good enough for a quiet room and a person speaking close to the laptop.

import (
	"context"
	"encoding/binary"
	"math"
	"sync"
	"time"
)

func frameRMS(pcm []byte) float64 {
	n := len(pcm) / 2
	if n == 0 {
		return 0
	}
	var sum float64
	for i := 0; i < n; i++ {
		s := float64(int16(binary.LittleEndian.Uint16(pcm[2*i:])))
		sum += s * s
	}
	return math.Sqrt(sum / float64(n))
}

// noiseFloor follows background loudness: it drops quickly and rises slowly,
// so speech does not drag it up but a fan switching on eventually does.
type noiseFloor struct {
	mu sync.Mutex
	v  float64
}

func (f *noiseFloor) update(rms float64) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.v == 0 {
		f.v = rms
	} else if rms < f.v {
		f.v = 0.9*f.v + 0.1*rms
	} else {
		f.v = 0.995*f.v + 0.005*rms
	}
	f.v = math.Max(f.v, 50)
}

func (f *noiseFloor) get() float64 {
	f.mu.Lock()
	defer f.mu.Unlock()
	return math.Max(f.v, 50)
}

// 2.5x the background, and at least +120: a quiet room has a floor near 50.
func speechThreshold(floor float64) float64 { return math.Max(floor*2.5, floor+120) }

type vadConfig struct {
	StartTimeout time.Duration // give up if speech has not started by then
	EndSilence   time.Duration // this much quiet after speech ends the utterance
	MaxLength    time.Duration
}

var defaultVAD = vadConfig{StartTimeout: 5 * time.Second, EndSilence: 900 * time.Millisecond, MaxLength: 12 * time.Second}

const frameDur = 80 * time.Millisecond

// recordUtterance reads frames until the speaker stops. It returns the audio
// (with a little lead-in before speech started) and whether any speech was heard.
// The loudest frame and the threshold are reported for tuning.
func recordUtterance(ctx context.Context, frames <-chan []byte, floor *noiseFloor, cfg vadConfig) (pcm []byte, heard bool, peak, threshold float64) {
	var (
		buf         [][]byte
		started     bool
		loud        int // consecutive loud frames
		quiet       time.Duration
		elapsed     time.Duration
		speechStart int
	)
	th := speechThreshold(floor.get())
	for {
		var f []byte
		select {
		case f = <-frames:
		case <-ctx.Done():
			return nil, false, peak, th
		}
		elapsed += frameDur
		buf = append(buf, f)
		rms := frameRMS(f)
		peak = math.Max(peak, rms)
		if !started {
			if rms > th {
				loud++
				if loud >= 2 { // 160 ms of sound: someone is talking
					started = true
					speechStart = max(0, len(buf)-2-5) // keep 400 ms before it
				}
			} else {
				loud = 0
				floor.update(rms)
				th = speechThreshold(floor.get())
			}
			if !started && elapsed >= cfg.StartTimeout {
				return nil, false, peak, th
			}
			continue
		}
		if rms > th {
			quiet = 0
		} else {
			quiet += frameDur
		}
		if quiet >= cfg.EndSilence || elapsed >= cfg.MaxLength+cfg.StartTimeout || time.Duration(len(buf)-speechStart)*frameDur >= cfg.MaxLength {
			var out []byte
			for _, b := range buf[speechStart:] {
				out = append(out, b...)
			}
			return out, true, peak, th
		}
	}
}
