/**
 * Does a running worker still match its profile? An orchestrator asks before
 * every prompt to a worker it already has, so a profile edit, a restart that
 * dropped the launch arguments, or a worker of another profile is caught by a
 * check rather than by memory.
 *
 * What a worker was launched as (its record) is a profile id plus a fingerprint
 * of the launch: harness, arguments, and env *names*, never env values.
 *   - App: `command --host hc` puts both on the terminal as labels.
 *   - Both hosts: `command --task <dir>` also writes them to `<dir>/workers.json`.
 * What it runs now comes from the host: `hc get` (state, foreground process) or
 * `herdr agent get` plus `herdr pane process-info` (the foreground command line).
 */
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { PROJECT_DIR_NAME } from "./paths.mjs";
import { RUNS_DIR_NAME } from "./task.mjs";

export const LABEL_PROFILE = "herdr-loadout.profile";
export const LABEL_FINGERPRINT = "herdr-loadout.fingerprint";
export const RECORD_FILE = "workers.json";

const SHELL_NAMES = new Set(["sh", "bash", "zsh", "fish", "dash", "ksh", "tcsh", "csh", "nu", "pwsh", "powershell", "cmd", "elvish", "xonsh"]);

/** A short, stable digest of how a profile launches; env values never enter it. */
export function launchFingerprint(result) {
  const shape = { harness: result.harness, args: result.args, env: Object.keys(result.env ?? {}).sort() };
  return crypto.createHash("sha256").update(JSON.stringify(shape)).digest("hex").slice(0, 12);
}

/** Labels `hc run` gets, so the app itself remembers what a worker was launched as. */
export function launchLabels(id, fingerprint) {
  return [`${LABEL_PROFILE}=${id}`, `${LABEL_FINGERPRINT}=${fingerprint}`];
}

export function isShell(program) {
  if (!program) return false;
  const base = path.win32.basename(path.posix.basename(program)).toLowerCase().replace(/\.exe$/, "");
  return SHELL_NAMES.has(base);
}

function readRecords(file, fsImpl) {
  if (!fsImpl.existsSync(file)) return { workers: {} };
  const parsed = JSON.parse(fsImpl.readFileSync(file, "utf8"));
  return { ...parsed, workers: parsed.workers ?? {} };
}

/** Add or replace `name` in `<taskDir>/workers.json`; returns the file. */
export function recordWorker(taskDir, name, record, { fsImpl = fs } = {}) {
  const file = path.join(taskDir, RECORD_FILE);
  const records = readRecords(file, fsImpl);
  records.workers[name] = record;
  fsImpl.writeFileSync(file, `${JSON.stringify(records, null, 2)}\n`);
  return file;
}

/**
 * The record for `name`: from `taskDir` when given, else the newest one in any
 * task folder under the project's `.herdr/runs/`.
 */
export function findWorkerRecord({ name, taskDir, projectRoot, fsImpl = fs }) {
  const dirs = taskDir
    ? [taskDir]
    : (() => {
      const runs = path.join(projectRoot, PROJECT_DIR_NAME, RUNS_DIR_NAME);
      if (!fsImpl.existsSync(runs)) return [];
      return fsImpl.readdirSync(runs).map((entry) => path.join(runs, entry));
    })();
  let found = null;
  for (const dir of dirs) {
    const file = path.join(dir, RECORD_FILE);
    if (!fsImpl.existsSync(file)) continue;
    const record = readRecords(file, fsImpl).workers[name];
    if (record && (!found || String(record.recorded) > String(found.recorded))) found = { ...record, file };
  }
  return found;
}

