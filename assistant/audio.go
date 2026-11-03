package main

// Microphone capture and speaker playback through ALSA's arecord/aplay. There
// is no sound server on the box: this service is the only thing using audio.

import (
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"log"
	"math"
	"os/exec"
	"strconv"
	"sync"
	"time"
)

const (
	micRate = 16000
	// 80 ms of 16 kHz mono 16-bit audio: the frame size openWakeWord works in.
	frameBytes = 1280 * 2
)

// Mic captures 16 kHz mono audio continuously (unless muted) and hands out
// 80 ms frames on Frames.
type Mic struct {
	device string
	Frames chan []byte

	mu     sync.Mutex
	muted  bool
	cancel context.CancelFunc
	change chan struct{}
}

func newMic(device string) *Mic {
	return &Mic{device: device, Frames: make(chan []byte, 64), change: make(chan struct{}, 1)}
}

func (m *Mic) Muted() bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.muted
}

// SetMuted stops capture entirely (the device is closed) or restarts it.
func (m *Mic) SetMuted(muted bool) {
	m.mu.Lock()
	m.muted = muted
	if muted && m.cancel != nil {
		m.cancel()
	}
	m.mu.Unlock()
	select {
	case m.change <- struct{}{}:
	default:
	}
}

func (m *Mic) Run(ctx context.Context) {
	for ctx.Err() == nil {
		if m.Muted() {
			select {
			case <-m.change:
			case <-ctx.Done():
			}
			continue
		}
		cctx, cancel := context.WithCancel(ctx)
		m.mu.Lock()
		m.cancel = cancel
		m.mu.Unlock()
		err := m.capture(cctx)
		cancel()
		if ctx.Err() != nil || m.Muted() {
			continue
		}
		log.Printf("mic: %v (retrying)", err)
		select {
		case <-time.After(2 * time.Second):
		case <-ctx.Done():
		}
	}
}

func (m *Mic) capture(ctx context.Context) error {
	cmd := exec.CommandContext(ctx, "arecord", "-q", "-D", m.device,
		"-t", "raw", "-f", "S16_LE", "-r", strconv.Itoa(micRate), "-c", "1")
	out, err := cmd.StdoutPipe()
	if err != nil {
		return err
	}
	if err := cmd.Start(); err != nil {
		return err
	}
	defer func() { _ = cmd.Wait() }()
	for {
		f := make([]byte, frameBytes)
		if _, err := io.ReadFull(out, f); err != nil {
			if ctx.Err() != nil {
				return nil
			}
			return fmt.Errorf("arecord: %w", err)
		}
		select {
		case m.Frames <- f:
		default: // consumer is behind: drop the oldest frame, keep the newest
			select {
			case <-m.Frames:
			default:
			}
			m.Frames <- f
		}
	}
}

// Player plays PCM through aplay. A new stream replaces nothing: callers
// serialise playback (the pipeline goroutine is the only one that speaks).
type Player struct {
	device string
}

// Play plays everything from src until it closes or ctx ends (which stops the sound at once).
func (p *Player) Play(ctx context.Context, src <-chan PCM) error {
	var first PCM
	var ok bool
	select {
	case first, ok = <-src:
		if !ok {
			return nil
		}
	case <-ctx.Done():
		return ctx.Err()
	}
	cmd := exec.CommandContext(ctx, "aplay", "-q", "-D", p.device,
		"-t", "raw", "-f", "S16_LE", "-r", strconv.Itoa(first.Rate), "-c", strconv.Itoa(first.Channels))
	in, err := cmd.StdinPipe()
	if err != nil {
		return err
	}
	if err := cmd.Start(); err != nil {
		return err
	}
	werr := func() error {
		if _, err := in.Write(first.Data); err != nil {
			return err
		}
		for {
			select {
			case c, ok := <-src:
				if !ok {
					return nil
				}
				if c.Rate != first.Rate || c.Channels != first.Channels {
					return errors.New("audio format changed mid-stream")
				}
				if _, err := in.Write(c.Data); err != nil {
					return err
				}
			case <-ctx.Done():
				return ctx.Err()
			}
		}
	}()
	_ = in.Close()
	err = cmd.Wait()
	if werr != nil {
		return werr
	}
	if ctx.Err() != nil {
		return ctx.Err()
	}
	return err
}

// PlayPCM plays one buffer.
func (p *Player) PlayPCM(ctx context.Context, pcm PCM) error {
	ch := make(chan PCM, 1)
	ch <- pcm
	close(ch)
	return p.Play(ctx, ch)
}

const toneRate = 22050

// tones renders a short sequence of soft sine notes (Hz, ms) for earcons.
func tones(notes ...[2]float64) PCM {
	var out []byte
	for _, n := range notes {
		freq, ms := n[0], n[1]
		samples := int(toneRate * ms / 1000)
		for i := 0; i < samples; i++ {
			// Short fade in/out so the notes don't click.
			env := math.Min(1, math.Min(float64(i), float64(samples-i))/(toneRate*0.01))
			v := 0.0
			if freq > 0 {
				v = 0.25 * env * math.Sin(2*math.Pi*freq*float64(i)/toneRate)
			}
			out = binary.LittleEndian.AppendUint16(out, uint16(int16(v*math.MaxInt16)))
		}
	}
	return PCM{Rate: toneRate, Channels: 1, Data: out}
}

var (
	earconListen = tones([2]float64{660, 70}, [2]float64{990, 110})
	earconDone   = tones([2]float64{990, 70}, [2]float64{660, 110})
	earconError  = tones([2]float64{330, 160}, [2]float64{0, 60}, [2]float64{330, 160})
	earconAlarm  = tones([2]float64{880, 150}, [2]float64{0, 80}, [2]float64{880, 150}, [2]float64{0, 80}, [2]float64{1175, 300}, [2]float64{0, 400})
)

// setVolume sets the speaker volume (0-100) with amixer.
func setVolume(ctx context.Context, card string, percent int) error {
	percent = max(0, min(100, percent))
	args := []string{"-q", "-c", card, "sset", "Master", strconv.Itoa(percent) + "%"}
	if percent == 0 {
		args = append(args, "mute")
	} else {
		args = append(args, "unmute")
	}
	out, err := exec.CommandContext(ctx, "amixer", args...).CombinedOutput()
	if err != nil {
		return fmt.Errorf("amixer: %v: %s", err, out)
	}
	return nil
}
