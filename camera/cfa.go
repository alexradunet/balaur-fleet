package main

import (
	"fmt"
	"strings"
)

// The front sensor is RGB-IR: a 4x4 tile in which every 2x2 cell holds two
// green pixels, one infrared pixel and one red OR blue pixel, with red and
// blue alternating in a checkerboard of cells:
//
//	B G R G
//	G I G I
//	R G B G
//	G I G I
//
// Read as an ordinary 2x2 Bayer grid, "blue" is really infrared and "red" is
// red and blue averaged together, which is the yellow-green tint.

type cellLayout struct {
	colX, colY int // the red or blue pixel
	colCh      int // 0 = red, 2 = blue
	g          [2][2]int
	irX, irY   int
}

// CFA is a parsed 4x4 RGB-IR layout, indexed by cell parity [cy&1][cx&1].
type CFA struct {
	Pattern string
	cells   [2][2]cellLayout
}

const baseCFA = "BGRGGIGIRGBGGIGI"

func normaliseCFA(s string) string {
	return strings.ToUpper(strings.NewReplacer("/", "", " ", "", ",", "").Replace(s))
}

// ParseCFA accepts "BGRG/GIGI/RGBG/GIGI" style layouts.
func ParseCFA(s string) (*CFA, error) {
	p := normaliseCFA(s)
	if len(p) != 16 {
		return nil, fmt.Errorf("cfa %q: want 16 letters (4 rows of R/G/B/I)", s)
	}
	c := &CFA{Pattern: p}
	for py := 0; py < 2; py++ {
		for px := 0; px < 2; px++ {
			var L cellLayout
			ng, ni, nc := 0, 0, 0
			for dy := 0; dy < 2; dy++ {
				for dx := 0; dx < 2; dx++ {
					switch p[(2*py+dy)*4+2*px+dx] {
					case 'G':
						if ng < 2 {
							L.g[ng] = [2]int{dx, dy}
						}
						ng++
					case 'I':
						L.irX, L.irY = dx, dy
						ni++
					case 'R', 'B':
						L.colX, L.colY = dx, dy
						if p[(2*py+dy)*4+2*px+dx] == 'B' {
							L.colCh = 2
						}
						nc++
					default:
						return nil, fmt.Errorf("cfa %q: unknown letter %q", s, p[(2*py+dy)*4+2*px+dx])
					}
				}
			}
			if ng != 2 || ni != 1 || nc != 1 {
				return nil, fmt.Errorf("cfa %q: each 2x2 cell needs two G, one I and one R or B", s)
			}
			c.cells[py][px] = L
		}
	}
	// Missing colours are interpolated from the 4 neighbouring cells, which
	// only works if those carry the other colour.
	k := c.cells
	if k[0][0].colCh == k[0][1].colCh || k[0][0].colCh == k[1][0].colCh || k[0][0].colCh != k[1][1].colCh {
		return nil, fmt.Errorf("cfa %q: red and blue cells must alternate like a checkerboard", s)
	}
	return c, nil
}

// String renders the layout as "BGRG/GIGI/RGBG/GIGI".
func (c *CFA) String() string {
	p := c.Pattern
	return p[0:4] + "/" + p[4:8] + "/" + p[8:12] + "/" + p[12:16]
}

// candidateCFAs lists every distinct alignment of the standard RGB-IR tile
// (8 of the 16 shifts are distinct). Which one the sensor uses depends on its
// crop origin and mounting, so `duet-camera analyze` renders them all.
func candidateCFAs() []*CFA {
	seen := map[string]bool{}
	var out []*CFA
	for dy := 0; dy < 4; dy++ {
		for dx := 0; dx < 4; dx++ {
			b := make([]byte, 16)
			for y := 0; y < 4; y++ {
				for x := 0; x < 4; x++ {
					b[y*4+x] = baseCFA[((y+dy)%4)*4+(x+dx)%4]
				}
			}
			if seen[string(b)] {
				continue
			}
			seen[string(b)] = true
			c, err := ParseCFA(string(b))
			if err != nil {
				panic(err) // shifts of a valid tile are valid
			}
			out = append(out, c)
		}
	}
	return out
}
