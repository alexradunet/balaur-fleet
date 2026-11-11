package main

import (
	"errors"
	"fmt"
	"syscall"
	"time"
	"unsafe"
)

// Just enough V4L2 for raw capture, subdev controls and a loopback output,
// with the kernel's struct layouts spelled out (amd64; sizes are unit-tested).

func ioctl(fd int, req uintptr, arg unsafe.Pointer) error {
	for {
		_, _, e := syscall.Syscall(syscall.SYS_IOCTL, uintptr(fd), req, uintptr(arg))
		switch e {
		case 0:
			return nil
		case syscall.EINTR:
			continue
		default:
			return e
		}
	}
}

func fourcc(s string) uint32 {
	return uint32(s[0]) | uint32(s[1])<<8 | uint32(s[2])<<16 | uint32(s[3])<<24
}

func fourccString(v uint32) string {
	return string([]byte{byte(v), byte(v >> 8), byte(v >> 16), byte(v >> 24)})
}

const (
	vidiocQuerycap  = 0x80685600
	vidiocGFmt      = 0xc0d05604
	vidiocSFmt      = 0xc0d05605
	vidiocReqbufs   = 0xc0145608
	vidiocQuerybuf  = 0xc0585609
	vidiocQbuf      = 0xc058560f
	vidiocDqbuf     = 0xc0585611
	vidiocStreamon  = 0x40045612
	vidiocStreamoff = 0x40045613
	vidiocGCtrl     = 0xc008561b
	vidiocSCtrl     = 0xc008561c
	vidiocQueryctrl = 0xc0445624

	vidiocSubdevGFmt = 0xc0585604
	vidiocSubdevSFmt = 0xc0585605

	bufTypeCapture = 1
	bufTypeOutput  = 2
	memoryMmap     = 1
	fieldNone      = 1
	colorspaceSRGB = 8

	capVideoCapture       = 0x00000001
	capVideoCaptureMplane = 0x00001000
	capDeviceCaps         = 0x80000000
)

type v4l2Capability struct {
	Driver       [16]byte
	Card         [32]byte
	BusInfo      [32]byte
	Version      uint32
	Capabilities uint32
	DeviceCaps   uint32
	_            [3]uint32
}

type v4l2Format struct {
	Type uint32
	_    uint32 // the union is 8-byte aligned
	Fmt  [200]byte
}

type v4l2PixFormat struct {
	Width, Height, PixelFormat, Field, BytesPerLine, SizeImage, Colorspace, Priv uint32
	Flags, YcbcrEnc, Quantization, XferFunc                                      uint32
}

type v4l2RequestBuffers struct {
	Count, Type, Memory, Capabilities uint32
	Flags                             uint8
	_                                 [3]uint8
}

type v4l2Buffer struct {
	Index, Type, BytesUsed, Flags, Field uint32
	_                                    uint32
	TsSec, TsUsec                        int64
	Timecode                             [16]byte
	Sequence, Memory                     uint32
	M                                    uint64 // mmap offset
	Length                               uint32
	_                                    uint32
	RequestFD                            int32
	_                                    uint32
}

type v4l2Control struct {
	ID    uint32
	Value int32
}

type v4l2Queryctrl struct {
	ID, Type                           uint32
	Name                               [32]byte
	Minimum, Maximum, Step, DefaultVal int32
	Flags                              uint32
	_                                  [2]uint32
}

type v4l2MbusFramefmt struct {
	Width, Height, Code, Field, Colorspace  uint32
	YcbcrEnc, Quantization, XferFunc, Flags uint16
	_                                       [10]uint16
}

type v4l2SubdevFormat struct {
	Which, Pad uint32
	Format     v4l2MbusFramefmt
	Stream     uint32
	_          [7]uint32
}

const subdevFormatActive = 1

// ---- sensor / bridge subdevs ------------------------------------------------

type Subdev struct{ fd int }

