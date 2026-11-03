import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";
import { cleanup, tempDir } from "./helpers.mjs";

const require = createRequire(import.meta.url);
import { resolveProjectRoot } from "../bin/ui.mjs";
import { sourceRoot } from "../src/core/paths.mjs";

const pluginRoot = sourceRoot();
const bootstrap = path.join(pluginRoot, "bootstrap.mjs");

test("resolveProjectRoot prefers an explicit project", () => {
  const env = { HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify({ workspace_cwd: "D:\\other" }) };
  assert.equal(resolveProjectRoot("D:\\explicit", env), "D:\\explicit");
});

test("resolveProjectRoot reads the Herdr invocation context", () => {
  // A pane runs in the plugin directory, so the user's project must come from
  // the context Herdr injects.
  const env = {
    HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify({
      workspace_cwd: "D:\\work\\herdr-loadout",
      focused_pane_cwd: "D:\\somewhere\\else",
    }),
  };
  assert.equal(resolveProjectRoot(undefined, env), "D:\\work\\herdr-loadout");
});

test("resolveProjectRoot falls back to the focused pane when there is no workspace cwd", () => {
  const env = { HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify({ focused_pane_cwd: "D:\\focused" }) };
  assert.equal(resolveProjectRoot(undefined, env), "D:\\focused");
});

test("resolveProjectRoot ignores a malformed context and uses cwd", () => {
  assert.equal(resolveProjectRoot(undefined, { HERDR_PLUGIN_CONTEXT_JSON: "{not json" }), process.cwd());
  assert.equal(resolveProjectRoot(undefined, {}), process.cwd());
});

test("resolveProjectRoot tolerates a context without usable paths", () => {
  const env = { HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify({ workspace_id: "w1" }) };
  assert.equal(resolveProjectRoot(undefined, env), process.cwd());
});

test("bootstrap resolves a module relative to HERDR_PLUGIN_ROOT", () => {
  const dir = tempDir();
  try {
    const marker = path.join(dir, "marker.txt");
    fs.writeFileSync(path.join(dir, "probe.mjs"), `import fs from "node:fs";fs.writeFileSync(${JSON.stringify(marker)}, "ok");`);

    const { spawnSync } = require("node:child_process");
    const result = spawnSync(process.execPath, [bootstrap, "probe.mjs", "extra-arg"], {
      cwd: process.cwd(),
      env: { ...process.env, HERDR_PLUGIN_ROOT: dir },
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.readFileSync(marker, "utf8"), "ok");
  } finally {
    cleanup(dir);
  }
});

test("bootstrap forwards trailing arguments to the module", () => {
  const dir = tempDir();
  try {
    const marker = path.join(dir, "args.json");
    fs.writeFileSync(
      path.join(dir, "probe.mjs"),
      `import fs from "node:fs";fs.writeFileSync(${JSON.stringify(marker)}, JSON.stringify(process.argv.slice(2)));`,
    );
    const { spawnSync } = require("node:child_process");
    const result = spawnSync(process.execPath, [bootstrap, "probe.mjs", "list", "--compact"], {
      env: { ...process.env, HERDR_PLUGIN_ROOT: dir },
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(fs.readFileSync(marker, "utf8")), ["list", "--compact"]);
  } finally {
    cleanup(dir);
  }
});

test("bootstrap refuses to escape the plugin root", () => {
  const { spawnSync } = require("node:child_process");
  const result = spawnSync(process.execPath, [bootstrap, "../../outside.mjs"], {
    env: { ...process.env, HERDR_PLUGIN_ROOT: pluginRoot },
    encoding: "utf8",
  });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /refusing to run outside the plugin root/);
});

test("bootstrap reports a missing module argument", () => {
  const { spawnSync } = require("node:child_process");
  const result = spawnSync(process.execPath, [bootstrap], { encoding: "utf8" });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /missing module path/);
});

test("bootstrap runs the real CLI from an unrelated cwd", () => {
  const dir = tempDir();
  try {
    const { spawnSync } = require("node:child_process");
    const configDir = path.join(dir, "cfg");
    const result = spawnSync(process.execPath, [bootstrap, "bin/herdr-loadout.mjs", "list", "--compact"], {
      cwd: dir, // a caller's project, not the plugin directory
      env: { ...process.env, HERDR_PLUGIN_ROOT: pluginRoot, HERDR_PLUGIN_CONFIG_DIR: configDir },
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^builder \| /m);
  } finally {
    cleanup(dir);
  }
});
