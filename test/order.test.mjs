import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { readConfigFile, reorderProfiles } from "../src/core/store.mjs";
import { cleanup, tempDir } from "./helpers.mjs";

const profile = (id, extra = "") =>
  `[[profiles]]\nid = "${id}"\nname = "${id.toUpperCase()}"\nharness = "claude"\nmodel = "m"\neffort = "low"\nwhen_to_use = "${id} work."\n${extra}`;

// a, b, c are global; the project overrides b (listed first in its file) and
// adds p and q of its own.
const GLOBAL = `# registry comment
version = 1

# about a
${profile("a", 'user_note = "keep me"  # trailing comment\n\n[profiles.env]\nFOO = "1"\n')}
${profile("b")}
${profile("c")}`;

const PROJECT = `version = 1

[[profiles]]
id = "b"
effort = "high"

${profile("p")}
${profile("q")}`;

const CLI = path.resolve("bin/herdr-loadout.mjs");

/** A throwaway registry; `run` is the real CLI pointed at it, from inside the project. */
function withRegistry(fn, { global = GLOBAL } = {}) {
  const dir = tempDir();
  try {
    const config = path.join(dir, "config");
    const root = path.join(dir, "project");
    const globalFile = path.join(config, "loadout.toml");
    const projectFile = path.join(root, ".herdr", "loadout.toml");
    fs.mkdirSync(config, { recursive: true });
    fs.mkdirSync(path.dirname(projectFile), { recursive: true });
    fs.writeFileSync(globalFile, global);
    fs.writeFileSync(projectFile, PROJECT);
    const env = { ...process.env, HERDR_PLUGIN_CONFIG_DIR: config, HERDR_PLUGIN_STATE_DIR: path.join(dir, "state") };
    const run = (...args) => spawnSync(process.execPath, [CLI, ...args], { cwd: root, env, encoding: "utf8" });
    const editor = (action, input) => JSON.parse(run("editor", action, "--input", JSON.stringify(input)).stdout);
    const ids = (file) => readConfigFile(file).doc.profiles.map((entry) => entry.id);
    fn({ run, editor, root, globalFile, projectFile, ids, listed: () => editor("state", {}).profiles.map((entry) => entry.id) });
  } finally {
    cleanup(dir);
  }
}

