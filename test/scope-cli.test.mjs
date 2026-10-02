import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { readConfigFile } from "../src/core/store.mjs";
import { renderList, renderShow } from "../src/core/format.mjs";
import { mergeProfiles } from "../src/core/merge.mjs";
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

const CLI = path.resolve("bin/herdr-loadout.mjs");

/** Run the real CLI from inside a project that has its own config. */
function withCli(fn, { project = PROJECT } = {}) {
  const dir = tempDir();
  try {
    const config = path.join(dir, "config");
    const root = path.join(dir, "project");
    const projectFile = path.join(root, ".herdr", "loadout.toml");
    fs.mkdirSync(config, { recursive: true });
    fs.mkdirSync(path.dirname(projectFile), { recursive: true });
    const globalFile = path.join(config, "loadout.toml");
    fs.writeFileSync(globalFile, GLOBAL);
    if (project !== null) fs.writeFileSync(projectFile, project);
    const env = { ...process.env, HERDR_PLUGIN_CONFIG_DIR: config, HERDR_PLUGIN_STATE_DIR: path.join(dir, "state") };
    const run = (...args) => spawnSync(process.execPath, [CLI, ...args], { cwd: root, env, encoding: "utf8" });
    fn({
      run,
      root,
      globalFile,
      projectFile,
      readGlobal: () => readConfigFile(globalFile).profiles,
      readProject: () => readConfigFile(projectFile).profiles,
    });
  } finally {
    cleanup(dir);
  }
}

const ids = (profiles) => profiles.map((entry) => entry.id);

test("list separates global and project profiles and says what an override changes", () => {
  withCli(({ run }) => {
    const out = run("list").stdout;
    const globalAt = out.indexOf("Global profiles");
    const projectAt = out.indexOf("Project profiles");
    assert.ok(globalAt >= 0 && projectAt > globalAt);
    assert.ok(out.indexOf("Builder") > globalAt && out.indexOf("Builder") < projectAt);
    assert.ok(out.indexOf("3D") > projectAt);
    assert.match(out, /Overridden: effort \(global: medium\)/);
    assert.match(out, /\.herdr[\\/]loadout\.toml/, "the project heading names the file");
  });
});

test("list announces an empty project section and keeps --compact undecorated", () => {
  withCli(({ run }) => {
    assert.match(run("list").stdout, /Project profiles \(none\)/);
    const compact = run("list", "--compact").stdout;
    assert.doesNotMatch(compact, /Global profiles|Project profiles/);
    assert.equal(compact.trim().split("\n").length, 2);
  }, { project: "version = 1\n" });
});

test("list --json carries what actually differs from global", () => {
  withCli(({ run }) => {
    const { profiles } = JSON.parse(run("list", "--json").stdout);
    assert.deepEqual(profiles.find((entry) => entry.id === "builder").differs, ["effort"]);
    assert.deepEqual(profiles.find((entry) => entry.id === "scout").differs, []);
  });
});

test("an override that restates the global value is not reported as a difference", () => {
  const { profiles } = mergeProfiles(
    [{ id: "b", name: "B", harness: "claude", model: "m", effort: "medium", when_to_use: "x" }],
    [{ id: "b", effort: "medium" }],
  );
  assert.deepEqual(profiles[0].differs, []);
  assert.deepEqual(profiles[0].overrides, ["effort"]);
});

test("show lists each overridden field with its global value", () => {
  withCli(({ run }) => {
    const out = run("show", "builder", "--project", ".").stdout;
    assert.match(out, /Overridden fields: effort \(global: medium\)/);
    assert.match(run("show", "three-d").stdout, /Source: project-only profile/);
  });
});

test("renderList and renderShow still work without global context", () => {
  const profile = { id: "b", name: "B", harness: "claude", model: "m", effort: "high", when_to_use: "x" };
  assert.match(renderList([{ ...profile, origin: "project-override", overrides: ["effort"], differs: ["effort"] }]), /Overridden: effort$/m);
  assert.match(renderShow({ ...profile, origin: "project-override", overrides: ["effort"] }), /Overridden fields: effort/);
});

test("set on the global profile does not copy the project override into global", () => {
  withCli(({ run, readGlobal, readProject }) => {
    const result = run("set", "builder", "--name", "Builder X");
    assert.equal(result.status, 0, result.stderr);
    const builder = readGlobal().find((entry) => entry.id === "builder");
    assert.equal(builder.name, "Builder X");
    assert.equal(builder.effort, "medium", "the override value stays out of global");
    assert.equal(readProject().find((entry) => entry.id === "builder").effort, "high");
  });
});

test("set on global warns when this project's override still shadows the field", () => {
  withCli(({ run }) => {
    const result = run("set", "builder", "--effort", "low", "--json");
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout).shadowed, ["effort"]);
    assert.match(run("set", "builder", "--effort", "medium").stdout, /override still sets effort/);
  });
});

