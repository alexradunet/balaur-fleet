import assert from "node:assert/strict";
import { test } from "node:test";

import { chart, parseCSV } from "../src/readings.js";

test("parseCSV reads the lines that hold a reading", () => {
  const text = "day,taken_at,value,source\r\n2026-11-14,2026-11-14T07:02:00+02:00,81.4,manual\r\n2026-11-15,,8a,manual\r\nbad\r\n2026-11-15,,-0.5e1,scale\r\n";
  assert.deepEqual(parseCSV(text, "f.csv"), [
    { day: "2026-11-14", takenAt: "2026-11-14T07:02:00+02:00", value: 81.4, text: "81.4", source: "manual", file: "f.csv" },
    { day: "2026-11-15", takenAt: "", value: -5, text: "-0.5e1", source: "scale", file: "f.csv" },
  ]);
  assert.deepEqual(parseCSV("day,value\n2026-11-14,1\n", "f.csv"), []);
});

test("chart draws a dot per reading and a line through each day's mean", () => {
  const rs = parseCSV("day,taken_at,value,source\n2026-11-01,,80,a\n2026-11-01,,82,b\n2026-11-11,,79,a\n", "f");
  const svg = chart(rs, { unit: "kg" });
  assert.equal((svg.match(/<circle/g) ?? []).length, 3);
  assert.equal(/points="([^"]+)"/.exec(svg)[1].split(" ").length, 2);
  assert.equal(chart([]), "");
  assert.match(chart(rs.slice(0, 1)), /<circle cx="[0-9.]+"/); // one reading: no division by zero
});
