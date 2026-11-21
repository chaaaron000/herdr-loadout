import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { quoteArg } from "../src/core/command.mjs";
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

[[profiles]]
id = "quoted"
name = "Quoted"
harness = "pi"
model = "p/m"
effort = "low"
when_to_use = "Work with a JSON argument."
extra_args = ["--settings", '{"modelProvider":"gemini"}']
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
    fn({ run, pi, root: dir, env });
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
    // The CLI runs in `root`, and its cwd is the real path (macOS temp dirs sit behind /var -> /private/var).
    const project = fs.realpathSync(root);
    assert.deepEqual(envy.argv, [process.execPath, CLI, "exec", "envy", "--host", "hc", "--project", project]);
  });
});

test("launch --host hc routes an argument with a double quote through exec", () => {
  withCli(({ run, root }) => {
    // Windows PowerShell 5.1 strips the quotes from a JSON argument it passes on.
    const quoted = JSON.parse(run("launch", "quoted", "--json", "--host", "hc").stdout);
    assert.deepEqual(quoted.argv, [process.execPath, CLI, "exec", "quoted", "--host", "hc", "--project", fs.realpathSync(root)]);
  });
});

const hasSh = !spawnSync("sh", ["-c", "true"]).error;

test("command keeps env values out of the TUI line and reads them when it runs", () => {
  withCli(({ run, root, env }) => {
    const result = run("command", "envy", "--name", "w1", "--pane", "p7");
    assert.equal(result.status, 0, result.stderr);
    assert.ok(!result.stdout.includes("hello"), "the value must not be printed");
    const lines = result.stdout.trim().split("\n");
    assert.equal(lines.at(-1), "herdr agent start w1 --kind pi --pane p7 -- --model p/m --effort low");
    const word = lines.find((line) => line.startsWith("#") && line.includes("--env"))?.match(/--env ("LOADOUT_PROBE=.*")$/)?.[1];
    assert.ok(word, result.stdout);
    if (hasSh) {
      const expanded = spawnSync("sh", ["-c", `printf %s ${word}`], { cwd: root, env, encoding: "utf8" });
      assert.equal(expanded.stdout, "LOADOUT_PROBE=hello", expanded.stderr);
    }

    const open = run("command", "plain", "--cwd", root).stdout.trim().split("\n");
    assert.equal(open.at(-1), "herdr agent start <worker-name> --kind pi --pane <pane_id> -- --model p/m --effort low");
  });
});

test("launch --json and show mask env values; env-value prints the real one", () => {
  withCli(({ run }) => {
    assert.deepEqual(JSON.parse(run("launch", "envy", "--json").stdout).env, { LOADOUT_PROBE: "***" });
    assert.deepEqual(JSON.parse(run("show", "envy", "--json").stdout).env, { LOADOUT_PROBE: "***" });
    assert.ok(!run("show", "envy").stdout.includes("hello"));
    assert.equal(run("env-value", "envy", "LOADOUT_PROBE").stdout, "hello");
    assert.equal(run("env-value", "envy", "MISSING").status, 1);
  });
});

test("command prints an hc run line that sh parses back into the profile's argv", { skip: spawnSync("sh", ["-c", "true"]).error ? "no sh" : false }, () => {
  withCli(({ run, pi }) => {
    const cwd = path.resolve("/work dir");
    const line = run("command", "plain", "--host", "hc", "--name", "w1", "--space", "s1", "--tab", "t1", "--cwd", cwd).stdout.trim().split("\n").at(-1);
    const echo = `node -e 'console.log(JSON.stringify(process.argv.slice(1)))'`;
    const parsed = JSON.parse(spawnSync("sh", ["-c", `${echo} ${line}`], { encoding: "utf8" }).stdout);
    const fingerprint = parsed[14];
    assert.match(fingerprint, /^herdr-loadout\.fingerprint=[0-9a-f]{12}$/);
    assert.deepEqual(parsed, [
      "hc", "run", "--bg", "--name", "w1", "--cwd", cwd, "--label", "herdr.space=s1", "--label", "herdr.tab=t1",
      "--label", "herdr-loadout.profile=plain", "--label", fingerprint, "--", pi, "--model", "p/m", "--effort", "low",
    ]);
  });
});

test("quoteArg survives sh for values with quotes, spaces, and shell syntax", { skip: spawnSync("sh", ["-c", "true"]).error ? "no sh" : false }, () => {
  const values = ['{"modelProvider":"gemini"}', "it's", "a b", "C:\\Program Files\\x", "$HOME", "`t", "x;y", "a|b", ""];
  const echo = `node -e 'console.log(JSON.stringify(process.argv.slice(1)))'`;
  const out = spawnSync("sh", ["-c", `${echo} ${values.map((value) => quoteArg(value, "sh")).join(" ")}`], { encoding: "utf8" }).stdout;
  assert.deepEqual(JSON.parse(out), values);
  // PowerShell doubles a single quote inside single quotes and quotes its array comma.
  assert.equal(quoteArg("it's", "powershell"), "'it''s'");
  assert.equal(quoteArg("a,b", "powershell"), "'a,b'");
  assert.equal(quoteArg("C:\\x\\y", "powershell"), "C:\\x\\y");
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
