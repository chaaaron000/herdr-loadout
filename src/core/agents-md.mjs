/**
 * The delegation block in a project's always-loaded instructions file.
 *
 * Skills load only once an agent has decided to use them, so the pointer "load
 * the skill and follow the user's workflow" has to live in the file every harness
 * reads at startup: `<project>/AGENTS.md`. The block stays neutral; who does what
 * is the workflow's call (`src/core/default-workflow.md`). The block sits between two marker lines and is
 * the only part of the file this module writes. Its text is the built-in
 * `src/core/agents-md.md`, so there is one source of truth.
 *
 * Some harnesses read another file in place of `AGENTS.md` (see `importTargets`).
 * For those, the block reaches them through an `@AGENTS.md` import, written
 * between the same markers.
 *
 * A user who declines the block is never asked again in that project. The record
 * lives in the plugin state dir, keyed by project root, never in the project.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { sourceRoot, stateDir } from "./paths.mjs";
import { resolveTaskRoot } from "./task.mjs";

export const BLOCK_START = "<!-- herdr-loadout:start -->";
export const BLOCK_END = "<!-- herdr-loadout:end -->";
export const AGENTS_FILE = "AGENTS.md";
export const DECLINES_FILE = "agents-md-declined.json";

/** Claude Code reads these instead of AGENTS.md when any one exists here or above, and loads all of them. */
export const CLAUDE_FILES = ["CLAUDE.md", ".claude/CLAUDE.md", "CLAUDE.local.md"];
/**
 * omp keeps one context file per directory depth, the highest-priority one. Each
 * of these outranks a standalone AGENTS.md in the same directory, in this order.
 */
export const OMP_SHADOWING_FILES = [
  ".omp/AGENTS.md",
  ".claude/CLAUDE.md",
  ".agent/AGENTS.md",
  ".agents/AGENTS.md",
  ".gemini/GEMINI.md",
  ".github/copilot-instructions.md",
];
/** Codex and pi read this instead of AGENTS.md in the same directory, and expand no imports. */
export const OVERRIDE_FILE = "AGENTS.override.md";
/** Claude Code `Project instructions` values that never read AGENTS.md on their own. */
const CLAUDE_SETTINGS_WITHOUT_AGENTS_MD = new Set(["claude-md"]);
const CLAUDE_PLUGIN_IDS = ["cc-plugin-agents-md@builtin", "agents-md@builtin"];

const splitLines = (text) => text.replace(/\r\n/g, "\n").split("\n");

/** The shipped block, LF line endings, no trailing newline. */
export function blockText(root = sourceRoot()) {
  return splitLines(fs.readFileSync(path.join(root, "src", "core", "agents-md.md"), "utf8")).join("\n").trimEnd();
}

/** The import region for a file at `relative` (posix, from the project root). */
export function importLine(relative) {
  return `@${path.posix.relative(path.posix.dirname(relative), AGENTS_FILE)}`;
}

/**
 * Where the markers are in `text`.
 * @returns {{start: number, end: number} | null | {error: string}} line indexes,
 *   null when there are none, or an error for anything but one ordered pair.
 */
export function findBlock(text) {
  const lines = splitLines(text);
  const starts = [];
  const ends = [];
  lines.forEach((line, index) => {
    if (line.trim() === BLOCK_START) starts.push(index);
    if (line.trim() === BLOCK_END) ends.push(index);
  });
  if (starts.length === 0 && ends.length === 0) return null;
  if (starts.length !== 1 || ends.length !== 1 || ends[0] < starts[0]) {
    return { error: `expected one "${BLOCK_START}" line followed by one "${BLOCK_END}" line; found ${starts.length} and ${ends.length}` };
  }
  return { start: starts[0], end: ends[0] };
}

/** Is `wanted` (the block, markers included) the text between the markers? */
function blockState(text, wanted) {
  if (text === null) return { block: "missing" };
  const found = findBlock(text);
  if (found === null) return { block: "missing" };
  if (found.error) return { block: "outdated", problem: found.error };
  const lines = splitLines(text).slice(found.start, found.end + 1).map((line) => line.trimEnd());
  const same = lines.join("\n") === splitLines(wanted).map((line) => line.trimEnd()).join("\n");
  return { block: same ? "current" : "outdated" };
}

