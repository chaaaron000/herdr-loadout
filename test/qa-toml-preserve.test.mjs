import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { parse } from "smol-toml";
import { cleanup, tempDir } from "./helpers.mjs";

const cli = fileURLToPath(new URL("../bin/herdr-loadout.mjs", import.meta.url));
const profile = '[[profiles]]\nid = "a"\nname = "A"\nharness = "claude"\nmodel = "m"\neffort = "low"\nwhen_to_use = "work"\n';

function withRegistry(globalText, projectText, check) {
  const dir = tempDir("qa-toml-preserve-");
  try {
    const config = path.join(dir, "config");
    const state = path.join(dir, "state");
    const project = path.join(dir, "project");
    const globalFile = path.join(config, "loadout.toml");
    const projectFile = path.join(project, ".herdr", "loadout.toml");
    for (const folder of [config, state, path.dirname(projectFile)]) fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(globalFile, globalText);
    fs.writeFileSync(projectFile, projectText);
    const env = { ...process.env, HERDR_PLUGIN_CONFIG_DIR: config, HERDR_PLUGIN_STATE_DIR: state };
    const run = (...args) => {
      const result = spawnSync(process.execPath, [cli, ...args], { cwd: project, env, encoding: "utf8" });
      assert.ifError(result.error);
      return result;
    };
    const editor = (action, input) => {
      const result = run("editor", action, "--project", project, "--input", JSON.stringify(input));
      assert.equal(result.status, 0, result.stderr);
      return JSON.parse(result.stdout);
    };
    check({ run, editor, global: () => fs.readFileSync(globalFile, "utf8"), project: () => fs.readFileSync(projectFile, "utf8") });
  } finally {
    cleanup(dir);
  }
}

test("set name preserves a hand-authored env key named __proto__", () => {
  const before = `${profile}env = { "__proto__" = "keep", OK = "v" } # keep inline\n`;
  withRegistry(before, "", ({ run, global }) => {
    const result = run("set", "a", "--name", "A2");
    if (result.status !== 0) {
      assert.match(result.stderr, /file is unchanged/);
      assert.equal(global(), before);
      return;
    }
    const saved = global();
    assert.equal(Object.getOwnPropertyDescriptor(parse(saved).profiles[0].env, "__proto__")?.value, "keep");
    assert.equal(saved, before.replace('name = "A"', 'name = "A2"'));
  });
});

test("add --env keeps an entry named __proto__", () => {
  withRegistry(profile, "", ({ run, global }) => {
    const result = run("add", "--id", "b", "--name", "B", "--harness", "claude", "--model", "m", "--effort", "low", "--when", "work", "--env", "__proto__=x", "--env", "Z=1");
    assert.equal(result.status, 0, result.stderr);
    const env = parse(global()).profiles[1].env;
    assert.deepEqual(Object.entries(env), [["__proto__", "x"], ["Z", "1"]]);
  });
});

test("editor save removing env does not remove standalone comments", () => {
  const before = `${profile}\n[profiles.env]\n# retained prose\nA = "one" # removed with A\n\n[profiles.x_meta]\nkeep = true\n`;
  withRegistry(before, "", ({ editor, global }) => {
    const opened = editor("open", { id: "a", mode: "edit" });
    assert.equal(opened.ok, true, opened.error);
    const { env, ...draft } = opened.draft;
    const saved = editor("save", { draft, baseline: opened.baseline, kind: opened.kind, target: "global" });
    if (!saved.ok) {
      assert.match(saved.error, /file is unchanged/);
      assert.equal(global(), before);
      return;
    }
    assert.equal(global(), before.replace("[profiles.env]\n", "").replace('A = "one" # removed with A\n', ""));
  });
});

for (const route of ["CLI", "editor"]) {
  test(`${route} deletion reports an unsafe project override instead of false success`, () => {
    const beforeGlobal = `# global\nversion = 1\n\n${profile}`;
    const beforeProject = '# project\nprofiles = [{ id = "a", model = "local" }]\n';
    withRegistry(beforeGlobal, beforeProject, ({ run, editor, global, project }) => {
      const result = route === "CLI"
        ? (() => {
          const r = run("remove", "a", "--json");
          return { ...JSON.parse(r.stdout), status: r.status };
        })()
        : editor("remove", { id: "a", action: "delete", confirmed: true });
      if (result.ok) {
        assert.equal(parse(project()).profiles?.some(({ id }) => id === "a") ?? false, false,
          `Reported successful deletion but override remains: ${JSON.stringify(result)}`);
        assert.equal(parse(global()).profiles?.some(({ id }) => id === "a") ?? false, false);
      } else {
        if (route === "CLI") assert.notEqual(result.status, 0);
        assert.equal(global(), beforeGlobal, "refusing the project edit must not partially delete the global entry");
        assert.equal(project(), beforeProject);
      }
    });
  });
}
