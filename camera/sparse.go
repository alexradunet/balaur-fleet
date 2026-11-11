package main

import (
	"encoding/binary"
	"fmt"
)

// With nobody watching the webcam, the relay needs only the motion grid and the
// exposure and white-balance statistics, not a picture. Sample gathers both
// from a few thousand cells of the raw buffer, unpacking only those cells (and
// the neighbours the colour rebuild reads), where the full path unpacks all
// 5 million pixels and renders 0.9 million. It runs single-threaded and
// leaves the rest of the RawFrame as it was.

// sampleN is the number of samples along each side of a motion grid cell.
const sampleN = 4

// lattice moves an output coordinate to the nearest multiple of 4: Frame's
// statistics are gathered on that lattice, which, with the filter's period,
// sees one kind of cell (red- or blue-centred, depending on the crop and flip).
// Sampling the same cells keeps the idle measurements equal to the active ones
// on a scene whose red and blue differ.
func lattice(v int) int { return (v + 2) &^ 3 }

// unpackPixel writes pixel (x, y) of a V4L2 buffer into f.Pix.
func (f *RawFrame) unpackPixel(data []byte, stride int, packed bool, x, y int) {
	row := data[y*stride:]
	if !packed {
		f.Pix[y*f.W+x] = binary.LittleEndian.Uint16(row[2*x:]) & 0x3ff
		return
	}
	s, i := x/4*5, x&3
	f.Pix[y*f.W+x] = uint16(row[s+i])<<2 | uint16(row[s+4]>>(2*i))&3
}

// unpackCell writes the 2x2 pixels of cell (cx, cy).
func (f *RawFrame) unpackCell(data []byte, stride int, packed bool, cx, cy int) {
	for y := 2 * cy; y < 2*cy+2; y++ {
		for x := 2 * cx; x < 2*cx+2; x++ {
			f.unpackPixel(data, stride, packed, x, y)
		}
	}
}

// Sample returns what Frame's statistics would be for the buffer, and fills
// grid (motionCols x motionRows) with the mean luma of each grid cell of the
// output picture, as Motion would measure it on the rendered frame.
func (p *Processor) Sample(f *RawFrame, data []byte, stride int, packed bool, outW, outH int, grid []float32) (Stats, error) {
	var st Stats
	if err := f.checkBuffer(data, stride, packed); err != nil {
		return st, err
	}
	cw, ch := outW/motionCols, outH/motionRows
	if cw < 1 || ch < 1 || len(grid) < motionCols*motionRows {
		return st, fmt.Errorf("cannot sample %dx%d into a %dx%d grid", outW, outH, motionCols, motionRows)
	}
	srcW, srcH := f.W/2, f.H/2
	for r := 0; r < motionRows; r++ {
		for c := 0; c < motionCols; c++ {
			var sum int32
			for j := 0; j < sampleN; j++ {
				oy := lattice(r*ch + (2*j+1)*ch/(2*sampleN))
				for i := 0; i < sampleN; i++ {
					ox := lattice(c*cw + (2*i+1)*cw/(2*sampleN))
					cx, cy := p.source(f, outW, outH, min(ox, outW-1), min(oy, outH-1))
					f.unpackCell(data, stride, packed, cx, cy)
					for n := 0; n < 4; n++ {
						nx, ny := neighbour(cx, cy, n, srcW, srcH)
						f.unpackCell(data, stride, packed, nx, ny)
					}
					R, G, B := p.shade(f, cx, cy, &st)
					sum += lumaBT601(int32(R), int32(G), int32(B))
				}
			}
			grid[r*motionCols+c] = float32(sum) / (sampleN * sampleN)
		}
	}
	return st, nil
}
