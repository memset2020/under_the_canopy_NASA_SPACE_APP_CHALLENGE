// The sidebar's reading aids (readable.js, docs/10 D-093): numbers stand out, nothing else changes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { splitNumbers } from "../../src/readable.js";

const strong = (t) => splitNumbers(t).filter((p) => p.strong).map((p) => p.text);

test("quantities with their units are marked, the sentence is kept whole", () => {
  const text = "610,000 km² of forest in view, home to about 30,000,000 people, over 92% of the land.";
  assert.deepEqual(strong(text), ["610,000 km²", "30,000,000 people", "92%"]);
  assert.equal(splitNumbers(text).map((p) => p.text).join(""), text);
});

test("years, track names and product versions are not quantities", () => {
  assert.deepEqual(strong("launched 30 July 2025 on track 162A with RL06.3 mascons"), ["30"]);
  assert.deepEqual(strong("−2.5 cm and +18 cm"), ["−2.5 cm", "+18 cm"]);
});

test("a unit made of words is kept with its number", () => {
  assert.deepEqual(strong("about 53 million tonnes a year, 32% of the world's"), ["53 million tonnes", "32%"]);
  assert.deepEqual(strong("1,311 mm of rain in 117 days"), ["1,311 mm", "117 days"]);
});

test("punctuation after a number stays outside it", () => {
  assert.deepEqual(strong("GLWD v2, 2025, 500 m: 99% of it."), ["500 m", "99%"]);
});

test("days inside dates are not quantities", () => {
  assert.deepEqual(strong("C-band saw 115.8 km² on Jun 21, 2026; optical on Sep 3."), ["115.8 km²"]);
});

test("ISO dates and track names are left alone", () => {
  assert.deepEqual(strong("51 radar images (latest 2026-10-09) on Track 54 southbound"), ["51"]);
});

test("Bengali digits are numbers too", () => {
  assert.deepEqual(strong("উচ্চতা ৭৪৭ কিমি, ২০২৫ সালে"), ["৭৪৭"]);
});
