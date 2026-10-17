/**
 * Harness detection and command construction adapters.
 *
 * Every adapter is best-effort: detection and model catalogs may fail without
 * blocking profile creation. Model listing is cached in the state directory.
 */
import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { stateDir } from "./paths.mjs";
import { KNOWN_HARNESSES } from "./schema.mjs";
import { buildLaunchEnv, PERMISSION_FIELDS, permissionArgs, permissionValue, validatePermissions } from "./permissions.mjs";

import { CATALOG_TTL_MS, fetchCatalog, loadCatalog, modelsForProvider, readSnapshot, readSnapshotEntry } from "./modelsdev.mjs";

/**
 * A harness's model list changes rarely, but it does follow the account: a
 * provider that is logged out drops off it. `detect --refresh` forces a new
 * read, and the profile UI re-reads a cached list in the background.
 */
export const CACHE_TTL_MS = 6 * 60 * 60 * 1000;

/** Harness executables to look for, in probe order. */
export const HARNESS_EXECUTABLES = {
  claude: ["claude"],
  codex: ["codex"],
  opencode: ["opencode"],
  omp: ["omp"],
  pi: ["pi"],
};

const WINDOWS_EXTENSIONS = [".exe", ".cmd", ".bat", ".ps1", ""];

function windowsExtensions(env) {
  const pathext = env.PATHEXT ? env.PATHEXT.split(";").filter(Boolean) : [];
  const all = [...pathext, ...WINDOWS_EXTENSIONS];
  return [...new Set(all.map((ext) => ext.toLowerCase()))];
}

/**
 * Resolve an executable on PATH, honouring PATHEXT on Windows.
 * Returns the absolute path or null.
 */
export function which(command, options = {}) {
  const env = options.env ?? process.env;
  const fsImpl = options.fs ?? fs;
  const platform = options.platform ?? process.platform;
  const isWin = platform === "win32";
  // Follow the simulated platform, not the host: identical on a real machine.
  const p = isWin ? path.win32 : path.posix;

  if (command.includes("/") || command.includes("\\")) {
    return fsImpl.existsSync(command) ? p.resolve(command) : null;
  }

  const dirs = (env.PATH ?? "").split(isWin ? ";" : ":").filter(Boolean);
  const extensions = isWin ? windowsExtensions(env) : [""];

  // Collect every match first: a caller may prefer the shortest path.
  const found = [];
  for (const dir of dirs) {
    for (const ext of extensions) {
      const candidate = p.join(dir, command + ext);
      if (fsImpl.existsSync(candidate)) found.push(p.resolve(candidate));
    }
  }
  if (found.length === 0) return null;
  if (!isWin || options.preferNoSpaces !== true) return found[0];

  // `herdr agent start` builds a shell string that breaks on a path containing
  // a space (measured on this machine: an nvm layout under "Author Software").
  // A different PATH entry often holds the same tool without a space, so prefer
  // that when the caller asks for a launchable path.
  return found.find((candidate) => !candidate.includes(" ")) ?? found[0];
}

/** Detect every known harness on this machine. */
export function detectHarnesses(options = {}) {
  return KNOWN_HARNESSES.map((id) => {
    const candidates = HARNESS_EXECUTABLES[id] ?? [id];
    let resolved = null;
    for (const candidate of candidates) {
      resolved = which(candidate, options);
      if (resolved) break;
    }
    return { id, detected: Boolean(resolved), path: resolved, candidates };
  });
}

function cacheFile(id, env) {
  return path.join(stateDir(env), "models", `${id}.json`);
}

function readCache(id, env) {
  try {
    const raw = fs.readFileSync(cacheFile(id, env), "utf8");
    const parsed = JSON.parse(raw);
    if (Date.now() - parsed.fetchedAt < CACHE_TTL_MS) return parsed;
  } catch {
    /* cache miss is normal */
  }
  return null;
}

/**
 * How a lookup uses the cache. `cache: false` neither reads nor writes it;
 * `refresh: true` skips the read but still stores the fresh answer.
 */
function cacheMode(options) {
  const write = options.cache !== false;
  return { read: write && options.refresh !== true, write };
}

