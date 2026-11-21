import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import {
  agentsMdStatus,
  BLOCK_END,
  BLOCK_START,
  blockText,
  hasImport,
  installAgentsMd,
  recordDecline,
  resolveProjectRoot,
} from "../src/core/agents-md.mjs";
import { cleanup, tempDir } from "./helpers.mjs";

const CLI = path.resolve("bin/herdr-loadout.mjs");
const BLOCK = blockText();

/** The import region install appends; built from lines so no `\n@` reads as an e-mail address. */
const importRegion = (line) => `${[BLOCK_START, line, BLOCK_END].join("\n")}\n`;

function withProject(fn) {
  const dir = tempDir();
  try {
    const project = path.join(dir, "project");
    fs.mkdirSync(path.join(project, ".git"), { recursive: true });
    const env = { HERDR_PLUGIN_STATE_DIR: path.join(dir, "state"), CLAUDE_CONFIG_DIR: path.join(dir, "claude") };
    const home = path.join(dir, "home");
    const opts = { projectRoot: project, env, home };
    fn({ dir, project, env, home, opts, file: (name) => path.join(project, name) });
  } finally {
    cleanup(dir);
  }
}

const read = (file) => fs.readFileSync(file, "utf8");
const write = (file, text) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};

test("the shipped block is marked, keeps the worker rule, and names only commands the CLI has", () => {
  const lines = BLOCK.split("\n");
  assert.equal(lines[0], BLOCK_START);
  assert.equal(lines.at(-1), BLOCK_END);
  assert.match(BLOCK, /`\[Worker-<name>\]` makes you a worker/);
  const usage = spawnSync(process.execPath, [CLI, "--help"], { encoding: "utf8" }).stdout;
  for (const [, command] of BLOCK.matchAll(/`herdr-loadout ([a-z-]+)/g)) {
    assert.ok(usage.includes(`herdr-loadout ${command} `), `usage lists ${command}`);
  }
});

test("a project without AGENTS.md gets one; installing again changes nothing", () => {
  withProject(({ opts, file }) => {
    assert.equal(agentsMdStatus(opts).state, "missing");
    assert.equal(agentsMdStatus(opts).exists, false);

    const first = installAgentsMd(opts);
    assert.deepEqual(first.changes, [{ file: file("AGENTS.md"), action: "created" }]);
    assert.equal(read(file("AGENTS.md")), `${BLOCK}\n`);
    assert.equal(first.status.state, "current");

    const again = installAgentsMd(opts);
    assert.deepEqual(again.changes, [{ file: file("AGENTS.md"), action: "unchanged" }]);
    assert.equal(read(file("AGENTS.md")), `${BLOCK}\n`);
  });
});

test("an existing AGENTS.md keeps every byte outside the markers, and its CRLF line endings", () => {
  withProject(({ opts, file }) => {
    const own = "# Project\r\n\r\nRun `npm test`.";
    write(file("AGENTS.md"), own);
    assert.equal(agentsMdStatus(opts).state, "missing");

    installAgentsMd(opts);
    const text = read(file("AGENTS.md"));
    assert.ok(text.startsWith(`${own}\r\n\r\n${BLOCK_START}\r\n`));
    assert.equal(text.replace(/\r\n/g, "\n").split("\n").length, text.split("\r\n").length, "no bare LF");
    assert.equal(agentsMdStatus(opts).state, "current");

    const once = read(file("AGENTS.md"));
    installAgentsMd(opts);
    assert.equal(read(file("AGENTS.md")), once);
  });
});

test("updating AGENTS.md preserves mixed line separators outside the block", () => {
  withProject(({ opts, file }) => {
    const before = "# Existing LF heading\n\n";
    const after = "\n## Existing LF content\nNo final newline";
    write(file("AGENTS.md"), `${before}${[BLOCK_START, "Old", BLOCK_END].join("\r\n")}${after}`);

    assert.equal(installAgentsMd(opts).status.state, "current");
    const updated = read(file("AGENTS.md"));
    assert.equal(updated.slice(0, updated.indexOf(BLOCK_START)), before);
    assert.equal(updated.slice(updated.indexOf(BLOCK_END) + BLOCK_END.length), after);
  });
});

test("appending to a whitespace-only AGENTS.md preserves the original bytes", () => {
  withProject(({ opts, file }) => {
    const before = " \t\r\n\r\n";
    write(file("AGENTS.md"), before);

    assert.equal(installAgentsMd(opts).status.state, "current");
    assert.equal(read(file("AGENTS.md")).slice(0, before.length), before);
  });
});

test("an outdated block is reported and replaced between its markers only", () => {
  withProject(({ opts, file }) => {
    const before = "# Top\n\nkeep me\n";
    const after = "\n## After\n\nkeep me too\n";
    write(file("AGENTS.md"), `${before}${BLOCK_START}\n## Delegation\n\nUse Herdr workers when delegation is beneficial.\n${BLOCK_END}${after}`);
    const status = agentsMdStatus(opts);
    assert.equal(status.state, "outdated");
    assert.equal(status.block, "outdated");

    const result = installAgentsMd(opts);
    assert.equal(result.changes[0].action, "updated");
    assert.equal(read(file("AGENTS.md")), `${before}${BLOCK}${after}`);
    assert.equal(result.status.state, "current");
  });
});

