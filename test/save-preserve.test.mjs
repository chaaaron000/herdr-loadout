/**
 * Every save edits the registry as text: only the keys and blocks it was asked
 * to change, so comments, unknown keys, other tables, line endings, a BOM and
 * a missing final newline survive. Each test compares exact bytes.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { deleteProfile, readConfigFile, upsertProfile } from "../src/core/store.mjs";
import { cleanup, tempDir } from "./helpers.mjs";

const BOM = "\uFEFF";
const crlf = (text) => `${text}\r\n`;
const lf = (text) => `${text}\n`;

// Global file: a BOM, CRLF lines with one LF line, no final newline, comments
// everywhere, unknown keys at the top level, in a profile and as a sub-table,
// a table between the two profiles, and a multi-line array.
const GLOBAL = [
  crlf(`${BOM}# registry preamble`), // 0
  crlf("version = 1"), // 1
  crlf('top_note = "keep" # top inline'), // 2
  crlf(""), // 3
  crlf("# about a"), // 4
  crlf("[[profiles]]"), // 5
  crlf('id = "a"'), // 6
  crlf('name = "A" # name inline'), // 7
  crlf('harness = "claude"'), // 8
  crlf('model = "m"'), // 9
  lf('effort = "low"'), // 10
  crlf('when_to_use = "a work."'), // 11
  crlf("tags = ["), // 12
  crlf('  "one", # first tag'), // 13
  crlf('  "two",'), // 14
  crlf("] # tags inline"), // 15
  crlf('x_note = "a unknown"'), // 16
  crlf(""), // 17
  crlf("[profiles.env]"), // 18
  crlf("# env comment"), // 19
  crlf('FOO = "1" # foo inline'), // 20
  crlf(""), // 21
  crlf("[profiles.x_meta]"), // 22
  crlf('owner = "me"'), // 23
  crlf(""), // 24
  crlf("[extra] # extra inline"), // 25
  crlf("value = 1"), // 26
  crlf(""), // 27
  crlf("# about b"), // 28
  crlf("[[profiles]]"), // 29
  crlf('id = "b"'), // 30
  crlf('name = "B"'), // 31
  crlf('harness = "claude"'), // 32
  crlf('model = "m"'), // 33
  crlf('effort = "low"'), // 34
  crlf('when_to_use = "b work."'), // 35
  crlf('x_note = "b unknown"'), // 36
  crlf(""), // 37
  crlf("# tail comment"), // 38
  crlf("[tail] # tail inline"), // 39
  'last = "yes"', // 40, no final newline
];

// Project file: LF, an override of a with an unknown key, and a project-only p.
const PROJECT = [
  lf("# project preamble"), // 0
  lf("version = 1"), // 1
  lf(""), // 2
  lf("# override of a"), // 3
  lf("[[profiles]]"), // 4
  lf('id = "a"'), // 5
  lf('effort = "high" # effort inline'), // 6
  lf('model = "pm"'), // 7
  lf('x_local = "keep"'), // 8
  lf(""), // 9
  lf("# project only"), // 10
  lf("[[profiles]]"), // 11
  lf('id = "p"'), // 12
  lf('name = "P"'), // 13
  lf('harness = "claude"'), // 14
  lf('model = "m"'), // 15
  lf('effort = "low"'), // 16
  lf('when_to_use = "p work."'), // 17
];

/** `lines` with `count` lines from `at` replaced by `insert`, joined. */
function splice(lines, at, count, ...insert) {
  const copy = [...lines];
  copy.splice(at, count, ...insert);
  return copy;
}

const CLI = path.resolve("bin/herdr-loadout.mjs");

function withRegistry(fn, { global = GLOBAL.join(""), project = PROJECT.join("") } = {}) {
  const dir = tempDir();
  try {
    const config = path.join(dir, "config");
    const root = path.join(dir, "project");
    const globalFile = path.join(config, "loadout.toml");
    const projectFile = path.join(root, ".herdr", "loadout.toml");
    fs.mkdirSync(config, { recursive: true });
    fs.mkdirSync(path.dirname(projectFile), { recursive: true });
    fs.writeFileSync(globalFile, global);
    fs.writeFileSync(projectFile, project);
    const env = { ...process.env, HERDR_PLUGIN_CONFIG_DIR: config, HERDR_PLUGIN_STATE_DIR: path.join(dir, "state") };
    const run = (...args) => {
      const result = spawnSync(process.execPath, [CLI, ...args], { cwd: root, env, encoding: "utf8" });
      return result;
    };
    const ok = (...args) => {
      const result = run(...args);
      assert.equal(result.status, 0, result.stderr);
      return result;
    };
    const editor = (action, input) => JSON.parse(ok("editor", action, "--input", JSON.stringify(input)).stdout);
    const read = (file) => fs.readFileSync(file, "utf8");
    fn({ dir, root, run, ok, editor, globalFile, projectFile, read });
  } finally {
    cleanup(dir);
  }
}

