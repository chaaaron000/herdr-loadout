import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { cleanup, tempDir } from "./helpers.mjs";
import { configDir, sourceRoot } from "../src/core/paths.mjs";
import { launchers } from "../scripts/setup-shim.mjs";

const shimScript = path.join(sourceRoot(), "scripts", "setup-shim.mjs");

test("setup-shim writes cmd, ps1, and sh launchers", async () => {
  const dir = tempDir();
  const savedEnv = process.env.HERDR_PLUGIN_CONFIG_DIR;
  try {
    process.env.HERDR_PLUGIN_CONFIG_DIR = dir;
    const result = spawnSync(process.execPath, [shimScript], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);

    const cmd = path.join(dir, "herdr-loadout.cmd");
    const ps1 = path.join(dir, "herdr-loadout.ps1");
    const sh = path.join(dir, "herdr-loadout");
    for (const file of [cmd, ps1, sh]) {
      assert.ok(fs.existsSync(file), `${file} must exist`);
    }

    assert.match(fs.readFileSync(cmd, "utf8"), /bin[\\/]herdr-loadout\.mjs/);
    assert.match(fs.readFileSync(ps1, "utf8"), /@args/);
    const shim = fs.readFileSync(sh, "utf8");
    assert.match(shim, /^#!\/usr\/bin\/env sh\n/, "POSIX shim needs a portable shebang");
    assert.match(shim, /"\$@"/);
    assert.ok(!shim.includes("\r\n"), "POSIX shim must not use CRLF line endings");
  } finally {
    if (savedEnv === undefined) delete process.env.HERDR_PLUGIN_CONFIG_DIR;
    else process.env.HERDR_PLUGIN_CONFIG_DIR = savedEnv;
    cleanup(dir);
  }
});

test("launchers point at the generated config directory", () => {
  const dir = tempDir();
  const savedEnv = process.env.HERDR_PLUGIN_CONFIG_DIR;
  try {
    process.env.HERDR_PLUGIN_CONFIG_DIR = dir;
    assert.equal(configDir(), path.resolve(dir));
  } finally {
    if (savedEnv === undefined) delete process.env.HERDR_PLUGIN_CONFIG_DIR;
    else process.env.HERDR_PLUGIN_CONFIG_DIR = savedEnv;
    cleanup(dir);
  }
});

function runShim(args, env = {}) {
  return spawnSync(process.execPath, [shimScript, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

test("setup-shim --dir installs into the given folder and leaves the config dir alone", () => {
  const target = tempDir();
  const config = tempDir();
  try {
    const result = runShim(["--dir", target], { HERDR_PLUGIN_CONFIG_DIR: config });
    assert.equal(result.status, 0, result.stderr);
    assert.ok(fs.existsSync(path.join(target, "herdr-loadout.cmd")));
    assert.deepEqual(fs.readdirSync(config), [], "--dir must not also write to the config dir");
  } finally {
    cleanup(target);
    cleanup(config);
  }
});

test("setup-shim --refresh rewrites existing launchers only", () => {
  const config = tempDir();
  try {
    const stale = path.join(config, "herdr-loadout.cmd");
    fs.writeFileSync(stale, "stale");
    const result = runShim(["--refresh"], { HERDR_PLUGIN_CONFIG_DIR: config });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "", "a startup hook must stay silent");
    assert.match(fs.readFileSync(stale, "utf8"), /bin[\\/]herdr-loadout\.mjs/);
    assert.ok(!fs.existsSync(path.join(config, "herdr-loadout")), "refresh must not create new launchers");
  } finally {
    cleanup(config);
  }
});

test("setup-shim --refresh creates nothing when no launcher was ever installed", () => {
  const parent = tempDir();
  const config = path.join(parent, "never-created");
  try {
    const result = runShim(["--refresh"], { HERDR_PLUGIN_CONFIG_DIR: config });
    assert.equal(result.status, 0, result.stderr);
    assert.ok(!fs.existsSync(config));
  } finally {
    cleanup(parent);
  }
});

test("a launcher reports a moved plugin instead of failing obscurely", () => {
  const config = tempDir();
  try {
    const sh = launchers(path.join(config, "gone", "herdr-loadout.mjs"))["herdr-loadout"];
    const file = path.join(config, "herdr-loadout");
    fs.writeFileSync(file, sh);
    const result = spawnSync("sh", [file], { encoding: "utf8" });
    if (result.error) return; // no POSIX sh on this machine
    assert.equal(result.status, 1);
    assert.match(result.stderr, /install-shim/);
  } finally {
    cleanup(config);
  }
});
