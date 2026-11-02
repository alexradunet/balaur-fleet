package main

import (
	"bufio"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"syscall"
	"unsafe"
)

// Media controller: find sensor -> (bridges) -> IPU6 CSI2 -> ISYS capture,
// enable the links and set the full-resolution format on every pad. This is
// what libcamera's pipeline handler does before it starts streaming.

const (
	mediaIocGTopology = 0xc0487c04
	mediaIocSetupLink = 0xc0347c03

	mediaLnkFlEnabled   = 1
	mediaLnkFlImmutable = 2
	mediaLnkFlTypeMask  = 0xf << 28
	mediaLnkFlInterface = 1 << 28
	mediaPadFlSource    = 2
	mediaEntFIOV4L      = 0x00010001
)

type mediaTopology struct {
	Version       uint64
	NumEntities   uint32
	_             uint32
	PtrEntities   uint64
	NumInterfaces uint32
	_             uint32
	PtrInterfaces uint64
	NumPads       uint32
	_             uint32
	PtrPads       uint64
	NumLinks      uint32
	_             uint32
	PtrLinks      uint64
}

type mediaEntity struct {
	ID       uint32
	Name     [64]byte
	Function uint32
	Flags    uint32
	_        [5]uint32
}

type mediaInterface struct {
	ID, IntfType, Flags uint32
	_                   [9]uint32
	Major, Minor        uint32
	_                   [14]uint32
}

type mediaPad struct {
	ID, EntityID, Flags, Index uint32
	_                          [4]uint32
}

type mediaLink struct {
	ID, SourceID, SinkID, Flags uint32
	_                           [6]uint32
}

type mediaPadDesc struct {
	Entity uint32
	Index  uint16
	_      uint16
	Flags  uint32
	_      [2]uint32
}

type mediaLinkDesc struct {
	Source, Sink mediaPadDesc
	Flags        uint32
	_            [2]uint32
}

type entity struct {
	ID       uint32
	Name     string
	Function uint32
	Devnode  string
}

type link struct {
	ID         uint32
	Src, Sink  mediaPad // the pads at each end
	Flags      uint32
	SrcEntity  *entity
	SinkEntity *entity
}

type graph struct {
	Path     string
	Entities map[uint32]*entity
	Links    []*link // data links only
}

func readGraph(path string) (*graph, error) {
	fd, err := syscall.Open(path, syscall.O_RDWR|syscall.O_CLOEXEC, 0)
	if err != nil {
		return nil, err
	}
	defer syscall.Close(fd)

	var t mediaTopology
	if err := ioctl(fd, mediaIocGTopology, unsafe.Pointer(&t)); err != nil {
		return nil, fmt.Errorf("%s G_TOPOLOGY: %w", path, err)
	}
	ents := make([]mediaEntity, t.NumEntities+1)
	intfs := make([]mediaInterface, t.NumInterfaces+1)
	pads := make([]mediaPad, t.NumPads+1)
	links := make([]mediaLink, t.NumLinks+1)
	t.PtrEntities = uint64(uintptr(unsafe.Pointer(&ents[0])))
	t.PtrInterfaces = uint64(uintptr(unsafe.Pointer(&intfs[0])))
	t.PtrPads = uint64(uintptr(unsafe.Pointer(&pads[0])))
	t.PtrLinks = uint64(uintptr(unsafe.Pointer(&links[0])))
	err = ioctl(fd, mediaIocGTopology, unsafe.Pointer(&t))
	runtime.KeepAlive(ents)
	runtime.KeepAlive(intfs)
	runtime.KeepAlive(pads)
	runtime.KeepAlive(links)
	if err != nil {
		return nil, fmt.Errorf("%s G_TOPOLOGY: %w", path, err)
	}

	g := &graph{Path: path, Entities: map[uint32]*entity{}}
	for _, e := range ents[:t.NumEntities] {
		g.Entities[e.ID] = &entity{ID: e.ID, Name: cString(e.Name[:]), Function: e.Function}
	}
	intfByID := map[uint32]mediaInterface{}
	for _, i := range intfs[:t.NumInterfaces] {
		intfByID[i.ID] = i
	}
	padByID := map[uint32]mediaPad{}
	for _, p := range pads[:t.NumPads] {
		padByID[p.ID] = p
	}
	for _, l := range links[:t.NumLinks] {
		if l.Flags&mediaLnkFlTypeMask == mediaLnkFlInterface {
			if i, ok := intfByID[l.SourceID]; ok {
				if e := g.Entities[l.SinkID]; e != nil {
					e.Devnode = devnode(i.Major, i.Minor)
				}
			}
			continue
		}
		if l.Flags&mediaLnkFlTypeMask != 0 {
			continue
		}
		src, ok1 := padByID[l.SourceID]
		sink, ok2 := padByID[l.SinkID]
		if !ok1 || !ok2 {
			continue
		}
		g.Links = append(g.Links, &link{ID: l.ID, Src: src, Sink: sink, Flags: l.Flags,
			SrcEntity: g.Entities[src.EntityID], SinkEntity: g.Entities[sink.EntityID]})
	}
	sort.Slice(g.Links, func(a, b int) bool {
		la, lb := g.Links[a], g.Links[b]
		if la.Src.Index != lb.Src.Index {
			return la.Src.Index < lb.Src.Index
		}
		return la.SinkEntity.Name < lb.SinkEntity.Name
	})
	return g, nil
}