func openSubdev(path string) (*Subdev, error) {
	fd, err := syscall.Open(path, syscall.O_RDWR|syscall.O_CLOEXEC, 0)
	if err != nil {
		return nil, fmt.Errorf("open %s: %w", path, err)
	}
	return &Subdev{fd}, nil
}

func (s *Subdev) Close() { syscall.Close(s.fd) }

func (s *Subdev) Range(id uint32) (int32, int32, error) {
	q := v4l2Queryctrl{ID: id}
	if err := ioctl(s.fd, vidiocQueryctrl, unsafe.Pointer(&q)); err != nil {
		return 0, 0, err
	}
	return q.Minimum, q.Maximum, nil
}

func (s *Subdev) Get(id uint32) (int32, error) {
	c := v4l2Control{ID: id}
	err := ioctl(s.fd, vidiocGCtrl, unsafe.Pointer(&c))
	return c.Value, err
}

func (s *Subdev) Set(id uint32, v int32) error {
	c := v4l2Control{ID: id, Value: v}
	return ioctl(s.fd, vidiocSCtrl, unsafe.Pointer(&c))
}

func (s *Subdev) GetFormat(pad uint32) (v4l2MbusFramefmt, error) {
	f := v4l2SubdevFormat{Which: subdevFormatActive, Pad: pad}
	err := ioctl(s.fd, vidiocSubdevGFmt, unsafe.Pointer(&f))
	return f.Format, err
}

func (s *Subdev) SetFormat(pad uint32, m v4l2MbusFramefmt) (v4l2MbusFramefmt, error) {
	f := v4l2SubdevFormat{Which: subdevFormatActive, Pad: pad, Format: m}
	err := ioctl(s.fd, vidiocSubdevSFmt, unsafe.Pointer(&f))
	return f.Format, err
}

// ---- raw capture (IPU6 ISYS video node) -------------------------------------

type Capture struct {
	fd       int
	bufs     [][]byte
	Stride   int
	Packed   bool
	Fourcc   uint32
	W, H     int
	streamed bool
}

// Raw 10-bit pixel formats for each media-bus Bayer code: unpacked, then
// MIPI-packed. The pixel order label doesn't matter to us (the CFA config
// does), it only has to match the link for the ISYS to accept it.
var rawFourccs = map[uint32][2]string{
	0x3007: {"BG10", "pBAA"}, // SBGGR10_1X10
	0x300e: {"GB10", "pGAA"}, // SGBRG10_1X10
	0x300a: {"BA10", "pgAA"}, // SGRBG10_1X10
	0x300f: {"RG10", "pRAA"}, // SRGGB10_1X10
}

// openCapture tries the unpacked then the packed format until streaming starts.
func openCapture(path string, w, h int, code uint32) (*Capture, error) {
	names, ok := rawFourccs[code]
	if !ok {
		return nil, fmt.Errorf("sensor bus format 0x%x is not a 10-bit Bayer code", code)
	}
	var errs []error
	for i, name := range names {
		c, err := tryCapture(path, w, h, fourcc(name), i == 1)
		if err == nil {
			return c, nil
		}
		errs = append(errs, fmt.Errorf("%s: %w", name, err))
	}
	return nil, fmt.Errorf("capture %s: %w", path, errors.Join(errs...))
}

func tryCapture(path string, w, h int, pixfmt uint32, packed bool) (*Capture, error) {
	fd, err := syscall.Open(path, syscall.O_RDWR|syscall.O_NONBLOCK|syscall.O_CLOEXEC, 0)
	if err != nil {
		return nil, err
	}
	c := &Capture{fd: fd, W: w, H: h, Packed: packed, Fourcc: pixfmt}
	if err := c.setup(w, h, pixfmt); err != nil {
		c.Close()
		return nil, err
	}
	return c, nil
}

