import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { cleanup, tempDir } from "./helpers.mjs";
import {
  ensureGlobalConfig,
  deleteProfile,
  loadConfig,
  readConfigFile,
  upsertProfile,
} from "../src/core/store.mjs";
import { mergeProfiles } from "../src/core/merge.mjs";
import { defaultTemplate, parseConfig, serializeConfig } from "../src/core/schema.mjs";

test("round trip keeps unknown keys and key order", () => {
  const text = [
    "version = 1",
    "",
    "custom_top_level = \"keep me\"",
    "",
    "[[profiles]]",
    "id = \"builder\"",
    "name = \"Builder\"",
    "harness = \"claude\"",
    "model = \"m\"",
    "effort = \"medium\"",
    "when_to_use = \"Do work.\"",
    "user_note = \"private\"",
    "",
  ].join("\n");

  const parsed = parseConfig(text, "test");
  assert.equal(parsed.ok, true);
  const out = serializeConfig(parsed.doc);
  const reparsed = parseConfig(out, "test");
  assert.equal(reparsed.ok, true);
  assert.equal(reparsed.doc.custom_top_level, "keep me");
  assert.equal(reparsed.doc.profiles[0].user_note, "private");
  assert.equal(serializeConfig(reparsed.doc), out, "stringify must be idempotent");
});

test("a broken config is reported, never rewritten", () => {
  const dir = tempDir();
  try {
    const file = path.join(dir, "loadout.toml");
    const broken = "version = 1\n[[profiles]\nid = \"x\"\n";
    fs.writeFileSync(file, broken);
    const result = readConfigFile(file);
    assert.equal(result.ok, false);
    assert.match(result.error, /loadout\.toml/);
    assert.equal(fs.readFileSync(file, "utf8"), broken, "file must be untouched");
  } finally {
    cleanup(dir);
  }
});

test("seeding creates a valid template once", () => {
  const dir = tempDir();
  try {
    const file = path.join(dir, "loadout.toml");
    const first = ensureGlobalConfig({ globalPath: file });
    assert.equal(first.created, true);
    const second = ensureGlobalConfig({ globalPath: file });
    assert.equal(second.created, false);

    const loaded = readConfigFile(file);
    assert.equal(loaded.ok, true);
    assert.equal(loaded.profiles.length, defaultTemplate().profiles.length);
    for (const profile of loaded.profiles) {
      assert.ok(profile.id);
      assert.ok(profile.when_to_use);
    }
  } finally {
    cleanup(dir);
  }
});

test("upsert inserts, replaces, and preserves unknown keys", () => {
  const dir = tempDir();
  try {
    const file = path.join(dir, "loadout.toml");
    fs.writeFileSync(file, 'version = 1\nkeep = "yes"\n');

    const created = upsertProfile(file, {
      id: "scout",
      name: "Scout",
      harness: "opencode",
      model: "m",
      effort: "low",
      when_to_use: "Explore.",
    });
    assert.deepEqual(created.errors, []);
    assert.equal(created.created, true);

    const replaced = upsertProfile(file, {
      id: "scout",
      name: "Scout 2",
      harness: "opencode",
      model: "m2",
      effort: "low",
      when_to_use: "Explore more.",
    });
    assert.equal(replaced.created, false);

    const loaded = readConfigFile(file);
    assert.equal(loaded.doc.keep, "yes");
    assert.equal(loaded.profiles.length, 1);
    assert.equal(loaded.profiles[0].name, "Scout 2");
  } finally {
    cleanup(dir);
  }
});

test("upsert rejects invalid profiles without touching the file", () => {
  const dir = tempDir();
  try {
    const file = path.join(dir, "loadout.toml");
    const before = 'version = 1\n[[profiles]]\nid = "ok"\nname = "Ok"\nharness = "claude"\nmodel = "m"\neffort = "low"\nwhen_to_use = "x"\n';
    fs.writeFileSync(file, before);

    const badCost = upsertProfile(file, {
      id: "x",
      name: "X",
      harness: "claude",
      model: "m",
      effort: "low",
      when_to_use: "x",
      cost: "cheapish",
    });
    assert.equal(badCost.ok, false);
    assert.match(badCost.errors[0], /cost/);

    const unknownHarness = upsertProfile(file, {
      id: "y",
      name: "Y",
      harness: "not-a-harness",
      model: "m",
      effort: "low",
      when_to_use: "x",
    });
    assert.equal(unknownHarness.ok, false);
    assert.match(unknownHarness.errors[0], /harness/);

    const badFieldType = upsertProfile(file, {
      id: "z",
      name: "Z",
      harness: "claude",
      model: "m",
      effort: "low",
      when_to_use: "x",
      extra_args: "not-an-array",
    });
    assert.equal(badFieldType.ok, false);

    assert.equal(fs.readFileSync(file, "utf8"), before);
  } finally {
    cleanup(dir);
  }
});

