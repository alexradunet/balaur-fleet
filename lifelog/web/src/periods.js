// The periods of the calendar: the ISO week (Monday first), the month and the
// year, as lists of days "YYYY-MM-DD". Every day is a calendar date with no
// time zone, so the arithmetic is done at noon UTC.

const at = (day) => new Date(day + "T12:00:00Z");
const iso = (d) => d.toISOString().slice(0, 10);

export function addDays(day, n) {
  const d = at(day);
  d.setUTCDate(d.getUTCDate() + n);
  return iso(d);
}

// weekday is 1 for Monday to 7 for Sunday.
export const weekday = (day) => at(day).getUTCDay() || 7;

// weekOf is the ISO week of a day, "2026-W46". The week belongs to the year of its Thursday.
export function weekOf(day) {
  const thursday = addDays(day, 4 - weekday(day));
  const year = Number(thursday.slice(0, 4));
  const jan4 = `${year}-01-04`; // the 4th of January is always in week 1
  const monday1 = addDays(jan4, 1 - weekday(jan4));
  const n = 1 + Math.floor((at(day) - at(monday1)) / (7 * 864e5));
  return `${year}-W${String(n).padStart(2, "0")}`;
}

// daysOfWeek is the seven days of a week "2026-W46", Monday first; null for a week the year does not have.
export function daysOfWeek(id) {
  const m = /^(\d{4})-W(\d{2})$/.exec(id);
  if (!m) return null;
  const jan4 = `${m[1]}-01-04`;
  const monday = addDays(addDays(jan4, 1 - weekday(jan4)), (Number(m[2]) - 1) * 7);
  if (weekOf(monday) !== id) return null;
  return Array.from({ length: 7 }, (_, i) => addDays(monday, i));
}

export const shiftWeek = (id, n) => weekOf(addDays(daysOfWeek(id)[0], 7 * n));

export function shiftMonth(ym, n) {
  const [y, m] = ym.split("-").map(Number);
  const t = y * 12 + (m - 1) + n;
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, "0")}`;
}

// monthGrid is the weeks of a month "2026-11": rows of seven, Monday first; a cell outside the month is null.
export function monthGrid(ym) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(ym)) return null;
  const first = `${ym}-01`;
  const days = [];
  for (let d = first; d.startsWith(ym); d = addDays(d, 1)) days.push(d);
  const cells = [...Array(weekday(first) - 1).fill(null), ...days];
  while (cells.length % 7 !== 0) cells.push(null);
  const rows = [];
  for (let i = 0; i < cells.length; i += 7) rows.push(cells.slice(i, i + 7));
  return rows;
}