function defaultRun(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8", windowsHide: true });
  if (result.error) return { status: null, stdout: "", stderr: result.error.message };
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** The JSON error a host CLI printed; both CLIs print it on stderr, but accept stdout too. */
function hostErrorBody(out, data) {
  return data?.error ?? parseJson(out.stderr)?.error ?? null;
}

/** The message of a host CLI error. */
function hostError(out, data) {
  return hostErrorBody(out, data)?.message ?? out.stderr.trim();
}

/**
 * Host errors that establish the worker does not exist (hc 0.1.21 `error.kind`, Herdr 0.9.5
 * `error.code`). Any other failure, such as a stopped server (`hc` kind `unavailable`, Herdr
 * `server_not_running`), leaves the worker unknown.
 */
const ABSENT_ERRORS = {
  hc: new Set(["not_found"]),
  herdr: new Set(["agent_not_found", "agent_name_not_found"]),
};

/** The answer for a host lookup that failed: absent on a known not-found error, else unknown. */
function lookupFailed(host, out, data) {
  const unknown = { found: false, live: false, shell: false, argvs: [], labels: {} };
  const body = hostErrorBody(out, data);
  const error = hostError(out, data) || `exit ${out.status}`;
  if (ABSENT_ERRORS[host].has(host === "hc" ? body?.kind : body?.code)) return { ...unknown, error };
  return { ...unknown, unreachable: true, error };
}

/**
 * The worker as the host sees it now.
 * @returns {{found: boolean, live: boolean, shell: boolean, argvs: string[][], labels: object,
 *   unreachable?: boolean, error?: string, probeError?: string}}
 *   `unreachable`: the host could not be asked (its CLI did not run, its server is down, or it
 *   answered with an error other than "no such worker"), so nothing is known about the worker
 *   `argvs`: the command lines of the foreground processes (TUI only)
 *   `probeError`: why those command lines could not be read (TUI only)
 */
export function inspectWorker(host, name, { run = defaultRun } = {}) {
  if (host === "hc") {
    const out = run("hc", ["get", name, "--json"]);
    const data = parseJson(out.stdout);
    if (out.status !== 0 || !data || data.error) return lookupFailed(host, out, data);
    const program = data.foreground?.argv?.[0] ?? data.foreground?.name;
    return { found: true, live: data.state === "live", shell: isShell(program), argvs: [], labels: data.labels ?? {} };
  }
  const agent = run("herdr", ["agent", "get", name]);
  const info = parseJson(agent.stdout);
  if (agent.status !== 0 || !info?.result?.agent) return lookupFailed(host, agent, info);
  const pane = info.result.agent.pane_id;
  const probe = run("herdr", ["pane", "process-info", "--pane", pane]);
  const proc = parseJson(probe.stdout);
  const foreground = proc?.result?.process_info?.foreground_processes;
  if (probe.status !== 0 || !Array.isArray(foreground)) {
    const probeError = hostError(probe, proc) || "no process info";
    return { found: true, live: true, shell: false, argvs: [], labels: {}, probeError };
  }
  // The pane's foreground job: the harness, plus any wrapper or child it runs under.
  const argvs = foreground.map((entry) => entry.argv ?? []).filter((argv) => argv.length > 0);
  return { found: true, live: true, shell: argvs.length > 0 && argvs.every((argv) => isShell(argv[0])), argvs, labels: {} };
}

/**
 * The app space and tab that show `terminal`, for a lead that keeps its members in its own tab.
 * The window's layout (`herdr-app ls`) is the truth: a terminal the app put in a new tab has no
 * `herdr.tab` label. Its labels (`hc get`) are used only when `herdr-app` cannot answer.
 * @returns {{space: string, tab: string} | {error: string}}
 */
export function appPlace(terminal, { run = defaultRun } = {}) {
  const ls = run("herdr-app", ["ls"]);
  const layout = ls.status === 0 ? parseJson(ls.stdout) : null;
  if (Array.isArray(layout?.spaces)) {
    for (const space of layout.spaces) {
      for (const tab of space.tabs ?? []) {
        if ((tab.terminals ?? []).some((entry) => entry.terminal === terminal)) return { space: space.id, tab: tab.id };
      }
    }
    return { error: `${terminal} is in no tab of the app window (it runs without a pane); pass --tab <tab_id> from \`herdr-app ls\`` };
  }
  const out = run("hc", ["get", terminal, "--json"]);
  const labels = out.status === 0 ? parseJson(out.stdout)?.labels : null;
  if (labels?.["herdr.space"] && labels?.["herdr.tab"]) return { space: labels["herdr.space"], tab: labels["herdr.tab"] };
  const why = ls.stderr?.trim() || `herdr-app ls exited ${ls.status}`;
  return { error: `could not find the tab of ${terminal}: ${why}; pass --tab <tab_id> from \`herdr-app ls\`` };
}

/** Does `haystack` hold `needle` as one unbroken run? */
export function containsRun(haystack, needle) {
  if (needle.length === 0) return true;
  for (let start = 0; start + needle.length <= haystack.length; start += 1) {
    if (needle.every((value, offset) => haystack[start + offset] === value)) return true;
  }
  return false;
}

/** The launch record for a worker: the app's labels first, else a workers.json entry. */
export function launchRecord(live, fileRecord) {
  const profile = live.labels?.[LABEL_PROFILE];
  const fingerprint = live.labels?.[LABEL_FINGERPRINT];
  if (profile && fingerprint) return { profile, fingerprint, source: "labels" };
  if (fileRecord) return { profile: fileRecord.profile, fingerprint: fileRecord.fingerprint, source: fileRecord.file };
  return null;
}

/**
 * Problem codes that mean the check could not see the worker, not that the
 * worker is wrong: nothing is known, so they call for another check, not a relaunch.
 */
export const INSPECTION_CODES = new Set(["host-unavailable", "process-unknown"]);

/**
 * Compare a live worker with the profile as it is now. `current` is the
 * recorded profile's launch now (`null` when that profile is gone).
 * @returns {{code: string, message: string}[]} empty when the worker matches
 */
export function compareWorker({ host, name, live, record, expectedProfile, current }) {
  if (live.unreachable) {
    return [{ code: "host-unavailable", message: `could not ask \`${host}\` about worker "${name}" (${live.error || "unknown error"}), so nothing is known about it` }];
  }
  if (!live.found) return [{ code: "not-running", message: `no worker "${name}" (${live.error || "not found"})` }];
  if (!live.live) return [{ code: "not-running", message: `worker "${name}" has exited` }];
  if (live.shell) return [{ code: "shell", message: `worker "${name}" runs a shell, not its harness (it was restarted or its harness exited)` }];
  if (!record) {
    return [{ code: "no-record", message: `worker "${name}" has no launch record: it was not started from \`herdr-loadout command\`${host === "herdr" ? " with --task" : ""}` }];
  }
  const problems = [];
  if (expectedProfile && expectedProfile !== record.profile) {
    problems.push({ code: "other-profile", message: `worker "${name}" runs profile "${record.profile}", not "${expectedProfile}"` });
  }
  if (!current) {
    problems.push({ code: "profile-missing", message: `profile "${record.profile}" no longer exists` });
    return problems;
  }
  if (current.fingerprint !== record.fingerprint) {
    problems.push({ code: "profile-edited", message: `profile "${record.profile}" changed since the worker started` });
  } else if (host === "herdr" && live.argvs.length === 0) {
    problems.push({ code: "process-unknown", message: `could not read the command line of worker "${name}" (${live.probeError || "no foreground process"}), so its launch arguments are unverified` });
  } else if (host === "herdr" && !live.argvs.some((argv) => containsRun(argv.slice(1), current.args))) {
    problems.push({ code: "launch-args-lost", message: `worker "${name}" runs without the profile's launch arguments (resumed after a Herdr restart?)` });
  }
  return problems;
}
