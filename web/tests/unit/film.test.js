// The opening film's timing (docs/10 D-084): the Space Apps demo cut must stay within the
// 30-second limit, and every scene must stay on screen long enough to read.
import { test } from "node:test";
import assert from "node:assert/strict";
import { AUDIENCES, INDEX, NEXT, SCENES, timeline } from "../../src/film.js";
import { wavePath } from "../../src/landing.js";

test("the 30-second cut fits the Space Apps limit", () => {
  const { duration } = timeline(true);
  assert.ok(duration > 25 && duration <= 30, `short cut is ${duration} s`);
});

test("scenes follow each other with no gap, in both cuts", () => {
  for (const short of [false, true]) {
    const { marks, duration } = timeline(short);
    let at = 0;
    for (const [id] of SCENES) {
      assert.equal(marks[id].a, at, `${id} starts where the last scene ended`);
      at = marks[id].b;
    }
    assert.equal(at, duration);
  }
});

test("every scene that is shown holds long enough to read", () => {
  // About 0.3 s a word plus a second (subtitle practice): the shortest lines need 1.4 s.
  for (const [id, full, cut] of SCENES) {
    assert.ok(full >= 2, `${id} full`);
    assert.ok(cut === 0 || cut >= 1.4, `${id} short`);
  }
  // The status quo (cold open, the blind map), the turn, the reveal and the title always make the cut.
  for (const id of ["cold", "blind", "hook", "nisar", "title"]) assert.ok(SCENES.find((s) => s[0] === id)[2] > 0, id);
});

test("the full film stays under two and a half minutes, and opens on the status quo", () => {
  // Engagement falls after about two minutes (docs/film/RESEARCH.md §1): the story must be told
  // before the reference beats (audiences, index, next) begin.
  const { marks, duration } = timeline(false);
  assert.ok(duration <= 150, `full cut is ${duration} s`);
  assert.equal(SCENES[0][0], "cold");
  assert.ok(marks.audience.a <= 110, `the story ends at ${marks.audience.a} s`);
});

test("each audience beat holds long enough for its question and three features", () => {
  const { marks } = timeline(false);
  assert.equal(AUDIENCES.length, 6);
  assert.ok(marks.audience.d / AUDIENCES.length >= 4.2);
});

test("the index wall and the directions name each feature once", () => {
  const items = INDEX.flatMap(([, list]) => list);
  assert.equal(new Set(items).size, items.length);
  assert.equal(new Set(NEXT.map(([k]) => k)).size, NEXT.length);
});

test("a wave runs from the first point to the last", () => {
  const d = wavePath([[0, 0], [100, 0]], 20, 5, 10);
  assert.match(d, /^M0\.0 0\.0/);
  assert.match(d, /L100\.0 0\.0$/);
});
