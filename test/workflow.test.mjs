import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { defaultWorkflowText, initWorkflow, loadWorkflow, renderWorkflow } from "../src/core/workflow.mjs";
import { cleanup, tempDir } from "./helpers.mjs";

function withDirs(fn) {
  const dir = tempDir();
  try {
    const env = { HERDR_PLUGIN_CONFIG_DIR: path.join(dir, "config") };
    const project = path.join(dir, "project");
    fs.mkdirSync(path.join(project, "src", "deep"), { recursive: true });
    fn({ env, project, globalFile: path.join(dir, "config", "workflow.md") });
  } finally {
    cleanup(dir);
  }
}

test("without files the built-in default applies, and a new project file goes beside loadout.toml", () => {
  withDirs(({ env, project }) => {
    fs.mkdirSync(path.join(project, ".herdr"), { recursive: true });
    fs.writeFileSync(path.join(project, ".herdr", "loadout.toml"), "version = 1\n");
    const workflow = loadWorkflow({ projectRoot: path.join(project, "src", "deep"), env });
    assert.equal(workflow.global.builtIn, true);
    assert.equal(workflow.global.text, defaultWorkflowText());
    assert.deepEqual(workflow.project, { path: path.join(project, ".herdr", "workflow.md"), exists: false, text: null });
  });
});

test("project rules come after the global workflow and are marked as winning", () => {
  withDirs(({ env, project, globalFile }) => {
    fs.mkdirSync(path.dirname(globalFile), { recursive: true });
    fs.writeFileSync(globalFile, "# Mine\n\n- Global rule.\n");
    fs.mkdirSync(path.join(project, ".herdr"), { recursive: true });
    fs.writeFileSync(path.join(project, ".herdr", "workflow.md"), "- Project rule.\n");

    const text = renderWorkflow(loadWorkflow({ projectRoot: path.join(project, "src"), env }));
    assert.ok(text.indexOf("- Global rule.") < text.indexOf("- Project rule."));
    assert.match(text, /Where the two conflict, follow these\.\n\n- Project rule\./);
    assert.ok(!text.includes(defaultWorkflowText().trim()), "a global file replaces the built-in default");
  });
});

test("init copies the default to the global file once and gives a project an empty template", () => {
  withDirs(({ env, project, globalFile }) => {
    const created = initWorkflow({ scope: "global", projectRoot: project, env });
    assert.deepEqual(created, { ok: true, path: globalFile });
    assert.equal(fs.readFileSync(globalFile, "utf8"), defaultWorkflowText());
    fs.writeFileSync(globalFile, "edited\n");
    assert.match(initWorkflow({ scope: "global", projectRoot: project, env }).error, /already exists/);
    assert.equal(fs.readFileSync(globalFile, "utf8"), "edited\n");

    const local = initWorkflow({ scope: "project", projectRoot: project, env });
    assert.equal(local.path, path.join(project, ".herdr", "workflow.md"));
    assert.equal(loadWorkflow({ projectRoot: project, env }).project.exists, true);
  });
});
