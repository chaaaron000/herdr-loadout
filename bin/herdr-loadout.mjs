#!/usr/bin/env node
/**
 * herdr-loadout CLI — the Director-facing profile registry.
 *
 * Contract: `list --compact` prints one `id | cost | purpose` line per profile
 * with no decoration, so an orchestrator can read it cheaply.
 */
import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { parseArgs } from "node:util";
import { renderCompact, renderList, renderShow } from "../src/core/format.mjs";
import { mergeProfiles, overrideDelta } from "../src/core/merge.mjs";
import {
  configDir,
  findProjectConfig,
  globalConfigPath,
  projectConfigPath,
  sourceRoot,
  stateDir,
} from "../src/core/paths.mjs";
import { detectHarnesses, dryRun, effortLevels, HOSTS, listModels, resolveSpawn, withModelEffort } from "../src/core/detect.mjs";
import { renderStartCommand, SHELLS } from "../src/core/command.mjs";
import { maskEnv } from "../src/core/env.mjs";
import {
  ensureGlobalConfig,
  loadConfig,
  readConfigFile,
  upsertProfile,
  deleteProfile,
  deleteProfileFrom,
} from "../src/core/store.mjs";
import { fetchCatalog, modelsForProvider, readSnapshot, MODELS_DEV_URL } from "../src/core/modelsdev.mjs";
import { mergeProfileInput, normalizePayload, profileFromFlags, readProfilePayload, looksLikeToml } from "../src/core/input.mjs";
import { parse as parseToml } from "smol-toml";
import fs from "node:fs";
import { validatePermissions } from "../src/core/permissions.mjs";
import { initWorkflow, loadWorkflow, renderWorkflow } from "../src/core/workflow.mjs";
import { createTask, detectHost, resolveTaskRoot } from "../src/core/task.mjs";
import { agentsMdStatus, blockText, installAgentsMd, recordDecline, resolveProjectRoot } from "../src/core/agents-md.mjs";
import { appPlace, compareWorker, findWorkerRecord, INSPECTION_CODES, inspectWorker, launchFingerprint, launchLabels, launchRecord, recordWorker } from "../src/core/worker.mjs";
import { listKeys, PROVIDER_IDS, PROVIDERS, removeKey, saveKey, testKey } from "../src/core/keys.mjs";

const EXIT_OK = 0;
const EXIT_ERROR = 1;
const EXIT_USAGE = 2;

const USAGE = `herdr-loadout — agent profile registry for Herdr

Usage:
  herdr-loadout list [--compact] [--json] [--all] [--project PATH]
  herdr-loadout show <id> [--json] [--project PATH] [--detect]
  herdr-loadout path [--project PATH]
  herdr-loadout validate [--json]
  herdr-loadout detect [--json] [--refresh]
  herdr-loadout catalog [--refresh] [--provider ID] [--json]   # models.dev snapshot
  herdr-loadout launch <id> [--json] [--host herdr|hc] [--project PATH]
  herdr-loadout command <id> [--host herdr|hc] [--shell sh|powershell] [--name WORKER]
                        [--pane ID] [--space ID] [--tab ID] [--cwd DIR] [--task DIR] [--project PATH]
                                   print the command that starts a worker on this profile
  herdr-loadout worker-check <worker> [--profile ID] [--task DIR] [--host herdr|hc] [--json]
                                   does a running worker still match its profile? (exit 1: no)
  herdr-loadout exec <id> [--host herdr|hc] [--project PATH]   run the harness here
  herdr-loadout env-value <id> <KEY> [--project PATH]   one env value a launch sets (unmasked)
  herdr-loadout ui [--placement split|popup|overlay] [--project PATH]
  herdr-loadout editor <action> [--input JSON] [--project PATH]   Herdr app editor backend (JSON)
  herdr-loadout keys [list] [--json]                 stored API keys (masked) and providers
  herdr-loadout keys add <ID> --provider P [--label L]   store a key; it is read from stdin
  herdr-loadout keys remove <ID> | keys test <ID>
  herdr-loadout workflow [--json] [--project PATH]   the delegation workflow for this project
  herdr-loadout workflow init [--project PATH]       create the global (or project) file to edit
  herdr-loadout task new <slug> [--worker NAME] [--profile ID] [--to ADDRESS]
                         [--host herdr|hc] [--project PATH] [--json]
                                   create .herdr/runs/<date>-<slug>/ with brief.md and report.md
  herdr-loadout agents-md [status] [--project PATH] [--claude-md] [--json]
                                   is the delegation block in this project's AGENTS.md?
                                   (current | missing | outdated | declined)
  herdr-loadout agents-md print    the block, exactly as install writes it
  herdr-loadout agents-md install [--project PATH] [--claude-md] [--json]
                                   write or update the block (and the @AGENTS.md imports
                                   other harnesses need), touching nothing outside its markers
  herdr-loadout agents-md decline [--project PATH] [--json]
                                   remember that the user said no here (kept outside the repo)

Write:
  herdr-loadout add [--id ID] [--name NAME] [--harness H] [--model M]
                    [--effort E] [--cost C] [--when TEXT] [--avoid TEXT]
                    [--sandbox S] [--approval-policy A] [--permission-mode P] [--auth A] [--api KEY]
                    [--tag T]... [--env K=V]... [--from FILE|-]
                    [--project PATH] [--force] [--json]
                    [-- EXTRA_ARG...]        everything after -- becomes extra_args
  herdr-loadout set <id> [flags...] [--from FILE|-] [--project PATH] [--json]
  herdr-loadout reset <id> [--project PATH] [--json]           drop a project override
  herdr-loadout remove <id> [--project PATH] [--json]
  herdr-loadout import <FILE|-> [--project PATH] [--json]      merge a config file
  herdr-loadout move <id> --up|--down|--before ID|--after ID [--project PATH] [--json]
                                   change where a profile is listed

Profiles live in two places: the global config (shared) and the project file
(<project>/.herdr/loadout.toml). A project file can hold an override of a global
profile (only the fields that differ) or a project-only profile (a whole profile).

Writing targets the global config by default; --project writes the project file.
  set      global: edits the global profile itself (a project override is never
           copied into it). --project: stores only what differs from global, or
           the whole profile for a project-only one. Back to the global values
           removes the override.
  reset    removes a project override so the profile follows global again.
  remove   global: deletes the global profile and this project's override of it.
           --project: deletes the project entry (an override or a project-only profile).
  add      refuses an id that already exists; with --project, also one that exists
           in global (use \`set --project\` to override it).
  move     reorders within the profile's own group: a global profile (overridden
           or not) moves in the global file, a project-only one in the project
           file. --project only names the project, as for list.
Flags whose values begin with a dash must use --flag=value, or pass them after --.

Options:
  --compact   one line per profile: id | cost | purpose (Director format)
  --json      machine-readable output
  --all       include a marker for suppressed/duplicate entries
  --project   use this project root for overrides
  --refresh   re-read the model catalog and replace the cache
  --from      read a profile from a JSON/TOML file, or - for stdin
  --force     allow overwriting an existing profile id
  --sandbox   Codex: read-only | workspace-write | danger-full-access
  --approval-policy  Codex: on-request | never | approve-for-me | bypass
                     (approve-for-me and bypass set the sandbox themselves)
  --permission-mode  Claude / OMP / OpenCode / agy permission mode (empty = inherit)
    Claude: manual | acceptEdits | auto | dontAsk | plan | bypassPermissions
    OMP: always-ask | always-ask-cached | write | yolo; OpenCode: ask | allow | deny | auto
    agy: accept-edits | auto | plan | dangerously-skip-permissions
  --api       a stored key the harness runs on instead of its own sign-in
              (claude: DeepSeek; agy: Google AI Studio). Empty = sign-in.
  --auth      agy: subscription (its sign-in; default) | api-key (Gemini API with
              GEMINI_API_KEY from --env or the worker's environment)
  --host      where the worker runs: herdr (TUI, default) or hc (Herdr app).
              launch --json adds \`argv\`, the whole command for \`hc run --\`; it goes
              through \`exec\` when the profile sets environment variables, which
              \`hc run\` cannot pass, or when an argument holds a double quote, which
              Windows PowerShell 5.1 strips.
  --shell     command: quote for sh (default; bash, Git Bash, zsh) or powershell.
              Values not given (--name, --pane, --space) print as <placeholders>.
  --cwd       command: the worker's working directory (default: here)
  --tab       command --host hc: the app tab for the worker. \`--tab self\` is the tab
              that shows you ($HC_TERMINAL_ID, found in \`herdr-app ls\`), and its
              space when --space is not given: a lead's members go there.
  --claude-md agents-md: also import AGENTS.md from CLAUDE.md (created when absent), for a
              Claude Code that reads only CLAUDE.md (older versions, or Project
              instructions set to claude-md)
  --worker    task new: the worker's name, used in the prompt and the report line
  --profile   task new: the profile id recorded in the brief.
              worker-check: the profile the worker should run (else its record's)
  --to        task new: the orchestrator address the worker reports to
              (default: $HC_TERMINAL_ID in the app, $HERDR_PANE_ID in the TUI)
  --task      command: record the worker (profile and launch fingerprint) in this
              task folder's workers.json. worker-check: read the record from there
              (default: the newest record for that worker under .herdr/runs/).
              With --host hc, command also labels the worker with its profile and
              fingerprint, which worker-check reads first.
  --up, --down        move: one place up or down the list
  --before, --after   move: put the profile right before or after this one
  -h, --help  show this message

Env values may hold secrets: list, show, launch, and command print them as ***.
command reads them at run time through env-value instead of printing them.
`;