test("set rewrites the changed keys in place and adds a new key at the end of the profile's own keys", () => {
  withRegistry(({ ok, read, globalFile, projectFile }) => {
    ok("set", "a", "--name", "A2", "--model", "m2", "--cost", "cheap", "--tag", "x", "--tag", "y");
    let expected = splice(GLOBAL, 16, 1, GLOBAL[16], crlf('cost = "cheap"'));
    expected = splice(expected, 12, 4, crlf('tags = [ "x", "y" ] # tags inline'));
    expected = splice(expected, 9, 1, crlf('model = "m2"'));
    expected = splice(expected, 7, 1, crlf('name = "A2" # name inline'));
    assert.equal(read(globalFile), expected.join(""));
    assert.equal(read(projectFile), PROJECT.join(""));
  });
});

test("the editor save changes a sub-table key by key and removes a deleted key's lines", () => {
  withRegistry(({ editor, read, globalFile, projectFile }) => {
    const open = editor("open", { id: "a", mode: "edit" });
    const draft = { ...open.draft, name: "A3", env: { FOO: "2", BAR: "3" } };
    delete draft.tags;
    const saved = editor("save", { draft, baseline: open.baseline, kind: open.kind, target: "global" });
    assert.equal(saved.ok, true, saved.error);
    let expected = splice(GLOBAL, 20, 1, crlf('FOO = "2" # foo inline'), crlf('BAR = "3"'));
    expected = splice(expected, 12, 4);
    expected = splice(expected, 7, 1, crlf('name = "A3" # name inline'));
    assert.equal(read(globalFile), expected.join(""));
    assert.equal(read(projectFile), PROJECT.join(""));
  });
});

test("add appends a block after the last profile, laid out like the file", () => {
  withRegistry(({ ok, read, globalFile }) => {
    ok("add", "--id", "c", "--name", 'C "quoted"', "--harness", "claude", "--model", "m", "--effort", "low", "--when", "c work.\tnow", "--env", "K=V");
    const block = [
      "",
      "[[profiles]]",
      'id = "c"',
      'name = "C \\"quoted\\""',
      'harness = "claude"',
      'model = "m"',
      'effort = "low"',
      'when_to_use = "c work.\\tnow"',
      "",
      "[profiles.env]",
      'K = "V"',
    ].map(crlf);
    assert.equal(read(globalFile), splice(GLOBAL, 37, 0, ...block).join(""));
  });
});

test("remove deletes the block with its header comment, and the override with it", () => {
  withRegistry(({ ok, read, globalFile, projectFile }) => {
    ok("remove", "a");
    assert.equal(read(globalFile), splice(GLOBAL, 3, 21).join(""));
    assert.equal(read(projectFile), splice(PROJECT, 2, 7).join(""));
  });
  withRegistry(({ ok, read, globalFile }) => {
    ok("remove", "b");
    assert.equal(read(globalFile), splice(GLOBAL, 27, 10).join(""));
  });
});

test("reset removes only the override block", () => {
  withRegistry(({ ok, read, globalFile, projectFile }) => {
    ok("reset", "a");
    assert.equal(read(projectFile), splice(PROJECT, 2, 7).join(""));
    assert.equal(read(globalFile), GLOBAL.join(""));
  });
});

test("a project override write keeps the override's unknown key and drops a key back on the global value", () => {
  withRegistry(({ ok, read, root, globalFile, projectFile }) => {
    // effort goes back to the global value, so its line goes, inline comment and all.
    ok("set", "a", "--effort", "low", "--notes", "local", "--project", root);
    let expected = splice(PROJECT, 8, 1, PROJECT[8], lf('notes = "local"'));
    expected = splice(expected, 6, 1);
    assert.equal(read(projectFile), expected.join(""));
    assert.equal(read(globalFile), GLOBAL.join(""));
  });
});

test("import updates an existing profile in place and appends a new one", () => {
  withRegistry(({ ok, read, dir, globalFile }) => {
    const input = path.join(dir, "import.toml");
    fs.writeFileSync(input, `${PROJECT.slice(11).join("")}\n[[profiles]]\nid = "b"\nname = "B2"\nharness = "claude"\nmodel = "m"\neffort = "low"\nwhen_to_use = "b work."\n`);
    ok("import", input);
    const block = ["", "[[profiles]]", 'id = "p"', 'name = "P"', 'harness = "claude"', 'model = "m"', 'effort = "low"', 'when_to_use = "p work."'].map(crlf);
    let expected = splice(GLOBAL, 37, 0, ...block);
    expected = splice(expected, 31, 1, crlf('name = "B2"'));
    assert.equal(read(globalFile), expected.join(""));
  });
});

