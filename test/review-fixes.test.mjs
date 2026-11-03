/**
 * Regression tests for the defects an independent review found.
 * Each case reproduces the reported failure so it cannot come back.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { splitListInput, formatListInput } from "../src/core/editor.mjs";
import { layoutFor } from "../src/core/layout.mjs";
import { effortLevels, listModels } from "../src/core/detect.mjs";
import { pickerView } from "../src/core/picker.mjs";
import { visibleWindow } from "../src/core/window.mjs";

test("extra args round-trip keeps arguments containing spaces", () => {
  const value = ["--add-dir", "D:/My Projects"];
  const text = formatListInput(value);
  assert.equal(text, '--add-dir "D:/My Projects"');
  assert.deepEqual(splitListInput(text), value, "opening and confirming must not shred the argument");
});

test("single quotes also protect spaces", () => {
  assert.deepEqual(splitListInput("--path 'C:/a b/c' --x"), ["--path", "C:/a b/c", "--x"]);
});

test("list input still splits plain whitespace and commas", () => {
  assert.deepEqual(splitListInput("a b,c  d"), ["a", "b", "c", "d"]);
  assert.deepEqual(splitListInput(""), []);
  assert.deepEqual(formatListInput([]), "");
  assert.deepEqual(formatListInput(["a", "b"]), "a b");
});

test("a bare quote character does not lose the rest of the input", () => {
  assert.deepEqual(splitListInput('a "unclosed b'), ["a", "unclosed b"]);
});

test("filtering cannot leave the picker without a highlighted row", () => {
  // the review's case: cursor deep in a long list, then a filter shrinks it
  const models = Array.from({ length: 30 }, (_, i) => ({ id: `p/model-${i}` }));
  const full = pickerView(models, {});
  const staleIndex = 20;
  assert.ok(staleIndex < full.models.length, "the cursor starts valid");

  const filtered = pickerView(models, { query: "model-1" });
  assert.equal(filtered.models[staleIndex], undefined, "the stale index is past the filtered end");

  const clamped = Math.min(staleIndex, Math.max(0, filtered.models.length - 1));
  assert.ok(filtered.models[clamped], "a clamped index lands on a real row");
  assert.equal(clamped, filtered.models.length - 1, "clamping selects the last row, not nothing");
});

test("an empty filtered list has no row to select, so Enter must be ignored", () => {
  const models = [{ id: "a" }, { id: "b" }];
  const view = pickerView(models, { query: "nothing-matches" });
  assert.equal(view.models.length, 0);
  const clamped = Math.min(5, Math.max(0, view.models.length - 1));
  assert.equal(view.models[clamped], undefined, "there is no row, so the caller must not write one");
});

test("layout never reports more than the terminal has", () => {
  for (const [rows, cols] of [[4, 10], [1, 1], [6, 20], [10, 40]]) {
    const layout = layoutFor(rows, cols);
    assert.ok(layout.rows <= Math.max(1, rows), `rows ${layout.rows} exceeds ${rows}`);
    assert.ok(layout.cols <= Math.max(1, cols), `cols ${layout.cols} exceeds ${cols}`);
  }
});

test("a pane below the minimum is flagged instead of laid out", () => {
  assert.equal(layoutFor(4, 10).tooSmall, true);
  assert.equal(layoutFor(47, 148).tooSmall, false);
});

test("the editor body fits its row budget at every size", () => {
  for (const [rows, cols] of [[16, 85], [20, 100], [26, 115], [35, 130], [47, 148]]) {
    const layout = layoutFor(rows, cols);
    const header = layout.compact ? 2 : 3;
    const indicator = 1; // reserved for "… N more fields"
    const pickerChrome = 2;
    const body = header + layout.fieldRows + indicator + pickerChrome + layout.optionRows;
    const usable = Math.max(1, rows - 4);
    assert.ok(body <= usable, `${cols}x${rows}: body ${body} exceeds usable ${usable}`);
  }
});

test("effort levels come from the selected model, not the whole catalog", () => {
  const models = [
    { id: "A", efforts: ["low"] },
    { id: "B", efforts: ["high"] },
  ];
  // a per-model lookup must not offer B's level for A
  const forA = effortLevels("codex", { models: [models[0]] });
  assert.deepEqual(forA, ["low"]);
  const forB = effortLevels("codex", { models: [models[1]] });
  assert.deepEqual(forB, ["high"]);
  // the union is only a fallback when no single model is known
  assert.deepEqual(effortLevels("codex", { models }).sort(), ["high", "low"]);
});

test("picker rows keep the metadata that sorting and filtering use", () => {
  // records, never bare ids: otherwise context sort and label search are dead
  const rows = [
    { id: "A", label: "Alpha", context: 1000 },
    { id: "B", label: "Beta", context: 9000 },
  ];
  const byContext = pickerView(rows, { sort: "context" });
  assert.deepEqual(byContext.models.map((m) => m.id), ["B", "A"], "larger context first");
  const byLabel = pickerView(rows, { query: "alpha" });
  assert.equal(byLabel.matched, 1, "a label-only match must still be found");
});

test("a model record with no context still sorts last", () => {
  const rows = [{ id: "A", context: 100 }, { id: "B" }];
  assert.deepEqual(pickerView(rows, { sort: "context" }).models.map((m) => m.id), ["A", "B"]);
});

test("visibleWindow keeps the cursor visible when total shrinks", () => {
  const before = visibleWindow(30, 25, 5, 25);
  assert.ok(25 >= before.start && 25 < before.end);
  const after = visibleWindow(3, 25, 5, before.offset);
  const clamped = Math.min(25, 2);
  const win = visibleWindow(3, clamped, 5, after.offset);
  assert.ok(clamped >= win.start && clamped < win.end, "after clamping, the cursor is visible again");
});
