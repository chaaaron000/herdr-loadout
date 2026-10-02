#!/usr/bin/env node
/**
 * Privacy guard: fail when personal data or machine-specific absolute paths are
 * about to be committed or pushed.
 *
 *   node scripts/check-privacy.mjs                 tracked + untracked-not-ignored files
 *   node scripts/check-privacy.mjs --staged        what the next commit contains (pre-commit)
 *   node scripts/check-privacy.mjs --range "<git log args>"
 *                                                  added lines, authors and messages of those
 *                                                  commits (pre-push); e.g. "origin/main..HEAD"
 *   node scripts/check-privacy.mjs --history       every commit reachable from any ref
 *
 * Personal identifiers are never written into this repo. They are read from the
 * machine running the check: the OS user name, the home directory, this
 * checkout's absolute path and the host name. Extra terms (a real name, a
 * handle) go in `<git-dir>/privacy-denylist`, one per line, or in the
 * PRIVACY_DENYLIST environment variable (comma separated). Both stay local.
 *
 * A line containing the marker `privacy-allow` is skipped, for fixtures that
 * need a fake absolute path on purpose.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

export const ALLOW_MARKER = "privacy-allow";

/** Account names that are placeholders, not people. */
const PLACEHOLDER_NAMES = new Set([
  "user", "users", "username", "you", "me", "name", "example", "public", "default", "all",
  "someone", "foo", "bar", "alice", "bob", "test", "tester", "runner", "home", "root", "admin", "x",
]);

/** Machine-neutral top-level folders: documenting these says nothing about anyone. */
const NEUTRAL_DRIVE_DIRS = /^[A-Za-z]:[\\/]+(?:tools|windows|program files(?: \(x86\))?|programdata|temp|tmp)(?:[\\/]|$)/i;

const NAME_CHARS = "[^\\\\/\\s\"'`<>*:|?%$(){}\\[\\]]+";