function fail(message, code = EXIT_ERROR) {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function loadMerged(options) {
  const projectRoot = options.project ?? process.cwd();
  ensureGlobalConfig();
  const loaded = loadConfig({
    globalPath: options.globalPath,
    projectPath: findProjectConfig(projectRoot),
  });
  if (loaded.errors.length > 0) {
    fail(loaded.errors.join("\n"));
  }
  const projectProfiles = loaded.project?.profiles ?? [];
  const { profiles, byId } = mergeProfiles(loaded.profiles, projectProfiles);
  return { loaded, profiles, byId, projectRoot };
}

function resolveDetection(profiles, options) {
  if (!options.detect) return null;
  const harnessIds = new Set(profiles.map((profile) => profile.harness).filter(Boolean));
  return detectHarnesses().filter((entry) => harnessIds.has(entry.id));
}

function cmdList(options) {
  const { profiles, loaded } = loadMerged(options);
  const detection = resolveDetection(profiles, options);

  if (options.json) {
    return printJson({
      globalPath: loaded.globalPath,
      projectPath: loaded.projectPath,
      profiles: profiles.map(({ origin, overrides, ...profile }) => ({ ...profile, env: maskEnv(profile.env), origin, overrides })),
      invalid: loaded.invalid,
    });
  }
  if (options.compact) {
    if (profiles.length === 0) return;
    process.stdout.write(`${renderCompact(profiles)}\n`);
    return;
  }
  if (profiles.length === 0) {
    process.stdout.write(`No profiles yet. Run \`herdr-loadout ui\` to create one, or edit ${loaded.globalPath}.\n`);
    return;
  }
  process.stdout.write(
    `${renderList(profiles, { detection, globalProfiles: loaded.profiles, projectPath: loaded.projectPath })}\n`,
  );
}

function cmdShow(id, options) {
  const { byId, loaded } = loadMerged(options);
  const profile = byId.get(id);
  if (!profile) {
    const known = [...byId.keys()];
    fail(`profile "${id}" not found.${known.length ? ` Known ids: ${known.join(", ")}` : ""}`);
  }
  if (options.json) return printJson({ ...profile, env: maskEnv(profile.env) });
  const detection = resolveDetection([profile], { detect: options.detect ?? true });
  const globalProfile = loaded.profiles.find((entry) => entry?.id === id) ?? null;
  process.stdout.write(`${renderShow(profile, { detection, globalProfile })}\n`);
}

function cmdPath(options) {
  const { loaded } = loadMerged(options);
  const workflow = loadWorkflow({ projectRoot: options.project ?? process.cwd() });
  printJson({
    pluginRoot: sourceRoot(),
    configDir: configDir(),
    stateDir: stateDir(),
    globalConfig: loaded.globalPath,
    projectConfig: options.project ? projectConfigPath(options.project) : loaded.projectPath,
    discoveredProjectConfig: loaded.projectPath,
    globalWorkflow: workflow.global.path,
    projectWorkflow: workflow.project.path,
  });
}

/**
 * The delegation workflow: the global one (or the built-in default), then this
 * project's rules. `init` creates a file to edit instead.
 */
function cmdWorkflow(sub, options) {
  const projectRoot = options.project ?? process.cwd();
  if (sub === "init") {
    const result = initWorkflow({ scope: options.project ? "project" : "global", projectRoot });
    if (!result.ok) fail(result.error);
    process.stdout.write(`created ${result.path}\n`);
    return;
  }
  if (sub !== undefined) fail(`unknown workflow command: ${sub}`, EXIT_USAGE);
  const workflow = loadWorkflow({ projectRoot });
  if (options.json) return printJson(workflow);
  process.stdout.write(renderWorkflow(workflow));
}

/**
 * Scaffold a task folder: brief and report from the project's templates or the
 * built-in ones, with the orchestrator address and notify command filled in.
 */
function cmdTask(sub, slug, options) {
  if (sub !== "new") fail("usage: herdr-loadout task new <slug> [--worker NAME] [--profile ID] [--to ADDRESS]", EXIT_USAGE);
  const result = createTask({
    slug,
    projectStart: options.project ?? process.cwd(),
    host: options.host,
    to: options.to,
    worker: options.worker,
    profile: options.profile,
  });
  if (!result.ok) {
    if (options.json) printJson({ ok: false, errors: [result.error] });
    else process.stderr.write(`${result.error}\n`);
    process.exit(result.usage ? EXIT_USAGE : EXIT_ERROR);
  }
  if (options.json) return printJson(result);
  for (const warning of result.warnings) process.stderr.write(`warning: ${warning}\n`);
  const created = [result.gitignore, result.brief, result.report].filter(Boolean);
  const lines = created.map((file) => `created ${file}`);
  lines.push("# fill in brief.md, start the worker, then send it:", result.prompt);
  process.stdout.write(`${lines.join("\n")}\n`);
}

/**
 * The delegation block in the project's AGENTS.md: its state, the block itself,
 * installing it, or recording that the user declined it.
 */
function cmdAgentsMd(sub, options) {
  const action = sub ?? "status";
  if (action === "print") {
    process.stdout.write(`${blockText()}\n`);
    return;
  }
  const projectRoot = resolveProjectRoot({ project: options.project });
  const claudeMd = options["claude-md"] === true;
  if (action === "status") {
    const status = agentsMdStatus({ projectRoot, claudeMd });
    if (options.json) return printJson(status);
    process.stdout.write(`${renderAgentsMdStatus(status)}\n`);
    return;
  }
  if (action === "install") {
    const result = installAgentsMd({ projectRoot, claudeMd });
    if (!result.ok) {
      if (options.json) printJson({ ok: false, errors: [result.error] });
      else process.stderr.write(`${result.error}\n`);
      process.exit(EXIT_ERROR);
    }
    if (options.json) return printJson(result);
    const lines = result.changes.map(({ file, action: done }) => `${done} ${file}`);
    if (result.undeclined) lines.push("the earlier decline for this project is dropped");
    lines.push(`state: ${result.status.state}`);
    process.stdout.write(`${lines.join("\n")}\n`);
    return;
  }
  if (action === "decline") {
    const record = recordDecline(projectRoot);
    if (options.json) return printJson({ ok: true, ...record });
    process.stdout.write(`declined for ${record.path}; recorded in ${record.file}\n`);
    return;
  }
  fail(`unknown agents-md command: ${action} (status, print, install, decline)`, EXIT_USAGE);
}

function renderAgentsMdStatus(status) {
  const lines = [`state: ${status.state}`, `project: ${status.projectRoot}`];
  const block = status.exists ? status.block : "missing (no file)";
  lines.push(`AGENTS.md: ${block}${status.problem ? ` (${status.problem})` : ""}`);
  for (const entry of status.imports) {
    const where = entry.exists ? "" : " (file would be created)";
    const readers = entry.readers.join(", ");
    const problem = entry.problem ? ` (${entry.problem})` : "";
    lines.push(`${entry.relative}: ${entry.present ? "imports" : "needs"} ${entry.line} for ${readers}${entry.present ? "" : where}${problem}`);
  }
  if (status.declined) lines.push(`declined: ${status.declined}`);
  for (const note of status.notes) lines.push(`note: ${note}`);
  return lines.join("\n");
}

function cmdValidate(options) {
  const { loaded, profiles } = loadMerged(options);
  const problems = [
    ...loaded.errors.map((error) => ({ file: "config", message: error })),
    ...loaded.invalid.map((entry) => ({
      file: entry.index === undefined ? "config" : "config",
      message: `profile #${entry.index}${entry.id ? ` (${entry.id})` : ""}: ${entry.errors.join("; ")}`,
    })),
  ];
  const ids = profiles.map((profile) => profile.id);
  const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index);
  for (const id of new Set(duplicates)) {
    problems.push({ file: "config", message: `duplicate profile id: ${id}` });
  }
  if (options.json) {
    return printJson({ ok: problems.length === 0, profiles: profiles.length, problems });
  }
  if (problems.length === 0) {
    process.stdout.write(`OK: ${profiles.length} profile(s) valid.\n`);
    return;
  }
  process.stdout.write(problems.map((problem) => `- ${problem.message}`).join("\n"));
  process.stdout.write("\n");
  process.exit(EXIT_ERROR);
}

