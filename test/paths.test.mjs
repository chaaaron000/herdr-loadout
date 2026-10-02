import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { cleanup, tempDir } from "./helpers.mjs";
import {
  configDir,
  findProjectConfig,
  globalConfigPath,
  projectConfigPath,
  rootCandidates,
  sourceRoot,
  stateDir,
} from "../src/core/paths.mjs";

test("config dir follows HERDR_PLUGIN_CONFIG_DIR when present", () => {
  const env = { HERDR_PLUGIN_CONFIG_DIR: path.join("C:", "tmp", "plugins", "config", "herdr-loadout") };
  assert.equal(configDir(env), path.resolve(env.HERDR_PLUGIN_CONFIG_DIR));
  assert.equal(globalConfigPath(env), path.join(path.resolve(env.HERDR_PLUGIN_CONFIG_DIR), "loadout.toml"));
});

test("config dir falls back to the herdr plugin path without env", () => {
  const env = { APPDATA: path.join("C:", "Users", "tester", "AppData", "Roaming") };
  const dir = configDir(env);
  assert.ok(dir.endsWith(path.join("herdr", "plugins", "config", "herdr-loadout")), dir);
  assert.ok(dir.startsWith(env.APPDATA));
  assert.ok(globalConfigPath(env).endsWith("loadout.toml"));
});

test("state dir prefers HERDR_PLUGIN_STATE_DIR", () => {
  const env = { HERDR_PLUGIN_STATE_DIR: path.join("C:", "state", "herdr-loadout") };
  assert.equal(stateDir(env), path.resolve(env.HERDR_PLUGIN_STATE_DIR));
});

test("every resolution path yields the same config file", () => {
  // the shim, the linked checkout, and a bare shell must agree on loadout.toml
  const fromEnv = globalConfigPath({ HERDR_PLUGIN_CONFIG_DIR: path.join("X:", "cfg") });
  assert.equal(fromEnv, path.join(path.resolve(path.join("X:", "cfg")), "loadout.toml"));
  assert.equal(sourceRoot(), path.resolve(sourceRoot()));
  assert.ok(rootCandidates({}).length >= 1);
  assert.ok(rootCandidates({ HERDR_PLUGIN_ROOT: "Y:" }).length >= 2);
});

test("project config is discovered upward from a nested directory", () => {
  const dir = tempDir();
  try {
    const projectRoot = path.join(dir, "repo");
    const nested = path.join(projectRoot, "src", "deep", "nested");
    const configFile = projectConfigPath(projectRoot);
    fs.mkdirSync(nested, { recursive: true });
    fs.mkdirSync(path.dirname(configFile), { recursive: true });
    fs.writeFileSync(configFile, "version = 1\n");

    assert.equal(findProjectConfig(nested), configFile);
    assert.equal(findProjectConfig(projectRoot), configFile);
    assert.equal(findProjectConfig(dir), null, "does not leak outside the project");
  } finally {
    cleanup(dir);
  }
});

test("projectConfigPath points into .herdr of the given root", () => {
  assert.equal(
    projectConfigPath("D:/work/repo"),
    path.join(path.resolve("D:/work/repo"), ".herdr", "loadout.toml"),
  );
});
