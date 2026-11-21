/**
 * Task folders: one `<project>/.herdr/runs/<YYYY-MM-DD>-<slug>/` per delegated
 * task, holding the brief the worker reads and the report it writes.
 *
 * The brief and report start from templates: `<project>/.herdr/templates/<name>.md`
 * when present, else the built-in `src/core/templates/<name>.md`. A template is
 * plain Markdown with `{{key}}` placeholders (see `taskValues`); a key it does not
 * know is left as written.
 *
 * The task id is the slug in upper case (`api-auth` → `API-AUTH`), so markers read
 * `API-AUTH-COMPLETE`.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PROJECT_DIR_NAME, sourceRoot } from "./paths.mjs";
import { ID_PATTERN } from "./schema.mjs";

export const RUNS_DIR_NAME = "runs";
export const TEMPLATES_DIR_NAME = "templates";
export const TEMPLATE_NAMES = ["brief", "report"];

/** Lowercase words of letters and digits joined by single dashes. */
export const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** Herdr's agent-name rule, which both hosts accept. */
export const WORKER_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;
/** An hc terminal id or name, or a Herdr pane id (`w1:p3`) or agent name. */
export const ADDRESS_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:._-]*$/;

const HOST_LABELS = { herdr: "Herdr TUI", hc: "Herdr app" };

/** The host as the skill decides it: the TUI wins, since a TUI pane can inherit the app's HC_TERMINAL_ID. */
export function detectHost(env = process.env) {
  if (env.HERDR_ENV === "1") return "herdr";
  if (env.HC_TERMINAL_ID) return "hc";
  return null;
}

/** The caller's own address on that host: the hc terminal id, or the Herdr pane id. */
export function ownAddress(host, env = process.env) {
  if (host === "hc") return env.HC_TERMINAL_ID || null;
  if (host === "herdr") return env.HERDR_PANE_ID || null;
  return null;
}

export function taskIdFor(slug) {
  return slug.toUpperCase();
}

/** The command a worker runs to send `message` to the orchestrator. */
export function notifyCommand(host, address, message) {
  const quoted = `"${message}"`;
  return host === "hc" ? `hc send ${address} ${quoted}` : `herdr agent prompt ${address} ${quoted}`;
}

function localDate(now) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/**
 * The project root a task folder goes under: the nearest directory up from
 * `start` that holds one of `markers` (`.herdr` by default), else `start`. The
 * walk stops at the home directory: the `.herdr` there is Herdr's own install
 * folder, not a project. `.herdr` counts only as a directory; any other marker
 * (`.git` is a file in a linked worktree) counts as either.
 */
