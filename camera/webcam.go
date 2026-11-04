package main

// Who needs full-rate frames? The full ISP costs several CPU cores at 30 fps,
// so the relay only runs it at full rate while some program (GNOME's Snapshot,
// a video call) has the webcam open. Otherwise it processes a few frames per
// second: enough for motion reporting and to keep exposure and white balance
// settled, so the picture is right the moment someone looks.

import (
	"os"
	"path/filepath"
	"strconv"
	"time"
)

// webcamWatch reports whether another process has the v4l2loopback device
// open, checked every couple of seconds by scanning /proc (the relay runs as root).
type webcamWatch struct {
	dev     string
	self    string
	checked time.Time
	inUse   bool
}

func newWebcamWatch(dev string) *webcamWatch {
	if p, err := filepath.EvalSymlinks(dev); err == nil {
		dev = p
	}
	return &webcamWatch{dev: dev, self: strconv.Itoa(os.Getpid())}
}

func (w *webcamWatch) InUse() bool {
	if time.Since(w.checked) < 2*time.Second {
		return w.inUse
	}
	w.checked = time.Now()
	w.inUse = deviceOpenElsewhere(w.dev, w.self)
	return w.inUse
}

func deviceOpenElsewhere(dev, self string) bool {
	procs, err := os.ReadDir("/proc")
	if err != nil {
		return true // can't tell: assume someone is watching
	}
	for _, p := range procs {
		pid := p.Name()
		if pid == self || pid[0] < '0' || pid[0] > '9' {
			continue
		}
		fds, err := os.ReadDir("/proc/" + pid + "/fd")
		if err != nil {
			continue
		}
		for _, fd := range fds {
			if t, err := os.Readlink("/proc/" + pid + "/fd/" + fd.Name()); err == nil && t == dev {
				return true
			}
		}
	}
	return false
}