test("an empty required field is refused on write and reported on read", () => {
  // The merge hides a project-only profile with an empty required field, so
  // letting one be saved made it vanish from the list without a word.
  const dir = tempDir();
  try {
    const file = path.join(dir, "loadout.toml");
    const body = { id: "scenario", name: "Scenario", harness: "agy", model: "m", effort: "medium" };
    for (const when_to_use of ["", "   "]) {
      const result = upsertProfile(file, { ...body, when_to_use });
      assert.equal(result.ok, false);
      assert.match(result.errors.join(" "), /when_to_use/);
    }
    assert.equal(upsertProfile(file, { id: "scenario", model: "" }, { partial: true }).ok, false);

    fs.writeFileSync(file, 'version = 1\n[[profiles]]\nid = "scenario"\nname = "Scenario"\nharness = "agy"\nmodel = "m"\neffort = "medium"\nwhen_to_use = ""\n');
    const loaded = readConfigFile(file);
    assert.deepEqual(loaded.profiles, []);
    assert.equal(loaded.invalid[0].id, "scenario");
    assert.match(loaded.invalid[0].errors.join(" "), /when_to_use/);
  } finally {
    cleanup(dir);
  }
});

test("upsert drops unknown profile fields instead of writing them", () => {
  const dir = tempDir();
  try {
    const file = path.join(dir, "loadout.toml");
    const result = upsertProfile(file, {
      id: "builder",
      name: "Builder",
      harness: "claude",
      model: "m",
      effort: "medium",
      when_to_use: "Work.",
      not_a_field: "should not persist",
    });
    assert.equal(result.ok, true);
    const loaded = readConfigFile(file);
    assert.equal(loaded.profiles[0].not_a_field, undefined);
  } finally {
    cleanup(dir);
  }
});

test("delete removes one profile and reports missing ids", () => {
  const dir = tempDir();
  try {
    const file = path.join(dir, "loadout.toml");
    ensureGlobalConfig({ globalPath: file });
    const removed = deleteProfile(file, "scout");
    assert.equal(removed.removed, true);
    const loaded = readConfigFile(file);
    assert.ok(!loaded.profiles.some((profile) => profile.id === "scout"));

    const missing = deleteProfile(file, "scout");
    assert.equal(missing.ok, false);
    assert.match(missing.errors[0], /not found/);
  } finally {
    cleanup(dir);
  }
});

test("project override replaces only declared fields", () => {
  const global = [
    {
      id: "builder",
      name: "Builder",
      harness: "claude",
      model: "deepseek",
      effort: "medium",
      cost: "normal",
      when_to_use: "Implement.",
      tags: ["implementation"],
    },
  ];
  const project = [{ id: "builder", effort: "high", extra_args: ["--trust"] }];

  const { profiles, byId } = mergeProfiles(global, project);
  assert.equal(profiles.length, 1);
  const merged = byId.get("builder");
  assert.equal(merged.effort, "high");
  assert.deepEqual(merged.extra_args, ["--trust"]);
  assert.equal(merged.model, "deepseek", "untouched global field must survive");
  assert.deepEqual(merged.tags, ["implementation"]);
  assert.equal(merged.origin, "project-override");
  assert.deepEqual(merged.overrides.sort(), ["effort", "extra_args"]);
});

test("project-only profiles are merged in and marked", () => {
  const { profiles, byId } = mergeProfiles(
    [{ id: "builder", name: "Builder", harness: "claude", model: "m", effort: "low", when_to_use: "x" }],
    [{ id: "unity-builder", name: "Unity", harness: "claude", model: "m", effort: "high", when_to_use: "y" }],
  );
  assert.equal(profiles.length, 2);
  assert.equal(byId.get("unity-builder").origin, "project-only");
  assert.equal(byId.get("builder").origin, "global");
});

test("global-only profiles keep their identity when project adds others", () => {
  const { profiles } = mergeProfiles(
    [
      { id: "a", name: "A", harness: "claude", model: "m", effort: "low", when_to_use: "x" },
      { id: "b", name: "B", harness: "codex", model: "m", effort: "low", when_to_use: "y" },
    ],
    [{ id: "c", name: "C", harness: "omp", model: "m", effort: "low", when_to_use: "z" }],
  );
  assert.deepEqual(profiles.map((profile) => profile.id), ["a", "b", "c"]);
});

test("merge does not mutate its inputs", () => {
  const global = [{ id: "a", name: "A", harness: "claude", model: "m", effort: "low", when_to_use: "x" }];
  const project = [{ id: "a", effort: "high" }];
  const snapshot = JSON.stringify({ global, project });
  mergeProfiles(global, project);
  assert.equal(JSON.stringify({ global, project }), snapshot);
});

test("loadConfig reports both layers and their errors", () => {
  const dir = tempDir();
  try {
    const globalPath = path.join(dir, "config", "loadout.toml");
    const projectDir = path.join(dir, "repo");
    const projectPath = path.join(projectDir, ".herdr", "loadout.toml");
    fs.mkdirSync(projectDir, { recursive: true });
    ensureGlobalConfig({ globalPath });
    fs.mkdirSync(path.dirname(projectPath), { recursive: true });
    fs.writeFileSync(projectPath, "version = 1\n");

    const loaded = loadConfig({ globalPath, cwd: path.join(projectDir, "sub", "dir"), fs });
    assert.equal(loaded.errors.length, 0);
    assert.equal(loaded.projectPath, projectPath);
    assert.ok(loaded.global.exists);
    assert.ok(loaded.project.exists);
  } finally {
    cleanup(dir);
  }
});

test("loadConfig finds no project config when none exists", () => {
  const dir = tempDir();
  try {
    const globalPath = path.join(dir, "config", "loadout.toml");
    ensureGlobalConfig({ globalPath });
    const loaded = loadConfig({ globalPath, cwd: path.join(dir, "empty") });
    assert.equal(loaded.projectPath, null);
    assert.equal(loaded.project, null);
  } finally {
    cleanup(dir);
  }
});