func (c *Capture) setup(w, h int, pixfmt uint32) error {
	var cp v4l2Capability
	if err := ioctl(c.fd, vidiocQuerycap, unsafe.Pointer(&cp)); err != nil {
		return fmt.Errorf("QUERYCAP: %w", err)
	}
	caps := cp.Capabilities
	if caps&capDeviceCaps != 0 {
		caps = cp.DeviceCaps
	}
	// The IPU6 capture nodes are single-plane; the multi-plane API is not implemented.
	switch {
	case caps&capVideoCapture != 0:
	case caps&capVideoCaptureMplane != 0:
		return fmt.Errorf("multi-plane capture device (caps 0x%x) is not supported", caps)
	default:
		return fmt.Errorf("not a capture device (caps 0x%x)", caps)
	}

	f := v4l2Format{Type: bufTypeCapture}
	pf := (*v4l2PixFormat)(unsafe.Pointer(&f.Fmt[0]))
	pf.Width, pf.Height, pf.PixelFormat, pf.Field = uint32(w), uint32(h), pixfmt, fieldNone
	if err := ioctl(c.fd, vidiocSFmt, unsafe.Pointer(&f)); err != nil {
		return fmt.Errorf("S_FMT: %w", err)
	}
	c.Stride = int(pf.BytesPerLine)
	if pf.PixelFormat != pixfmt || int(pf.Width) != w || int(pf.Height) != h {
		return fmt.Errorf("driver chose %s %dx%d", fourccString(pf.PixelFormat), pf.Width, pf.Height)
	}

	rb := v4l2RequestBuffers{Count: 4, Type: bufTypeCapture, Memory: memoryMmap}
	if err := ioctl(c.fd, vidiocReqbufs, unsafe.Pointer(&rb)); err != nil {
		return fmt.Errorf("REQBUFS: %w", err)
	}
	if rb.Count < 2 {
		return fmt.Errorf("only %d buffers", rb.Count)
	}
	for i := uint32(0); i < rb.Count; i++ {
		b := v4l2Buffer{Index: i, Type: bufTypeCapture, Memory: memoryMmap}
		if err := ioctl(c.fd, vidiocQuerybuf, unsafe.Pointer(&b)); err != nil {
			return fmt.Errorf("QUERYBUF: %w", err)
		}
		mem, err := syscall.Mmap(c.fd, int64(b.M), int(b.Length), syscall.PROT_READ|syscall.PROT_WRITE, syscall.MAP_SHARED)
		if err != nil {
			return fmt.Errorf("mmap: %w", err)
		}
		c.bufs = append(c.bufs, mem)
		if err := c.queue(i); err != nil {
			return err
		}
	}
	t := uint32(bufTypeCapture)
	if err := ioctl(c.fd, vidiocStreamon, unsafe.Pointer(&t)); err != nil {
		return fmt.Errorf("STREAMON: %w", err)
	}
	c.streamed = true
	return nil
}

func (c *Capture) queue(i uint32) error {
	b := v4l2Buffer{Index: i, Type: bufTypeCapture, Memory: memoryMmap}
	if err := ioctl(c.fd, vidiocQbuf, unsafe.Pointer(&b)); err != nil {
		return fmt.Errorf("QBUF: %w", err)
	}
	return nil
}

// dequeue takes the oldest filled buffer: its index, the bytes used, the
// capture time and the driver's frame counter.
func (c *Capture) dequeue() (idx uint32, used int, ts time.Duration, seq uint32, err error) {
	b := v4l2Buffer{Type: bufTypeCapture, Memory: memoryMmap}
	if err = ioctl(c.fd, vidiocDqbuf, unsafe.Pointer(&b)); err != nil {
		return
	}
	used = int(b.BytesUsed)
	if used == 0 || used > len(c.bufs[b.Index]) {
		used = len(c.bufs[b.Index])
	}
	return b.Index, used, time.Duration(b.TsSec)*time.Second + time.Duration(b.TsUsec)*time.Microsecond, b.Sequence, nil
}

type pollFd struct {
	Fd      int32
	Events  int16
	Revents int16
}

