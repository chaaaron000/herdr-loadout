import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { createTask, detectHost, resolveTaskRoot } from "../src/core/task.mjs";
import { cleanup, tempDir } from "./helpers.mjs";

const NOW = new Date(2026, 10, 21, 9, 30);
const APP = { HC_TERMINAL_ID: "t7" };
const CLI = path.resolve("bin/herdr-loadout.mjs");

function withProject(fn) {
  const dir = tempDir();
  try {
    const project = path.join(dir, "project");
    fs.mkdirSync(path.join(project, ".herdr"), { recursive: true });
    fn({ dir, project, home: path.join(dir, "home") });
  } finally {
    cleanup(dir);
  }
}

const read = (file) => fs.readFileSync(file, "utf8");
const lastLine = (text) => text.trimEnd().split("\n").at(-1);

test("built-in templates carry the task id, the address, and the app's notify command", () => {
  withProject(({ project, home }) => {
    const result = createTask({ slug: "api-auth", projectStart: project, worker: "builder-auth", profile: "builder", env: APP, now: NOW, home });
    assert.equal(result.ok, true);
    assert.equal(result.task, "API-AUTH");
    assert.equal(result.dir, path.join(project, ".herdr", "runs", "2026-11-21-api-auth"));
    assert.deepEqual(result.templates, { brief: "built-in", report: "built-in" });

    const brief = read(result.brief);
    const report = ".herdr/runs/2026-11-21-api-auth/report.md";
    assert.match(brief, /- Worker: `builder-auth` \(profile `builder`\)/);
    assert.match(brief, /- Orchestrator: `t7` \(Herdr app\)/);
    assert.ok(brief.includes(`hc send t7 "[Report-builder-auth] <MARKER> ${report}"`));
    assert.ok(brief.includes("`API-AUTH-COMPLETE`") && brief.includes("`API-AUTH-BLOCKED`"));
    for (const section of ["Goal", "Scope", "Inputs", "Done when", "Forbidden", "Report"]) {
      assert.match(brief, new RegExp(`^## ${section}$`, "m"));
    }
    assert.doesNotMatch(brief, /\{\{/);
    assert.equal(result.prompt, `[Worker-builder-auth] Read .herdr/runs/2026-11-21-api-auth/brief.md and do it. Report in ${report}.`);

    // An untouched report must not read as finished to an orchestrator checking its last line.
    const last = lastLine(read(result.report));
    assert.ok(last.includes("API-AUTH-COMPLETE"));
    assert.notEqual(last, "API-AUTH-COMPLETE");
  });
});

test("a project's templates replace the built-in ones and keep unknown placeholders", () => {
  withProject(({ project, home }) => {
    const templates = path.join(project, ".herdr", "templates");
    fs.mkdirSync(templates);
    fs.writeFileSync(path.join(templates, "brief.md"), "{{task}} for {{worker}} -> {{notify}} {{unknown}}\n");
    const result = createTask({ slug: "x1", projectStart: project, worker: "w", env: APP, now: NOW, home });
    assert.equal(read(result.brief), 'X1 for w -> hc send t7 "[Report-w] <MARKER> .herdr/runs/2026-11-21-x1/report.md" {{unknown}}\n');
    assert.equal(result.templates.brief, path.join(templates, "brief.md"));
    assert.equal(result.templates.report, "built-in");
  });
});

test("runs/.gitignore is written only when runs/ is created, and an existing task folder is refused", () => {
  withProject(({ project, home }) => {
    const gitignore = path.join(project, ".herdr", "runs", ".gitignore");
    const first = createTask({ slug: "one", projectStart: project, env: APP, now: NOW, home });
    assert.equal(first.gitignore, gitignore);
    assert.equal(read(gitignore), "*\n");

    fs.writeFileSync(gitignore, "kept\n");
    const second = createTask({ slug: "two", projectStart: project, env: APP, now: NOW, home });
    assert.equal(second.gitignore, null);
    assert.equal(read(gitignore), "kept\n");

    fs.writeFileSync(first.brief, "edited\n");
    const again = createTask({ slug: "one", projectStart: project, env: APP, now: NOW, home });
    assert.equal(again.ok, false);
    assert.equal(again.usage, undefined);
    assert.match(again.error, /already exists/);
    assert.equal(read(first.brief), "edited\n");
  });
});

test("the TUI wins over an inherited app address and reports through herdr agent prompt", () => {
  const env = { HERDR_ENV: "1", HERDR_PANE_ID: "w1:p3", HC_TERMINAL_ID: "t9" };
  assert.equal(detectHost(env), "herdr");
  withProject(({ project, home }) => {
    const result = createTask({ slug: "tui", projectStart: project, worker: "w", env, now: NOW, home });
    assert.equal(result.orchestrator, "w1:p3");
    assert.equal(result.notify, 'herdr agent prompt w1:p3 "[Report-w] <MARKER> .herdr/runs/2026-11-21-tui/report.md"');

    const forced = createTask({ slug: "forced", projectStart: project, worker: "w", host: "hc", to: "lead", env, now: NOW, home });
    assert.equal(forced.notify, 'hc send lead "[Report-w] <MARKER> .herdr/runs/2026-11-21-forced/report.md"');
  });
});

test("a missing address or worker becomes a placeholder with a warning; no host is a usage error", () => {
  withProject(({ project, home }) => {
    const result = createTask({ slug: "gap", projectStart: project, host: "herdr", env: {}, now: NOW, home });
    assert.equal(result.ok, true);
    assert.equal(result.orchestrator, null);
    assert.match(read(result.brief), /herdr agent prompt <orchestrator> "\[Report-<worker-name>\]/);
    assert.equal(result.warnings.length, 2);

    const outside = createTask({ slug: "nowhere", projectStart: project, env: {}, now: NOW, home });
    assert.equal(outside.usage, true);
    assert.match(outside.error, /--host/);
  });
});

test("slugs, worker names, and addresses are validated before anything is written", () => {
  withProject(({ project, home }) => {
    for (const input of [{ slug: "Bad" }, { slug: "a--b" }, { slug: "-a" }, { slug: "ok", worker: "9w" }, { slug: "ok", to: "t1 && rm" }]) {
      const result = createTask({ ...input, projectStart: project, env: APP, now: NOW, home });
      assert.equal(result.usage, true, JSON.stringify(input));
    }
    assert.equal(fs.existsSync(path.join(project, ".herdr", "runs")), false);
  });
});

test("the project root is the nearest .herdr up the tree, never the one in the home directory", () => {
  withProject(({ dir, project }) => {
    const deep = path.join(project, "src", "deep");
    fs.mkdirSync(deep, { recursive: true });
    assert.equal(resolveTaskRoot(deep, { home: path.join(dir, "home") }), project);

    const home = path.join(dir, "home");
    const bare = path.join(home, "code", "bare");
    fs.mkdirSync(path.join(home, ".herdr"), { recursive: true });
    fs.mkdirSync(bare, { recursive: true });
    assert.equal(resolveTaskRoot(bare, { home }), bare);
  });
});

test("the CLI prints JSON and exits 2 on bad input, 1 on an existing folder", () => {
  withProject(({ project }) => {
    const env = { ...process.env, HC_TERMINAL_ID: "t4" };
    delete env.HERDR_ENV;
    const run = (...args) => spawnSync(process.execPath, [CLI, "task", "new", ...args, "--project", project], { env, encoding: "utf8" });

    const ok = run("cli-task", "--worker", "w", "--json");
    assert.equal(ok.status, 0, ok.stderr);
    const result = JSON.parse(ok.stdout);
    assert.equal(result.orchestrator, "t4");
    assert.ok(fs.existsSync(result.report));

    assert.equal(run("cli-task", "--json").status, 1);
    assert.equal(run("Bad").status, 2);
    const text = run("second", "--worker", "w");
    assert.equal(text.status, 0, text.stderr);
    assert.match(lastLine(text.stdout), /^\[Worker-w\] Read \.herdr\/runs\/\d{4}-\d{2}-\d{2}-second\/brief\.md and do it\. Report in /);
  });
});