function writeCache(id, env, models) {
  const file = cacheFile(id, env);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ fetchedAt: Date.now(), models }, null, 2));
  } catch {
    /* cache write failure must never break the CLI */
  }
}

/**
 * Spawn a resolved executable. On Windows, npm-style `.cmd`/`.bat` shims and
 * `.ps1` scripts cannot be spawned directly, so route them through their
 * interpreter with argument arrays (no shell string interpolation).
 */
function resolveSpawn(executablePath, args, options) {
  const env = options.env ?? process.env;
  const timeout = options.timeoutMs ?? 15000;
  const lower = String(executablePath).toLowerCase();
  const isWin = (options.platform ?? process.platform) === "win32";

  let file = executablePath;
  let argv = args;

  if (isWin && (lower.endsWith(".cmd") || lower.endsWith(".bat"))) {
    file = env.ComSpec ?? env.COMSPEC ?? "cmd.exe";
    argv = ["/d", "/c", executablePath, ...args];
  } else if (isWin && lower.endsWith(".ps1")) {
    file = "powershell.exe";
    argv = ["-NoProfile", "-NonInteractive", "-File", executablePath, ...args];
  }

  return { file, argv, env, timeout };
}

function spawnResolved(executablePath, args, options) {
  const { file, argv, env, timeout } = resolveSpawn(executablePath, args, options);
  return execFileSync(file, argv, {
    encoding: "utf8",
    timeout,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
}

function run(command, args, options = {}) {
  const env = options.env ?? process.env;
  const executable = options.executablePath ?? command;
  try {
    const stdout = spawnResolved(executable, args, { ...options, env });
    return { ok: true, stdout };
  } catch (error) {
    return { ok: false, error: error.message, stdout: error.stdout ?? "" };
  }
}

/**
 * `run` without blocking the event loop, for the interactive UI. Resolves to
 * the same shape and never rejects. `options.signal` kills the child.
 */
function runAsync(command, args, options = {}) {
  const executable = options.executablePath ?? command;
  return new Promise((resolve) => {
    try {
      const { file, argv, env, timeout } = resolveSpawn(executable, args, options);
      const child = execFile(
        file,
        argv,
        { encoding: "utf8", timeout, env, windowsHide: true, signal: options.signal },
        (error, stdout) => {
          if (error) resolve({ ok: false, error: error.message, stdout: stdout ?? "" });
          else resolve({ ok: true, stdout });
        },
      );
      child.stdin?.end();
    } catch (error) {
      resolve({ ok: false, error: error.message, stdout: "" });
    }
  });
}

/**
 * Static fallback effort levels when a harness cannot be queried.
 * Values mirror each CLI's own help output on this machine.
 */
export const EFFORT_LEVELS = {
  claude: ["low", "medium", "high", "xhigh", "max"],
  codex: ["low", "medium", "high", "xhigh", "max"],
  opencode: ["minimal", "low", "medium", "high", "max"],
  omp: ["off", "minimal", "low", "medium", "high", "xhigh", "max", "auto"],
  pi: [],
  custom: [],
};

/** Model catalogs: each adapter returns { id, label, efforts? } records. */
/**
 * Harness-specific catalogs that are not available from the harness itself.
 *
 * claude has no model-listing command, but omp does carry Anthropic's catalog.
 * `claudeCatalogFromOmp()` reads that list and keeps the entries claude accepts,
 * which also supplies each model's valid effort levels. The aliases below stay
 * as a fallback for when omp is unavailable.
 */
const CLAUDE_ALIAS_EFFORTS = ["low", "medium", "high", "xhigh", "max"];

const STATIC_CATALOGS = {
  claude: [
    { id: "opus", label: "opus — latest Opus", efforts: ["low", "medium", "high", "max"] },
    { id: "sonnet", label: "sonnet — latest Sonnet", efforts: ["low", "medium", "high"] },
    { id: "haiku", label: "haiku — latest Haiku", efforts: ["minimal", "low", "medium", "high", "xhigh"] },
    { id: "fable", label: "fable — needs usage credits", efforts: CLAUDE_ALIAS_EFFORTS },
  ],
};

/**
 * ids to drop from omp's Anthropic list when building claude's picker.
 *
 * omp tracks Anthropic's API catalog, which is wider than what claude code
 * accepts. Each candidate was probed with `--model <id> --print "x"`: an
 * unknown id fails locally, a retired one says so, an inaccessible one reports
 * "may not exist or you may not have access".
 *
 * Dropped here:
 *  - the retired 3.x generation
 *  - dated snapshots, whose short form is the maintained name
 *  - claude-sonnet-4-0 (retired 2026-06-15) and claude-mythos-* (no access)
 */
const CLAUDE_EXCLUDED = /^claude-3|-\d{8}$|^claude-sonnet-4-0$|^claude-mythos-/;

/**
 * Build claude's picker rows from the models.dev Anthropic catalog.
 *
 * This is the same source omp reads, so it needs no omp installation and gives
 * each model's reasoning levels. Falls back to null so the caller can try its
 * own sources.
 *
 * @param {object} [options]
 * @param {object} [options.catalog] pre-loaded catalog (for tests)
 * @returns {object[]|null}
 */
export function claudeCatalogFromModelsDev(options = {}) {
  const catalog = options.catalog ?? readSnapshot(options);
  if (!catalog) return null;
  const rows = modelsForProvider(catalog, "anthropic", options);
  if (!rows) return null;
  return filterClaudeRows(rows);
}

/** Keep the curated aliases on top and drop what claude does not accept. */
function filterClaudeRows(rows) {
  const seen = new Set();
  const out = [];
  for (const alias of STATIC_CATALOGS.claude) {
    out.push(alias);
    seen.add(alias.id);
  }
  for (const row of rows) {
    if (!row?.id || seen.has(row.id)) continue;
    if (CLAUDE_EXCLUDED.test(row.id)) continue;
    seen.add(row.id);
    out.push(row);
  }
  return out;
}

/**
 * Build claude's picker rows from omp's Anthropic catalog.
 *
 * omp tracks Anthropic's model list, including the effort levels each model
 * accepts, so it is a better source than a hand-maintained table. ids claude
 * itself rejects are filtered out, and the curated aliases are kept on top.
 *
 * @returns {object[]|null} rows, or null when omp is unavailable
 */
export function claudeCatalogFromOmp(options = {}) {
  const env = options.env ?? process.env;
  const ompPath = options.executablePath ?? which("omp", { env });
  if (!ompPath) return null;
  const result = run(ompPath, ["models", "--json"], { ...options, env, executablePath: ompPath, timeoutMs: options.timeoutMs ?? 20000 });
  if (!result.ok) return null;
  return parseOmpAnthropic(result.stdout);
}

/** claude's rows from `omp models --json` output, or null when it has none. */
function parseOmpAnthropic(stdout) {
  let data;
  try {
    data = JSON.parse(stdout);
  } catch {
    return null;
  }
  const list = Array.isArray(data?.models) ? data.models : [];
  const anthropic = list.filter((model) => model?.provider === "anthropic");
  if (anthropic.length === 0) return null;

  return filterClaudeRows(
    anthropic.map((model) => ({
      id: model.id,
      label: model.name ?? model.id,
      efforts: Array.isArray(model.thinking) ? model.thinking : undefined,
    })),
  );
}

/** Effort levels a harness accepts at launch, for the picker's effort field. */
const STATIC_EFFORT = {
  claude: ["low", "medium", "high", "xhigh", "max"],
};

const CATALOGS = {
  codex: {
    // `codex debug models` prints {"models":[{"slug","display_name",...}]}
    args: ["debug", "models"],
    parse(stdout) {
      const data = JSON.parse(stdout);
      const list = Array.isArray(data?.models) ? data.models : [];
      return list
        .map((model) => ({
          id: model.slug,
          label: model.display_name ?? model.slug,
          context: model.context_window ?? model.contextWindow,
          efforts: Array.isArray(model.supported_reasoning_levels)
            ? model.supported_reasoning_levels.map((level) => level.effort).filter(Boolean)
            : undefined,
        }))
        .filter((model) => model.id);
    },
  },
  opencode: {
    // `opencode models` prints one `provider/model` per line
    args: ["models"],
    parse(stdout) {
      return stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line && line.includes("/"))
        .map((line) => ({ id: line, label: line }));
    },
  },
  omp: {
    // `omp models --json` prints {"models":[{"selector","name",...}]}
    args: ["models", "--json"],
    parse(stdout) {
      const data = JSON.parse(stdout);
      const list = Array.isArray(data?.models) ? data.models : [];
      return list
        .map((model) => ({
          id: model.selector ?? model.id,
          label: model.name ?? model.selector ?? model.id,
          efforts: Array.isArray(model.thinking) ? model.thinking : undefined,
          context: model.contextWindow,
        }))
        .filter((model) => model.id);
    },
  },
};

/**
 * Harnesses with no model list at all: the value stays free-form.
 * claude is no longer here — it has a fixed alias set (STATIC_CATALOGS).
 */
export const NO_CATALOG = ["pi"];

/**
 * Harnesses whose launched form accepts an effort flag.
 * opencode's `--variant` belongs to `opencode run`, not the interactive TUI.
 */
export const EFFORT_CAPABLE = ["claude", "codex", "omp"];

/**
 * List models for a harness. Never throws: failure yields an empty catalog and
 * a reason, so the caller can fall back to free-form input.
 *
 * A cached answer that came from a harness CLI carries `revalidate: true`: that
 * list follows the account's logins, so it can be out of date well inside the
 * TTL. Ask again with `refresh: true` to replace it.
 * @returns {{ok: boolean, models: object[], error?: string, cached?: boolean, revalidate?: boolean}}
 */
export function listModels(harness, options = {}) {
  const env = options.env ?? process.env;
  const cache = cacheMode(options);
  // claude has no listing command. Prefer the models.dev snapshot (the same
  // source omp reads), then omp itself, then the curated aliases.
  if (harness === "claude") {
    const fromModelsDev = claudeCatalogFromModelsDev(options);
    if (fromModelsDev) return { ok: true, models: fromModelsDev, derived: "models.dev" };
    const fromOmp = claudeCatalogFromOmp(options);
    if (fromOmp) return { ok: true, models: fromOmp, derived: "omp" };
    return { ok: true, models: STATIC_CATALOGS.claude, static: true };
  }
  // A harness with a fixed set of values and no listing command.
  const fixed = STATIC_CATALOGS[harness];
  if (fixed) {
    return { ok: true, models: fixed, static: true };
  }
  // `noCatalog` distinguishes "this harness has no model list" (fine, the
  // value is free-form) from "the lookup failed" (a real problem to report).
  const catalog = CATALOGS[harness];
  if (!catalog) {
    return { ok: true, models: [], error: `no catalog for harness "${harness}"`, noCatalog: true };
  }
  if (cache.read) {
    const cached = readCache(harness, env);
    if (cached) return { ok: true, models: cached.models, cached: true, revalidate: true };
  }
  const executablePath = options.executablePath ?? which(harness, { env }) ?? harness;
  const result = run(executablePath, catalog.args, { ...options, env, executablePath });
  return catalogFromOutput(harness, catalog, result, cache.write, env);
}

function catalogFromOutput(harness, catalog, result, useCache, env) {
  if (!result.ok) return { ok: false, models: [], error: result.error };
  try {
    const models = catalog.parse(result.stdout);
    if (models.length === 0) return { ok: false, models: [], error: "empty model catalog" };
    if (useCache) writeCache(harness, env, models);
    return { ok: true, models };
  } catch (error) {
    return { ok: false, models: [], error: `parse failed: ${error.message}` };
  }
}

/**
 * `listModels` for the interactive UI: same result, but a harness CLI runs
 * without blocking the event loop, so the pane keeps taking keys meanwhile.
 *
 * claude differs from the sync form in two ways that keep it fast: its derived
 * rows are cached like any other harness, and an expired models.dev snapshot is
 * still served while a fresh one is fetched in the background for next time.
 * `options.offline` (or HERDR_LOADOUT_OFFLINE=1) suppresses that fetch.
 * @returns {Promise<{ok: boolean, models: object[], error?: string, cached?: boolean, revalidate?: boolean}>}
 */
export async function listModelsAsync(harness, options = {}) {
  const env = options.env ?? process.env;
  const cache = cacheMode(options);
  if (harness === "claude") {
    if (cache.read) {
      const cached = readCache(harness, env);
      if (cached) return { ok: true, models: cached.models, cached: true };
    }
    const snapshot = options.catalog ? { data: options.catalog, ageMs: 0 } : readSnapshotEntry(options);
    const offline = options.offline ?? env.HERDR_LOADOUT_OFFLINE === "1";
    if (!offline && (!snapshot || snapshot.ageMs > CATALOG_TTL_MS)) void fetchCatalog(options);

    let result = null;
    const fromModelsDev = snapshot ? claudeCatalogFromModelsDev({ ...options, catalog: snapshot.data }) : null;
    if (fromModelsDev) result = { ok: true, models: fromModelsDev, derived: "models.dev" };
    if (!result) {
      const ompPath = options.executablePath ?? which("omp", { env });
      const output = ompPath
        ? await runAsync(ompPath, ["models", "--json"], { ...options, env, executablePath: ompPath, timeoutMs: options.timeoutMs ?? 20000 })
        : null;
      const fromOmp = output?.ok ? parseOmpAnthropic(output.stdout) : null;
      if (fromOmp) result = { ok: true, models: fromOmp, derived: "omp" };
    }
    if (!result) return { ok: true, models: STATIC_CATALOGS.claude, static: true };
    if (cache.write) writeCache(harness, env, result.models);
    return result;
  }
  const fixed = STATIC_CATALOGS[harness];
  if (fixed) {
    return { ok: true, models: fixed, static: true };
  }
  const catalog = CATALOGS[harness];
  if (!catalog) {
    return { ok: true, models: [], error: `no catalog for harness "${harness}"`, noCatalog: true };
  }
  if (cache.read) {
    const cached = readCache(harness, env);
    if (cached) return { ok: true, models: cached.models, cached: true, revalidate: true };
  }
  const executablePath = options.executablePath ?? which(harness, { env }) ?? harness;
  const result = await runAsync(executablePath, catalog.args, { ...options, env, executablePath });
  return catalogFromOutput(harness, catalog, result, cache.write, env);
}

/** Effort levels for a harness, preferring the live catalog when it reports any. */
export function effortLevels(harness, options = {}) {
  const fixed = STATIC_EFFORT[harness];
  if (fixed && !options.models?.some((model) => model.efforts?.length)) return fixed;
  if (options.models) {
    const found = new Set();
    for (const model of options.models) {
      for (const level of model.efforts ?? []) found.add(level);
    }
    if (found.size > 0) return [...found];
  }
  return EFFORT_LEVELS[harness] ?? [];
}

/**
 * Build the argv for launching a harness with a profile's settings.
 * Pure function: no process is started here.
 *
 * Flags must be ones the *interactive* form accepts, because that is what
 * `herdr agent start` launches. For example opencode exposes `--variant` on
 * `opencode run` only; passing it to the interactive TUI makes it print help
 * and exit, so the effort is carried through config instead.
 */
export function buildLaunchArgs(profile) {
  const harness = profile.harness ?? "custom";
  const args = [];
  const effort = profile.effort;
  switch (harness) {
    case "codex": {
      if (profile.model) args.push("-m", profile.model);
      if (effort) args.push("-c", `model_reasoning_effort=${effort}`);
      break;
    }
    case "claude": {
      if (profile.model) args.push("--model", profile.model);
      if (effort) args.push("--effort", effort);
      break;
    }
    case "opencode": {
      if (profile.model) args.push("-m", profile.model);
      // interactive opencode has no effort flag; `--variant` exists only on `run`
      break;
    }
    case "omp": {
      if (profile.model) args.push(`--model=${profile.model}`);
      if (effort) args.push(`--thinking=${effort}`);
      break;
    }
    default: {
      if (profile.model) args.push("--model", profile.model);
      if (effort) args.push("--effort", effort);
    }
  }
  const replacesMode = (harness === "codex" && Object.hasOwn(profile, "approval_policy")) ||
    (harness === "claude" && Object.hasOwn(profile, "permission_mode"));
  if (profile.mode && !replacesMode) args.push(...modeArgs(harness, profile.mode));
  args.push(...permissionArgs(profile));
  if (Array.isArray(profile.extra_args)) args.push(...profile.extra_args);
  return args;
}

function modeArgs(harness, mode) {
  switch (harness) {
    case "claude":
      return ["--permission-mode", mode];
    case "codex":
      return ["-a", mode];
    default:
      return ["--mode", mode];
  }
}

/**
 * Test Launch dry-run: verify the executable, model, and effort are usable
 * without starting an agent.
 * @returns {{ok: boolean, checks: Array<{label: string, ok: boolean, detail?: string}>}}
 */
export function dryRun(profile, options = {}) {
  const checks = [];
  const permissionErrors = validatePermissions(profile);
  let env = {};
  try {
    env = buildLaunchEnv(profile, options.env ?? process.env);
  } catch (error) {
    permissionErrors.push(error.message);
  }
  checks.push({
    label: "permissions",
    ok: permissionErrors.length === 0,
    detail: permissionErrors.length ? permissionErrors.join("; ") :
      PERMISSION_FIELDS.map((field) => permissionValue(profile, field)).filter(Boolean).join(", ") || "inherit harness settings",
  });
  const harness = profile.harness ?? "custom";
  const launchOptions = { ...options, preferNoSpaces: true };
  const detected = detectHarnesses(launchOptions).find((entry) => entry.id === harness);
  const executablePath = detected?.path ?? (harness === "custom" ? which(profile.model ?? "", launchOptions) : null);

  checks.push({
    label: `${harness} executable`,
    ok: Boolean(executablePath),
    detail: executablePath ?? "not found on PATH",
  });

  // A path with a space cannot be launched by Herdr on Windows, so surface it
  // here rather than letting the worker fail after a 30-second startup wait.
  if (executablePath && String(executablePath).includes(" ") && (options.platform ?? process.platform) === "win32") {
    const alternative = which(harness, { ...options, preferNoSpaces: true });
    checks.push({
      label: "launchable path",
      ok: false,
      detail:
        alternative && alternative !== executablePath
          ? `path contains a space; use ${alternative}`
          : "path contains a space and Herdr cannot launch it; adjust PATH",
    });
  }

  const catalog = CATALOGS[harness] ? listModels(harness, options) : null;
  if (profile.model) {
    if (catalog?.ok && catalog.models.length > 0) {
      const match = catalog.models.find((model) => model.id === profile.model);
      checks.push({
        label: `model "${profile.model}"`,
        ok: Boolean(match),
        detail: match ? match.id : `not in catalog (${catalog.models.length} known)`,
      });
    } else {
      checks.push({
        label: `model "${profile.model}"`,
        ok: true,
        detail: catalog?.error ? `unverified: ${catalog.error}` : "no catalog; accepting free-form value",
      });
    }
  }

  if (profile.effort && harness !== "custom") {
    const known = effortLevels(harness, { models: catalog?.models });
    const ok = known.length === 0 || known.includes(profile.effort);
    const carried = EFFORT_CAPABLE.includes(harness);
    checks.push({
      label: `effort "${profile.effort}"`,
      ok,
      detail: !carried
        ? `not settable via ${harness} launch flags; ignored at startup`
        : known.length > 0
          ? `allowed: ${known.join(", ")}`
          : "unknown harness; accepting value",
    });
  }

  const args = buildLaunchArgs(profile);
  checks.push({
    label: "launch command",
    ok: Boolean(executablePath),
    detail: `${executablePath ?? harness} ${args.join(" ")}`.trim(),
  });

  return {
    ok: checks.every((check) => check.ok),
    checks,
    // Machine-usable launch description: a caller appends these to
    // `herdr agent start <name> --kind <harness> --pane <id> --`.
    harness,
    model: profile.model ?? null,
    effort: profile.effort ?? null,
    executable: executablePath ?? null,
    args,
    env,
  };
}

export { run as runCommand };