/** Does `text` import `line` (`@AGENTS.md`, `@../AGENTS.md`) outside code fences and code spans? */
export function hasImport(text, line) {
  const target = line.slice(1);
  const accepted = new Set([target, `./${target}`]);
  let fenced = false;
  for (const raw of splitLines(text)) {
    if (/^\s*(```|~~~)/.test(raw)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    const bare = raw.replace(/`[^`]*`/g, " ");
    for (const match of bare.matchAll(/(?:^|\s)@(\S+)/g)) {
      if (accepted.has(match[1])) return true;
    }
  }
  return false;
}

function readText(file, fsImpl) {
  try {
    return fsImpl.readFileSync(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "EISDIR") return null;
    throw error;
  }
}

/** Claude Code's `Project instructions` setting from its user settings, or null when unset. */
export function claudeInstructionSetting({ env = process.env, home = os.homedir(), fsImpl = fs } = {}) {
  const dir = env.CLAUDE_CONFIG_DIR ? path.resolve(env.CLAUDE_CONFIG_DIR) : path.join(home, ".claude");
  const text = readText(path.join(dir, "settings.json"), fsImpl);
  if (text === null) return null;
  let settings;
  try {
    settings = JSON.parse(text);
  } catch {
    return null;
  }
  for (const id of CLAUDE_PLUGIN_IDS) {
    const value = settings?.pluginConfigs?.[id]?.options?.instructionFiles;
    if (typeof value === "string") return value;
  }
  return null;
}

/**
 * The files that must import AGENTS.md so every supported harness sees the
 * block, with whether they already do. Readers that see AGENTS.md itself need
 * nothing: codex, opencode, agy, pi, and Claude Code or omp when nothing here
 * outranks it.
 */
export function importTargets(projectRoot, { fsImpl = fs, claudeSetting = null, claudeMd = false } = {}) {
  const read = (relative) => readText(path.join(projectRoot, relative), fsImpl);
  const targets = new Map();
  const add = (relative, reader, text) => {
    const line = importLine(relative);
    const problem = text === null ? undefined : findBlock(text)?.error;
    const entry = targets.get(relative) ?? {
      relative,
      file: path.join(projectRoot, relative),
      line,
      exists: text !== null,
      present: text !== null && hasImport(text, line),
      ...(problem ? { problem } : {}),
      readers: [],
    };
    entry.readers.push(reader);
    targets.set(relative, entry);
  };

  // Claude Code loads every one of its files, so one import among them is enough.
  const claude = CLAUDE_FILES.map((relative) => ({ relative, text: read(relative) })).filter(({ text }) => text !== null);
  const importing = claude.find(({ relative, text }) => hasImport(text, importLine(relative)));
  if (importing) add(importing.relative, "claude", importing.text);
  else if (claude.length > 0) add(claude[0].relative, "claude", claude[0].text);
  else if (claudeMd || CLAUDE_SETTINGS_WITHOUT_AGENTS_MD.has(claudeSetting)) add(CLAUDE_FILES[0], "claude", null);

  // omp skips empty files, so an empty one does not take the directory's slot.
  for (const relative of OMP_SHADOWING_FILES) {
    const text = read(relative);
    if (text !== null && text.trim() !== "") {
      add(relative, "omp", text);
      break;
    }
  }
  return [...targets.values()];
}

/** The key a project's decline is stored under; Windows paths compare without case. */
export function projectKey(projectRoot) {
  const resolved = path.resolve(projectRoot);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function declinesPath(env) {
  return path.join(stateDir(env), DECLINES_FILE);
}

function readDeclines(env, fsImpl) {
  const text = readText(declinesPath(env), fsImpl);
  if (text === null) return { version: 1, projects: {} };
  try {
    const data = JSON.parse(text);
    return { version: 1, projects: data?.projects && typeof data.projects === "object" ? data.projects : {} };
  } catch {
    return { version: 1, projects: {} };
  }
}

function writeDeclines(data, env, fsImpl) {
  const file = declinesPath(env);
  fsImpl.mkdirSync(path.dirname(file), { recursive: true });
  fsImpl.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
}

/** The recorded decline for this project, or null. */
export function findDecline(projectRoot, { env = process.env, fsImpl = fs } = {}) {
  return readDeclines(env, fsImpl).projects[projectKey(projectRoot)] ?? null;
}

/** Record that the user declined the block here; the skill then never asks again. */
export function recordDecline(projectRoot, { env = process.env, fsImpl = fs, now = new Date() } = {}) {
  const data = readDeclines(env, fsImpl);
  const entry = { path: path.resolve(projectRoot), declined: now.toISOString() };
  data.projects[projectKey(projectRoot)] = entry;
  writeDeclines(data, env, fsImpl);
  return { file: declinesPath(env), ...entry };
}

function clearDecline(projectRoot, env, fsImpl) {
  const data = readDeclines(env, fsImpl);
  const key = projectKey(projectRoot);
  if (!Object.hasOwn(data.projects, key)) return false;
  delete data.projects[key];
  writeDeclines(data, env, fsImpl);
  return true;
}

/**
 * The project root the block belongs to: `project` when given, else the nearest
 * directory up from `start` holding `.git` or `.herdr` (never the home
 * directory's), else `start`.
 */
export function resolveProjectRoot({ project, start = process.cwd(), fsImpl = fs, home = os.homedir() } = {}) {
  if (project) return path.resolve(project);
  return resolveTaskRoot(start, { fsImpl, home, markers: [".git", ".herdr"] });
}

/**
 * Where the project stands.
 *
 * `state` is what the skill acts on:
 * - `current`: the block is as shipped and every harness that reads another
 *   file imports it;
 * - `declined`: anything else, after the user said no here;
 * - `outdated`: the markers hold other text, or are broken (in AGENTS.md or
 *   in a file that must import it);
 * - `missing`: no block, or a file that must import it does not.
 */
export function agentsMdStatus({
  projectRoot,
  env = process.env,
  fsImpl = fs,
  home = os.homedir(),
  builtInRoot = sourceRoot(),
  claudeMd = false,
}) {
  const file = path.join(projectRoot, AGENTS_FILE);
  const text = readText(file, fsImpl);
  const { block, problem } = blockState(text, blockText(builtInRoot));
  const claudeSetting = claudeInstructionSetting({ env, home, fsImpl });
  const imports = importTargets(projectRoot, { fsImpl, claudeSetting, claudeMd });
  const notes = [];
  if (readText(path.join(projectRoot, OVERRIDE_FILE), fsImpl) !== null) {
    notes.push(`${OVERRIDE_FILE} exists: codex and pi read it instead of ${AGENTS_FILE} in this folder, and neither expands imports; add the block there yourself`);
  }
  if (claudeSetting === "managed-only") {
    notes.push("Claude Code's Project instructions setting is managed-only: it reads no project file, so the block cannot reach it");
  }
  const decline = findDecline(projectRoot, { env, fsImpl });
  const brokenImport = imports.some((entry) => entry.problem);
  const complete = block === "current" && !brokenImport && imports.every((entry) => entry.present);
  let state;
  if (complete) state = "current";
  else if (decline) state = "declined";
  else if (block === "outdated" || brokenImport) state = "outdated";
  else state = "missing";
  return {
    state,
    projectRoot,
    file,
    exists: text !== null,
    block,
    ...(problem ? { problem } : {}),
    imports,
    claudeSetting,
    declined: decline ? decline.declined : null,
    notes,
  };
}

/**
 * Put `region` (lines, markers included) into `text`: replace the marked
 * region, or append it. Every line outside the region keeps its own ending;
 * the region takes the endings of the lines it replaces, or of the line it
 * follows.
 */
function writeRegion(text, region) {
  if (text === null) return region.join("\n") + "\n";
  // [line, ending, line, ending, ..., last line]; line i is parts[2i], its ending parts[2i + 1].
  const parts = text.split(/(\r?\n)/);
  const found = findBlock(text);
  if (found?.error) throw new Error(found.error);
  if (found) {
    const eol = parts[2 * found.start + 1] || parts.find((part, index) => index % 2 === 1) || "\n";
    const lastEnding = parts[2 * found.end + 1] ?? "";
    const head = parts.slice(0, 2 * found.start).join("");
    const tail = parts.slice(2 * found.end + 2).join("");
    return `${head}${region.join(eol)}${lastEnding}${tail}`;
  }
  const endings = parts.filter((part, index) => index % 2 === 1);
  const eol = endings.at(-1) ?? "\n";
  const body = text === "" || text.endsWith("\n") ? text : text + eol;
  // A file holding only whitespace gets the region right after it, without another blank line.
  const gap = text.trim() === "" ? "" : eol;
  return `${body}${gap}${region.join(eol)}${eol}`;
}

function writeIfChanged(file, before, after, fsImpl) {
  if (before === after) return "unchanged";
  fsImpl.mkdirSync(path.dirname(file), { recursive: true });
  fsImpl.writeFileSync(file, after);
  return before === null ? "created" : "updated";
}

/**
 * Write the block into AGENTS.md and the import into every file that needs it,
 * touching nothing outside the markers, and drop a recorded decline.
 * @returns {{ok: true, changes: Array<{file: string, action: string}>, status: object} | {ok: false, error: string}}
 */
export function installAgentsMd({
  projectRoot,
  env = process.env,
  fsImpl = fs,
  home = os.homedir(),
  builtInRoot = sourceRoot(),
  claudeMd = false,
}) {
  const plan = [];
  const file = path.join(projectRoot, AGENTS_FILE);
  plan.push({ file, region: splitLines(blockText(builtInRoot)) });
  const claudeSetting = claudeInstructionSetting({ env, home, fsImpl });
  for (const entry of importTargets(projectRoot, { fsImpl, claudeSetting, claudeMd })) {
    // A file that already imports still has its markers checked, so a broken region is never left behind.
    plan.push({ file: entry.file, region: entry.present ? null : [BLOCK_START, entry.line, BLOCK_END] });
  }

  // Check every file before writing any, so a broken marker leaves all of them alone.
  const texts = [];
  for (const { file: target, region } of plan) {
    const before = readText(target, fsImpl);
    try {
      if (region) texts.push({ target, before, after: writeRegion(before, region) });
      else {
        const problem = before === null ? undefined : findBlock(before)?.error;
        if (problem) throw new Error(problem);
      }
    } catch (error) {
      return { ok: false, error: `${target}: ${error.message}; fix the markers by hand` };
    }
  }
  const changes = texts.map(({ target, before, after }) => ({ file: target, action: writeIfChanged(target, before, after, fsImpl) }));
  const undeclined = clearDecline(projectRoot, env, fsImpl);
  return {
    ok: true,
    changes,
    undeclined,
    status: agentsMdStatus({ projectRoot, env, fsImpl, home, builtInRoot, claudeMd }),
  };
}