test("broken markers are reported, and install leaves every file alone", () => {
  withProject(({ opts, file }) => {
    const broken = `# Top\n${BLOCK_START}\nhalf a block\n`;
    write(file("AGENTS.md"), broken);
    write(file("CLAUDE.md"), "# Claude\n");
    const status = agentsMdStatus(opts);
    assert.equal(status.state, "outdated");
    assert.match(status.problem, /found 1 and 0/);

    const result = installAgentsMd(opts);
    assert.equal(result.ok, false);
    assert.equal(read(file("AGENTS.md")), broken);
    assert.equal(read(file("CLAUDE.md")), "# Claude\n");
  });
});

test("install rejects broken markers even when CLAUDE.md already imports AGENTS.md", () => {
  withProject(({ opts, file }) => {
    const before = ["# Claude rules", BLOCK_START, "@AGENTS.md", ""].join("\n");
    write(file("CLAUDE.md"), before);

    assert.equal(installAgentsMd(opts).ok, false);
    assert.equal(fs.existsSync(file("AGENTS.md")), false);
    assert.equal(read(file("CLAUDE.md")), before);
  });
});

test("a decline is kept in the state dir, not the project, and install drops it", () => {
  withProject(({ opts, project, env }) => {
    const record = recordDecline(project, { env });
    assert.equal(path.dirname(record.file), env.HERDR_PLUGIN_STATE_DIR);
    assert.deepEqual(fs.readdirSync(project), [".git"]);
    const status = agentsMdStatus(opts);
    assert.equal(status.state, "declined");
    assert.equal(status.declined, record.declined);

    // A decline in one project says nothing about another.
    const other = path.join(path.dirname(project), "other");
    fs.mkdirSync(other);
    assert.equal(agentsMdStatus({ ...opts, projectRoot: other }).state, "missing");

    const result = installAgentsMd(opts);
    assert.equal(result.undeclined, true);
    assert.equal(result.status.state, "current");
    assert.equal(result.status.declined, null);
  });
});

test("Claude Code files that hide AGENTS.md get an @AGENTS.md import; a user's own import counts", () => {
  withProject(({ opts, file }) => {
    write(file("AGENTS.md"), `${BLOCK}\n`);
    write(file("CLAUDE.md"), "# Claude rules\n");
    const status = agentsMdStatus(opts);
    assert.equal(status.state, "missing");
    assert.deepEqual(status.imports.map(({ relative, present, readers }) => ({ relative, present, readers })), [
      { relative: "CLAUDE.md", present: false, readers: ["claude"] },
    ]);

    const result = installAgentsMd(opts);
    assert.deepEqual(result.changes.map(({ action }) => action), ["unchanged", "updated"]);
    assert.equal(read(file("CLAUDE.md")), `# Claude rules\n\n${importRegion("@AGENTS.md")}`);
    assert.equal(result.status.state, "current");
    assert.deepEqual(installAgentsMd(opts).changes.map(({ action }) => action), ["unchanged"]);
    assert.equal(read(file("CLAUDE.md")), `# Claude rules\n\n${importRegion("@AGENTS.md")}`);
  });

  withProject(({ opts, file }) => {
    write(file("AGENTS.md"), `${BLOCK}\n`);
    write(file("CLAUDE.md"), "See @AGENTS.md for the shared rules.\n");
    assert.equal(agentsMdStatus(opts).state, "current");
    write(file("CLAUDE.md"), ["Not an import: `@AGENTS.md`", "```", "@AGENTS.md", "```", ""].join("\n"));
    assert.equal(agentsMdStatus(opts).state, "missing");
  });
});

