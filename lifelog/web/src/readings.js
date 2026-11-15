// The readings of a metric, read from its CSV files, and a chart of them.
// The checker holds the rules of a CSV (design §6); a line it would refuse is
// left out of the chart here, not judged.

const NUMBER = /^-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?$/;

// parseCSV returns the readings of one file: { day, takenAt, value, source, file }.
export function parseCSV(text, file) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  if (lines[0] !== "day,taken_at,value,source") return [];
  const out = [];
  for (const line of lines.slice(1)) {
    if (line === "") continue;
    const f = line.split(",");
    if (f.length !== 4 || !/^\d{4}-\d{2}-\d{2}$/.test(f[0]) || !NUMBER.test(f[2])) continue;
    out.push({ day: f[0], takenAt: f[1], value: Number(f[2]), text: f[2], source: f[3], file });
  }
  return out;
}

// Readings keeps each metric's readings until one of its files changes.
export class Readings {
  constructor(folder) {
    this.folder = folder;
    this.cache = new Map(); // file -> { mtime, readings }
  }

  async of(metric) {
    const files = (await this.folder.list(`metrics/${metric}`)).filter((f) => f.endsWith(".csv"));
    const all = [];
    for (const f of files) {
      const mtime = await this.folder.mtime(f);
      let c = this.cache.get(f);
      if (!c || c.mtime !== mtime) {
        const r = await this.folder.read(f);
        c = { mtime, readings: r ? parseCSV(r.text, f) : [] };
        this.cache.set(f, c);
      }
      all.push(...c.readings);
    }
    return all.sort((a, b) => (a.day + a.takenAt).localeCompare(b.day + b.takenAt));
  }
}

// chart draws the readings as an SVG: a line through the mean of each day,
// a dot for each reading. Colours come from the page's CSS.
export function chart(readings, { width = 640, height = 220, unit = "" } = {}) {
  if (readings.length === 0) return "";
  const pad = { l: 44, r: 10, t: 12, b: 26 };
  const days = new Map();
  for (const r of readings) {
    if (!days.has(r.day)) days.set(r.day, []);
    days.get(r.day).push(r.value);
  }
  const t = (day) => Date.parse(day + "T00:00:00Z");
  const first = t(readings[0].day);
  const last = t(readings[readings.length - 1].day);
  const values = readings.map((r) => r.value);
  let lo = values.reduce((a, b) => Math.min(a, b));
  let hi = values.reduce((a, b) => Math.max(a, b));
  if (lo === hi) {
    lo -= 1;
    hi += 1;
  }
  const x = (day) => pad.l + (last === first ? 0.5 : (t(day) - first) / (last - first)) * (width - pad.l - pad.r);
  const y = (v) => pad.t + (1 - (v - lo) / (hi - lo)) * (height - pad.t - pad.b);
  const means = [...days].map(([day, vs]) => [day, vs.reduce((a, b) => a + b, 0) / vs.length]);
  const line = means.map(([d, v]) => `${x(d).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  const dots = readings
    .map((r) => `<circle cx="${x(r.day).toFixed(1)}" cy="${y(r.value).toFixed(1)}" r="2.5"><title>${r.day} ${r.text} ${escapeXML(unit)}</title></circle>`)
    .join("");
  const label = (v) => String(Math.round(v * 100) / 100);
  return `<svg class="chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="chart">
<line class="axis" x1="${pad.l}" y1="${height - pad.b}" x2="${width - pad.r}" y2="${height - pad.b}"/>
<text x="${pad.l - 6}" y="${y(hi) + 4}" text-anchor="end">${label(hi)}</text>
<text x="${pad.l - 6}" y="${y(lo) + 4}" text-anchor="end">${label(lo)}</text>
<text x="${pad.l}" y="${height - 6}">${readings[0].day}</text>
<text x="${width - pad.r}" y="${height - 6}" text-anchor="end">${readings[readings.length - 1].day}</text>
<polyline class="line" points="${line}"/>
<g class="dots">${dots}</g>
</svg>`;
}

function escapeXML(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
}