function cmdDetect(options) {
  const harnesses = detectHarnesses();
  const details = harnesses.map((entry) => {
    if (!entry.detected) return { ...entry, models: [], effort: effortLevels(entry.id) };
    const catalog = listModels(entry.id, { refresh: options.refresh });
    return {
      ...entry,
      models: catalog.models,
      modelsOk: catalog.ok,
      modelsError: catalog.error ?? null,
      cached: Boolean(catalog.cached),
      effort: effortLevels(entry.id, { models: catalog.models }),
    };
  });
  if (options.json) return printJson({ harnesses: details });
  const lines = details.map((entry) => {
    const status = entry.detected ? "✓ detected" : "✗ not found";
    const modelInfo = entry.detected
      ? entry.modelsOk
        ? `${entry.models.length} models`
        : `model list unavailable (${entry.modelsError})`
      : "";
    return `${pad(entry.id, 10)} ${status}${modelInfo ? `  — ${modelInfo}` : ""}`;
  });
  process.stdout.write(`${lines.join("\n")}\n`);
}

function pad(text, width) {
  return text.length >= width ? text : text + " ".repeat(width - text.length);
}

/** Fetch or inspect the models.dev snapshot used for derived catalogs. */
async function cmdCatalog(options) {
  const before = readSnapshot({ maxAgeMs: Number.MAX_SAFE_INTEGER });
  let catalog = before;
  let fetched = false;

  if (options.refresh || !before) {
    catalog = await fetchCatalog({});
    fetched = Boolean(catalog);
  }
  if (!catalog) {
    if (options.json) {
      printJson({ ok: false, url: MODELS_DEV_URL, error: "catalog unavailable (offline and no snapshot)" });
    } else {
      process.stderr.write(`catalog unavailable (no snapshot and could not reach ${MODELS_DEV_URL})\n`);
    }
    process.exit(EXIT_ERROR);
  }

  const providers = Object.keys(catalog);
  if (options.provider) {
    const rows = modelsForProvider(catalog, options.provider);
    if (!rows) {
      fail(`provider "${options.provider}" not found in the catalog`);
    }
    if (options.json) return printJson({ ok: true, provider: options.provider, models: rows });
    process.stdout.write(`${options.provider}: ${rows.length} models\n`);
    for (const row of rows) {
      process.stdout.write(`  ${row.id}${row.efforts ? `  (effort: ${row.efforts.join(", ")})` : ""}\n`);
    }
    return;
  }

  if (options.json) {
    return printJson({ ok: true, url: MODELS_DEV_URL, fetched, providers: providers.length, names: providers });
  }
  process.stdout.write(
    `${fetched ? "fetched" : "cached"} models.dev catalog — ${providers.length} providers\n`,
  );
  for (const id of ["anthropic", "openai", "opencode", "ollama-cloud"]) {
    const rows = modelsForProvider(catalog, id);
    if (rows) process.stdout.write(`  ${id.padEnd(14)} ${rows.length} models\n`);
  }
}

