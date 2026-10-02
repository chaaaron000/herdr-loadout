import assert from "node:assert/strict";
import test from "node:test";
import { visibleWindow } from "../src/core/window.mjs";

test("a list shorter than the window shows everything and hides nothing", () => {
  const win = visibleWindow(3, 2, 8);
  assert.deepEqual(win, { start: 0, end: 3, offset: 0, hiddenAbove: 0, hiddenBelow: 0 });
});

test("an empty list produces an empty window", () => {
  const win = visibleWindow(0, 0, 8);
  assert.deepEqual(win, { start: 0, end: 0, offset: 0, hiddenAbove: 0, hiddenBelow: 0 });
});

test("the cursor stays visible while moving down past the window edge", () => {
  const height = 5;
  for (let cursor = 0; cursor < 200; cursor++) {
    const win = visibleWindow(200, cursor, height);
    assert.ok(
      cursor >= win.start && cursor < win.end,
      `cursor ${cursor} outside window [${win.start}, ${win.end})`,
    );
  }
});

test("the window does not move while the cursor is inside it", () => {
  const first = visibleWindow(100, 0, 5);
  assert.equal(first.start, 0);
  const third = visibleWindow(100, 3, 5, first.offset);
  assert.equal(third.start, 0, "cursor 3 still fits in rows 0..4");
  const fourth = visibleWindow(100, 4, 5, third.offset);
  assert.equal(fourth.start, 0, "cursor 4 is the last visible row");
});

test("the window scrolls by one when the cursor crosses the bottom edge", () => {
  const win = visibleWindow(100, 5, 5, 0);
  assert.equal(win.start, 1, "cursor 5 scrolls the window down by one");
  assert.equal(win.end, 6);
  assert.equal(win.hiddenAbove, 1);
});

test("moving back up scrolls only when the cursor passes the top edge", () => {
  const at = visibleWindow(100, 10, 5);
  const inside = visibleWindow(100, at.start + 1, 5, at.offset);
  assert.equal(inside.start, at.start, "inside the window, no scroll");
  const above = visibleWindow(100, at.start - 1, 5, at.offset);
  assert.equal(above.start, at.start - 1, "crossing the top scrolls up by one");
});

test("the last item is reachable and the list ends flush", () => {
  const win = visibleWindow(100, 99, 5);
  assert.equal(win.end, 100);
  assert.equal(win.hiddenBelow, 0);
  assert.ok(99 >= win.start && 99 < win.end);
});

test("hidden counts describe what is off-screen", () => {
  const win = visibleWindow(50, 25, 5);
  assert.equal(win.hiddenAbove, win.start);
  assert.equal(win.hiddenBelow, 50 - win.end);
  assert.equal(win.hiddenAbove + (win.end - win.start) + win.hiddenBelow, 50, "accounting adds up");
});

test("a cursor beyond the end clamps to the last item", () => {
  const win = visibleWindow(10, 999, 4);
  assert.ok(9 >= win.start && 9 < win.end);
});

test("a negative cursor clamps to the first item", () => {
  const win = visibleWindow(10, -5, 4);
  assert.equal(win.start, 0);
});

test("a stale offset is clamped into range", () => {
  const win = visibleWindow(10, 0, 4, 999);
  assert.ok(win.start >= 0 && win.end <= 10);
  assert.ok(0 >= win.start && 0 < win.end, "cursor is still visible after clamping");
});

test("height of one still shows the cursor", () => {
  const win = visibleWindow(10, 7, 1);
  assert.deepEqual([win.start, win.end], [7, 8]);
});

test("a zero or invalid height degrades to one row instead of collapsing", () => {
  assert.deepEqual(visibleWindow(5, 2, 0), { start: 2, end: 3, offset: 2, hiddenAbove: 2, hiddenBelow: 2 });
  assert.deepEqual(visibleWindow(5, 2, undefined).start, 2);
  assert.equal(visibleWindow(5, 2, -3).end - visibleWindow(5, 2, -3).start, 1);
});

test("every cursor position in a large catalog is reachable", () => {
  // mirrors the real omp catalog (86 models) inside a short popup window
  const total = 86;
  const height = 5;
  let offset = 0;
  const seen = new Set();
  for (let cursor = 0; cursor < total; cursor++) {
    const win = visibleWindow(total, cursor, height, offset);
    offset = win.offset;
    assert.ok(cursor >= win.start && cursor < win.end, `cursor ${cursor} lost`);
    seen.add(cursor);
  }
  assert.equal(seen.size, total, "every model can be highlighted");
});

test("scrolling is driven by input, not by render", () => {
  // The editor must not schedule state updates while rendering; the offset has
  // to be computable as a pure function of the cursor move.
  const total = 86;
  const height = 14;
  let offset = 0;
  const offsets = [];
  for (let cursor = 0; cursor < 30; cursor++) {
    const next = visibleWindow(total, cursor, height, offset).offset;
    offsets.push(next);
    offset = next;
  }
  assert.equal(offsets[0], 0, "the window starts at the top");
  assert.ok(offsets.at(-1) > 0, "the window eventually scrolls");
  // monotonic for a monotonic cursor walk
  for (let i = 1; i < offsets.length; i++) {
    assert.ok(offsets[i] >= offsets[i - 1], "the window does not jump backwards while scrolling down");
  }
});