func waitReadable(fd int, timeout time.Duration) error {
	p := pollFd{Fd: int32(fd), Events: 1} // POLLIN
	ts := syscall.NsecToTimespec(timeout.Nanoseconds())
	for {
		n, _, e := syscall.Syscall6(syscall.SYS_PPOLL, uintptr(unsafe.Pointer(&p)), 1, uintptr(unsafe.Pointer(&ts)), 0, 0, 0)
		if e == syscall.EINTR {
			continue
		}
		if e != 0 {
			return e
		}
		if n == 0 {
			return fmt.Errorf("no frame within %v", timeout)
		}
		return nil
	}
}

// Latest waits for a frame and returns the newest one, requeueing any older
// ones, so a slow consumer never adds latency. seq is the driver's frame
// counter: it jumps by more than one when older frames were skipped.
func (c *Capture) Latest(timeout time.Duration) (idx uint32, data []byte, ts time.Duration, seq uint32, err error) {
	for {
		if err := waitReadable(c.fd, timeout); err != nil {
			return 0, nil, 0, 0, err
		}
		idx, used, ts, seq, err := c.dequeue()
		if err == syscall.EAGAIN {
			continue
		}
		if err != nil {
			return 0, nil, 0, 0, fmt.Errorf("DQBUF: %w", err)
		}
		for {
			i2, u2, t2, s2, err := c.dequeue()
			if err == syscall.EAGAIN {
				break
			}
			if err != nil {
				return 0, nil, 0, 0, fmt.Errorf("DQBUF: %w", err)
			}
			if err := c.queue(idx); err != nil {
				return 0, nil, 0, 0, err
			}
			idx, used, ts, seq = i2, u2, t2, s2
		}
		return idx, c.bufs[idx][:used], ts, seq, nil
	}
}

func (c *Capture) Requeue(idx uint32) error { return c.queue(idx) }

func (c *Capture) Close() {
	if c.streamed {
		t := uint32(bufTypeCapture)
		ioctl(c.fd, vidiocStreamoff, unsafe.Pointer(&t))
	}
	for _, b := range c.bufs {
		syscall.Munmap(b)
	}
	syscall.Close(c.fd)
}

// ---- v4l2loopback output ------------------------------------------------------

type Output struct{ fd int }

func openOutput(path string, w, h int) (*Output, error) {
	fd, err := syscall.Open(path, syscall.O_RDWR|syscall.O_CLOEXEC, 0)
	if err != nil {
		return nil, fmt.Errorf("open %s: %w", path, err)
	}
	f := v4l2Format{Type: bufTypeOutput}
	pf := (*v4l2PixFormat)(unsafe.Pointer(&f.Fmt[0]))
	pf.Width, pf.Height, pf.PixelFormat, pf.Field = uint32(w), uint32(h), fourcc("YUYV"), fieldNone
	pf.BytesPerLine, pf.SizeImage, pf.Colorspace = uint32(w*2), uint32(w*h*2), colorspaceSRGB
	if err := ioctl(fd, vidiocSFmt, unsafe.Pointer(&f)); err != nil {
		syscall.Close(fd)
		return nil, fmt.Errorf("%s S_FMT YUYV %dx%d: %w", path, w, h, err)
	}
	// S_FMT hands back what the driver accepted; frames of another size or format would be garbled.
	if err := checkOutputFormat(pf, w, h); err != nil {
		syscall.Close(fd)
		return nil, fmt.Errorf("%s: %w", path, err)
	}
	return &Output{fd}, nil
}

func checkOutputFormat(pf *v4l2PixFormat, w, h int) error {
	if pf.PixelFormat != fourcc("YUYV") || int(pf.Width) != w || int(pf.Height) != h {
		return fmt.Errorf("driver chose %s %dx%d, want YUYV %dx%d", fourccString(pf.PixelFormat), pf.Width, pf.Height, w, h)
	}
	return nil
}

func (o *Output) Write(frame []byte) error {
	for len(frame) > 0 {
		n, err := syscall.Write(o.fd, frame)
		if err == syscall.EINTR {
			continue
		}
		if err != nil {
			return err
		}
		frame = frame[n:]
	}
	return nil
}

func (o *Output) Close() { syscall.Close(o.fd) }
