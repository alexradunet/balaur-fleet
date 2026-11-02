package main

import (
	"fmt"
	"math"
	"strings"
)

type analysis struct {
	text       string
	irX, irY   int // parity of the IR pixels, -1 if unclear
	means      [4][4]float64
	parityMean [2][2]float64
}

// analyzeRaw prints the mean of each position in the 4x4 tile (black level
// removed) and guesses which 2x2 parity holds the IR pixels.
//
// In each 2x2 cell the two greens sit on one diagonal and colour + IR on the
// other. The greens share a filter, so their means match closely; of the
// other two, the IR pixels are the ones whose 4 positions in the tile all
// look alike (colour positions split into a red pair and a blue pair) and
// that are darker under ordinary indoor light.
func analyzeRaw(f *RawFrame, black float64) analysis {
	var a analysis
	var sum [4][4]float64
	var n [4][4]int
	for y := 0; y+3 < f.H; y += 2 {
		for x := 0; x+3 < f.W; x += 2 {
			for dy := 0; dy < 2; dy++ {
				for dx := 0; dx < 2; dx++ {
					py, px := (y+dy)%4, (x+dx)%4
					sum[py][px] += float64(f.Pix[(y+dy)*f.W+x+dx]) - black
					n[py][px]++
				}
			}
		}
	}
	var b strings.Builder
	b.WriteString("Mean of each position in the 4x4 tile (10-bit, black removed):\n")
	for y := 0; y < 4; y++ {
		b.WriteString("   ")
		for x := 0; x < 4; x++ {
			a.means[y][x] = sum[y][x] / math.Max(1, float64(n[y][x]))
			fmt.Fprintf(&b, " %7.1f", a.means[y][x])
		}
		b.WriteString("\n")
	}
	for y := 0; y < 4; y++ {
		for x := 0; x < 4; x++ {
			a.parityMean[y%2][x%2] += a.means[y][x] / 4
		}
	}
	pm := a.parityMean
	rel := func(p, q float64) float64 { return math.Abs(p-q) / math.Max(1e-6, (p+q)/2) }
	// diagonal A: (0,0)+(1,1); diagonal B: (0,1)+(1,0)
	diagA, diagB := rel(pm[0][0], pm[1][1]), rel(pm[0][1], pm[1][0])
	var cands [2][2]int // [i] = {x, y} parity of the non-green diagonal
	if diagA < diagB {
		cands = [2][2]int{{1, 0}, {0, 1}}
	} else {
		cands = [2][2]int{{0, 0}, {1, 1}}
	}
	spread := func(px, py int) float64 {
		lo, hi := math.Inf(1), math.Inf(-1)
		for y := py; y < 4; y += 2 {
			for x := px; x < 4; x += 2 {
				lo, hi = math.Min(lo, a.means[y][x]), math.Max(hi, a.means[y][x])
			}
		}
		return rel(lo, hi)
	}
	fmt.Fprintf(&b, "\nGreens: diagonal (0,0)/(1,1) differ %.0f%%, (1,0)/(0,1) differ %.0f%%.\n", diagA*100, diagB*100)
	s0, s1 := spread(cands[0][0], cands[0][1]), spread(cands[1][0], cands[1][1])
	m0, m1 := pm[cands[0][1]][cands[0][0]], pm[cands[1][1]][cands[1][0]]
	fmt.Fprintf(&b, "Other diagonal: x%d,y%d mean %.1f spread %.0f%%; x%d,y%d mean %.1f spread %.0f%%.\n",
		cands[0][0], cands[0][1], m0, s0*100, cands[1][0], cands[1][1], m1, s1*100)
	pick := 0
	if s1 < s0 {
		pick = 1
	}
	if (s0 < s1) != (m0 < m1) && math.Abs(s0-s1) < 0.05 {
		a.irX, a.irY = -1, -1
		b.WriteString("IR position unclear from this frame (try a scene with strong colours under indoor light).\n")
	} else {
		a.irX, a.irY = cands[pick][0], cands[pick][1]
		fmt.Fprintf(&b, "Likely IR pixels: x%%2==%d, y%%2==%d.\n", a.irX, a.irY)
	}
	if d := math.Max(diagA, diagB); d < 0.08 {
		b.WriteString("Note: all four 2x2 positions look alike, so this may not be an RGB-IR sensor at all\n(or the scene is very dim/grey).\n")
	}
	a.text = b.String()
	return a
}

func (a analysis) matches(c *CFA) bool {
	if a.irX < 0 {
		return false
	}
	return c.Pattern[a.irY*4+a.irX] == 'I'
}