func cString(b []byte) string {
	if i := strings.IndexByte(string(b), 0); i >= 0 {
		return string(b[:i])
	}
	return string(b)
}

func devnode(major, minor uint32) string {
	f, err := os.Open(fmt.Sprintf("/sys/dev/char/%d:%d/uevent", major, minor))
	if err != nil {
		return ""
	}
	defer f.Close()
	s := bufio.NewScanner(f)
	for s.Scan() {
		if name, ok := strings.CutPrefix(s.Text(), "DEVNAME="); ok {
			return "/dev/" + name
		}
	}
	return ""
}

func (g *graph) outLinks(e *entity) []*link {
	var out []*link
	for _, l := range g.Links {
		if l.SrcEntity == e && l.Src.Flags&mediaPadFlSource != 0 {
			out = append(out, l)
		}
	}
	return out
}

func (g *graph) setupLink(l *link, enable bool) error {
	fd, err := syscall.Open(g.Path, syscall.O_RDWR|syscall.O_CLOEXEC, 0)
	if err != nil {
		return err
	}
	defer syscall.Close(fd)
	d := mediaLinkDesc{
		Source: mediaPadDesc{Entity: l.Src.EntityID, Index: uint16(l.Src.Index)},
		Sink:   mediaPadDesc{Entity: l.Sink.EntityID, Index: uint16(l.Sink.Index)},
	}
	if enable {
		d.Flags = mediaLnkFlEnabled
	}
	if err := ioctl(fd, mediaIocSetupLink, unsafe.Pointer(&d)); err != nil {
		return fmt.Errorf("enable link %q:%d -> %q:%d: %w", l.SrcEntity.Name, l.Src.Index, l.SinkEntity.Name, l.Sink.Index, err)
	}
	return nil
}

// Pipeline is the chain from the sensor to the capture node.
type Pipeline struct {
	Graph  *graph
	Sensor *entity
	Links  []*link // sensor -> ... -> capture node, in order
	Video  *entity
	Code   uint32
	W, H   int
}

func (p *Pipeline) String() string {
	var b strings.Builder
	fmt.Fprintf(&b, "%s: %q (%s)", p.Graph.Path, p.Sensor.Name, p.Sensor.Devnode)
	for _, l := range p.Links {
		fmt.Fprintf(&b, " -[%d:%d]-> %q", l.Src.Index, l.Sink.Index, l.SinkEntity.Name)
	}
	if p.Video != nil {
		fmt.Fprintf(&b, " (%s)", p.Video.Devnode)
	}
	return b.String()
}

func mediaDevices() []string {
	m, _ := filepath.Glob("/dev/media*")
	sort.Strings(m)
	return m
}