/** The whole worker command for `hc run --`, which has no way to set environment variables. */
function launchArgv(result, id, projectRoot) {
  if (!result.executable) return null;
  const direct = Object.keys(result.env).length === 0 && !result.args.some((arg) => arg.includes('"'));
  if (direct) return [result.executable, ...result.args];
  const bin = path.join(sourceRoot(), "bin", "herdr-loadout.mjs");
  return [process.execPath, bin, "exec", id, "--host", result.host, "--project", projectRoot];
}

function cmdLaunch(id, options) {
  const { byId, projectRoot } = loadMerged(options);
  const profile = byId.get(id);
  if (!profile) fail(`profile "${id}" not found`);
  const result = dryRun(profile, { refresh: options.refresh, host: options.host });
  if (options.json) return printJson({ ...result, env: maskEnv(result.env), argv: launchArgv(result, id, projectRoot) });
  const lines = result.checks.map((check) => `${check.ok ? "✓" : "✗"} ${check.label}: ${check.detail}`);
  process.stdout.write(`${lines.join("\n")}\n`);
  process.stdout.write(result.ok ? "✓ profile launchable (dry-run)\n" : "✗ profile is not launchable\n");
  if (!result.ok) process.exit(EXIT_ERROR);
}

function cmdCommand(id, options) {
  const shell = options.shell ?? "sh";
  if (!SHELLS.includes(shell)) fail(`--shell must be one of: ${SHELLS.join(", ")}`, EXIT_USAGE);
  const { byId, projectRoot } = loadMerged(options);
  const profile = byId.get(id);
  if (!profile) fail(`profile "${id}" not found`);
  const host = options.host ?? "herdr";
  let { space, tab } = options;
  if (tab === "self") {
    if (host !== "hc") fail("--tab self needs --host hc", EXIT_USAGE);
    if (!process.env.HC_TERMINAL_ID) fail("--tab self needs HC_TERMINAL_ID: run it inside a Herdr app terminal", EXIT_USAGE);
    const place = appPlace(process.env.HC_TERMINAL_ID);
    if (place.error) fail(place.error);
    tab = place.tab;
    space ??= place.space;
  }
  if (options.task !== undefined && !options.name) fail("command --task needs --name: the record is kept per worker", EXIT_USAGE);
  const taskDir = options.task === undefined ? null : path.resolve(options.task);
  if (taskDir && !fs.existsSync(taskDir)) fail(`task folder ${taskDir} does not exist; create it with \`task new\``, EXIT_USAGE);
  const result = dryRun(profile, { host });
  if (!result.ok) {
    const failed = result.checks.filter((check) => !check.ok).map((check) => `✗ ${check.label}: ${check.detail}`);
    fail(`profile "${id}" is not launchable\n${failed.join("\n")}`);
  }
  const fingerprint = launchFingerprint(result);
  const lines = renderStartCommand({
    id,
    result,
    argv: launchArgv(result, id, projectRoot),
    envValueCommand: [process.execPath, path.join(sourceRoot(), "bin", "herdr-loadout.mjs"), "env-value", id, "--project", projectRoot],
    host,
    shell,
    cwd: path.resolve(options.cwd ?? process.cwd()),
    name: options.name,
    pane: options.pane,
    space,
    tab,
    launchLabels: launchLabels(id, fingerprint),
  });
  if (taskDir) {
    const file = recordWorker(taskDir, options.name, { profile: id, fingerprint, host, recorded: new Date().toISOString() });
    lines.push(`# recorded ${options.name} as profile ${id} in ${file}; \`worker-check ${options.name}\` compares against it`);
  }
  process.stdout.write(`${lines.join("\n")}\n`);
}

/**
 * Does a running worker still match its profile? Exit 0 when it does, 1 with
 * the reasons when it does not (close it and launch a fresh one) or when the
 * host could not be inspected (nothing is known; check again).
 */
function cmdWorkerCheck(name, options) {
  const host = options.host ?? detectHost();
  if (!host) fail("not inside Herdr (neither HERDR_ENV=1 nor HC_TERMINAL_ID is set); pass --host herdr|hc", EXIT_USAGE);
  const live = inspectWorker(host, name);
  const fileRecord = findWorkerRecord({
    name,
    taskDir: options.task === undefined ? undefined : path.resolve(options.task),
    projectRoot: resolveTaskRoot(options.project ?? process.cwd()),
  });
  const record = live.found ? launchRecord(live, fileRecord) : null;
  let current = null;
  if (record) {
    const { byId } = loadMerged(options);
    const profile = byId.get(record.profile);
    if (profile) {
      const result = dryRun(profile, { host });
      current = { fingerprint: launchFingerprint(result), args: result.args };
    }
  }
  const problems = compareWorker({ host, name, live, record, expectedProfile: options.profile, current });
  const ok = problems.length === 0;
  if (options.json) {
    printJson({ ok, worker: name, host, profile: record?.profile ?? null, record: record?.source ?? null, problems });
  } else if (ok) {
    process.stdout.write(`✓ ${name} matches profile "${record.profile}" as it is now\n`);
  } else {
    const lines = problems.map((problem) => `✗ ${problem.message}`);
    lines.push(problems.every((problem) => INSPECTION_CODES.has(problem.code))
      ? "# could not inspect the host; nothing is known about the worker. Fix what the message names and run worker-check again; do not treat the worker as gone"
      : "# close this worker and launch a fresh one from `command`; never switch its model or effort in place");
    process.stdout.write(`${lines.join("\n")}\n`);
  }
  if (!ok) process.exit(EXIT_ERROR);
}

/** Print one value of the env a launch sets, for `$(...)` in a printed command. */
function cmdEnvValue(id, key, options) {
  const { byId } = loadMerged(options);
  const profile = byId.get(id);
  if (!profile) fail(`profile "${id}" not found`);
  const { env } = dryRun(profile, { host: "herdr" });
  if (!Object.hasOwn(env, key)) fail(`profile "${id}" sets no env ${key}`);
  process.stdout.write(env[key]);
}

