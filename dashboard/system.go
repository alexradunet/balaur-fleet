package main

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

// ---------------------------------------------------------------- sampler

// sampler keeps a running CPU usage figure from /proc/stat deltas.
type sampler struct {
	mu  sync.RWMutex
	cpu float64
}

func newSampler() *sampler { return &sampler{} }

func readCPUTimes() (idle, total uint64, ok bool) {
	f, err := os.Open("/proc/stat")
	if err != nil {
		return 0, 0, false
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	if !sc.Scan() {
		return 0, 0, false
	}
	fields := strings.Fields(sc.Text())
	if len(fields) < 5 || fields[0] != "cpu" {
		return 0, 0, false
	}
	for i, s := range fields[1:] {
		v, err := strconv.ParseUint(s, 10, 64)
		if err != nil {
			return 0, 0, false
		}
		total += v
		if i == 3 || i == 4 { // idle + iowait
			idle += v
		}
	}
	return idle, total, true
}

func (s *sampler) run() {
	pi, pt, _ := readCPUTimes()
	for range time.Tick(2 * time.Second) {
		i, t, ok := readCPUTimes()
		if !ok || t <= pt {
			continue
		}
		usage := 100 * (1 - float64(i-pi)/float64(t-pt))
		pi, pt = i, t
		s.mu.Lock()
		s.cpu = usage
		s.mu.Unlock()
	}
}

func (s *sampler) CPU() float64 {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.cpu
}

// ----------------------------------------------------------------- status

type ServiceStatus struct {
	Service
	State string `json:"state"` // active | inactive | failed | activating | unknown
}

type Disk struct {
	Mount string `json:"mount"`
	Total uint64 `json:"total"`
	Used  uint64 `json:"used"`
}

type Temp struct {
	Name string  `json:"name"`
	C    float64 `json:"c"`
}

type Battery struct {
	Present   bool    `json:"present"`
	Percent   int     `json:"percent"`
	Status    string  `json:"status"` // Charging | Discharging | Full | ...
	OnBattery bool    `json:"onBattery"`
	Watts     float64 `json:"watts"`
}

type Brightness struct {
	Available bool `json:"available"`
	Percent   int  `json:"percent"`
}

type Status struct {
	Hostname      string          `json:"hostname"`
	Time          time.Time       `json:"time"`
	UptimeSec     int64           `json:"uptimeSec"`
	Load          [3]float64      `json:"load"`
	CPU           float64         `json:"cpu"`
	MemTotal      uint64          `json:"memTotal"`
	MemUsed       uint64          `json:"memUsed"`
	Disks         []Disk          `json:"disks"`
	Temps         []Temp          `json:"temps"`
	Battery       Battery         `json:"battery"`
	Brightness    Brightness      `json:"brightness"`
	Services      []ServiceStatus `json:"services"`
	Camera        bool            `json:"camera"`        // this client may watch the live view
	CameraViewers int             `json:"cameraViewers"` // streams open right now (any client)
}

func collectStatus(ctx context.Context, cfg Config, s *sampler) Status {
	st := Status{
		Hostname:   cfg.Hostname,
		Time:       time.Now(),
		CPU:        s.CPU(),
		Disks:      readDisks(),
		Temps:      readTemps(),
		Battery:    readBattery(),
		Brightness: readBrightness(),
		Services:   serviceStates(ctx, cfg.Services),
	}
	st.UptimeSec = readUptime()
	st.Load = readLoad()
	st.MemTotal, st.MemUsed = readMem()
	return st
}

func serviceStates(ctx context.Context, svcs []Service) []ServiceStatus {
	out := make([]ServiceStatus, len(svcs))
	var wg sync.WaitGroup
	for i, svc := range svcs {
		out[i] = ServiceStatus{Service: svc, State: "unknown"}
		if svc.Unit == "" {
			continue
		}
		wg.Add(1)
		go func(i int, unit string) {
			defer wg.Done()
			// `systemctl is-active` exits non-zero for inactive units but
			// still prints the state, so ignore the error.
			b, _ := exec.CommandContext(ctx, "systemctl", "is-active", unit).Output()
			if s := strings.TrimSpace(string(b)); s != "" {
				out[i].State = s
			}
		}(i, svc.Unit)
	}
	wg.Wait()
	return out
}

func readUptime() int64 {
	b, err := os.ReadFile("/proc/uptime")
	if err != nil {
		return 0
	}
	f, _ := strconv.ParseFloat(strings.Fields(string(b))[0], 64)
	return int64(f)
}

func readLoad() (l [3]float64) {
	b, err := os.ReadFile("/proc/loadavg")
	if err != nil {
		return
	}
	for i, s := range strings.Fields(string(b))[:3] {
		l[i], _ = strconv.ParseFloat(s, 64)
	}
	return
}

func readMem() (total, used uint64) {
	f, err := os.Open("/proc/meminfo")
	if err != nil {
		return
	}
	defer f.Close()
	var avail uint64
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		fields := strings.Fields(sc.Text())
		if len(fields) < 2 {
			continue
		}
		v, _ := strconv.ParseUint(fields[1], 10, 64)
		switch fields[0] {
		case "MemTotal:":
			total = v * 1024
		case "MemAvailable:":
			avail = v * 1024
		}
	}
	if total >= avail {
		used = total - avail
	}
	return
}

