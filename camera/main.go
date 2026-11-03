// duet-camera turns the Yoga Duet 7's RGB-IR front sensor into a normal
// webcam: raw frames from the IPU6 capture node, an RGB-IR rebuild with IR
// subtraction, auto white balance, colour correction, gamma and auto exposure
// (the steps the Windows driver runs in the IPU's ISP), then YUYV frames into
// the v4l2loopback device that Chromium opens.
package main

import (
	"flag"
	"fmt"
	"image/png"
	"log"
	"math"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"
)

func usage() {
	fmt.Fprint(os.Stderr, `usage: duet-camera <command> [flags]

  run -output /dev/videoN   stream the processed camera into a v4l2loopback device
  probe                     print the media graphs and the pipeline that run would use
  analyze [flags] FILE      check a raw dump: 4x4 pixel statistics + one PNG per CFA layout

While run is active, SIGUSR1 saves a raw + PNG snapshot to the state directory
and SIGHUP reloads the tuning (`+systemConfigPath+` + `+"$STATE_DIRECTORY"+`/tuning.json).
`)
	os.Exit(2)
}

func main() {
	log.SetFlags(0)
	if len(os.Args) < 2 {
		usage()
	}
	cmd, args := os.Args[1], os.Args[2:]
	var err error
	switch cmd {
	case "run":
		err = cmdRun(args)
	case "probe":
		var cfg Config
		if cfg, err = loadConfig(systemConfigPath, overlayPath()); err == nil {
			err = probe(&cfg)
		}
	case "analyze":
		err = cmdAnalyze(args)
	default:
		usage()
	}
	if err != nil {
		log.Fatalf("duet-camera %s: %v", cmd, err)
	}
}

func cmdRun(args []string) error {
	fs := flag.NewFlagSet("run", flag.ExitOnError)
	output := fs.String("output", "", "v4l2loopback device to write to")
	fs.Parse(args)
	if *output == "" {
		return fmt.Errorf("-output is required")
	}
	cfg, err := loadConfig(systemConfigPath, overlayPath())
	if err != nil {
		return err
	}

	pipe, err := findPipeline(&cfg)
	if err != nil {
		return err
	}
	if err := pipe.Apply(cfg.Width, cfg.Height); err != nil {
		return fmt.Errorf("%s: %w", pipe, err)
	}
	log.Printf("pipeline %s, bus format 0x%x", pipe, pipe.Code)

	capt, err := openCapture(pipe.Video.Devnode, cfg.Width, cfg.Height, pipe.Code)
	if err != nil {
		return err
	}
	defer capt.Close()
	log.Printf("capturing %s %dx%d, %d bytes/row", fourccString(capt.Fourcc), capt.W, capt.H, capt.Stride)

	out, err := openOutput(*output, cfg.OutWidth, cfg.OutHeight)
	if err != nil {
		return err
	}
	defer out.Close()

	sensor, err := openSubdev(pipe.Sensor.Devnode)
	if err != nil {
		return err
	}
	defer sensor.Close()
	ae := NewAE(sensor, &cfg)

	proc, err := NewProcessor(cfg)
	if err != nil {
		return err
	}
	raw := newRawFrame(cfg.Width, cfg.Height)
	frame := make([]byte, cfg.OutWidth*cfg.OutHeight*2)
	log.Printf("cfa %s, ir %v, %s, writing %dx%d YUYV to %s", proc.cfa, cfg.IRCoeffs, ae, cfg.OutWidth, cfg.OutHeight, *output)

	sigs := make(chan os.Signal, 4)
	signal.Notify(sigs, syscall.SIGHUP, syscall.SIGUSR1, syscall.SIGTERM, syscall.SIGINT)

	var lastTs, frameDur time.Duration
	var frames, total int
	var busy time.Duration
	lastLog := time.Now()
	snapshot := false
	for {
		select {
		case s := <-sigs:
			switch s {
			case syscall.SIGHUP:
				if c, err := loadConfig(systemConfigPath, overlayPath()); err != nil {
					log.Printf("reload: %v (keeping the old tuning)", err)
				} else if err := proc.Reconfigure(c); err != nil {
					log.Printf("reload: %v (keeping the old tuning)", err)
				} else {
					cfg = c
					log.Printf("reloaded tuning: view %s, cfa %s, ir %v, ccm %v", cfg.View, proc.cfa, cfg.IRCoeffs, cfg.CCM)
				}
			case syscall.SIGUSR1:
				snapshot = true
			default:
				log.Printf("stopping")
				return nil
			}
		default:
		}

		idx, data, ts, err := capt.Latest(5 * time.Second)
		if err != nil {
			return err
		}
		start := time.Now()
		uerr := raw.Unpack(data, capt.Stride, capt.Packed)
		if err := capt.Requeue(idx); err != nil {
			return err
		}
		if uerr != nil {
			return uerr
		}
		if lastTs > 0 && ts > lastTs {
			d := ts - lastTs
			if frameDur == 0 {
				frameDur = d
			} else {
				frameDur += (d - frameDur) / 8
			}
		}
		lastTs = ts

		st := proc.Frame(raw, cfg.OutWidth, cfg.OutHeight, frame)
		if err := out.Write(frame); err != nil {
			return fmt.Errorf("write %s: %w", *output, err)
		}
		proc.UpdateAWB(st)
		ae.Update(st.MeanY(), st.ClipFrac(), frameDur)
		proc.SetDigitalGain(ae.Digital())
		busy += time.Since(start)
		frames++
		total++
		// Once at the first frame and again when exposure has had ~3 s to settle.
		if total == 1 || total == 90 {
			logDiagnostics(total, raw, proc, &cfg, ae)
		}

		if snapshot {
			snapshot = false
			if err := writeSnapshot(raw, proc); err != nil {
				log.Printf("snapshot: %v", err)
			}
		}
		if since := time.Since(lastLog); since >= 30*time.Second {
			g := proc.Gains()
			log.Printf("%.1f fps (sensor %.1f), %.1f ms/frame, raw level %.3f, green %.3f, clipped %.1f%%, awb %.2f/%.2f/%.2f, %s",
				float64(frames)/since.Seconds(), 1/math.Max(frameDur.Seconds(), 1e-6),
				busy.Seconds()*1000/float64(frames), st.MeanY(), st.MeanG(), st.ClipFrac()*100, g[0], g[1], g[2], ae)
			frames, busy, lastLog = 0, 0, time.Now()
		}
	}
}

