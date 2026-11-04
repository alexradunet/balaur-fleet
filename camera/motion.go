package main

import (
	"math"
	"time"
)

// Motion is a cheap movement detector on the processed YUYV frames: the
// picture is reduced to a coarse grid of cell brightnesses, and a frame counts
// as movement when enough cells differ from a short-memory background.
//
// The whole frame is scaled to the background's mean first, so auto exposure
// or a lamp switching on doesn't count; only local changes do. Two moving
// frames in a row are needed, so a single noisy frame doesn't count as someone there.
type Motion struct {
	Threshold float64 // luma levels (of 255) a cell must change by
	Area      float64 // fraction of cells that must change

	cols, rows int
	cur, bg    []float32
	ready      bool
	hits       int
	peak       float64 // largest changed fraction since the last Peak()
}

const (
	motionCols  = 32
	motionRows  = 18
	motionAlpha = 0.1 // background memory: ~10 frames, a third of a second
	// How often movement is reported at most: each report rewrites the motion
	// file and restarts the session's idle inhibitor, which needs no more.
	motionReport = 2 * time.Second
)

func NewMotion(threshold, area float64) *Motion {
	return &Motion{
		Threshold: threshold, Area: area,
		cols: motionCols, rows: motionRows,
		cur: make([]float32, motionCols*motionRows),
		bg:  make([]float32, motionCols*motionRows),
	}
}

// Peak returns the largest changed fraction seen since the last call (for the log).
func (m *Motion) Peak() float64 {
	p := m.peak
	m.peak = 0
	return p
}

// Update takes one w x h YUYV frame and reports whether it shows movement.
func (m *Motion) Update(yuyv []byte, w, h int) bool {
	cw, ch := w/m.cols, h/m.rows
	if cw < 1 || ch < 1 || len(yuyv) < w*h*2 {
		return false
	}
	// Every 4th pixel of every 4th row: ~100 samples per cell, a few
	// microseconds per frame.
	var sum float64
	for r := 0; r < m.rows; r++ {
		for c := 0; c < m.cols; c++ {
			var s, n int
			for y := r * ch; y < (r+1)*ch; y += 4 {
				row := yuyv[y*w*2:]
				for x := c * cw; x < (c+1)*cw; x += 4 {
					s += int(row[2*x])
					n++
				}
			}
			v := float32(s) / float32(n)
			m.cur[r*m.cols+c] = v
			sum += float64(v)
		}
	}
	if !m.ready {
		copy(m.bg, m.cur)
		m.ready = true
		return false
	}
	var bgSum float64
	for _, v := range m.bg {
		bgSum += float64(v)
	}
	gain := float32(1)
	if sum > 0 {
		gain = float32(math.Max(0.5, math.Min(2, bgSum/sum)))
	}
	changed := 0
	thr := float32(m.Threshold)
	for i, v := range m.cur {
		v *= gain
		d := v - m.bg[i]
		if d > thr || d < -thr {
			changed++
		}
		m.bg[i] += motionAlpha * (v - m.bg[i])
	}
	frac := float64(changed) / float64(len(m.cur))
	m.peak = math.Max(m.peak, frac)
	if frac >= m.Area {
		m.hits++
	} else {
		m.hits = 0
	}
	return m.hits >= 2
}
