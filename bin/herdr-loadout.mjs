#!/usr/bin/env node
/**
 * herdr-loadout CLI — the Director-facing profile registry.
 *
 * Contract: `list --compact` prints one `id | cost | purpose` line per profile
 * with no decoration, so an orchestrator can read it cheaply.
 */
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
import { detectHarnesses, dryRun, effortLevels, listModels } from "../src/core/detect.mjs";
import {
  ensureGlobalConfig,
  loadConfig,
  readConfigFile,
  upsertProfile,
  deleteProfile,
} from "../src/core/store.mjs";
import { fetchCatalog, modelsForProvider, readSnapshot, MODELS_DEV_URL } from "../src/core/modelsdev.mjs";
import { mergeProfileInput, normalizePayload, profileFromFlags, readProfilePayload, looksLikeToml } from "../src/core/input.mjs";
import { parse as parseToml } from "smol-toml";
import fs from "node:fs";
import { validatePermissions } from "../src/core/permissions.mjs";

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
  herdr-loadout launch <id> [--dry-run] [--project PATH]
  herdr-loadout ui [--placement split|popup|overlay]

Write:
  herdr-loadout add [--id ID] [--name NAME] [--harness H] [--model M]
                    [--effort E] [--cost C] [--when TEXT] [--avoid TEXT]
                    [--sandbox S] [--approval-policy A] [--permission-mode P]
                    [--tag T]... [--env K=V]... [--from FILE|-]
                    [--project PATH] [--force] [--json]
                    [-- EXTRA_ARG...]        everything after -- becomes extra_args
  herdr-loadout set <id> [flags...] [--from FILE|-] [--project PATH] [--json]
  herdr-loadout reset <id> [--project PATH] [--json]           drop a project override
  herdr-loadout remove <id> [--project PATH] [--json]
  herdr-loadout import <FILE|-> [--project PATH] [--json]      merge a config file

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
  --approval-policy  Codex: on-request | never
  --permission-mode  Claude / OMP / OpenCode permission mode (empty = inherit)
    Claude: manual | acceptEdits | auto | dontAsk | plan | bypassPermissions
    OMP: always-ask | write | yolo; OpenCode: ask | allow | deny
  -h, --help  show this message
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
      profiles: profiles.map(({ origin, overrides, ...profile }) => ({ ...profile, origin, overrides })),
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
  if (options.json) return printJson(profile);
  const detection = resolveDetection([profile], { detect: options.detect ?? true });
  const globalProfile = loaded.profiles.find((entry) => entry?.id === id) ?? null;
  process.stdout.write(`${renderShow(profile, { detection, globalProfile })}\n`);
}

function cmdPath(options) {
  const { loaded } = loadMerged(options);
  printJson({
    pluginRoot: sourceRoot(),
    configDir: configDir(),
    stateDir: stateDir(),
    globalConfig: loaded.globalPath,
    projectConfig: options.project ? projectConfigPath(options.project) : loaded.projectPath,
    discoveredProjectConfig: loaded.projectPath,
  });
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

function cmdLaunch(id, options) {
  const { byId } = loadMerged(options);
  const profile = byId.get(id);
  if (!profile) fail(`profile "${id}" not found`);
  const result = dryRun(profile, { refresh: options.refresh });
  if (options.json) return printJson(result);
  const lines = result.checks.map((check) => `${check.ok ? "✓" : "✗"} ${check.label}: ${check.detail}`);
  process.stdout.write(`${lines.join("\n")}\n`);
  process.stdout.write(result.ok ? "✓ profile launchable (dry-run)\n" : "✗ profile is not launchable\n");
  if (!result.ok) process.exit(EXIT_ERROR);
}

function cmdUi(options) {
  // Kept in a separate module so the CLI never imports Ink unless asked.
  return import("../src/tui/app.mjs").then(({ runTui }) => runTui(options));
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

  const profile = input.profile;
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
    const next = { ...globalProfile, ...input.profile, id };
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
  const next = { ...base, ...input.profile, id };
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

  const result = deleteProfile(target.path, id);
  if (!result.ok) {
    const errors =
      target.scope === "global" && !inGlobal && inProject
        ? [`profile "${id}" exists only in the project; use --project to remove it`]
        : result.errors;
    return reportFailure(options, errors, { id, scope: target.scope });
  }

  let overrideRemoved = null;
  if (target.scope === "global" && inProject && deleteProfile(projectFile, id).ok) {
    overrideRemoved = projectFile;
  }
  if (options.json) {
    return printJson({ ok: true, id, scope: target.scope, removed: true, path: target.path, overrideRemoved });
  }
  process.stdout.write(`removed ${id} from ${target.path}\n`);
  if (overrideRemoved) process.stdout.write(`removed its project override from ${overrideRemoved}\n`);
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
        notes: { type: "string" },
        tag: { type: "string", multiple: true },
        "extra-arg": { type: "string", multiple: true },
        skill: { type: "string", multiple: true },
        env: { type: "string", multiple: true },
        help: { type: "boolean", short: "h" },
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
    default:
      process.stderr.write(`unknown command: ${command}\n\n${USAGE}`);
      process.exit(EXIT_USAGE);
  }
}

main(process.argv.slice(2)).catch((error) => {
  fail(error?.stack ?? String(error));
});