/** Start the profile's harness in this terminal with its args and environment. */
function cmdExec(id, options) {
  const { byId } = loadMerged(options);
  const profile = byId.get(id);
  if (!profile) fail(`profile "${id}" not found`);
  const result = dryRun(profile, { host: options.host });
  if (!result.ok) {
    const failed = result.checks.filter((check) => !check.ok).map((check) => `✗ ${check.label}: ${check.detail}`);
    fail(`profile "${id}" is not launchable\n${failed.join("\n")}`);
  }
  const env = { ...process.env, ...result.env };
  const { file, argv } = resolveSpawn(result.executable, result.args, { env });
  const child = spawn(file, argv, { stdio: "inherit", env });
  // The terminal delivers Ctrl+C to the harness itself; the wrapper must outlive
  // it, or the terminal would end while the harness keeps running.
  for (const signal of ["SIGINT", "SIGBREAK"]) process.on(signal, () => {});
  for (const signal of ["SIGTERM", "SIGHUP"]) process.on(signal, () => child.kill(signal));
  child.on("error", (error) => fail(`could not start ${result.executable}: ${error.message}`));
  child.on("exit", (code, signal) => {
    // Left on the worker's screen, where `hc read` finds it next to the harness's own error.
    if (code !== 0) {
      process.stderr.write(`herdr-loadout: profile "${id}" (${result.harness}) exited with ${code ?? signal}: ${[result.executable, ...result.args].join(" ")}\n`);
    }
    process.exit(code ?? EXIT_ERROR);
  });
}

function cmdUi(options) {
  // Kept in a separate module so the CLI never imports Ink unless asked.
  const argv = [];
  if (options.placement) argv.push("--placement", options.placement);
  if (options.project) argv.push("--project", options.project);
  return import("./ui.mjs").then(({ main: runUi }) => runUi(argv));
}

/**
 * The Herdr app editor's backend: one JSON request in (`--input`), one JSON
 * answer out. See `runEditorAction` for the actions.
 */
async function cmdEditor(action, options) {
  let input = {};
  try {
    input = options.input ? JSON.parse(options.input) : {};
  } catch (error) {
    return printJson({ ok: false, error: `--input is not JSON: ${error.message}` });
  }
  const { runEditorAction } = await import("../src/core/editor.mjs");
  printJson(await runEditorAction(action, input, { projectRoot: options.project ?? process.cwd() }));
}

/** Read a key from stdin: piped as is, or typed at a TTY without echo. */
function readSecret(prompt) {
  if (!process.stdin.isTTY) {
    return new Promise((resolve, reject) => {
      let text = "";
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", (chunk) => (text += chunk));
      process.stdin.on("end", () => resolve(text.trim()));
      process.stdin.on("error", reject);
    });
  }
  return new Promise((resolve) => {
    process.stderr.write(prompt);
    let text = "";
    process.stdin.setRawMode(true);
    process.stdin.setEncoding("utf8");
    const onData = (chunk) => {
      for (const char of chunk) {
        if (char === "\r" || char === "\n" || char === "\u0004") {
          process.stdin.setRawMode(false);
          process.stdin.off("data", onData);
          process.stdin.pause();
          process.stderr.write("\n");
          resolve(text.trim());
          return;
        }
        if (char === "\u0003") {
          process.stdin.setRawMode(false);
          process.stderr.write("\n");
          process.exit(EXIT_ERROR);
        }
        if (char === "\u007f" || char === "\b") text = text.slice(0, -1);
        else text += char;
      }
    };
    process.stdin.on("data", onData);
    process.stdin.resume();
  });
}

/** Profiles that name a stored key, as `id` strings. */
function profilesUsingKey(keyId, options) {
  const { profiles } = loadMerged(options);
  return profiles.filter((profile) => profile.api === keyId).map((profile) => profile.id);
}

async function cmdKeys([sub = "list", id], options) {
  switch (sub) {
    case "list": {
      const store = listKeys();
      if (!store.ok) fail(store.error);
      if (options.json) {
        return printJson({
          path: store.path,
          keys: store.keys,
          providers: PROVIDER_IDS.map((provider) => ({ id: provider, label: PROVIDERS[provider].label, harnesses: Object.keys(PROVIDERS[provider].harnesses) })),
        });
      }
      const lines = store.keys.length === 0
        ? ["no stored keys (herdr-loadout keys add <ID> --provider <P>)"]
        : store.keys.map((key) => `${key.id} | ${key.providerLabel} | ${key.masked} | ${key.harnesses.join(", ")}${key.label ? ` | ${key.label}` : ""}`);
      lines.push("", `providers: ${PROVIDER_IDS.map((provider) => `${provider} (${Object.keys(PROVIDERS[provider].harnesses).join(", ")})`).join(", ")}`);
      process.stdout.write(`${lines.join("\n")}\n`);
      return;
    }
    case "add": {
      if (!id) fail("usage: herdr-loadout keys add <ID> --provider <P> [--label L]  (key on stdin)", EXIT_USAGE);
      if (!options.provider) fail(`--provider is required: ${PROVIDER_IDS.join(" | ")}`, EXIT_USAGE);
      const key = await readSecret(`${PROVIDERS[options.provider]?.label ?? options.provider} API key: `);
      const result = saveKey({ id, provider: options.provider, key, label: options.label });
      if (!result.ok) fail(result.error);
      if (options.json) return printJson({ ok: true, id: result.id });
      process.stdout.write(`stored key "${result.id}"; use it with: herdr-loadout set <profile> --api ${result.id}\n`);
      return;
    }
    case "remove": {
      if (!id) fail("usage: herdr-loadout keys remove <ID>", EXIT_USAGE);
      const users = profilesUsingKey(id, options);
      const result = removeKey(id);
      if (!result.ok) fail(result.error);
      if (options.json) return printJson({ ok: true, id, profiles: users });
      process.stdout.write(`removed key "${id}"${users.length ? `; these profiles still name it and will not launch: ${users.join(", ")}` : ""}\n`);
      return;
    }
    case "test": {
      if (!id) fail("usage: herdr-loadout keys test <ID>", EXIT_USAGE);
      const result = await testKey(id);
      if (options.json) return printJson({ id, ...result });
      process.stdout.write(`${result.ok ? "✓" : "✗"} ${id}: ${result.detail}\n`);
      if (!result.ok) process.exit(EXIT_ERROR);
      return;
    }
    default:
      fail(`unknown keys command: ${sub} (list | add | remove | test)`, EXIT_USAGE);
  }
}