test(".claude/CLAUDE.md imports ../AGENTS.md, which serves Claude Code and omp at once", () => {
  withProject(({ opts, file }) => {
    write(file(".claude/CLAUDE.md"), "# Claude rules\n");
    const status = agentsMdStatus(opts);
    assert.deepEqual(status.imports.map(({ relative, line, readers }) => ({ relative, line, readers })), [
      { relative: ".claude/CLAUDE.md", line: "@../AGENTS.md", readers: ["claude", "omp"] },
    ]);
    installAgentsMd(opts);
    assert.ok(read(file(".claude/CLAUDE.md")).endsWith(importRegion("@../AGENTS.md")));
    assert.equal(agentsMdStatus(opts).state, "current");
  });
});

test("omp's own .omp/AGENTS.md hides AGENTS.md unless empty", () => {
  withProject(({ opts, file }) => {
    write(file(".omp/AGENTS.md"), "   \n");
    assert.deepEqual(agentsMdStatus(opts).imports, []);
    write(file(".omp/AGENTS.md"), "# omp rules\n");
    assert.deepEqual(agentsMdStatus(opts).imports.map(({ relative, readers }) => [relative, readers]), [[".omp/AGENTS.md", ["omp"]]]);
    installAgentsMd(opts);
    assert.ok(hasImport(read(file(".omp/AGENTS.md")), "@../AGENTS.md"));
    assert.equal(agentsMdStatus(opts).state, "current");
  });
});

test("a Claude Code set to read only CLAUDE.md, or --claude-md, gets a CLAUDE.md that imports AGENTS.md", () => {
  withProject(({ opts, env, file }) => {
    assert.deepEqual(agentsMdStatus(opts).imports, []);
    write(path.join(env.CLAUDE_CONFIG_DIR, "settings.json"), JSON.stringify({
      pluginConfigs: { "cc-plugin-agents-md@builtin": { options: { instructionFiles: "claude-md" } } },
    }));
    const status = agentsMdStatus(opts);
    assert.equal(status.claudeSetting, "claude-md");
    assert.deepEqual(status.imports.map(({ relative, exists }) => [relative, exists]), [["CLAUDE.md", false]]);
    const result = installAgentsMd(opts);
    assert.deepEqual(result.changes.map(({ action }) => action), ["created", "created"]);
    assert.equal(read(file("CLAUDE.md")), importRegion("@AGENTS.md"));
  });

  withProject(({ opts, file }) => {
    installAgentsMd({ ...opts, claudeMd: true });
    assert.equal(read(file("CLAUDE.md")), importRegion("@AGENTS.md"));
  });
});

test("AGENTS.override.md is reported, never edited", () => {
  withProject(({ opts, file }) => {
    write(file("AGENTS.override.md"), "# override\n");
    const result = installAgentsMd(opts);
    assert.match(result.status.notes.join("\n"), /codex and pi read it instead/);
    assert.equal(read(file("AGENTS.override.md")), "# override\n");
  });
});

test("the project root is the nearest folder with .git or .herdr", () => {
  withProject(({ dir, project, home }) => {
    const deep = path.join(project, "src", "deep");
    fs.mkdirSync(deep, { recursive: true });
    assert.equal(resolveProjectRoot({ start: deep, home }), project);
    assert.equal(resolveProjectRoot({ project: dir, start: deep, home }), path.resolve(dir));
  });
});

test("the CLI prints the block, reports and installs with --json, records a decline, and rejects unknown actions", () => {
  withProject(({ dir, project, env }) => {
    const run = (...args) =>
      spawnSync(process.execPath, [CLI, "agents-md", ...args], { env: { ...process.env, ...env, HOME: path.join(dir, "home"), USERPROFILE: path.join(dir, "home") }, encoding: "utf8" });

    const printed = run("print");
    assert.equal(printed.status, 0);
    assert.equal(printed.stdout, `${BLOCK}\n`);

    const missing = run("--project", project, "--json");
    assert.equal(missing.status, 0, missing.stderr);
    assert.equal(JSON.parse(missing.stdout).state, "missing");

    const declined = run("decline", "--project", project, "--json");
    assert.equal(declined.status, 0, declined.stderr);
    assert.match(run("status", "--project", project).stdout, /^state: declined$/m);

    const installed = run("install", "--project", project, "--json");
    assert.equal(installed.status, 0, installed.stderr);
    assert.equal(JSON.parse(installed.stdout).status.state, "current");
    assert.equal(read(path.join(project, "AGENTS.md")), `${BLOCK}\n`);

    assert.equal(run("remove", "--project", project).status, 2);
  });
});