// logDiagnostics tells "no signal" (raw level ~0: capture/format/exposure)
// apart from "wrong layout" (IR position in the statistics doesn't match cfa).
func logDiagnostics(n int, raw *RawFrame, proc *Processor, cfg *Config, ae *AE) {
	lo, hi, sum := uint16(0xffff), uint16(0), 0.0
	for _, v := range raw.Pix {
		lo, hi = min(lo, v), max(hi, v)
		sum += float64(v)
	}
	log.Printf("frame %d: raw min %d / mean %.1f / max %d (black %v, white %v), %s, view %s",
		n, lo, sum/float64(len(raw.Pix)), hi, cfg.BlackLevel, cfg.WhiteLevel, ae, cfg.View)
	if float64(hi) <= cfg.BlackLevel+4 {
		log.Printf("frame %d: the sensor delivers no signal (all pixels at or below black level): capture or exposure problem, not colour", n)
		return
	}
	a := analyzeRaw(raw, cfg.BlackLevel)
	for _, line := range strings.Split(strings.TrimRight(a.text, "\n"), "\n") {
		log.Printf("frame %d: %s", n, line)
	}
	if a.irX >= 0 && !a.matches(proc.cfa) {
		var ok []string
		for _, c := range candidateCFAs() {
			if a.matches(c) {
				ok = append(ok, c.String())
			}
		}
		log.Printf("frame %d: WARNING cfa %s puts IR where the statistics see colour; IR subtraction will darken or blacken the image. Candidates: %s (calibrate: docs/SETUP.md Stage 10)",
			n, proc.cfa, strings.Join(ok, " or "))
	}
}

func writeSnapshot(raw *RawFrame, proc *Processor) error {
	dir := filepath.Join(stateDir(), "snapshots")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	base := filepath.Join(dir, fmt.Sprintf("snap-%s-%dx%d", time.Now().Format("20060102-150405"), raw.W, raw.H))
	if err := os.WriteFile(base+".raw16", raw.Bytes(), 0o644); err != nil {
		return err
	}
	if err := writePNG(base+".png", proc, raw); err != nil {
		return err
	}
	g := proc.Gains()
	log.Printf("snapshot %s.{raw16,png} (awb %.2f/%.2f/%.2f)", base, g[0], g[1], g[2])
	return nil
}

func writePNG(path string, proc *Processor, raw *RawFrame) error {
	f, err := os.Create(path)
	if err != nil {
		return err
	}
	if err := png.Encode(f, proc.Image(raw)); err != nil {
		f.Close()
		return err
	}
	return f.Close()
}

func cmdAnalyze(args []string) error {
	fs := flag.NewFlagSet("analyze", flag.ExitOnError)
	w := fs.Int("width", 0, "frame width (default: from the file name, else 2592)")
	h := fs.Int("height", 0, "frame height (default: from the file name, else 1944)")
	format := fs.String("format", "auto", "auto, 16 (16-bit LE) or 10p (MIPI packed)")
	outDir := fs.String("out", "", "directory for the candidate PNGs (default: next to FILE)")
	fs.Parse(args)
	if fs.NArg() != 1 {
		return fmt.Errorf("give exactly one raw file")
	}
	path := fs.Arg(0)
	cfg, err := loadConfig(systemConfigPath, overlayPath())
	if err != nil {
		return err
	}
	raw, desc, err := loadRaw(path, *w, *h, *format)
	if err != nil {
		return err
	}
	fmt.Printf("%s: %s\n\n", path, desc)
	report := analyzeRaw(raw, cfg.BlackLevel)
	fmt.Print(report.text)

	dir := *outDir
	if dir == "" {
		dir = filepath.Dir(path)
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	stem := filepath.Join(dir, filepath.Base(path))
	fmt.Println("\nOne image per CFA layout, auto white balance, your irCoeffs/ccm:")
	for _, c := range candidateCFAs() {
		cc := cfg
		cc.CFA = c.String()
		cc.AWBGains = nil
		proc, err := NewProcessor(cc)
		if err != nil {
			return err
		}
		proc.SetAWB(proc.Measure(raw))
		name := fmt.Sprintf("%s.cfa-%s.png", stem, c.Pattern)
		if err := writePNG(name, proc, raw); err != nil {
			return err
		}
		mark := " "
		if report.matches(c) {
			mark = "*"
		}
		g := proc.Gains()
		fmt.Printf("  %s %s  awb %.2f/%.2f/%.2f  %s\n", mark, c, g[0], g[1], g[2], name)
	}
	fmt.Println("\n* = IR position agrees with the statistics. Pick the image with natural colours")
	fmt.Println("(red things red, blue things blue) and set duet.camera.tuning.cfa to its layout.")
	return nil
}