/**
 * The project file in effect for a project root, so writes land in the file the
 * reads came from; a new one is created at the root when none exists yet.
 */
function projectFileFor(root) {
  return findProjectConfig(root) ?? projectConfigPath(root);
}

/** Target file for writes: the project file when --project is given. */
function writeTarget(options) {
  if (options.project) {
    return { path: projectFileFor(options.project), scope: "project" };
  }
  return { path: globalConfigPath(), scope: "global" };
}

/** Both layers as they are on disk, for the write commands. */
function loadLayers(options) {
  ensureGlobalConfig();
  const projectRoot = options.project ?? process.cwd();
  const loaded = loadConfig({ globalPath: globalConfigPath(), projectPath: findProjectConfig(projectRoot) });
  if (loaded.errors.length > 0) fail(loaded.errors.join("\n"));
  return {
    loaded,
    globalProfiles: loaded.profiles,
    projectProfiles: loaded.project?.profiles ?? [],
    projectFile: loaded.projectPath ?? projectConfigPath(projectRoot),
  };
}

function reportFailure(options, errors, extra = {}) {
  if (options.json) printJson({ ok: false, errors, ...extra });
  else process.stderr.write(`${errors.join("\n")}\n`);
  process.exit(EXIT_ERROR);
}

/** Collect profile input from --from/--stdin plus flags. */
function collectInput(options) {
  const fromStdin = options.from === "-";
  const payload = readProfilePayload({ file: fromStdin ? null : options.from, stdin: fromStdin });
  if (!payload.ok) return { ok: false, errors: payload.errors };

  const flags = profileFromFlags(options);
  if (!flags.ok) return { ok: false, errors: flags.errors };

  const merged = mergeProfileInput(payload.profile, flags.profile);
  if (merged.unknown.length > 0) {
    return { ok: false, errors: [`unknown field(s): ${merged.unknown.join(", ")}`] };
  }
  return { ok: true, profile: merged.profile, errors: [] };
}

const REQUIRED_FOR_ADD = ["id", "name", "harness", "model", "effort", "when_to_use"];

function describeMissing(profile) {
  return REQUIRED_FOR_ADD.filter((field) => !profile[field]).map((field) => `missing required field: ${field}`);
}

function cmdAdd(options) {
  const target = writeTarget(options);
  const input = collectInput(options);
  if (!input.ok) fail(input.errors.join("\n"));

  // An agy id like `gemini-3.8-flash-medium` supplies the effort itself.
  const profile = withModelEffort(input.profile);
  if (!profile.id && profile.name) {
    profile.id = String(profile.name)
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^[-._]+|[-._]+$/g, "");
  }

  const missing = describeMissing(profile);
  if (missing.length > 0) fail(missing.join("\n"), EXIT_USAGE);

  // A project profile must not shadow a global one by accident: that is what an
  // override is for, and it stores only the differences.
  const globalExisting = readConfigFile(globalConfigPath()).profiles?.find((entry) => entry?.id === profile.id);
  if (target.scope === "project" && globalExisting) {
    const message = `profile "${profile.id}" already exists in global; use \`set ${profile.id} ... --project\` to override it`;
    if (options.json) printJson({ ok: false, error: "exists-in-global", id: profile.id, path: globalConfigPath() });
    else process.stderr.write(`${message}\n`);
    process.exit(EXIT_ERROR);
  }
  const existing = readConfigFile(target.path).profiles?.find((entry) => entry?.id === profile.id);
  if (existing && !options.force) {
    if (options.json) {
      printJson({ ok: false, error: "exists", id: profile.id, path: target.path });
    } else {
      process.stderr.write(
        `profile "${profile.id}" already exists in ${target.path}; use \`set\` to update or --force to overwrite\n`,
      );
    }
    process.exit(EXIT_ERROR);
  }

  const result = upsertProfile(target.path, profile);
  if (!result.ok) {
    if (options.json) printJson({ ok: false, errors: result.errors });
    else process.stderr.write(`${result.errors.join("\n")}\n`);
    process.exit(EXIT_ERROR);
  }
  if (options.json) {
    return printJson({ ok: true, id: profile.id, scope: target.scope, path: target.path, created: result.created });
  }
  process.stdout.write(`${result.created ? "added" : "updated"} ${profile.id} in ${target.path}\n`);
}

/**
 * Change one profile.
 *
 * Without --project this edits the global profile itself. The base is the global
 * profile, never the merged one, so a project override is not copied into the
 * shared file. With --project only what differs from global is stored (a
 * project-only profile stores its whole body); setting everything back to the
 * global values removes the override.
 */
function cmdSet(id, options) {
  const input = collectInput(options);
  if (!input.ok) fail(input.errors.join("\n"));

  const { globalProfiles, projectProfiles } = loadLayers(options);
  const globalProfile = globalProfiles.find((entry) => entry?.id === id) ?? null;
  const projectEntry = projectProfiles.find((entry) => entry?.id === id) ?? null;
  const { byId } = mergeProfiles(globalProfiles, projectProfiles);
  const merged = byId.get(id);
  if (!merged) {
    const known = [...byId.keys()];
    fail(`profile "${id}" not found.${known.length ? ` Known: ${known.join(", ")}` : ""}`);
  }

  const target = writeTarget(options);
  const done = (message, extra = {}) => {
    if (options.json) return printJson({ ok: true, id, scope: target.scope, path: target.path, ...extra });
    process.stdout.write(`${message}\n`);
  };

  if (!options.project) {
    if (!globalProfile) {
      fail(`profile "${id}" exists only in the project; use --project to change it`);
    }
    const next = withModelEffort({ ...globalProfile, ...input.profile, id });
    const permissionErrors = validatePermissions(next);
    if (permissionErrors.length) fail(permissionErrors.join("\n"));
    const result = upsertProfile(target.path, next);
    if (!result.ok) reportFailure(options, result.errors);
    // A field this project still overrides keeps its project value.
    const shadowed = projectEntry ? Object.keys(input.profile).filter((key) => key !== "id" && Object.hasOwn(projectEntry, key)) : [];
    return done(
      `updated ${id} in ${target.path}${shadowed.length ? `\nnote: this project's override still sets ${shadowed.join(", ")}` : ""}`,
      { updated: true, shadowed },
    );
  }

  // Strip the merge bookkeeping so it never lands in the file.
  const { origin, overrides, differs, ...base } = merged;
  const next = withModelEffort({ ...base, ...input.profile, id });
  const permissionErrors = validatePermissions(next);
  if (permissionErrors.length) fail(permissionErrors.join("\n"));

  if (!globalProfile) {
    // Project-only: nothing to inherit from, so the whole body is stored.
    const result = upsertProfile(target.path, overrideDelta(next, null).entry);
    if (!result.ok) reportFailure(options, result.errors);
    return done(`updated ${id} in ${target.path}`, { updated: true });
  }

  const { entry, changed } = overrideDelta(next, globalProfile);
  if (changed.length === 0) {
    // Back on the global values: the override has nothing left to say.
    if (!projectEntry) return done(`${id} already matches global; nothing to change`, { updated: false, changed: [] });
    const removed = deleteProfile(target.path, id);
    if (!removed.ok) reportFailure(options, removed.errors);
    return done(`${id} matches global again; removed its override from ${target.path}`, {
      updated: true,
      changed: [],
      overrideRemoved: true,
    });
  }
  const result = upsertProfile(target.path, entry, { partial: true });
  if (!result.ok) reportFailure(options, result.errors);
  return done(`updated ${id} in ${target.path} (overrides: ${changed.join(", ")})`, { updated: true, changed });
}

