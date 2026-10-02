import assert from "node:assert/strict";
import test from "node:test";
import { mergeProfiles, overrideDelta } from "../src/core/merge.mjs";

const globalBuilder = {
  id: "builder",
  name: "Builder",
  harness: "claude",
  model: "deepseek-v4.1",
  effort: "medium",
  cost: "normal",
  when_to_use: "Implement things.",
  tags: ["implementation"],
};

test("overrideDelta keeps only fields that differ from the global profile", () => {
  const draft = { ...globalBuilder, effort: "high" };
  const { entry, changed } = overrideDelta(draft, globalBuilder);
  assert.deepEqual(entry, { id: "builder", effort: "high" });
  assert.deepEqual(changed, ["effort"]);
});

test("overrideDelta keeps the whole body when there is no global profile", () => {
  const draft = {
    id: "unity-scout",
    name: "Unity Scout",
    harness: "opencode",
    model: "ollama-cloud/glm-5.3-flash",
    effort: "low",
    cost: "cheap",
    when_to_use: "Find Unity references.",
  };
  const { entry, changed } = overrideDelta(draft, null);
  assert.equal(entry.id, "unity-scout");
  assert.equal(entry.harness, "opencode");
  assert.equal(entry.model, "ollama-cloud/glm-5.3-flash");
  assert.deepEqual(changed.sort(), ["cost", "effort", "harness", "model", "name", "when_to_use"]);
});

test("overrideDelta detects array additions and removals", () => {
  const added = overrideDelta({ ...globalBuilder, tags: ["implementation", "unity"] }, globalBuilder);
  assert.deepEqual(added.entry.tags, ["implementation", "unity"]);

  const removed = overrideDelta({ ...globalBuilder, tags: [] }, globalBuilder);
  assert.deepEqual(removed.entry.tags, []);
});

test("overrideDelta treats equal arrays and tables as unchanged", () => {
  const draft = {
    ...globalBuilder,
    tags: ["implementation"],
    extra_args: ["--a", "--b"],
    env: { A: "1" },
  };
  const base = { ...globalBuilder, extra_args: ["--a", "--b"], env: { A: "1" } };
  const { entry, changed } = overrideDelta(draft, base);
  assert.deepEqual(entry, { id: "builder" });
  assert.deepEqual(changed, []);
});

test("overrideDelta detects env value changes", () => {
  const draft = { ...globalBuilder, env: { A: "2" } };
  const base = { ...globalBuilder, env: { A: "1" } };
  const { changed } = overrideDelta(draft, base);
  assert.deepEqual(changed, ["env"]);
});

test("overrideDelta omits ui-only bookkeeping fields", () => {
  const draft = { ...globalBuilder, origin: "project-override", overrides: ["effort"], effort: "high" };
  const { entry } = overrideDelta(draft, globalBuilder);
  assert.equal(entry.origin, undefined);
  assert.equal(entry.overrides, undefined);
  assert.deepEqual(entry, { id: "builder", effort: "high" });
});

test("overrideDelta drops unknown keys", () => {
  const draft = { ...globalBuilder, not_a_field: "x" };
  const { entry } = overrideDelta(draft, globalBuilder);
  assert.equal(entry.not_a_field, undefined);
});

test("a delta round-trips through the merge to the edited values", () => {
  const draft = { ...globalBuilder, effort: "high", extra_args: ["--add-dir", "Assets"] };
  const { entry } = overrideDelta(draft, globalBuilder);

  const { byId } = mergeProfiles([globalBuilder], [entry]);
  const merged = byId.get("builder");
  assert.equal(merged.effort, "high");
  assert.deepEqual(merged.extra_args, ["--add-dir", "Assets"]);
  assert.equal(merged.model, "deepseek-v4.1", "untouched global field still applies");
  assert.deepEqual(merged.tags, ["implementation"]);
});

test("overrideDelta does not mutate its inputs", () => {
  const draft = { ...globalBuilder, effort: "high" };
  const snapshot = JSON.stringify({ draft, globalBuilder });
  overrideDelta(draft, globalBuilder);
  assert.equal(JSON.stringify({ draft, globalBuilder }), snapshot);
});