test("set on a project-only profile needs --project", () => {
  withCli(({ run, readGlobal }) => {
    const result = run("set", "three-d", "--effort", "high");
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /only in the project; use --project/);
    assert.equal(readGlobal().length, 2);
  });
});

test("set --project stores only the difference and removes the override when it matches global", () => {
  withCli(({ run, readProject, readGlobal }) => {
    let result = run("set", "scout", "--model", "other", "--project", ".", "--json");
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout).changed, ["model"]);
    assert.deepEqual({ ...readProject().find((entry) => entry.id === "scout") }, { id: "scout", model: "other" });

    result = run("set", "scout", "--model", "test-model", "--project", ".", "--json");
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).overrideRemoved, true);
    assert.deepEqual(ids(readProject()), ["builder", "three-d"]);

    result = run("set", "scout", "--model", "test-model", "--project", ".");
    assert.match(result.stdout, /already matches global/);
    assert.equal(readGlobal().find((entry) => entry.id === "scout").model, "test-model");
  });
});

test("set --project on a project-only profile keeps its whole body", () => {
  withCli(({ run, readProject }) => {
    const result = run("set", "three-d", "--effort", "high", "--project", ".");
    assert.equal(result.status, 0, result.stderr);
    const stored = readProject().find((entry) => entry.id === "three-d");
    assert.equal(stored.effort, "high");
    assert.equal(stored.model, "test-model");
  });
});

test("reset removes a project override and leaves global alone", () => {
  withCli(({ run, readProject, readGlobal }) => {
    const result = run("reset", "builder", "--json");
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).reset, true);
    assert.deepEqual(ids(readProject()), ["three-d"]);
    assert.equal(readGlobal()[0].effort, "medium");
    assert.doesNotMatch(run("list").stdout, /Overridden/);
  });
});

test("reset explains why it cannot act", () => {
  withCli(({ run, readProject }) => {
    assert.match(run("reset", "scout").stderr, /no project override to reset/);
    assert.match(run("reset", "three-d").stderr, /no global profile to reset to/);
    assert.match(run("reset", "nope").stderr, /not found/);
    assert.equal(readProject().length, 2);
  });
});

test("remove on global also drops this project's override", () => {
  withCli(({ run, readGlobal, readProject }) => {
    const result = run("remove", "builder", "--json");
    assert.equal(result.status, 0, result.stderr);
    assert.ok(JSON.parse(result.stdout).overrideRemoved);
    assert.deepEqual(ids(readGlobal()), ["scout"]);
    assert.deepEqual(ids(readProject()), ["three-d"]);
  });
});

test("remove without --project points at the project when the profile only lives there", () => {
  withCli(({ run, readProject }) => {
    const result = run("remove", "three-d");
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /only in the project; use --project/);
    assert.equal(run("remove", "three-d", "--project", ".").status, 0);
    assert.deepEqual(ids(readProject()), ["builder"]);
  });
});

test("add --project refuses a global id and stores a project-only profile whole", () => {
  withCli(({ run, readProject }) => {
    const clash = run("add", "--id", "scout", "--name", "S", "--harness", "claude", "--model", "m", "--effort", "low", "--when", "x", "--project", ".");
    assert.notEqual(clash.status, 0);
    assert.match(clash.stderr, /already exists in global/);

    const result = run("add", "--id", "backend", "--name", "Backend", "--harness", "claude", "--model", "m", "--effort", "low", "--when", "API work.", "--project", ".");
    assert.equal(result.status, 0, result.stderr);
    const stored = readProject().find((entry) => entry.id === "backend");
    assert.equal(stored.model, "m");
    assert.equal(stored.when_to_use, "API work.");
  });
});

test("import --project turns a global id into an override and skips a no-op", () => {
  withCli(({ run, readProject, root }) => {
    const file = path.join(root, "in.json");
    fs.writeFileSync(file, JSON.stringify({
      profiles: [
        { id: "scout", effort: "high" },
        { id: "builder", effort: "medium" },
        { id: "extra", name: "Extra", harness: "claude", model: "m", effort: "low", when_to_use: "More." },
      ],
    }));
    const result = run("import", file, "--project", ".", "--json");
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.deepEqual(report.added.sort(), ["extra", "scout"]);
    assert.deepEqual(report.unchanged, ["builder"]);
    assert.deepEqual({ ...readProject().find((entry) => entry.id === "scout") }, { id: "scout", effort: "high" });
    assert.equal(readProject().find((entry) => entry.id === "extra").model, "m");
  });
});

test("--project writes to the project file in effect, found from a subfolder", () => {
  withCli(({ run, root, readProject }) => {
    const sub = path.join(root, "src", "deep");
    fs.mkdirSync(sub, { recursive: true });
    const result = run("set", "scout", "--effort", "high", "--project", sub);
    assert.equal(result.status, 0, result.stderr);
    assert.ok(!fs.existsSync(path.join(sub, ".herdr")), "no second project file is created below the real one");
    assert.equal(readProject().find((entry) => entry.id === "scout").effort, "high");
  });
});