/** Drop a project override so the profile follows the global one again. */
function cmdReset(id, options) {
  const { globalProfiles, projectProfiles, projectFile } = loadLayers(options);
  const inGlobal = globalProfiles.some((entry) => entry?.id === id);
  const inProject = projectProfiles.some((entry) => entry?.id === id);
  if (!inGlobal && inProject) {
    reportFailure(options, [`profile "${id}" exists only in the project, so there is no global profile to reset to; use \`remove ${id} --project\` to delete it`], { id });
  }
  if (!inGlobal) reportFailure(options, [`profile "${id}" not found`], { id });
  if (!inProject) reportFailure(options, [`profile "${id}" has no project override to reset`], { id });

  const result = deleteProfile(projectFile, id);
  if (!result.ok) reportFailure(options, result.errors, { id });
  if (options.json) return printJson({ ok: true, id, scope: "project", reset: true, path: projectFile });
  process.stdout.write(`reset ${id}; it follows the global profile again (removed its override from ${projectFile})\n`);
}

/**
 * Delete a profile.
 *
 * Without --project it removes the global profile and this project's override of
 * it (an override alone would be left half-formed). With --project it removes
 * the project entry: an override (same as `reset`) or a project-only profile.
 */
function cmdRemove(id, options) {
  const target = writeTarget(options);
  const { globalProfiles, projectProfiles, projectFile } = loadLayers(options);
  const inGlobal = globalProfiles.some((entry) => entry?.id === id);
  const inProject = projectProfiles.some((entry) => entry?.id === id);

  // A global profile and this project's override of it go together or not at all.
  const overrideRemoved = target.scope === "global" && inGlobal && inProject ? projectFile : null;
  const result = deleteProfileFrom(overrideRemoved ? [overrideRemoved, target.path] : [target.path], id);
  if (!result.ok) {
    const errors =
      target.scope === "global" && !inGlobal && inProject
        ? [`profile "${id}" exists only in the project; use --project to remove it`]
        : result.errors;
    return reportFailure(options, errors, { id, scope: target.scope });
  }

  if (options.json) {
    return printJson({ ok: true, id, scope: target.scope, removed: true, path: target.path, overrideRemoved });
  }
  process.stdout.write(`removed ${id} from ${target.path}\n`);
  if (overrideRemoved) process.stdout.write(`removed its project override from ${overrideRemoved}\n`);
}

/**
 * Change where a profile is listed. The file written follows from the profile:
 * the global file for a global profile (an override never changes the order),
 * the project file for a project-only one.
 */
async function cmdMove(id, options) {
  const given = [["direction", options.up ? "up" : null], ["direction", options.down ? "down" : null], ["before", options.before ?? null], ["after", options.after ?? null]].filter(([, value]) => value !== null);
  if (given.length !== 1) fail("usage: herdr-loadout move <id> --up|--down|--before ID|--after ID", EXIT_USAGE);
  loadLayers(options); // a broken config is reported before anything moves
  const { loadEditorState, moveProfile } = await import("../src/core/editor.mjs");
  const state = loadEditorState({ projectRoot: options.project ?? process.cwd(), globalPath: globalConfigPath() });
  const result = moveProfile(state, id, Object.fromEntries(given));
  if (!result.ok) reportFailure(options, [result.error], { id });
  if (options.json) return printJson(result);
  process.stdout.write(`${result.message}${result.moved ? ` (${result.path})` : ""}\n`);
}

/** Merge every profile from an existing config file into the target config. */
function cmdImport(file, options) {
  const target = writeTarget(options);
  const fromStdin = file === "-";
  const path_ = fromStdin ? null : file;

  let text;
  try {
    text = fromStdin ? fs.readFileSync(0, "utf8") : fs.readFileSync(path_, "utf8");
  } catch (error) {
    fail(`could not read ${fromStdin ? "stdin" : path_}: ${error.message}`);
  }

  const isToml = fromStdin ? looksLikeToml(text) : String(path_).toLowerCase().endsWith(".toml");
  let parsed;
  try {
    parsed = isToml ? parseToml(text) : JSON.parse(text);
  } catch (error) {
    fail(`${fromStdin ? "stdin" : path_}: parse failed: ${error.message}`);
  }

  const list = Array.isArray(parsed?.profiles)
    ? parsed.profiles
    : Array.isArray(parsed)
      ? parsed
      : [parsed];
  if (list.length === 0) fail("no profiles found in input");

  // Into the project file, an entry for a global profile becomes an override that
  // stores only what differs; anything else is a project-only profile.
  const globalProfiles = target.scope === "project" ? readConfigFile(globalConfigPath()).profiles ?? [] : [];

  const added = [];
  const updated = [];
  const unchanged = [];
  const failed = [];
  for (const entry of list) {
    const normalized = normalizePayload(entry);
    if (!normalized.ok) {
      failed.push({ profile: null, errors: normalized.errors });
      continue;
    }
    const id = normalized.profile.id;
    const before = id ? readConfigFile(target.path).profiles?.find((item) => item?.id === id) : null;
    const globalProfile = id ? globalProfiles.find((item) => item?.id === id) : null;
    let payload = normalized.profile;
    if (globalProfile) {
      const delta = overrideDelta({ ...globalProfile, ...normalized.profile }, globalProfile);
      if (delta.changed.length === 0) {
        unchanged.push(id);
        continue;
      }
      payload = delta.entry;
    }
    const result = upsertProfile(target.path, payload, { partial: Boolean(globalProfile) });
    if (!result.ok) failed.push({ profile: id ?? null, errors: result.errors });
    else if (before) updated.push(id);
    else added.push(id);
  }

  if (options.json) {
    printJson({ ok: failed.length === 0, scope: target.scope, path: target.path, added, updated, unchanged, failed });
    if (failed.length > 0) process.exit(EXIT_ERROR);
    return;
  }
  process.stdout.write(
    `imported into ${target.path}: ${added.length} added, ${updated.length} updated${
      unchanged.length ? `, ${unchanged.length} unchanged (same as global)` : ""
    }${failed.length ? `, ${failed.length} failed` : ""}\n`,
  );
  for (const entry of failed) {
    process.stderr.write(`  ${entry.profile ?? "<no id>"}: ${entry.errors.join("; ")}\n`);
  }
  if (failed.length > 0) process.exit(EXIT_ERROR);
}

