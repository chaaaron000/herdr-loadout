import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { cleanup, tempDir } from "./helpers.mjs";
import { loadConfig, readConfigFile, upsertProfile } from "../src/core/store.mjs";
import { mergeProfiles, overrideDelta } from "../src/core/merge.mjs";

const globalBuilder = {
  id: "builder",
  name: "Builder",
  harness: "claude",
  model: "deepseek-v4.1",
  effort: "medium",
  cost: "normal",
  when_to_use: "Implement things.",
};

test("a partial override writes without the full profile body", () => {
  const dir = tempDir();
  try {
    const file = path.join(dir, "loadout.toml");
    fs.writeFileSync(file, "version = 1\n");

    const delta = overrideDelta({ ...globalBuilder, effort: "high" }, globalBuilder).entry;
    const result = upsertProfile(file, delta, { partial: true });
    assert.deepEqual(result.errors, []);
    assert.equal(result.ok, true);

    const loaded = readConfigFile(file);
    assert.equal(loaded.profiles.length, 1);
    assert.equal(loaded.profiles[0].effort, "high");
    assert.equal(loaded.profiles[0].model, undefined, "override stores only the delta");
  } finally {
    cleanup(dir);
  }
});

test("a partial override still requires an id", () => {
  const dir = tempDir();
  try {
    const file = path.join(dir, "loadout.toml");
    fs.writeFileSync(file, "version = 1\n");
    const result = upsertProfile(file, { effort: "high" }, { partial: true });
    assert.equal(result.ok, false);
    assert.match(result.errors.join(" "), /id/);
  } finally {
    cleanup(dir);
  }
});

test("without partial, an incomplete profile is still rejected", () => {
  const dir = tempDir();
  try {
    const file = path.join(dir, "loadout.toml");
    fs.writeFileSync(file, "version = 1\n");
    const result = upsertProfile(file, { id: "x", effort: "high" });
    assert.equal(result.ok, false);
    assert.match(result.errors.join(" "), /harness/);
  } finally {
    cleanup(dir);
  }
});

test("a project override round-trips through merge to the edited value", () => {
  const dir = tempDir();
  try {
    const globalFile = path.join(dir, "global.toml");
    const projectFile = path.join(dir, "project.toml");
    fs.writeFileSync(globalFile, "version = 1\n");
    fs.writeFileSync(projectFile, "version = 1\n");
    upsertProfile(globalFile, globalBuilder);

    const delta = overrideDelta({ ...globalBuilder, effort: "high" }, globalBuilder).entry;
    upsertProfile(projectFile, delta, { partial: true });

    const loaded = loadConfig({ globalPath: globalFile, projectPath: projectFile });
    const { byId } = mergeProfiles(loaded.profiles, loaded.project.profiles);
    const merged = byId.get("builder");
    assert.equal(merged.effort, "high");
    assert.equal(merged.model, "deepseek-v4.1");
    assert.equal(merged.name, "Builder");
    assert.equal(merged.origin, "project-override");
    assert.deepEqual(merged.overrides, ["effort"]);
  } finally {
    cleanup(dir);
  }
});

test("an incomplete project-only profile is not surfaced by the merge", () => {
  const { profiles } = mergeProfiles([globalBuilder], [{ id: "half-made", effort: "high" }]);
  assert.deepEqual(profiles.map((profile) => profile.id), ["builder"]);
});

test("a complete project-only profile is surfaced", () => {
  const { byId } = mergeProfiles([globalBuilder], [
    {
      id: "unity-scout",
      name: "Unity Scout",
      harness: "opencode",
      model: "m",
      effort: "low",
      when_to_use: "Find unity refs.",
    },
  ]);
  assert.equal(byId.get("unity-scout").origin, "project-only");
});
