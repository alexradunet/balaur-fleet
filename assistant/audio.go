package main

// Microphone capture and speaker playback. Two backends, picked by the device
// name in the config:
//   - "pulse" (or "pulse:<source/sink name>"): the desktop's sound server
//     (PipeWire's PulseAudio interface, at $PULSE_SERVER) through parec/pacat,
//     volume with pactl. Used with the desktop on, since apps share the card.
//   - anything else: an ALSA device through arecord/aplay, volume with amixer,
//     for a box with no sound server where this service is the only audio user.

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
	"strings"
	"sync"
	"sync/atomic"
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

// micStall is how long the microphone may deliver nothing before capture is
// restarted. A sound server restart can leave a recorder connected but with
// no stream, silent rather than failing.
const micStall = 5 * time.Second

func (m *Mic) capture(ctx context.Context) error {
	rctx, stop := context.WithCancel(ctx)
	defer stop()
	var stalled atomic.Bool
	watchdog := time.AfterFunc(micStall, func() { stalled.Store(true); stop() })
	defer watchdog.Stop()

	cmd := recordCmd(rctx, m.device, micRate)
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
			if watchdog.Stop(); stalled.Load() {
				return fmt.Errorf("%s: no audio for %s", cmd.Args[0], micStall)
			}
			return fmt.Errorf("%s: %w", cmd.Args[0], err)
		}
		watchdog.Reset(micStall)
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
	cmd := playCmd(ctx, p.device, first.Rate, first.Channels)
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

// pulseDevice reports whether device names the sound server backend, and
// which source/sink ("" = the server's default).
func pulseDevice(device string) (name string, ok bool) {
	if device == "pulse" {
		return "", true
	}
	return strings.CutPrefix(device, "pulse:")
}

// Both backends move raw signed 16-bit little-endian PCM over stdio.
func recordCmd(ctx context.Context, device string, rate int) *exec.Cmd {
	if name, ok := pulseDevice(device); ok {
		args := []string{"--raw", "--format=s16le", "--rate=" + strconv.Itoa(rate), "--channels=1",
			"--latency-msec=40", "--client-name=Duet assistant", "--stream-name=Wake word"}
		if name != "" {
			args = append(args, "--device="+name)
		}
		return exec.CommandContext(ctx, "parec", args...)
	}
	return exec.CommandContext(ctx, "arecord", "-q", "-D", device,
		"-t", "raw", "-f", "S16_LE", "-r", strconv.Itoa(rate), "-c", "1")
}

func playCmd(ctx context.Context, device string, rate, channels int) *exec.Cmd {
	if name, ok := pulseDevice(device); ok {
		args := []string{"--playback", "--raw", "--format=s16le", "--rate=" + strconv.Itoa(rate),
			"--channels=" + strconv.Itoa(channels), "--client-name=Duet assistant", "--stream-name=Voice"}
		if name != "" {
			args = append(args, "--device="+name)
		}
		return exec.CommandContext(ctx, "pacat", args...)
	}
	return exec.CommandContext(ctx, "aplay", "-q", "-D", device,
		"-t", "raw", "-f", "S16_LE", "-r", strconv.Itoa(rate), "-c", strconv.Itoa(channels))
}

// getVolume reads the sound server's output volume (0-100, 0 when muted).
func getVolume(ctx context.Context, output string) (int, error) {
	name, ok := pulseDevice(output)
	if !ok {
		return 0, errors.New("volume is only read from a sound server")
	}
	if name == "" {
		name = "@DEFAULT_SINK@"
	}
	out, err := exec.CommandContext(ctx, "pactl", "get-sink-mute", name).Output()
	if err != nil {
		return 0, fmt.Errorf("pactl: %w", err)
	}
	if strings.Contains(string(out), "yes") {
		return 0, nil
	}
	out, err = exec.CommandContext(ctx, "pactl", "get-sink-volume", name).Output()
	if err != nil {
		return 0, fmt.Errorf("pactl: %w", err)
	}
	// "Volume: front-left: 45875 /  70% / -9.29 dB, ..."
	for _, f := range strings.Fields(string(out)) {
		if p, ok := strings.CutSuffix(f, "%"); ok {
			if v, err := strconv.Atoi(p); err == nil {
				return min(v, 100), nil
			}
		}
	}
	return 0, fmt.Errorf("pactl: no volume in %q", out)
}

// setVolume sets the speaker volume (0-100): the sound server's output for a
// pulse device, else the ALSA card's Master control.
func setVolume(ctx context.Context, output, card string, percent int) error {
	percent = max(0, min(100, percent))
	if name, ok := pulseDevice(output); ok {
		if name == "" {
			name = "@DEFAULT_SINK@"
		}
		mute := "0"
		if percent == 0 {
			mute = "1"
		}
		for _, args := range [][]string{
			{"set-sink-volume", name, strconv.Itoa(percent) + "%"},
			{"set-sink-mute", name, mute},
		} {
			if out, err := exec.CommandContext(ctx, "pactl", args...).CombinedOutput(); err != nil {
				return fmt.Errorf("pactl: %v: %s", err, out)
			}
		}
		return nil
	}
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