export function resolveTaskRoot(start, { fsImpl = fs, home = os.homedir(), markers = [PROJECT_DIR_NAME] } = {}) {
  const origin = path.resolve(start);
  // Windows paths compare without case: a drive letter can come back either way.
  const key = (value) => (process.platform === "win32" ? value.toLowerCase() : value);
  const stop = home ? key(path.resolve(home)) : null;
  const holds = (dir, name) => {
    const candidate = path.join(dir, name);
    return fsImpl.existsSync(candidate) && (name !== PROJECT_DIR_NAME || fsImpl.statSync(candidate).isDirectory());
  };
  let dir = origin;
  for (;;) {
    if (key(dir) === stop) return origin;
    if (markers.some((name) => holds(dir, name))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return origin;
    dir = parent;
  }
}

/** Fill `{{key}}` placeholders; unknown keys stay as written. */
export function fillTemplate(text, values) {
  return text.replace(/\{\{([a-z_]+)\}\}/g, (match, key) => (Object.hasOwn(values, key) ? values[key] : match));
}

/** The template text for `name` and where it came from (a path, or `built-in`). */
export function readTemplate(projectRoot, name, { fsImpl = fs, builtInRoot = sourceRoot() } = {}) {
  const own = path.join(projectRoot, PROJECT_DIR_NAME, TEMPLATES_DIR_NAME, `${name}.md`);
  if (fsImpl.existsSync(own)) return { text: fsImpl.readFileSync(own, "utf8"), source: own };
  const builtIn = path.join(builtInRoot, "src", "core", "templates", `${name}.md`);
  return { text: fsImpl.readFileSync(builtIn, "utf8"), source: "built-in" };
}

const toPosix = (value) => value.split(path.sep).join("/");

/**
 * Every value a template can use. Paths are relative to the project root, with
 * forward slashes, because workers run there.
 */
export function taskValues({ slug, date, host, orchestrator, worker, profile }) {
  const task = taskIdFor(slug);
  const dir = `${PROJECT_DIR_NAME}/${RUNS_DIR_NAME}/${date}-${slug}`;
  const brief = `${dir}/brief.md`;
  const report = `${dir}/report.md`;
  const workerName = worker ?? "<worker-name>";
  const address = orchestrator ?? "<orchestrator>";
  return {
    task,
    slug,
    date,
    host,
    host_label: HOST_LABELS[host],
    orchestrator: address,
    worker: workerName,
    profile: profile ?? "<profile-id>",
    dir,
    brief,
    report,
    prompt: `[Worker-${workerName}] Read ${brief} and do it. Report in ${report}.`,
    notify: notifyCommand(host, address, `[Report-${workerName}] <MARKER> ${report}`),
  };
}

/**
 * Create the task folder with its brief and report. Refuses a folder that
 * already exists. `runs/.gitignore` (`*`) is written when `runs/` is created,
 * so task files stay out of git even where `.herdr/` is committed.
 *
 * @returns {{ok: true, ...} | {ok: false, error: string, usage?: true}} `usage`
 *   marks bad input, as opposed to a folder that already exists.
 */
export function createTask({
  slug,
  projectStart,
  host: hostOption,
  to,
  worker,
  profile,
  env = process.env,
  now = new Date(),
  fsImpl = fs,
  home = os.homedir(),
  builtInRoot = sourceRoot(),
}) {
  const invalid = (error) => ({ ok: false, usage: true, error });
  if (!slug || !SLUG_PATTERN.test(slug)) {
    return invalid(`task slug "${slug ?? ""}" must be lowercase letters and digits joined by single dashes (${SLUG_PATTERN})`);
  }
  if (worker !== undefined && !WORKER_PATTERN.test(worker)) return invalid(`--worker "${worker}" must match ${WORKER_PATTERN}`);
  if (profile !== undefined && !ID_PATTERN.test(profile)) return invalid(`--profile "${profile}" must match ${ID_PATTERN}`);
  if (to !== undefined && !ADDRESS_PATTERN.test(to)) return invalid(`--to "${to}" must match ${ADDRESS_PATTERN}`);
  const host = hostOption ?? detectHost(env);
  if (!host) return invalid("not inside Herdr (neither HERDR_ENV=1 nor HC_TERMINAL_ID is set); pass --host herdr|hc");

  const warnings = [];
  const orchestrator = to ?? ownAddress(host, env);
  if (!orchestrator) {
    const source = host === "hc" ? "HC_TERMINAL_ID" : "HERDR_PANE_ID";
    warnings.push(`${source} is not set, so the orchestrator address is a placeholder; pass --to <address> or fill <orchestrator> in brief.md`);
  }
  if (worker === undefined) warnings.push("no --worker given; fill <worker-name> in brief.md and in the prompt");

  const projectRoot = resolveTaskRoot(projectStart, { fsImpl, home });
  const date = localDate(now);
  const values = taskValues({ slug, date, host, orchestrator, worker, profile });
  const herdrDir = path.join(projectRoot, PROJECT_DIR_NAME);
  const runsDir = path.join(herdrDir, RUNS_DIR_NAME);
  const dir = path.join(runsDir, `${date}-${slug}`);
  if (fsImpl.existsSync(dir)) return { ok: false, error: `${dir} already exists; pick another slug or use that folder` };

  const templates = Object.fromEntries(
    TEMPLATE_NAMES.map((name) => [name, readTemplate(projectRoot, name, { fsImpl, builtInRoot })]),
  );

  let gitignore = null;
  if (!fsImpl.existsSync(runsDir)) {
    fsImpl.mkdirSync(runsDir, { recursive: true });
    gitignore = path.join(runsDir, ".gitignore");
    fsImpl.writeFileSync(gitignore, "*\n");
  }
  fsImpl.mkdirSync(dir, { recursive: true });
  const files = {};
  for (const name of TEMPLATE_NAMES) {
    files[name] = path.join(dir, `${name}.md`);
    fsImpl.writeFileSync(files[name], fillTemplate(templates[name].text, values));
  }

  return {
    ok: true,
    task: values.task,
    projectRoot,
    dir,
    brief: files.brief,
    report: files.report,
    gitignore,
    templates: { brief: templates.brief.source, report: templates.report.source },
    host,
    orchestrator,
    worker: worker ?? null,
    profile: profile ?? null,
    prompt: values.prompt,
    notify: values.notify,
    warnings,
  };
}