const PATH_RULES = [
  {
    id: "user-home-path",
    re: new RegExp(`[A-Za-z]:[\\\\/]+Users[\\\\/]+(${NAME_CHARS})`, "g"),
    flagged: (m) => !PLACEHOLDER_NAMES.has(m[1].toLowerCase()),
  },
  {
    id: "user-home-path",
    re: new RegExp(`(?<![\\w.:-])/(?:Users|home)/(${NAME_CHARS})`, "g"),
    flagged: (m) => !PLACEHOLDER_NAMES.has(m[1].toLowerCase()),
  },
  {
    id: "absolute-windows-path",
    re: /(?<![\w/\\.-])[A-Za-z]:[\\/][^\s"'`*|?]*/g,
    // `D:\...` and `C:\Users\<user>` are placeholders. Test files use throwaway
    // fixture paths by design; the identifier rules still apply to them.
    flagged: (m, file) =>
      !m[0].includes("...") &&
      !/[\\/][<%$]/.test(m[0]) &&
      !NEUTRAL_DRIVE_DIRS.test(m.input.slice(m.index)) &&
      !/^test[\\/]/.test(file ?? ""),
  },
];

const SECRET_RULES = [
  { id: "secret", re: /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g },
  { id: "secret", re: /\bsk-[A-Za-z0-9_-]{20,}\b/g },
  { id: "secret", re: /\bAKIA[0-9A-Z]{16}\b/g },
  { id: "secret", re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { id: "secret", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
];

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

export function isSafeEmail(email) {
  return /noreply|no-reply|@example\.(com|org|net)$|@(localhost|test|invalid)$/i.test(email);
}

/** Show enough to locate a hit without reprinting the whole value into logs. */
function mask(value) {
  return value.length <= 3 ? "***" : `${value.slice(0, 2)}${"*".repeat(Math.min(value.length - 2, 6))}`;
}

/** A path hit keeps its shape but hides the account name and everything past the first folder. */
function maskPath(m) {
  const text = m[0].replace(/((?:Users|home)[\\/]+)([^\\/]+)/i, (_, dir, name) => dir + mask(name));
  const parts = text.split(/([\\/]+)/);
  return parts.length > 5 ? `${parts.slice(0, 5).join("")}…` : text;
}

function pathVariants(p) {
  const resolved = path.resolve(p);
  return [resolved, resolved.replaceAll("\\", "/"), resolved.replaceAll("/", "\\")];
}

function gitDir(cwd) {
  try {
    return execFileSync("git", ["rev-parse", "--git-common-dir"], { cwd, encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

/** Identifiers of the machine and person running the check. */
export function buildContext({ cwd = process.cwd(), env = process.env } = {}) {
  const raw = new Set();
  const add = (value, { minLength = 4 } = {}) => {
    const v = String(value ?? "").trim();
    if (v.length >= minLength && !PLACEHOLDER_NAMES.has(v.toLowerCase())) raw.add(v);
  };

  try {
    add(os.userInfo().username);
  } catch {
    // no passwd entry for this uid
  }
  add(env.USERNAME ?? env.USER);
  add(os.hostname());
  for (const variant of pathVariants(os.homedir())) add(variant);
  for (const variant of pathVariants(cwd)) add(variant);

  const dir = gitDir(cwd);
  const denylist = dir ? path.resolve(cwd, dir, "privacy-denylist") : null;
  if (denylist && fs.existsSync(denylist)) {
    for (const line of fs.readFileSync(denylist, "utf8").split(/\r?\n/)) {
      if (line.trim() && !line.trim().startsWith("#")) add(line, { minLength: 1 });
    }
  }
  for (const term of (env.PRIVACY_DENYLIST ?? "").split(",")) add(term, { minLength: 1 });

  return { tokens: [...raw].map((value) => ({ value, lower: value.toLowerCase() })) };
}

/** Scan text and return [{ line, rule, match }]. Line numbers are 1-based. */
export function scanText(text, context, { file } = {}) {
  const issues = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.includes(ALLOW_MARKER)) continue;
    const lower = line.toLowerCase();

    for (const rule of PATH_RULES) {
      for (const m of line.matchAll(rule.re)) {
        if (rule.flagged(m, file)) issues.push({ line: i + 1, rule: rule.id, match: maskPath(m) });
      }
    }
    for (const m of line.matchAll(EMAIL_RE)) {
      if (!isSafeEmail(m[0])) issues.push({ line: i + 1, rule: "email", match: mask(m[0]) });
    }
    for (const rule of SECRET_RULES) {
      for (const m of line.matchAll(rule.re)) issues.push({ line: i + 1, rule: rule.id, match: mask(m[0]) });
    }
    for (const token of context.tokens) {
      if (lower.includes(token.lower)) {
        issues.push({ line: i + 1, rule: "personal-identifier", match: mask(token.value) });
      }
    }
  }
  return dedupe(issues);
}

function dedupe(issues) {
  const seen = new Set();
  return issues.filter((issue) => {
    const key = `${issue.line}|${issue.rule}|${issue.match}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

const SKIPPED = (file) =>
  file === "package-lock.json" || file.startsWith("graft/") || file.startsWith("node_modules/");

function git(args, cwd, { raw = false } = {}) {
  const out = execFileSync("git", args, { cwd, maxBuffer: 512 * 1024 * 1024, encoding: raw ? "buffer" : "utf8" });
  return out;
}

function looksBinary(buffer) {
  return buffer.subarray(0, 8000).includes(0);
}

function scanFiles(files, read, context) {
  const findings = [];
  let scanned = 0;
  for (const file of files) {
    if (!file || SKIPPED(file)) continue;
    const buffer = read(file);
    if (!buffer || looksBinary(buffer)) continue;
    scanned += 1;
    for (const issue of scanText(buffer.toString("utf8"), context, { file })) {
      findings.push({ where: `${file}:${issue.line}`, ...issue });
    }
  }
  return { findings, summary: `${scanned} files` };
}

function scanWorkingTree(cwd, context) {
  const files = git(["ls-files", "-z", "--cached", "--others", "--exclude-standard"], cwd)
    .split("\0")
    .filter(Boolean);
  return scanFiles(
    [...new Set(files)],
    (file) => {
      const full = path.join(cwd, file);
      return fs.existsSync(full) && fs.statSync(full).isFile() ? fs.readFileSync(full) : null;
    },
    context,
  );
}

/** Scan only the lines a unified diff adds. `commit:<id>` lines, when present, label the hits. */
function scanAddedLines(patch, context) {
  const findings = [];
  let commit = "";
  let file = "";
  for (const line of patch.split("\n")) {
    if (line.startsWith("commit:")) commit = line.slice(7).trim();
    else if (line.startsWith("+++ ")) file = line.slice(6).trim();
    else if (line.startsWith("+") && !SKIPPED(file)) {
      const where = commit ? `commit ${commit} ${file}` : file;
      for (const issue of scanText(line.slice(1), context, { file })) {
        findings.push({ where, ...issue });
      }
    }
  }
  return findings;
}

function scanStaged(cwd, context) {
  const patch = git(["diff", "--cached", "-U0", "--no-color", "--diff-filter=ACMR"], cwd);
  return { findings: scanAddedLines(patch, context), summary: "staged changes" };
}

function scanRange(rangeArgs, cwd, context) {
  const findings = [];

  // Authors, committers and messages.
  const meta = git(["log", "--format=%h%x1f%an%x1f%ae%x1f%cn%x1f%ce%x1f%B%x1e", ...rangeArgs], cwd);
  let commits = 0;
  for (const record of meta.split("\x1e")) {
    if (!record.trim()) continue;
    commits += 1;
    const [hash, an, ae, cn, ce, body] = record.trim().split("\x1f");
    for (const email of new Set([ae, ce])) {
      if (email && !isSafeEmail(email)) {
        findings.push({ where: `commit ${hash}`, rule: "author-email", match: mask(email) });
      }
    }
    for (const issue of scanText(`${an}\n${cn}\n${body ?? ""}`, context)) {
      findings.push({ where: `commit ${hash} (author/message)`, ...issue });
    }
  }

  // Added lines.
  const patch = git(["log", "-p", "-U0", "--no-color", "--format=commit:%h", ...rangeArgs], cwd);
  findings.push(...scanAddedLines(patch, context));
  return { findings, summary: `${commits} commits` };
}

function report(findings, summary) {
  const unique = new Map();
  for (const f of findings) unique.set(`${f.where}|${f.rule}|${f.match}`, f);
  if (unique.size === 0) {
    process.stdout.write(`privacy check: clean (${summary})\n`);
    return 0;
  }
  process.stderr.write(`privacy check: ${unique.size} problem(s) found. Nothing was changed.\n`);
  for (const f of unique.values()) process.stderr.write(`  ${f.where}  [${f.rule}]  ${f.match}\n`);
  process.stderr.write(
    [
      "",
      "Fix the file, or use a placeholder such as <user>. If a line really needs a fake absolute",
      `path, add the marker \`${ALLOW_MARKER}\` to it. Terms to always block can go in .git/privacy-denylist.`,
      "",
    ].join("\n"),
  );
  return 1;
}

function main() {
  const { values } = parseArgs({
    options: {
      staged: { type: "boolean", default: false },
      range: { type: "string" },
      history: { type: "boolean", default: false },
    },
    strict: true,
  });
  const cwd = process.cwd();
  try {
    git(["rev-parse", "--git-dir"], cwd);
  } catch {
    process.stderr.write("privacy check: not inside a git repository\n");
    return 2;
  }

  const context = buildContext({ cwd });
  try {
    if (values.history || values.range) {
      const rangeArgs = values.history ? ["--all"] : values.range.split(/\s+/).filter(Boolean);
      const { findings, summary } = scanRange(rangeArgs, cwd, context);
      return report(findings, summary);
    }
    const { findings, summary } = values.staged ? scanStaged(cwd, context) : scanWorkingTree(cwd, context);
    return report(findings, summary);
  } catch (error) {
    process.stderr.write(`privacy check: could not run git: ${error.message}\n`);
    return 2;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