// readDisks reports the root filesystem plus /srv when it is a separate mount.
func readDisks() []Disk {
	out := []Disk{}
	seen := map[uint64]bool{}
	for _, m := range []string{"/", "/srv"} {
		var s syscall.Statfs_t
		if err := syscall.Statfs(m, &s); err != nil {
			continue
		}
		key := uint64(s.Fsid.X__val[0])<<32 | uint64(uint32(s.Fsid.X__val[1]))
		if seen[key] {
			continue
		}
		seen[key] = true
		total := s.Blocks * uint64(s.Bsize)
		free := s.Bfree * uint64(s.Bsize)
		out = append(out, Disk{Mount: m, Total: total, Used: total - free})
	}
	return out
}

func readTemps() []Temp {
	out := []Temp{}
	zones, _ := filepath.Glob("/sys/class/thermal/thermal_zone*")
	for _, z := range zones {
		t, err := os.ReadFile(filepath.Join(z, "temp"))
		if err != nil {
			continue
		}
		name, _ := os.ReadFile(filepath.Join(z, "type"))
		v, err := strconv.ParseFloat(strings.TrimSpace(string(t)), 64)
		if err != nil {
			continue
		}
		out = append(out, Temp{Name: strings.TrimSpace(string(name)), C: v / 1000})
	}
	return out
}

func readTrim(path string) string {
	b, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(b))
}

func readInt(path string) (int, bool) {
	v, err := strconv.Atoi(readTrim(path))
	return v, err == nil
}

func readBattery() Battery {
	dirs, _ := filepath.Glob("/sys/class/power_supply/*")
	for _, d := range dirs {
		if readTrim(filepath.Join(d, "type")) != "Battery" {
			continue
		}
		b := Battery{Present: true, Status: readTrim(filepath.Join(d, "status"))}
		b.Percent, _ = readInt(filepath.Join(d, "capacity"))
		b.OnBattery = b.Status == "Discharging"
		if p, ok := readInt(filepath.Join(d, "power_now")); ok {
			b.Watts = float64(p) / 1e6
		} else if c, ok := readInt(filepath.Join(d, "current_now")); ok {
			if v, ok := readInt(filepath.Join(d, "voltage_now")); ok {
				b.Watts = float64(c) / 1e6 * float64(v) / 1e6
			}
		}
		return b
	}
	return Battery{}
}

// -------------------------------------------------------------- backlight

var errNoBacklight = errors.New("no controllable backlight")

func backlightDir() string {
	dirs, _ := filepath.Glob("/sys/class/backlight/*")
	if len(dirs) == 0 {
		return ""
	}
	return dirs[0]
}

func readBrightness() Brightness {
	d := backlightDir()
	if d == "" {
		return Brightness{}
	}
	cur, ok1 := readInt(filepath.Join(d, "brightness"))
	max, ok2 := readInt(filepath.Join(d, "max_brightness"))
	if !ok1 || !ok2 || max <= 0 {
		return Brightness{}
	}
	return Brightness{Available: true, Percent: (cur*100 + max/2) / max}
}

func setBrightness(percent int) error {
	d := backlightDir()
	if d == "" {
		return errNoBacklight
	}
	max, ok := readInt(filepath.Join(d, "max_brightness"))
	if !ok || max <= 0 {
		return errNoBacklight
	}
	if percent < 1 { // never allow a fully black screen on a touch-only kiosk
		percent = 1
	}
	if percent > 100 {
		percent = 100
	}
	v := max * percent / 100
	if v < 1 {
		v = 1
	}
	if err := os.WriteFile(filepath.Join(d, "brightness"), []byte(strconv.Itoa(v)), 0o644); err != nil {
		return fmt.Errorf("set brightness: %w", err)
	}
	return nil
}
