import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import React from "react";
import { render } from "ink";
import { App } from "../src/tui/app.mjs";
import { diffFields, overrideDelta, patchProfile, sameValue } from "../src/core/merge.mjs";
import { listWindow } from "../src/core/layout.mjs";
import { clipStartToWidth, displayWidth } from "../src/core/textwidth.mjs";
import { readConfigFile } from "../src/core/store.mjs";
import { cleanup, tempDir } from "./helpers.mjs";

const GLOBAL = `version = 1

[[profiles]]
id = "builder"
name = "Builder"
harness = "claude"
model = "test-model"
effort = "medium"
when_to_use = "Build things."

[[profiles]]
id = "scout"
name = "Scout"
harness = "claude"
model = "test-model"
effort = "low"
when_to_use = "Look around."
`;

const PROJECT = `version = 1

[[profiles]]
id = "builder"
effort = "high"

[[profiles]]
id = "three-d"
name = "3D"
harness = "claude"
model = "test-model"
effort = "low"
when_to_use = "3D work."
`;

const DOWN = "\u001b[B";
const ESC = "\u001b";

/** Run the TUI against a temp global config and a temp project with its own config. */
async function withApp(fn, { project = PROJECT, rows = 30, cols = 100 } = {}) {
  const dir = tempDir();
  const keys = ["HERDR_PLUGIN_CONFIG_DIR", "HERDR_PLUGIN_STATE_DIR", "PATH"];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  const stdin = new PassThrough();
  stdin.isTTY = true;
  stdin.setRawMode = () => {};
  stdin.ref = () => {};
  stdin.unref = () => {};
  const stdout = new PassThrough();
  stdout.columns = cols;
  stdout.rows = rows;
  const state = { screen: "" };
  stdout.on("data", (chunk) => {
    state.screen += chunk.toString();
  });
  let app;
  const settle = () => new Promise((resolve) => setTimeout(resolve, 60));
  try {
    process.env.HERDR_PLUGIN_CONFIG_DIR = dir;
    process.env.HERDR_PLUGIN_STATE_DIR = path.join(dir, "state");
    process.env.PATH = ""; // never start a real harness
    const globalFile = path.join(dir, "loadout.toml");
    const projectRoot = path.join(dir, "proj");
    const projectFile = path.join(projectRoot, ".herdr", "loadout.toml");
    fs.writeFileSync(globalFile, GLOBAL);
    if (project !== null) {
      fs.mkdirSync(path.dirname(projectFile), { recursive: true });
      fs.writeFileSync(projectFile, project);
    } else {
      fs.mkdirSync(projectRoot, { recursive: true });
    }
    app = render(React.createElement(App, { initialProject: projectRoot }), {
      stdin, stdout, stderr: stdout, debug: true, patchConsole: false, exitOnCtrlC: false,
    });
    await settle();
    const send = async (...inputs) => {
      for (const input of inputs) {
        stdin.write(input);
        await settle();
      }
    };
    // Last frame only: Ink repaints the whole frame on every change.
    const frame = () => state.screen.split("Agent Profiles").pop();
    await fn({ send, state, frame, globalFile, projectFile, readGlobal: () => readConfigFile(globalFile), readProject: () => readConfigFile(projectFile) });
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
}

test("the list separates global profiles from project profiles", async () => {
  await withApp(async ({ frame }) => {
    const screen = frame();
    const globalAt = screen.indexOf("Global profiles");
    const builderAt = screen.indexOf("Builder");
    const scoutAt = screen.indexOf("Scout");
    const projectAt = screen.indexOf("Project profiles");
    const threeDAt = screen.indexOf("3D");
    assert.ok(globalAt >= 0 && projectAt > globalAt, "both headings appear, global first");
    assert.ok(builderAt > globalAt && scoutAt > builderAt && scoutAt < projectAt, "global profiles sit under their heading");
    assert.ok(threeDAt > projectAt, "the project-only profile sits under the project heading");
    assert.match(screen, /\.herdr[\\/]loadout\.toml/, "the project heading names the file");
  });
});

test("an overridden global profile says which fields differ", async () => {
  await withApp(async ({ frame }) => {
    assert.match(frame(), /Builder\s+≠ effort/);
    assert.doesNotMatch(frame(), /Scout\s+≠/);
  });
});

test("an empty project section is still announced", async () => {
  await withApp(async ({ frame }) => {
    assert.match(frame(), /Project profiles \(none\)/);
  }, { project: "version = 1\n" });
});

test("r resets an override after confirmation and the profile follows global again", async () => {
  await withApp(async ({ send, frame, readProject, readGlobal }) => {
    await send("r");
    assert.match(frame(), /reset "Builder" to the global profile\?/);
    await send("y");
    assert.match(frame(), /reset builder/);
    assert.deepEqual(readProject().profiles.map((entry) => entry.id), ["three-d"]);
    assert.equal(readGlobal().profiles[0].effort, "medium", "global is untouched");
    assert.doesNotMatch(frame(), /Builder\s+≠/);
  });
});

test("r is refused on a profile without an override", async () => {
  await withApp(async ({ send, frame, readProject }) => {
    await send(DOWN, "r");
    assert.match(frame(), /no project override to reset/);
    assert.equal(readProject().profiles.length, 2);
  });
});

test("any other key cancels a reset", async () => {
  await withApp(async ({ send, readProject }) => {
    await send("r", "n");
    assert.equal(readProject().profiles.length, 2);
  });
});

test("saving to global does not bake the project override into the global profile", async () => {
  await withApp(async ({ send, frame, readGlobal, readProject }) => {
    // Builder is overridden to effort=high here; rename it and save to global.
    await send("\r", "\r", "X", "\r", "g");
    const builder = readGlobal().profiles.find((entry) => entry.id === "builder");
    assert.equal(builder.name, "BuilderX");
    assert.equal(builder.effort, "medium", "the override value stays out of global");
    assert.equal(readProject().profiles.find((entry) => entry.id === "builder").effort, "high");
    assert.match(frame(), /saved builder to global/);
  });
});

test("p saves only what differs from global as a project override", async () => {
  await withApp(async ({ send, frame, readGlobal, readProject }) => {
    await send(DOWN, "\r", "\r", "X", "\r", "p"); // Scout: rename, save to project
    const entry = readProject().profiles.find((profile) => profile.id === "scout");
    assert.deepEqual({ ...entry }, { id: "scout", name: "ScoutX" });
    assert.equal(readGlobal().profiles[1].name, "Scout", "global is untouched");
    assert.match(frame(), /saved scout as project override \(name\)/);
  });
});

test("r in the editor puts a field back to global, and p then drops the empty override", async () => {
  await withApp(async ({ send, frame, readProject }) => {
    await send("\r", DOWN, DOWN, DOWN); // Builder -> Effort (overridden to high)
    assert.match(frame(), /≠ global: medium/);
    await send("r");
    assert.match(frame(), /Effort back to the global value/);
    await send("p");
    assert.match(frame(), /matches global again/);
    assert.deepEqual(readProject().profiles.map((entry) => entry.id), ["three-d"]);
  });
});

test("p with nothing different from global writes nothing", async () => {
  await withApp(async ({ send, frame, readProject }) => {
    await send(DOWN, "\r", "p"); // Scout, untouched
    assert.match(frame(), /no differences from global/);
    assert.equal(readProject().profiles.length, 2);
  });
});

test("a project-only profile saves with p and refuses g", async () => {
  await withApp(async ({ send, frame, readGlobal, readProject }) => {
    await send(DOWN, DOWN, "\r", "\r", "X", "\r", "g");
    assert.match(frame(), /no global copy/);
    assert.equal(readGlobal().profiles.length, 2, "nothing was written to global");
    await send("p");
    assert.match(frame(), /saved three-d to project/);
    const stored = readProject().profiles.find((entry) => entry.id === "three-d");
    assert.equal(stored.name, "3DX");
    assert.equal(stored.model, "test-model", "a project profile stores its whole body");
    assert.equal(readGlobal().profiles.length, 2);
  });
});

test("a copy goes to the chosen target and cannot overwrite an existing id", async () => {
  await withApp(async ({ send, frame, readGlobal, readProject }) => {
    await send("c", "g");
    assert.match(frame(), /saved builder-copy to global/);
    assert.ok(readGlobal().profiles.some((entry) => entry.id === "builder-copy"));

    await send("c", "g"); // the same copy id again
    assert.match(frame(), /"builder-copy" already exists in global/);

    await send(ESC, ESC);
    await send(DOWN, DOWN, "c", "p"); // third row is the other global copy source; copy to project
    assert.ok(readProject().profiles.some((entry) => entry.id.endsWith("-copy")));
  });
});

test("deleting an overridden global profile also removes its override", async () => {
  await withApp(async ({ send, frame, readGlobal, readProject }) => {
    await send("d");
    assert.match(frame(), /delete "Builder" from global and its project override\?/);
    await send("y");
    assert.deepEqual(readGlobal().profiles.map((entry) => entry.id), ["scout"]);
    assert.deepEqual(readProject().profiles.map((entry) => entry.id), ["three-d"]);
  });
});

test("the editor names the target of each save key", async () => {
  await withApp(async ({ send, frame }) => {
    await send(DOWN, "\r");
    assert.match(frame(), /global profile · g global · p project override/);
    assert.match(frame(), /g save global/);
    assert.match(frame(), /p save project/);
    await send(ESC, DOWN, "\r");
    assert.match(frame(), /project profile · p saves to/);
    assert.doesNotMatch(frame(), /g save global/);
  });
});

test("diffFields compares resolved values, not what the project file lists", () => {
  const base = { id: "b", name: "B", harness: "claude", model: "m", effort: "medium", when_to_use: "x" };
  assert.deepEqual(diffFields({ ...base, effort: "high" }, base), ["effort"]);
  assert.deepEqual(diffFields({ ...base }, base), [], "restating the global value is not a difference");
  assert.deepEqual(diffFields({ ...base, tags: [], sandbox: "" }, base), [], "empty means unset");
  assert.deepEqual(diffFields({ ...base, effort: "high" }, null), [], "no global profile, nothing to compare");
});

test("sameValue treats every empty shape as unset", () => {
  assert.equal(sameValue(undefined, ""), true);
  assert.equal(sameValue([], undefined), true);
  assert.equal(sameValue({}, null), true);
  assert.equal(sameValue("a", ""), false);
  assert.equal(sameValue(["a"], []), false);
});

test("patchProfile applies only the edits made since the baseline", () => {
  const global = { id: "b", name: "B", harness: "claude", model: "m", effort: "medium", when_to_use: "x", tags: ["t"] };
  const baseline = { ...global, effort: "high" }; // what the editor opened with (override applied)
  const draft = { ...baseline, name: "B2", tags: [] };
  const next = patchProfile(global, baseline, draft);
  assert.equal(next.name, "B2");
  assert.equal(next.effort, "medium", "an untouched overridden field keeps the global value");
  assert.equal(next.tags, undefined, "a cleared list is removed");
  assert.equal(global.name, "B", "the input is not mutated");
});

test("overrideDelta ignores an empty value that global also leaves unset", () => {
  const global = { id: "b", name: "B", harness: "claude", model: "m", effort: "medium", when_to_use: "x" };
  const { entry, changed } = overrideDelta({ ...global, sandbox: "", tags: [] }, global);
  assert.deepEqual(changed, []);
  assert.deepEqual(entry, { id: "b" });
});

test("listWindow leaves room for the section headings", () => {
  const without = listWindow(30, 100, 50);
  const withHeaders = listWindow(30, 100, 50, { headerRows: 2 });
  assert.ok(withHeaders.visible <= without.visible);
  assert.ok(withHeaders.visible >= 1);
  assert.ok(listWindow(8, 40, 50, { headerRows: 2 }).visible >= 1, "never collapses to nothing");
});

test("clipStartToWidth keeps the tail of a path", () => {
  const clipped = clipStartToWidth("D:\\work\\projects\\game\\.herdr\\loadout.toml", 20);
  assert.ok(displayWidth(clipped) <= 20);
  assert.ok(clipped.startsWith("…"));
  assert.ok(clipped.endsWith("loadout.toml"));
  assert.equal(clipStartToWidth("short", 20), "short");
  assert.ok(displayWidth(clipStartToWidth("프로젝트/경로/설정/loadout.toml", 14)) <= 14, "wide characters count as two columns");
});
