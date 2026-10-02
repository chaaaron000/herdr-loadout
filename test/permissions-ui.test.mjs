import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import React from "react";
import { render } from "ink";
import { App } from "../src/tui/app.mjs";
import { readConfigFile } from "../src/core/store.mjs";
import { cleanup, tempDir } from "./helpers.mjs";

for (const scenario of [
  { harness: "claude", field: "permission_mode", initial: "plan", selected: "manual", cursor: 4, label: /Permissions/ },
  { harness: "codex", field: "sandbox", initial: "workspace-write", selected: "read-only", cursor: 4, label: /Sandbox \(Codex\)/ },
  { harness: "codex", field: "approval_policy", initial: "on-request", selected: "never", cursor: 5, label: /Approval \(Codex\)/ },
]) {
test(`TUI edits and saves ${scenario.harness} ${scenario.field} with only supported fields visible`, async () => {
  const dir = tempDir();
  const keys = ["HERDR_PLUGIN_CONFIG_DIR", "HERDR_PLUGIN_STATE_DIR", "PATH"];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  const stdin = new PassThrough();
  stdin.isTTY = true;
  stdin.setRawMode = () => {};
  stdin.ref = () => {};
  stdin.unref = () => {};
  const stdout = new PassThrough();
  stdout.columns = 85;
  stdout.rows = 24;
  let screen = "";
  stdout.on("data", (chunk) => { screen += chunk.toString(); });
  let app;
  const settle = () => new Promise((resolve) => setTimeout(resolve, 60));
  const send = async (key) => { stdin.write(key); await settle(); };
  try {
    process.env.HERDR_PLUGIN_CONFIG_DIR = dir;
    process.env.HERDR_PLUGIN_STATE_DIR = path.join(dir, "state");
    process.env.PATH = ""; // Catalog fallback only; never start a real harness.
    const config = path.join(dir, "loadout.toml");
    fs.writeFileSync(config, `version = 1\n[[profiles]]\nid = "ui-test"\nname = "UI Test"\nharness = "${scenario.harness}"\nmodel = "test-model"\neffort = "high"\nwhen_to_use = "Test editing."\n${scenario.field} = "${scenario.initial}"\n`);
    app = render(React.createElement(App, { initialProject: dir }), {
      stdin, stdout, stderr: stdout, debug: true, patchConsole: false, exitOnCtrlC: false,
    });
    await settle();
    await send("\r");
    for (let i = 0; i < scenario.cursor; i++) await send("\u001b[B");
    assert.match(screen, scenario.label);
    assert.doesNotMatch(screen, /not supported/);
    if (scenario.harness === "claude") assert.doesNotMatch(screen, /Sandbox \(Codex\)|Approval \(Codex\)/);
    else assert.doesNotMatch(screen, /Permissions/);
    screen = "";
    await send("\r");
    assert.ok(screen.includes(`> ${scenario.initial}`), "the picker should focus the saved permission");
    await send("/");
    await send(scenario.selected);
    await send("\r");
    await send("g");
    assert.equal(readConfigFile(config).profiles[0][scenario.field], scenario.selected);
    assert.match(screen, /saved ui-test to global/);
  } finally {
    app?.unmount();
    stdin.destroy();
    stdout.destroy();
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
    cleanup(dir);
  }
});
}
