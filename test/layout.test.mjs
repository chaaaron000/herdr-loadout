import assert from "node:assert/strict";
import test from "node:test";
import { layoutFor, listWindow } from "../src/core/layout.mjs";

test("a small popup still leaves room for the option list", () => {
  // measured: the previous 60%x40% popup gave 85x16, which overflowed
  const layout = layoutFor(16, 85);
  assert.ok(layout.optionRows >= 2, "the picker must keep at least two rows");
  assert.ok(layout.listRows >= 2);
  assert.equal(layout.compact, true, "a 16-row pane uses the compact layout");
  assert.equal(layout.narrow, false, "85 columns fit a two-column field row");
});

test("the measured 90%x80% popup fits the whole editor", () => {
  const layout = layoutFor(35, 130);
  assert.equal(layout.compact, false);
  assert.equal(layout.narrow, false);
  assert.ok(layout.optionRows >= 10, `picker should have room, got ${layout.optionRows}`);
  assert.ok(layout.listRows >= 25, `list should have room, got ${layout.listRows}`);
});

test("the picker budget never goes negative at any realistic size", () => {
  for (let rows = 6; rows <= 60; rows++) {
    for (const cols of [40, 60, 80, 120, 200]) {
      const layout = layoutFor(rows, cols);
      assert.ok(layout.optionRows >= 2, `optionRows ${layout.optionRows} at ${cols}x${rows}`);
      assert.ok(layout.listRows >= 2, `listRows ${layout.listRows} at ${cols}x${rows}`);
      assert.ok(layout.fieldRows > 0);
    }
  }
});

test("narrow terminals stack fields instead of wrapping them", () => {
  assert.equal(layoutFor(30, 59).narrow, true);
  assert.equal(layoutFor(30, 60).narrow, false);
});

test("short terminals switch to the compact layout", () => {
  assert.equal(layoutFor(27, 100).compact, true);
  assert.equal(layoutFor(28, 100).compact, false);
});

test("the picker never exceeds its cap, so the field list stays on screen", () => {
  const huge = layoutFor(200, 300);
  assert.ok(huge.optionRows <= 14, `picker capped, got ${huge.optionRows}`);
});

test("invalid or missing sizes degrade to a usable layout", () => {
  for (const [rows, cols] of [[0, 0], [undefined, undefined], [NaN, NaN]]) {
    const layout = layoutFor(rows, cols);
    assert.ok(layout.rows >= 6);
    assert.ok(layout.cols >= 20);
    assert.ok(layout.optionRows >= 2);
  }
});

test("the layout accounts for the rows it claims", () => {
  // frame + header + fields + picker chrome + options must fit the terminal,
  // otherwise the pane scrolls and the hint line disappears.
  for (const [rows, cols] of [[16, 85], [16, 40], [26, 115], [35, 130], [45, 132], [60, 200]]) {
    const layout = layoutFor(rows, cols);
    const usable = Math.max(3, rows - 4);
    const header = layout.compact ? 2 : 3;
    const used = header + layout.fieldRows + 2 + layout.optionRows;
    assert.ok(used <= usable, `layout needs ${used} rows, only ${usable} usable (${cols}x${rows})`);
  }
});

test("a short pane shrinks the field list rather than the picker", () => {
  const small = layoutFor(16, 85);
  assert.ok(small.visibleFields < 10, "fields are trimmed in a short pane");
  assert.ok(small.optionRows >= 2, "the picker stays reachable");
});

test("listWindow never exceeds the visible rows", () => {
  const win = listWindow(16, 85, 100);
  assert.ok(win.end - win.start <= win.visible);
  assert.equal(win.start, 0);
});

test("listWindow handles fewer profiles than rows", () => {
  const win = listWindow(40, 130, 3);
  assert.equal(win.end, 3);
});

test("the list window accounts for entry height, not row count", () => {
  // Regression: treating the row budget as a profile count rendered up to three
  // rows per entry, overflowed the pane, and left stale frames behind.
  for (const [rows, cols] of [[47, 148], [35, 130], [26, 115], [16, 85]]) {
    const layout = layoutFor(rows, cols);
    const win = listWindow(layout, cols, 100, { selected: 0 });
    const consumed = win.visible * win.rowHeight;
    assert.ok(
      consumed <= layout.listRows,
      `${cols}x${rows}: ${win.visible} profiles x ${win.rowHeight} rows = ${consumed} exceeds budget ${layout.listRows}`,
    );
    assert.ok(win.visible >= 1, "at least one profile must show");
  }
});

test("the list window follows the cursor", () => {
  const layout = layoutFor(20, 80);
  const first = listWindow(layout, 80, 100, { selected: 0 });
  assert.equal(first.start, 0);
  const deep = listWindow(layout, 80, 100, { selected: 40 });
  assert.ok(deep.start > 0, "a deep cursor scrolls the list");
  assert.ok(40 >= deep.start && 40 < deep.end, "the cursor stays inside the window");
});

test("an entry is never one row tall", () => {
  // name + detail, so a height of 1 would misreport the budget
  for (const compact of [true, false]) {
    const layout = { ...layoutFor(30, 80), compact };
    const win = listWindow(layout, 80, 50, { selected: 0 });
    assert.ok(win.rowHeight >= 2, `rowHeight ${win.rowHeight} is too small`);
  }
});

test("listWindow accepts either a size pair or a layout", () => {
  const fromPair = listWindow(30, 80, 50, { selected: 1 });
  const fromLayout = listWindow(layoutFor(30, 80), 80, 50, { selected: 1 });
  assert.deepEqual(fromPair, fromLayout);
});
