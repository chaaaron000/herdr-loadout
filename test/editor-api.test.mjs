import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { runEditorAction } from "../src/core/editor.mjs";
import { readConfigFile } from "../src/core/store.mjs";
import { bindKey, installMod, MOD_NAME } from "../scripts/install-app-mod.mjs";
import { cleanup, tempDir } from "./helpers.mjs";

const GLOBAL = `version = 1

[[profiles]]
id = "builder"
name = "Builder"
harness = "pi"
model = "p/m"
effort = "medium"
when_to_use = "Build things."
`;

/** Run the editor backend against a throwaway global config and project. */
async function withRegistry(fn) {
  const dir = tempDir();
  const saved = { config: process.env.HERDR_PLUGIN_CONFIG_DIR, state: process.env.HERDR_PLUGIN_STATE_DIR };
  try {
    const config = path.join(dir, "config");
    const project = path.join(dir, "project");
    fs.mkdirSync(config, { recursive: true });
    fs.mkdirSync(project, { recursive: true });
    fs.writeFileSync(path.join(config, "loadout.toml"), GLOBAL);
    process.env.HERDR_PLUGIN_CONFIG_DIR = config;
    process.env.HERDR_PLUGIN_STATE_DIR = path.join(dir, "state");
    const act = (action, input = {}) => runEditorAction(action, input, { projectRoot: project });
    await fn({ act, globalFile: path.join(config, "loadout.toml"), projectFile: path.join(project, ".herdr", "loadout.toml") });
  } finally {
    for (const [key, value] of [["HERDR_PLUGIN_CONFIG_DIR", saved.config], ["HERDR_PLUGIN_STATE_DIR", saved.state]]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    cleanup(dir);
  }
}

test("an edit made through view and saved to the project becomes an override of that field only", async () => {
  await withRegistry(async ({ act, globalFile, projectFile }) => {
    const opened = await act("open", { mode: "edit", id: "builder" });
    assert.equal(opened.kind, "global");
    const viewed = await act("view", { draft: opened.draft, kind: opened.kind, baseline: opened.baseline, set: { field: "effort", value: "high" } });
    assert.equal(viewed.dirty, true);
    assert.equal(viewed.fields.find((row) => row.field === "effort").differs, true);

    const saved = await act("save", { draft: viewed.draft, baseline: opened.baseline, kind: opened.kind, target: "project" });
    assert.equal(saved.ok, true, saved.error);
    assert.deepEqual(readConfigFile(projectFile).profiles.map((entry) => ({ ...entry })), [{ id: "builder", effort: "high" }]);
    assert.equal(readConfigFile(globalFile).profiles[0].effort, "medium");

    const state = await act("state");
    assert.equal(state.profiles[0].origin, "project-override");
    assert.equal(state.profiles[0].differing, "effort");
  });
});

test("remove asks before it deletes, and deletes only when confirmed", async () => {
  await withRegistry(async ({ act, globalFile }) => {
    const asked = await act("remove", { id: "builder", action: "delete" });
    assert.equal(asked.question, 'delete "Builder" from global?');
    assert.equal(readConfigFile(globalFile).profiles.length, 1);

    const done = await act("remove", { id: "builder", action: "delete", confirmed: true });
    assert.equal(done.ok, true);
    assert.equal(readConfigFile(globalFile).profiles.length, 0);
  });
});

test("a model field waits for a catalog that is not read yet, and is typed when the harness has none", async () => {
  await withRegistry(async ({ act }) => {
    const draft = { id: "x", name: "X", harness: "codex", model: "m", effort: "low", when_to_use: "w" };
    const pending = await act("view", { draft, kind: "new", baseline: null });
    assert.equal(pending.catalogReady, false);
    const waiting = pending.fields.find((row) => row.field === "model");
    assert.deepEqual(waiting.options, []);
    assert.equal(waiting.pending, true);

    const failed = await act("view", { draft, kind: "new", baseline: null, catalogError: "codex: not logged in" });
    const model = failed.fields.find((row) => row.field === "model");
    assert.equal(model.options, null, "a failed list falls back to typing the id");
    assert.match(model.note, /model list failed: codex: not logged in/);
  });
});

test("the installer updates its own mod but never replaces another one", () => {
  const home = tempDir();
  try {
    const files = { "main.js": "// herdr-loadout editor\n", "mod.json": "{}\n" };
    const target = installMod(home, files);
    assert.equal(target, path.join(home, "mods", MOD_NAME));
    installMod(home, { ...files, "mod.json": '{ "place": "none" }\n' });
    assert.equal(fs.readFileSync(path.join(target, "mod.json"), "utf8"), '{ "place": "none" }\n');

    fs.writeFileSync(path.join(target, "main.js"), "// someone else's mod\n");
    assert.throws(() => installMod(home, files), /holds another mod/);
  } finally {
    cleanup(home);
  }
});

test("binding a key adds it for terminals too and keeps the person's existing bindings", () => {
  const home = tempDir();
  try {
    fs.writeFileSync(
      path.join(home, "keys.json"),
      JSON.stringify({ global: { "ctrl-shift-p": "app.palette" }, terminal: { "ctrl-shift-c": "terminal.copy" } }),
    );
    assert.throws(() => bindKey(home, "ctrl-shift-p"), /already runs "app.palette" \(global\)/);
    assert.throws(() => bindKey(home, "ctrl-shift-c"), /already runs "terminal.copy" \(terminal\)/);
    assert.equal(bindKey(home, "ctrl-shift-a"), "added");
    assert.equal(bindKey(home, "ctrl-shift-a"), "present");
    const keys = JSON.parse(fs.readFileSync(path.join(home, "keys.json"), "utf8"));
    const open = `mod.open:${MOD_NAME}`;
    assert.deepEqual(keys.global, { "ctrl-shift-p": "app.palette", "ctrl-shift-a": open });
    assert.deepEqual(keys.terminal, { "ctrl-shift-c": "terminal.copy", "ctrl-shift-a": open });
  } finally {
    cleanup(home);
  }
});
