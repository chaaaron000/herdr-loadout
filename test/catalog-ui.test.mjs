import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import React from "react";
import { render } from "ink";
import { App } from "../src/tui/app.mjs";
import { cleanup, fakeCli, tempDir } from "./helpers.mjs";

test("a cached catalog is re-read behind the pane, so a restored login shows up", async () => {
  const dir = tempDir();
  const keys = ["HERDR_PLUGIN_CONFIG_DIR", "HERDR_PLUGIN_STATE_DIR", "HERDR_LOADOUT_OFFLINE", "PATH"];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  const stdin = new PassThrough();
  stdin.isTTY = true;
  stdin.setRawMode = () => {};
  stdin.ref = () => {};
  stdin.unref = () => {};
  const stdout = new PassThrough();
  stdout.columns = 100;
  stdout.rows = 30;
  let screen = "";
  stdout.on("data", (chunk) => {
    screen += chunk.toString();
  });
  let app;
  try {
    const bin = path.join(dir, "bin");
    const stateDir = path.join(dir, "state");
    process.env.HERDR_PLUGIN_CONFIG_DIR = dir;
    process.env.HERDR_PLUGIN_STATE_DIR = stateDir;
    process.env.HERDR_LOADOUT_OFFLINE = "1"; // no catalog refresh over the network
    process.env.PATH = bin; // the only harness is the stand-in below

    // omp now lists a provider that was logged out when the cache was written.
    fakeCli(bin, "omp", '{"models":[{"selector":"ollama/x"},{"selector":"anthropic/claude-opus-5"}]}');
    fs.mkdirSync(path.join(stateDir, "models"), { recursive: true });
    fs.writeFileSync(path.join(stateDir, "models", "omp.json"), JSON.stringify({ fetchedAt: Date.now(), models: [{ id: "ollama/x" }] }));
    fs.writeFileSync(path.join(dir, "loadout.toml"), "version = 1\n");

    app = render(React.createElement(App, { initialProject: dir }), {
      stdin, stdout, stderr: stdout, debug: true, patchConsole: false, exitOnCtrlC: false,
    });
    await new Promise((resolve) => setTimeout(resolve, 60));
    stdin.write("j"); // the detect view counts each harness's models

    const frame = () => screen.split("Agent Profiles").pop();
    for (let waited = 0; waited < 10000 && !/omp\s+✓ detected — 2 models/.test(frame()); waited += 50) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.match(screen, /omp\s+✓ detected — 1 models/, "the cached list is shown first");
    assert.match(frame(), /omp\s+✓ detected — 2 models/, "then the CLI's current list replaces it");
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
