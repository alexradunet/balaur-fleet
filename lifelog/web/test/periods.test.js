// The periods of the calendar: ISO weeks at the edges of a year, the grid of a month.

import assert from "node:assert/strict";
import { test } from "node:test";

import { daysOfWeek, monthGrid, shiftMonth, shiftWeek, weekOf } from "../src/periods.js";

test("a week is the ISO week: Monday first, the year of its Thursday", () => {
  assert.equal(weekOf("2026-11-15"), "2026-W46"); // a Sunday ends its week
  assert.equal(weekOf("2026-11-16"), "2026-W47");
  assert.equal(weekOf("2026-01-01"), "2026-W01"); // a Thursday
  assert.equal(weekOf("2027-01-01"), "2026-W53"); // a Friday: the week of 2026's last Thursday
  assert.equal(weekOf("2024-12-30"), "2025-W01"); // a Monday whose Thursday is in 2025
  assert.deepEqual(daysOfWeek("2026-W46"), ["2026-11-09", "2026-11-10", "2026-11-11", "2026-11-12", "2026-11-13", "2026-11-14", "2026-11-15"]);
  assert.equal(daysOfWeek("2026-W53")[6], "2027-01-03");
  assert.equal(daysOfWeek("2025-W53"), null); // 2025 has 52 weeks
  assert.equal(daysOfWeek("2026-W00"), null);
  assert.equal(shiftWeek("2026-W53", 1), "2027-W01");
  assert.equal(shiftWeek("2027-W01", -1), "2026-W53");
});

test("every day of five years is in the week its days list", () => {
  for (let d = new Date("2024-01-01T12:00:00Z"); d < new Date("2029-01-01T12:00:00Z"); d.setUTCDate(d.getUTCDate() + 1)) {
    const day = d.toISOString().slice(0, 10);
    assert.ok(daysOfWeek(weekOf(day))?.includes(day), day);
  }
});

test("a month is rows of seven, Monday first, blank outside it", () => {
  const nov = monthGrid("2026-11"); // the 1st is a Sunday
  assert.equal(nov.length, 6);
  assert.deepEqual(nov[0], [null, null, null, null, null, null, "2026-11-01"]);
  assert.deepEqual(nov[5], ["2026-11-30", null, null, null, null, null, null]);
  assert.ok(nov.every((row) => row.length === 7));
  assert.equal(monthGrid("2026-02").flat().filter(Boolean).length, 28);
  assert.equal(monthGrid("2028-02").flat().filter(Boolean).length, 29);
  assert.equal(monthGrid("2026-13"), null);
  assert.equal(shiftMonth("2026-12", 1), "2027-01");
  assert.equal(shiftMonth("2026-01", -1), "2025-12");
});
