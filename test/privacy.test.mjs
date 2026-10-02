import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { cleanup, tempDir } from "./helpers.mjs";
import { buildContext, isSafeEmail, scanText } from "../scripts/check-privacy.mjs";
import { sourceRoot } from "../src/core/paths.mjs";

const script = path.join(sourceRoot(), "scripts", "check-privacy.mjs");

// Fixtures are assembled at runtime so this file never trips the guard it tests.
const WIN_HOME = `C:/Users/${"jdoe"}/project`;
const POSIX_HOME = `/${"home"}/${"jdoe"}/project`;
const EMAIL = `${"jane"}@${"corp.io"}`;
const TOKEN = `${"ghp"}_${"a".repeat(36)}`;

const none = { tokens: [] };
const rules = (text, context = none, opts) => scanText(text, context, opts).map((i) => i.rule);

test("flags another person's home directory, on Windows and POSIX", () => {
  assert.deepEqual(rules(`cwd = "${WIN_HOME}"`), ["user-home-path", "absolute-windows-path"]);
  assert.deepEqual(rules(`cd ${POSIX_HOME}`), ["user-home-path"]);
});

test("placeholders and the allow marker pass", () => {
  assert.deepEqual(rules(`C:\\Users\\<user>\\AppData`), []);
  assert.deepEqual(rules(`C:\\Users\\%USERNAME%\\x`), []);
  assert.deepEqual(rules(`/home/user/project and /Users/you/x`), []);
  assert.deepEqual(rules(`D:\\...\\repo`), []);
  assert.deepEqual(rules(`C:\\tools\\nvm and C:\\Program Files\\app`), []);
  assert.deepEqual(rules(`${WIN_HOME} // privacy-allow`), []);
});

test("an arbitrary drive path is flagged in source but not in test fixtures", () => {
  assert.deepEqual(rules("D:\\work\\repo", none, { file: "src/core/x.mjs" }), ["absolute-windows-path"]);
  assert.deepEqual(rules("D:\\work\\repo", none, { file: "test/x.test.mjs" }), []);
  // identifiers are still checked inside tests
  assert.deepEqual(rules(`/${"home"}/${"jdoe"}/x`, none, { file: "test/x.test.mjs" }), ["user-home-path"]);
});

test("flags emails and secrets, but not noreply addresses", () => {
  assert.deepEqual(rules(`contact ${EMAIL}`), ["email"]);
  assert.deepEqual(rules(`token=${TOKEN}`), ["secret"]);
  assert.ok(isSafeEmail("noreply@example.com"));
  assert.ok(isSafeEmail("12345+someone@users.noreply.github.com"));
  assert.ok(!isSafeEmail(EMAIL));
});

test("personal identifiers come from the machine, never from the repo", () => {
  const context = buildContext({ cwd: sourceRoot(), env: { PRIVACY_DENYLIST: "Zanzibar Corp, ab" } });
  const values = context.tokens.map((t) => t.value);
  assert.ok(values.includes("Zanzibar Corp"), "denylist terms are honoured");
  assert.deepEqual(rules("we met at zanzibar corp", context), ["personal-identifier"]);
  assert.ok(values.some((v) => v.toLowerCase() === process.env.USERNAME?.toLowerCase() || !process.env.USERNAME));
  assert.ok(values.some((v) => v.toLowerCase().includes(path.basename(sourceRoot()).toLowerCase())));
});

// --- CLI against a throwaway repository ------------------------------------------------------

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

function makeRepo() {
  const dir = tempDir();
  git(dir, "init", "-q");
  git(dir, "config", "user.name", "tester");
  git(dir, "config", "user.email", "tester@users.noreply.github.com");
  git(dir, "config", "commit.gpgsign", "false");
  return dir;
}

function check(cwd, ...args) {
  return spawnSync(process.execPath, [script, ...args], { cwd, encoding: "utf8" });
}

test("CLI: working tree scan fails on a leak and passes once it is removed", () => {
  const dir = makeRepo();
  try {
    fs.writeFileSync(path.join(dir, "notes.md"), `see ${WIN_HOME}\n`);
    const bad = check(dir);
    assert.equal(bad.status, 1, bad.stdout);
    assert.match(bad.stderr, /notes\.md:1\s+\[user-home-path\]/);

    fs.writeFileSync(path.join(dir, "notes.md"), "see C:\\Users\\<user>\\project\n");
    assert.equal(check(dir).status, 0);
  } finally {
    cleanup(dir);
  }
});

test("CLI: --staged looks only at lines the commit adds", () => {
  const dir = makeRepo();
  try {
    fs.writeFileSync(path.join(dir, "a.md"), `old ${EMAIL}\n`);
    git(dir, "add", ".");
    git(dir, "-c", "core.hooksPath=/dev/null", "commit", "-q", "-m", "init");

    fs.appendFileSync(path.join(dir, "a.md"), "harmless\n");
    git(dir, "add", ".");
    assert.equal(check(dir, "--staged").status, 0, "an old line is not this commit's problem");

    fs.appendFileSync(path.join(dir, "a.md"), `${POSIX_HOME}\n`);
    git(dir, "add", ".");
    const bad = check(dir, "--staged");
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /a\.md\s+\[user-home-path\]/);
  } finally {
    cleanup(dir);
  }
});

test("CLI: --range checks added lines, commit messages and author addresses", () => {
  const dir = makeRepo();
  try {
    fs.writeFileSync(path.join(dir, "a.md"), "clean\n");
    git(dir, "add", ".");
    git(dir, "commit", "-q", "-m", "init");
    const base = git(dir, "rev-parse", "HEAD").trim();

    fs.appendFileSync(path.join(dir, "a.md"), "still clean\n");
    git(dir, "commit", "-q", "-am", "tidy");
    assert.equal(check(dir, "--range", `${base}..HEAD`).status, 0);

    fs.appendFileSync(path.join(dir, "a.md"), "fine\n");
    git(dir, "-c", `user.email=${EMAIL}`, "commit", "-q", "-am", `note from ${POSIX_HOME}`);
    const bad = check(dir, "--range", `${base}..HEAD`);
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /\[author-email\]/);
    assert.match(bad.stderr, /author\/message\)\s+\[user-home-path\]/);
  } finally {
    cleanup(dir);
  }
});

test("CLI: outside a git repository it exits 2 instead of passing", () => {
  const dir = tempDir();
  try {
    assert.equal(check(dir).status, 2);
  } finally {
    cleanup(dir);
  }
});