test("reordering moves whole blocks and keeps comments, unknown keys, sub-tables and line endings", () => {
  const dir = tempDir();
  try {
    const file = path.join(dir, "loadout.toml");
    fs.writeFileSync(file, GLOBAL.replace(/\n/g, "\r\n"));
    const result = reorderProfiles(file, ["c", "a", "b"]);
    assert.equal(result.ok, true, result.errors.join());
    const text = fs.readFileSync(file, "utf8");
    assert.ok(!/[^\r]\n/.test(text), "CRLF stays CRLF");
    assert.ok(text.startsWith("# registry comment\r\nversion = 1\r\n"), "the head of the file stays put");
    assert.match(text, /# about a\r\n\[\[profiles\]\]\r\nid = "a"/, "a comment above a profile moves with it");
    assert.match(text, /user_note = "keep me"  # trailing comment/);
    const doc = readConfigFile(file).doc;
    assert.deepEqual(doc.profiles.map((entry) => entry.id), ["c", "a", "b"]);
    assert.equal(doc.profiles[1].env.FOO, "1", "a profile keeps its sub-table");
  } finally {
    cleanup(dir);
  }
});

/** Write `text` to a temp config, reorder it to `ids`, and return the result with the bytes after. */
function reorderText(text, ids) {
  const dir = tempDir();
  try {
    const file = path.join(dir, "loadout.toml");
    fs.writeFileSync(file, text);
    const result = reorderProfiles(file, ids);
    return { result, after: fs.readFileSync(file, "utf8") };
  } finally {
    cleanup(dir);
  }
}

// QA round 1, C4: one preamble comment, then a and b.
const HEAD = "version = 1\n\n# KEEP-ME\n\n";
const A = profile("a");
const B = profile("b");

test("a [[profiles]] line inside a multi-line string is text, not a profile", () => {
  for (const quotes of ['"""', "'''"]) {
    const a = profile("a", `notes = ${quotes}\nqa\n[[profiles]]\n[extra]\nexample${quotes}\n`);
    const { result, after } = reorderText(`${HEAD}${a}\n${B}`, ["b", "a"]);
    assert.equal(result.ok, true, result.errors.join());
    assert.equal(after, `${HEAD}${B}\n${a}`, `${quotes}: only the two blocks swap`);
  }
});

test("a header-like line inside a multi-line array is a value, not a table", () => {
  const a = profile("a", 'args = [\n  ["x"]\n]\n');
  const { result, after } = reorderText(`${HEAD}${a}\n${B}`, ["b", "a"]);
  assert.equal(result.ok, true, result.errors.join());
  assert.equal(after, `${HEAD}${B}\n${a}`);
});

test("a table between two profiles keeps its slot and its comments", () => {
  const extra = "# about extra\n[extra]\nvalue = 1 # INLINE\n\n";
  const { result, after } = reorderText(`${HEAD}${A}\n${extra}${B}`, ["b", "a"]);
  assert.equal(result.ok, true, result.errors.join());
  assert.equal(after, `${HEAD}${B}\n${extra}${A}`);
});

test("every line keeps its own line ending, and a missing final newline stays missing", () => {
  const a = A.replace('id = "a"\n', 'id = "a"\r\n'); // one CRLF in an LF file
  const mixed = reorderText(`${HEAD}${a}\n${B}`, ["b", "a"]);
  assert.equal(mixed.after, `${HEAD}${B}\n${a}`);

  const bare = reorderText(`${HEAD}${A}\n${B.trimEnd()}`, ["b", "a"]);
  assert.equal(bare.after, `${HEAD}${B}\n${A.trimEnd()}`, "the block that moved up gains a newline; the new last line loses it");
});

test("a quoted top-level table containing a dot keeps its slot between profiles", () => {
  const extra = '# unrelated table\n["profiles.env"]\nEXAMPLE = "other"\n\n';
  const { result, after } = reorderText(`${HEAD}${A}\n${extra}${B}`, ["b", "a"]);
  assert.equal(result.ok, true, result.errors.join());
  assert.equal(after, `${HEAD}${B}\n${extra}${A}`);
});

test("quoted header keys are read as key parts: a ] inside a quoted sub-table key, a quoted [[profiles]]", () => {
  const sub = '[profiles."x]y"]\nk = 1\n';
  const nested = reorderText(`${HEAD}${A}${sub}\n${B}`, ["b", "a"]);
  assert.equal(nested.result.ok, true, nested.result.errors.join());
  assert.equal(nested.after, `${HEAD}${B}\n${A}${sub}`, "the sub-table moves with its profile");

  const a = A.replace("[[profiles]]", '[[ "profiles" ]]');
  const quoted = reorderText(`${HEAD}${a}\n${B}`, ["b", "a"]);
  assert.equal(quoted.result.ok, true, quoted.result.errors.join());
  assert.equal(quoted.after, `${HEAD}${B}\n${a}`);
});

test("moving a bare EOF line keeps the displaced CRLF at the block boundary", () => {
  const a = `${A.trimEnd()}\r\n`;
  const { result, after } = reorderText(`${HEAD}${a}\n${B.trimEnd()}`, ["b", "a"]);
  assert.equal(result.ok, true, result.errors.join());
  assert.equal(after, `${HEAD}${B.trimEnd()}\r\n\n${A.trimEnd()}`);
});

test("reorder refuses invalid UTF-8 instead of overwriting undecodable bytes", () => {
  const dir = tempDir();
  try {
    const file = path.join(dir, "loadout.toml");
    const before = Buffer.concat([
      Buffer.from(`${HEAD}# malformed: `),
      Buffer.from([0x80]),
      Buffer.from(`\n\n${A}\n${B}`),
    ]);
    fs.writeFileSync(file, before);
    const result = reorderProfiles(file, ["b", "a"]);
    assert.deepEqual(fs.readFileSync(file), before);
    assert.equal(result.ok, false);
  } finally {
    cleanup(dir);
  }
});

test("a layout that cannot be reordered as blocks is refused and the file is left as it was", () => {
  const layouts = {
    "inline array": 'version = 1\n# KEEP\nprofiles = [{ id = "a" }, { id = "b" }]\n',
    "sub-table apart from its profile": `${HEAD}${A}\n${B}\n[extra]\nvalue = 1\n\n[profiles.env]\nFOO = "1"\n`,
  };
  for (const [name, text] of Object.entries(layouts)) {
    const { result, after } = reorderText(text, ["b", "a"]);
    assert.equal(result.ok, false, name);
    assert.match(result.errors[0], /not reordered, the file is unchanged/, name);
    assert.equal(after, text, `${name}: no byte changes`);
  }
});

test("move refuses with exit 1 and writes nothing when the file cannot be reordered as blocks", () => {
  const global = `${HEAD}${A}\n${B}\n${profile("c")}\n[extra]\nvalue = 1\n\n[profiles.env]\nFOO = "1"\n`;
  withRegistry(({ run, globalFile, ids }) => {
    const result = run("move", "b", "--up");
    assert.equal(result.status, 1);
    assert.match(result.stderr, /not reordered, the file is unchanged: a \[profiles\.…\] table stands apart/);
    assert.equal(fs.readFileSync(globalFile, "utf8"), global);
    const json = JSON.parse(run("move", "b", "--up", "--json").stdout);
    assert.equal(json.ok, false);
    assert.deepEqual(ids(globalFile), ["a", "b", "c"]);
  }, { global });
});

test("move up, down, before and after reorder global profiles in the global file and the list", () => {
  withRegistry(({ run, globalFile, projectFile, ids, listed }) => {
    const projectBefore = fs.readFileSync(projectFile, "utf8");
    let result = run("move", "c", "--up");
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /moved c up/);
    assert.deepEqual(ids(globalFile), ["a", "c", "b"]);

    assert.equal(run("move", "a", "--after", "b").status, 0);
    assert.deepEqual(ids(globalFile), ["c", "b", "a"]);
    assert.equal(run("move", "a", "--before", "c").status, 0);
    assert.deepEqual(ids(globalFile), ["a", "c", "b"]);
    assert.equal(run("move", "a", "--down").status, 0);
    assert.deepEqual(ids(globalFile), ["c", "a", "b"]);

    assert.deepEqual(listed(), ["c", "a", "b", "p", "q"]);
    assert.deepEqual(run("list", "--compact").stdout.trim().split("\n").map((line) => line.split(" | ")[0]), ["c", "a", "b", "p", "q"]);
    assert.equal(fs.readFileSync(projectFile, "utf8"), projectBefore, "a global move leaves the project file alone");
    assert.equal(readConfigFile(globalFile).doc.profiles[1].user_note, "keep me");
  });
});

test("an overridden profile moves with its global profile; the override's place never counts", () => {
  withRegistry(({ run, globalFile, projectFile, ids, listed }) => {
    // b's override is first in the project file, yet b is listed after a.
    assert.deepEqual(listed(), ["a", "b", "c", "p", "q"]);
    const result = JSON.parse(run("move", "b", "--down", "--json").stdout);
    assert.equal(result.scope, "global");
    assert.equal(result.path, globalFile);
    assert.equal(result.index, 2);
    assert.deepEqual(ids(globalFile), ["a", "c", "b"]);
    assert.deepEqual(ids(projectFile), ["b", "p", "q"], "the override stays where it was");
    assert.equal(readConfigFile(projectFile).doc.profiles[0].effort, "high");
  });
});

test("a project profile moves within the project file, around the override entries", () => {
  withRegistry(({ run, globalFile, projectFile, ids, listed }) => {
    const globalBefore = fs.readFileSync(globalFile, "utf8");
    const result = JSON.parse(run("move", "q", "--up", "--json").stdout);
    assert.equal(result.scope, "project");
    assert.equal(result.index, 3, "q is first among the project profiles, after the three global ones");
    assert.deepEqual(ids(projectFile), ["b", "q", "p"]);
    assert.deepEqual(listed(), ["a", "b", "c", "q", "p"]);
    assert.equal(fs.readFileSync(globalFile, "utf8"), globalBefore);
  });
});

test("moving past either end, an unknown id, and a move across groups change nothing", () => {
  withRegistry(({ run, globalFile, projectFile }) => {
    const before = [fs.readFileSync(globalFile, "utf8"), fs.readFileSync(projectFile, "utf8")];
    const first = JSON.parse(run("move", "a", "--up", "--json").stdout);
    assert.deepEqual([first.ok, first.moved, first.index], [true, false, 0]);
    const last = run("move", "q", "--down");
    assert.equal(last.status, 0);
    assert.match(last.stdout, /q is already last among the project profiles/);
    const lastGlobal = JSON.parse(run("move", "c", "--down", "--json").stdout);
    assert.deepEqual([lastGlobal.moved, lastGlobal.index], [false, 2]);

    const unknown = run("move", "nope", "--up");
    assert.equal(unknown.status, 1);
    assert.match(unknown.stderr, /profile "nope" not found/);
    const across = run("move", "a", "--before", "p");
    assert.equal(across.status, 1);
    assert.match(across.stderr, /a profile moves only among the global profiles/);
    assert.equal(run("move", "a").status, 2, "a move needs a direction");
    assert.equal(run("move", "a", "--up", "--down").status, 2, "and only one");
    assert.deepEqual([fs.readFileSync(globalFile, "utf8"), fs.readFileSync(projectFile, "utf8")], before);
  });
});

test("the app editor's move action reorders and says where the profile now is", () => {
  withRegistry(({ editor, globalFile, ids, listed }) => {
    const moved = editor("move", { id: "c", direction: "up" });
    assert.equal(moved.ok, true, moved.error);
    assert.deepEqual([moved.moved, moved.index], [true, 1]);
    assert.deepEqual(ids(globalFile), ["a", "c", "b"]);
    assert.deepEqual(listed(), ["a", "c", "b", "p", "q"]);

    assert.equal(editor("move", { id: "p", direction: "up" }).moved, false);
    assert.equal(editor("move", { id: "nope", direction: "up" }).ok, false);
    assert.match(editor("move", { id: "a", direction: "sideways" }).error, /unknown direction/);
  });
});
