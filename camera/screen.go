package main

import (
	"encoding/binary"
	"errors"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

// Screen switches the built-in screen's backlight off after a stretch with no
// movement in front of the camera and no touch, and on again at the next one.
//
// While the screen is off, touchscreen and pen are grabbed, so the tap that
// wakes the screen doesn't also press whatever is under the finger. The grab
// ends half a second after the finger lifts. Keyboards are never grabbed:
// Ctrl+Alt+F2 must always reach the console.
//
// The brightness to come back to is also written to restorePath, so the
// service's postStop can light the screen again if this process dies while
// it is off.
type Screen struct {
	dir         string // /sys/class/backlight/<name>
	restorePath string

	mu       sync.Mutex
	timeout  time.Duration
	off      bool
	saved    int
	last     time.Time // last movement, touch or key
	switched time.Time // last off/on
	devs     map[string]*inputDev
	done     chan struct{}
}

type inputDev struct {
	f       *os.File
	name    string
	touch   bool // has absolute axes (touchscreen, pen): grabbed while off
	grabbed bool
	ungrab  *time.Timer
}

const (
	screenSettle = 4 * time.Second // ignore the camera this long after switching: the screen's own light changes the scene
	motionReport = 2 * time.Second // with a desktop: how often movement is reported at most
	touchRelease = 500 * time.Millisecond
	evioCGrab    = 0x40044590 // EVIOCGRAB
	inputEvSize  = 24         // struct input_event on 64-bit
)

func NewScreen(timeout time.Duration, restorePath string) (*Screen, error) {
	dirs, _ := filepath.Glob("/sys/class/backlight/*")
	if len(dirs) == 0 {
		return nil, errors.New("no backlight in /sys/class/backlight")
	}
	now := time.Now()
	s := &Screen{
		dir: dirs[0], restorePath: restorePath, timeout: timeout,
		last: now, switched: now,
		devs: map[string]*inputDev{}, done: make(chan struct{}),
	}
	s.rescan()
	go s.run()
	return s, nil
}

func (s *Screen) String() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	state := "on"
	if s.off {
		state = "off"
	}
	return fmt.Sprintf("screen %s (off after %s idle)", state, s.timeout)
}

// Activity is movement (or a touch/key): keeps the screen on, or wakes it.
func (s *Screen) Activity(src string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.last = time.Now()
	if s.off {
		s.wake(src)
	}
}

// Settling is true just after the screen switched; the motion detector
// should drop its background then.
func (s *Screen) Settling() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return time.Since(s.switched) < screenSettle
}

// SetTimeout changes the idle time (0 = always on) after a tuning reload.
func (s *Screen) SetTimeout(d time.Duration) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.timeout = d
	s.last = time.Now()
	if d <= 0 && s.off {
		s.wake("timeout disabled")
	}
}

// Close lights the screen again and releases the input devices.
func (s *Screen) Close() {
	close(s.done)
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.off {
		s.wake("stopping")
	}
	for p, d := range s.devs {
		s.grab(d, false)
		d.f.Close()
		delete(s.devs, p)
	}
}

func (s *Screen) run() {
	t := time.NewTicker(time.Second)
	defer t.Stop()
	for n := 1; ; n++ {
		select {
		case <-s.done:
			return
		case <-t.C:
		}
		if n%30 == 0 {
			s.rescan() // a keyboard or pen plugged in later
		}
		s.mu.Lock()
		switch {
		case !s.off && s.timeout > 0 && time.Since(s.last) >= s.timeout:
			s.blank()
		case s.off:
			// Someone set a brightness meanwhile (the dashboard slider on
			// another device): the screen is on again.
			if v, err := readSysInt(filepath.Join(s.dir, "brightness")); err == nil && v != 0 {
				s.on("brightness changed")
			}
		}
		s.mu.Unlock()
	}
}