test("a missing final newline stays missing when the last block goes or a block is added after it", () => {
  const dir = tempDir();
  try {
    const file = path.join(dir, "loadout.toml");
    const body = (id) => `[[profiles]]\nid = "${id}"\nname = "${id}"\nharness = "claude"\nmodel = "m"\neffort = "low"\nwhen_to_use = "w"`;
    fs.writeFileSync(file, `version = 1\n\n${body("a")}\n\n${body("b")}`);
    assert.equal(deleteProfile(file, "b").ok, true);
    assert.equal(fs.readFileSync(file, "utf8"), `version = 1\n\n${body("a")}`);
    assert.equal(upsertProfile(file, { id: "c", name: "c", harness: "claude", model: "m", effort: "low", when_to_use: "w" }).ok, true);
    assert.equal(fs.readFileSync(file, "utf8"), `version = 1\n\n${body("a")}\n\n${body("c")}`);
    assert.equal(deleteProfile(file, "a").ok, true);
    assert.equal(deleteProfile(file, "c").ok, true);
    assert.equal(fs.readFileSync(file, "utf8"), "version = 1");
  } finally {
    cleanup(dir);
  }
});

test("an env written inline or as dotted keys is edited in that form", () => {
  const dir = tempDir();
  try {
    const file = path.join(dir, "loadout.toml");
    const head = (id) => `[[profiles]]\nid = "${id}"\nname = "${id}"\nharness = "claude"\nmodel = "m"\neffort = "low"\nwhen_to_use = "w"\n`;
    fs.writeFileSync(file, `${head("a")}env = { A = "1" } # inline\n\n${head("b")}env.B = "1" # dotted\nenv."C D" = "2"\n`);
    const profileOf = (id) => readConfigFile(file).profiles.find((entry) => entry.id === id);
    assert.equal(upsertProfile(file, { ...profileOf("a"), env: { A: "1", "x y": "2" } }).ok, true);
    assert.equal(upsertProfile(file, { ...profileOf("b"), env: { B: "1", E: "3" } }).ok, true);
    // A new profile follows the file's inline style.
    assert.equal(upsertProfile(file, { ...profileOf("a"), id: "c", name: "c", env: { Z: "9" } }).ok, true);
    assert.equal(
      fs.readFileSync(file, "utf8"),
      `${head("a")}env = { A = "1", "x y" = "2" } # inline\n\n${head("b")}env.B = "1" # dotted\nenv.E = "3"\n\n${head("c")}env = { Z = "9" }\n`,
    );
  } finally {
    cleanup(dir);
  }
});

test("a layout that cannot be edited as text is refused and every write path leaves the file as it was", () => {
  const profile = 'id = "a", name = "A", harness = "claude", model = "m", effort = "low", when_to_use = "w"';
  const layouts = {
    "inline array": `# keep\nversion = 1\nprofiles = [{ ${profile} }]\n`,
    "detached sub-table": `# keep\n[[profiles]]\n${profile.replaceAll(", ", "\n")}\n\n[extra]\nv = 1\n\n[profiles.env]\nK = "v"\n`,
  };
  for (const [name, text] of Object.entries(layouts)) {
    withRegistry(({ run, read, globalFile }) => {
      for (const args of [["set", "a", "--name", "A2"], ["add", "--id", "z", "--name", "Z", "--harness", "claude", "--model", "m", "--effort", "low", "--when", "w"], ["remove", "a"]]) {
        const result = run(...args);
        assert.equal(result.status, 1, `${name}: ${args[0]}`);
        assert.match(result.stderr, /not saved, the file is unchanged/, `${name}: ${args[0]}`);
        assert.equal(read(globalFile), text, `${name}: ${args[0]}`);
      }
    }, { global: text });
  }
});

test("invalid UTF-8 is refused, not replaced", () => {
  const dir = tempDir();
  try {
    const file = path.join(dir, "loadout.toml");
    const bytes = Buffer.concat([
      Buffer.from('version = 1\nnote = "'),
      Buffer.from([0xff, 0xfe]),
      Buffer.from('"\n[[profiles]]\nid = "a"\nname = "A"\nharness = "claude"\nmodel = "m"\neffort = "low"\nwhen_to_use = "w"\n'),
    ]);
    fs.writeFileSync(file, bytes);
    const set = upsertProfile(file, { id: "a", name: "A2", harness: "claude", model: "m", effort: "low", when_to_use: "w" });
    assert.equal(set.ok, false);
    assert.match(set.errors[0], /not valid UTF-8/);
    const removed = deleteProfile(file, "a");
    assert.equal(removed.ok, false);
    assert.match(removed.errors[0], /not valid UTF-8/);
    assert.deepEqual(fs.readFileSync(file), bytes);
  } finally {
    cleanup(dir);
  }
});