// findPipeline locates the sensor and walks its data links to a capture node.
func findPipeline(cfg *Config) (*Pipeline, error) {
	devs := mediaDevices()
	if len(devs) == 0 {
		return nil, fmt.Errorf("no /dev/media* devices: is the IPU6 driver loaded?")
	}
	for _, dev := range devs {
		g, err := readGraph(dev)
		if err != nil {
			return nil, err
		}
		var sensor *entity
		for _, e := range g.Entities {
			if strings.HasPrefix(strings.ToLower(e.Name), strings.ToLower(cfg.Sensor)) {
				sensor = e
			}
		}
		if sensor == nil {
			continue
		}
		p := &Pipeline{Graph: g, Sensor: sensor}
		cur := sensor
		for depth := 0; depth < 6 && p.Video == nil; depth++ {
			var toVideo, toSubdev []*link
			for _, l := range g.outLinks(cur) {
				if l.SinkEntity.Function == mediaEntFIOV4L {
					if cfg.Capture == "" || l.SinkEntity.Name == cfg.Capture {
						toVideo = append(toVideo, l)
					}
				} else {
					toSubdev = append(toSubdev, l)
				}
			}
			var pick []*link
			if len(toVideo) > 0 {
				pick = toVideo
			} else {
				pick = toSubdev
			}
			if len(pick) == 0 {
				return nil, fmt.Errorf("%s: no way from %q towards a capture node (capture=%q)", dev, cur.Name, cfg.Capture)
			}
			l := pick[0]
			for _, c := range pick { // prefer what is already enabled
				if c.Flags&mediaLnkFlEnabled != 0 {
					l = c
					break
				}
			}
			p.Links = append(p.Links, l)
			if len(toVideo) > 0 {
				p.Video = l.SinkEntity
			}
			cur = l.SinkEntity
		}
		if p.Video == nil || p.Video.Devnode == "" {
			return nil, fmt.Errorf("%s: no capture node found after %q", dev, cur.Name)
		}
		if sensor.Devnode == "" {
			return nil, fmt.Errorf("%s: sensor %q has no subdev node", dev, sensor.Name)
		}
		return p, nil
	}
	return nil, fmt.Errorf("no media entity named %q*: check `duet-camera probe` and the kernel log", cfg.Sensor)
}

// Apply enables the links and propagates the sensor's full-resolution format.
func (p *Pipeline) Apply(w, h int) error {
	for _, l := range p.Links {
		if l.Flags&mediaLnkFlEnabled == 0 {
			if err := p.Graph.setupLink(l, true); err != nil {
				return err
			}
		}
	}
	sensor, err := openSubdev(p.Sensor.Devnode)
	if err != nil {
		return err
	}
	defer sensor.Close()
	srcPad := p.Links[0].Src.Index
	cur, err := sensor.GetFormat(srcPad)
	if err != nil {
		return fmt.Errorf("sensor G_FMT: %w", err)
	}
	cur.Width, cur.Height = uint32(w), uint32(h)
	fmtSet, err := sensor.SetFormat(srcPad, cur)
	if err != nil {
		return fmt.Errorf("sensor S_FMT %dx%d: %w", w, h, err)
	}
	if int(fmtSet.Width) != w || int(fmtSet.Height) != h {
		return fmt.Errorf("sensor offers %dx%d, not %dx%d", fmtSet.Width, fmtSet.Height, w, h)
	}
	p.Code, p.W, p.H = fmtSet.Code, w, h

	// Every subdev between the sensor and the capture node: sink pad gets the
	// sensor format; the source pad normally follows by itself.
	for i, l := range p.Links {
		if l.SinkEntity == p.Video {
			break
		}
		sd, err := openSubdev(l.SinkEntity.Devnode)
		if err != nil {
			return err
		}
		if _, err := sd.SetFormat(l.Sink.Index, fmtSet); err != nil {
			sd.Close()
			return fmt.Errorf("%q pad %d S_FMT: %w", l.SinkEntity.Name, l.Sink.Index, err)
		}
		out := p.Links[i+1].Src.Index
		if got, err := sd.GetFormat(out); err != nil || got.Width != fmtSet.Width || got.Height != fmtSet.Height || got.Code != fmtSet.Code {
			if _, err := sd.SetFormat(out, fmtSet); err != nil {
				sd.Close()
				return fmt.Errorf("%q pad %d S_FMT: %w", l.SinkEntity.Name, out, err)
			}
		}
		sd.Close()
	}
	return nil
}

// probe prints every media graph, for setup and bug reports.
func probe(cfg *Config) error {
	for _, dev := range mediaDevices() {
		g, err := readGraph(dev)
		if err != nil {
			fmt.Println(err)
			continue
		}
		fmt.Printf("%s\n", dev)
		ids := make([]uint32, 0, len(g.Entities))
		for id := range g.Entities {
			ids = append(ids, id)
		}
		sort.Slice(ids, func(a, b int) bool { return ids[a] < ids[b] })
		for _, id := range ids {
			e := g.Entities[id]
			fmt.Printf("  entity %-3d %-40q fn 0x%08x %s\n", e.ID, e.Name, e.Function, e.Devnode)
			for _, l := range g.outLinks(e) {
				state := "off"
				if l.Flags&mediaLnkFlEnabled != 0 {
					state = "on"
				}
				if l.Flags&mediaLnkFlImmutable != 0 {
					state += ",fixed"
				}
				fmt.Printf("      pad %d -> %q pad %d [%s]\n", l.Src.Index, l.SinkEntity.Name, l.Sink.Index, state)
			}
		}
	}
	p, err := findPipeline(cfg)
	if err != nil {
		return err
	}
	fmt.Printf("\npipeline: %s\n", p)
	return nil
}