// blank and wake run with s.mu held.
func (s *Screen) blank() {
	path := filepath.Join(s.dir, "brightness")
	cur, err := readSysInt(path)
	if err != nil {
		log.Printf("screen: %v", err)
		s.last = time.Now()
		return
	}
	if cur == 0 { // already dark by other means; nothing to come back to
		s.last = time.Now()
		return
	}
	if s.restorePath != "" {
		if err := os.WriteFile(s.restorePath, []byte(strconv.Itoa(cur)+"\n"), 0o644); err != nil {
			log.Printf("screen: %v", err)
		}
	}
	if err := os.WriteFile(path, []byte("0"), 0o644); err != nil {
		log.Printf("screen off: %v", err)
		s.last = time.Now()
		return
	}
	s.off, s.saved, s.switched = true, cur, time.Now()
	for _, d := range s.devs {
		if d.touch {
			s.grab(d, true)
		}
	}
	log.Printf("screen off: no movement or touch for %s", s.timeout)
}

func (s *Screen) wake(src string) {
	path := filepath.Join(s.dir, "brightness")
	if v, err := readSysInt(path); err == nil && v == 0 {
		if err := os.WriteFile(path, []byte(strconv.Itoa(s.saved)), 0o644); err != nil {
			log.Printf("screen on: %v", err)
		}
	}
	s.on(src)
}

func (s *Screen) on(src string) {
	s.off, s.switched, s.last = false, time.Now(), time.Now()
	if s.restorePath != "" {
		os.Remove(s.restorePath)
	}
	for _, d := range s.devs {
		if d.grabbed {
			// Let go once the waking touch is over (each event pushes this back).
			d.ungrab = time.AfterFunc(touchRelease, func() { s.release(d) })
		}
	}
	log.Printf("screen on (%s)", src)
}

func (s *Screen) release(d *inputDev) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.off {
		s.grab(d, false)
	}
}

func (s *Screen) grab(d *inputDev, on bool) {
	if d.grabbed == on {
		return
	}
	arg := uintptr(0)
	if on {
		arg = 1
	}
	var errno syscall.Errno
	rc, err := d.f.SyscallConn()
	if err == nil {
		err = rc.Control(func(fd uintptr) {
			_, _, errno = syscall.Syscall(syscall.SYS_IOCTL, fd, evioCGrab, arg)
		})
	}
	if err == nil && errno != 0 {
		err = errno
	}
	if err != nil {
		log.Printf("screen: grab %s=%v: %v", d.name, on, err)
		return
	}
	d.grabbed = on
}

// rescan opens input devices not yet watched.
func (s *Screen) rescan() {
	paths, _ := filepath.Glob("/dev/input/event*")
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, p := range paths {
		if _, ok := s.devs[p]; ok {
			continue
		}
		f, err := os.Open(p)
		if err != nil {
			continue
		}
		sys := filepath.Join("/sys/class/input", filepath.Base(p), "device")
		name, _ := os.ReadFile(filepath.Join(sys, "name"))
		abs, _ := os.ReadFile(filepath.Join(sys, "capabilities/abs"))
		d := &inputDev{
			f:     f,
			name:  strings.TrimSpace(string(name)),
			touch: strings.TrimSpace(string(abs)) != "0" && len(abs) > 0,
		}
		s.devs[p] = d
		if s.off && d.touch {
			s.grab(d, true)
		}
		go s.read(p, d)
	}
}

func (s *Screen) read(path string, d *inputDev) {
	buf := make([]byte, inputEvSize*64)
	for {
		n, err := d.f.Read(buf)
		if err != nil {
			s.mu.Lock()
			if s.devs[path] == d {
				delete(s.devs, path)
				d.f.Close()
			}
			s.mu.Unlock()
			return
		}
		for i := 0; i+inputEvSize <= n; i += inputEvSize {
			// EV_KEY, EV_REL, EV_ABS: a key, a mouse, a finger or the pen.
			// (Switches such as the lid or headphone jack are EV_SW.)
			if t := binary.LittleEndian.Uint16(buf[i+16:]); t >= 1 && t <= 3 {
				s.input(d)
				break
			}
		}
	}
}

func (s *Screen) input(d *inputDev) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.last = time.Now()
	if s.off {
		src := "key"
		if d.touch {
			src = "touch"
		}
		s.wake(src)
	}
	if d.grabbed && d.ungrab != nil {
		d.ungrab.Reset(touchRelease)
	}
}

func readSysInt(path string) (int, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return 0, err
	}
	return strconv.Atoi(strings.TrimSpace(string(b)))
}