async function main(argv) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        compact: { type: "boolean" },
        json: { type: "boolean" },
        all: { type: "boolean" },
        detect: { type: "boolean" },
        refresh: { type: "boolean" },
        provider: { type: "string" },
        "dry-run": { type: "boolean" },
        force: { type: "boolean" },
        project: { type: "string" },
        placement: { type: "string" },
        host: { type: "string" },
        shell: { type: "string" },
        pane: { type: "string" },
        space: { type: "string" },
        tab: { type: "string" },
        cwd: { type: "string" },
        input: { type: "string" },
        from: { type: "string" },
        id: { type: "string" },
        name: { type: "string" },
        harness: { type: "string" },
        model: { type: "string" },
        effort: { type: "string" },
        cost: { type: "string" },
        when: { type: "string" },
        avoid: { type: "string" },
        provider: { type: "string" },
        mode: { type: "string" },
        sandbox: { type: "string" },
        "approval-policy": { type: "string" },
        "permission-mode": { type: "string" },
        auth: { type: "string" },
        api: { type: "string" },
        label: { type: "string" },
        notes: { type: "string" },
        tag: { type: "string", multiple: true },
        "extra-arg": { type: "string", multiple: true },
        skill: { type: "string", multiple: true },
        env: { type: "string", multiple: true },
        to: { type: "string" },
        worker: { type: "string" },
        profile: { type: "string" },
        task: { type: "string" },
        help: { type: "boolean", short: "h" },
        up: { type: "boolean" },
        down: { type: "boolean" },
        before: { type: "string" },
        after: { type: "string" },
        "claude-md": { type: "boolean" },
      },
    });
  } catch (error) {
    process.stderr.write(`${error.message}\n\n${USAGE}`);
    process.exit(EXIT_USAGE);
  }

  const { values, positionals } = parsed;
  // Everything after `--` is passed to the harness, which is how flags such as
  // `--verbose` reach extra_args without fighting the option parser.
  const passthroughIndex = argv.indexOf("--");
  const passthrough = passthroughIndex === -1 ? [] : argv.slice(passthroughIndex + 1);
  const commandPositionals = passthroughIndex === -1 ? positionals : positionals.slice(0, -passthrough.length);
  if (passthrough.length > 0) {
    values["extra-arg"] = [...(values["extra-arg"] ?? []), ...passthrough];
  }
  const usePositionals = commandPositionals;
  if (values.help || usePositionals.length === 0) {
    process.stdout.write(USAGE);
    process.exit(values.help ? EXIT_OK : EXIT_USAGE);
  }

  const command = usePositionals[0];
  const options = { ...values, project: values.project ? path.resolve(values.project) : undefined };
  if (options.host !== undefined && !HOSTS.includes(options.host)) {
    fail(`--host must be one of: ${HOSTS.join(", ")}`, EXIT_USAGE);
  }

  switch (command) {
    case "list":
      return cmdList(options);
    case "show": {
      const id = usePositionals[1];
      if (!id) fail("usage: herdr-loadout show <id>", EXIT_USAGE);
      return cmdShow(id, options);
    }
    case "path":
      return cmdPath(options);
    case "validate":
      return cmdValidate(options);
    case "detect":
      return cmdDetect(options);
    case "catalog":
      return cmdCatalog(options);
    case "launch": {
      const id = usePositionals[1];
      if (!id) fail("usage: herdr-loadout launch <id>", EXIT_USAGE);
      return cmdLaunch(id, options);
    }
    case "command": {
      const id = usePositionals[1];
      if (!id) fail("usage: herdr-loadout command <id>", EXIT_USAGE);
      return cmdCommand(id, options);
    }
    case "exec": {
      const id = usePositionals[1];
      if (!id) fail("usage: herdr-loadout exec <id>", EXIT_USAGE);
      return cmdExec(id, options);
    }
    case "env-value": {
      const [id, key] = usePositionals.slice(1);
      if (!id || !key) fail("usage: herdr-loadout env-value <id> <KEY>", EXIT_USAGE);
      return cmdEnvValue(id, key, options);
    }
    case "workflow":
      return cmdWorkflow(usePositionals[1], options);
    case "task":
      return cmdTask(usePositionals[1], usePositionals[2], options);
    case "agents-md":
      return cmdAgentsMd(usePositionals[1], options);
    case "worker-check": {
      const name = usePositionals[1];
      if (!name) fail("usage: herdr-loadout worker-check <worker> [--profile ID] [--task DIR]", EXIT_USAGE);
      return cmdWorkerCheck(name, options);
    }
    case "keys":
      return cmdKeys(usePositionals.slice(1), options);
    case "editor": {
      const action = usePositionals[1];
      if (!action) fail("usage: herdr-loadout editor <action> [--input JSON]", EXIT_USAGE);
      return cmdEditor(action, options);
    }
    case "ui":
      return cmdUi(options);
    case "add":
      return cmdAdd(options);
    case "set": {
      const id = usePositionals[1];
      if (!id) fail("usage: herdr-loadout set <id> [flags...]", EXIT_USAGE);
      return cmdSet(id, options);
    }
    case "reset": {
      const id = usePositionals[1];
      if (!id) fail("usage: herdr-loadout reset <id>", EXIT_USAGE);
      return cmdReset(id, options);
    }
    case "remove": {
      const id = usePositionals[1];
      if (!id) fail("usage: herdr-loadout remove <id>", EXIT_USAGE);
      return cmdRemove(id, options);
    }
    case "import": {
      const file = usePositionals[1];
      if (!file) fail("usage: herdr-loadout import <FILE|->", EXIT_USAGE);
      return cmdImport(file, options);
    }
    case "move": {
      const id = usePositionals[1];
      if (!id) fail("usage: herdr-loadout move <id> --up|--down|--before ID|--after ID", EXIT_USAGE);
      return cmdMove(id, options);
    }
    default:
      process.stderr.write(`unknown command: ${command}\n\n${USAGE}`);
      process.exit(EXIT_USAGE);
  }
}

main(process.argv.slice(2)).catch((error) => {
  fail(error?.stack ?? String(error));
});
