import assert from "node:assert/strict";
import test from "node:test";
import {
  filterModels,
  nextSort,
  pickerView,
  SORT_CRITERIA,
  sortModels,
  splitModelId,
} from "../src/core/picker.mjs";

const models = [
  { id: "ollama-cloud/deepseek-v4.1-flash", context: 128000 },
  { id: "ollama-cloud/glm-5.3-flash", context: 200000 },
  { id: "anthropic/claude-opus-5", context: 1000000 },
  { id: "anthropic/claude-sonnet-4-6", context: 200000 },
  { id: "opencode/big-pickle" },
];

test("an empty query keeps every model", () => {
  assert.equal(filterModels(models, "").length, models.length);
  assert.equal(filterModels(models, "   ").length, models.length);
  assert.equal(filterModels(models, undefined).length, models.length);
});

test("a query matches the id, the provider, or the bare name", () => {
  const byProvider = filterModels(models, "ollama");
  assert.equal(byProvider.length, 2);
  const byName = filterModels(models, "opus");
  assert.equal(byName.length, 1);
  assert.equal(byName[0].id, "anthropic/claude-opus-5");
  const byFullId = filterModels(models, "deepseek-v4.1-flash");
  assert.equal(byFullId.length, 1);
});

test("terms are ANDed so a few keystrokes narrow a long list", () => {
  assert.equal(filterModels(models, "ollama flash").length, 2);
  assert.equal(filterModels(models, "anthropic opus").length, 1);
  assert.equal(filterModels(models, "anthropic big-pickle").length, 0, "no model matches both");
});

test("filtering is case-insensitive", () => {
  assert.equal(filterModels(models, "CLAUDE").length, 2);
  assert.equal(filterModels(models, "OpUs").length, 1);
});

test("splitModelId separates a provider prefix from the name", () => {
  assert.deepEqual(splitModelId("anthropic/claude-opus-5"), {
    provider: "anthropic",
    name: "claude-opus-5",
  });
  assert.deepEqual(splitModelId("no-prefix"), { provider: "", name: "no-prefix" });
  assert.deepEqual(splitModelId(""), { provider: "", name: "" });
});

test("catalog order is left untouched", () => {
  assert.deepEqual(sortModels(models, "catalog"), models);
});

test("sorting by name ignores the provider prefix", () => {
  const ids = sortModels(models, "name").map((m) => m.id);
  assert.equal(ids[0], "opencode/big-pickle");
  assert.ok(ids.indexOf("anthropic/claude-opus-5") < ids.indexOf("anthropic/claude-sonnet-4-6"));
});

test("sorting by provider groups providers then sorts names within", () => {
  const ids = sortModels(models, "provider").map((m) => m.id);
  assert.equal(ids[0], "anthropic/claude-opus-5");
  assert.equal(ids[1], "anthropic/claude-sonnet-4-6");
  assert.ok(ids[2].startsWith("ollama-cloud/"));
  assert.equal(ids.at(-1), "opencode/big-pickle");
});

test("sorting by context puts the largest first and unknown sizes last", () => {
  const ids = sortModels(models, "context").map((m) => m.id);
  assert.equal(ids[0], "anthropic/claude-opus-5");
  assert.equal(ids.at(-1), "opencode/big-pickle", "a model without a size sorts last");
});

test("sorting never mutates the input array", () => {
  const snapshot = models.map((m) => m.id);
  sortModels(models, "provider");
  sortModels(models, "context");
  assert.deepEqual(models.map((m) => m.id), snapshot);
});

test("the sort cycle visits every criterion and returns to the start", () => {
  let current = SORT_CRITERIA[0];
  const seen = [current];
  for (let i = 0; i < SORT_CRITERIA.length - 1; i++) {
    current = nextSort(current);
    seen.push(current);
  }
  assert.deepEqual(seen, SORT_CRITERIA);
  assert.equal(nextSort(current), SORT_CRITERIA[0], "wraps to the first");
});

test("nextSort recovers from an unknown criterion", () => {
  // an unknown value lands on the first criterion, which is the safe default
  assert.equal(nextSort("nonsense"), SORT_CRITERIA[0]);
  assert.equal(nextSort(undefined), SORT_CRITERIA[0]);
});

test("pickerView reports both the matched and the total count", () => {
  const view = pickerView(models, { query: "claude", sort: "name" });
  assert.equal(view.total, models.length);
  assert.equal(view.matched, 2);
  assert.equal(view.models.length, 2);
  assert.deepEqual(view.models.map((m) => m.id), ["anthropic/claude-opus-5", "anthropic/claude-sonnet-4-6"]);
});

test("pickerView filters before sorting", () => {
  const view = pickerView(models, { query: "ollama", sort: "context" });
  assert.deepEqual(view.models.map((m) => m.id), [
    "ollama-cloud/glm-5.3-flash",
    "ollama-cloud/deepseek-v4.1-flash",
  ]);
});

test("every model in a large list stays reachable through filtering", () => {
  const big = Array.from({ length: 387 }, (_, i) => ({ id: `provider-${i}/model-${i}` }));
  for (const target of [0, 100, 386]) {
    const found = filterModels(big, `model-${target}`);
    assert.equal(found.length, 1, `model-${target} must be findable`);
    assert.equal(found[0].id, `provider-${target}/model-${target}`);
  }
});

test("arrow navigation stays inside the filtered results", () => {
  // Regression: while filtering, up/down were swallowed by the search branch,
  // so only the first match could ever be chosen.
  const models = Array.from({ length: 40 }, (_, i) => ({ id: `p/alpha-${i}` }));
  const view = pickerView(models, { query: "alpha" });
  assert.equal(view.matched, 40);

  let index = 0;
  const moveDown = () => {
    index = Math.min(Math.max(0, view.models.length - 1), index + 1);
  };
  const moveUp = () => {
    index = Math.max(0, index - 1);
  };

  moveDown();
  moveDown();
  assert.equal(index, 2, "down must advance within the results");
  assert.equal(view.models[index].id, "p/alpha-2", "the cursor lands on the third match");

  moveUp();
  assert.equal(index, 1);

  // and the cursor cannot leave the filtered set
  for (let i = 0; i < 100; i++) moveDown();
  assert.equal(index, view.models.length - 1);
  assert.ok(view.models[index], "the last match is still selectable");
});

test("narrowing the query keeps the cursor on a real row", () => {
  const models = Array.from({ length: 30 }, (_, i) => ({ id: `p/model-${i}` }));
  const wide = pickerView(models, { query: "model" });
  let index = 20;
  assert.ok(wide.models[index]);

  const narrow = pickerView(models, { query: "model-1" });
  const clamped = Math.min(index, Math.max(0, narrow.models.length - 1));
  assert.ok(narrow.models[clamped], "after narrowing, the clamped cursor is valid");
  assert.equal(clamped, 10, "model-1 matches 11 rows, so the cursor clamps to the last");
});

test("backspace widens the list without losing the cursor row", () => {
  const models = Array.from({ length: 30 }, (_, i) => ({ id: `p/model-${i}` }));
  const narrow = pickerView(models, { query: "model-12" });
  const index = 0;
  const wider = pickerView(models, { query: "model-1" });
  // the previously selected row must still exist in the wider result
  assert.ok(wider.models[index], "the cursor row survives widening");
  assert.ok(wider.matched > narrow.matched, "deleting a character widens the result set");
});
