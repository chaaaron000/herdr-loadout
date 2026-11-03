import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { cleanup, tempDir } from "./helpers.mjs";

const CLI = path.resolve("bin/herdr-loadout.mjs");

const CONFIG = `version = 1

[[profiles]]
id = "plain"
name = "Plain"
harness = "pi"
model = "p/m"
effort = "low"
when_to_use = "Plain work."

[[profiles]]
id = "envy"
name = "Envy"
harness = "pi"
model = "p/m"
effort = "low"
when_to_use = "Work that needs a variable."
env = { LOADOUT_PROBE = "hello" }
`;

/** A stand-in `pi` that echoes its environment variable and arguments, then exits 7. */
function fakePi(dir) {
  const win = process.platform === "win32";
  const file = path.join(dir, win ? "pi.cmd" : "pi");
  const body = win
    ? "@echo env=%LOADOUT_PROBE% args=%*\r\n@exit /b 7\r\n"
    : '#!/bin/sh\necho "env=$LOADOUT_PROBE args=$*"\nexit 7\n';
  fs.writeFileSync(file, body, { mode: 0o755 });
  return file;
}

function withCli(fn) {
  const dir = tempDir();
  try {
    const config = path.join(dir, "config");
    const bin = path.join(dir, "bin");
    fs.mkdirSync(config, { recursive: true });
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(config, "loadout.toml"), CONFIG);
    const pi = fakePi(bin);
    // Windows keys are case-insensitive; a leftover `Path` would shadow ours.
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== "path"));
    Object.assign(env, {
      PATH: `${bin}${path.delimiter}${process.env.PATH ?? process.env.Path ?? ""}`,
      HERDR_PLUGIN_CONFIG_DIR: config,
      HERDR_PLUGIN_STATE_DIR: path.join(dir, "state"),
      HERDR_LOADOUT_OFFLINE: "1",
    });
    const run = (...args) => spawnSync(process.execPath, [CLI, ...args], { cwd: dir, env, encoding: "utf8" });
    fn({ run, pi, root: dir });
  } finally {
    cleanup(dir);
  }
}

test("launch --host hc gives the harness argv, or exec when the profile sets env", () => {
  withCli(({ run, pi, root }) => {
    const plain = JSON.parse(run("launch", "plain", "--json", "--host", "hc").stdout);
    assert.equal(plain.ok, true);
    assert.deepEqual(plain.argv, [pi, ...plain.args]);

    // hc run cannot set environment variables, so the CLI applies them itself.
    const envy = JSON.parse(run("launch", "envy", "--json", "--host", "hc").stdout);
    assert.deepEqual(envy.argv, [process.execPath, CLI, "exec", "envy", "--host", "hc", "--project", root]);
  });
});

test("exec starts the harness with the profile's env and returns its exit code", () => {
  withCli(({ run }) => {
    const result = run("exec", "envy", "--host", "hc");
    assert.equal(result.status, 7);
    assert.match(result.stdout, /env=hello args=--model p\/m --effort low/);
  });
});

test("--host rejects an unknown host", () => {
  withCli(({ run }) => {
    const result = run("launch", "plain", "--host", "tmux");
    assert.equal(result.status, 2);
    assert.match(result.stderr, /--host must be one of: herdr, hc/);
  });
});
