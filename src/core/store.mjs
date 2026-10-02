/**
 * Config store: read both config layers, patch known fields, write atomically.
 *
 * The parsed TOML tree is kept as-is and only edited in place, so unknown keys
 * written by the user survive every save. Writes go through a temp file plus
 * rename to avoid truncating a valid file on failure.
 */
import fs from "node:fs";
import path from "node:path";
import {
  defaultTemplate,
  parseConfig,
  serializeConfig,
  validateProfile,
  KNOWN_FIELDS,
} from "./schema.mjs";
import { findProjectConfig, globalConfigPath } from "./paths.mjs";

export function readConfigFile(filePath, fsImpl = fs) {
  if (!fsImpl.existsSync(filePath)) {
    return { ok: true, exists: false, doc: null, profiles: [], invalid: [], source: filePath };
  }
  const text = fsImpl.readFileSync(filePath, "utf8");
  const result = parseConfig(text, filePath);
  return { ...result, exists: true };
}

/**
 * Load global and project layers.
 * @returns {{
 *   global: object, project: object|null,
 *   profiles: object[], invalid: Array<object>, errors: string[]
 * }}
 */
export function loadConfig(options = {}) {
  const fsImpl = options.fs ?? fs;
  const globalPath = options.globalPath ?? globalConfigPath(options.env ?? process.env);
  const projectPath =
    options.projectPath ?? findProjectConfig(options.cwd ?? process.cwd(), fsImpl);

  const global = readConfigFile(globalPath, fsImpl);
  const project = projectPath ? readConfigFile(projectPath, fsImpl) : null;

  const errors = [];
  if (!global.ok) errors.push(global.error);
  if (project && !project.ok) errors.push(project.error);

  return {
    globalPath,
    projectPath: projectPath ?? null,
    global,
    project,
    profiles: global.profiles ?? [],
    invalid: [...(global.invalid ?? []), ...((project?.invalid) ?? [])],
    errors,
  };
}

/** Deep-clone a TOML value so callers never mutate the parsed doc. */
function clone(value) {
  if (Array.isArray(value)) return value.map(clone);
  if (value && typeof value === "object") {
    const out = {};
    for (const [key, item] of Object.entries(value)) out[key] = clone(item);
    return out;
  }
  return value;
}

/** Copy only known profile fields from `input`; unknown keys are dropped. */
export function pickKnownFields(input) {
  const out = {};
  for (const [key, value] of Object.entries(input)) {
    if (KNOWN_FIELDS.has(key)) out[key] = clone(value);
  }
  return out;
}

/**
 * Validate and normalize a profile before writing.
 * @param {object} input
 * @param {{partial?: boolean}} [options] partial accepts a project override that
 *   only carries the fields it changes; an id is still required.
 * @returns {{ok: boolean, errors: string[], profile: object|null}}
 */
export function prepareProfile(input, options = {}) {
  const profile = pickKnownFields(input);
  const partial = options.partial === true;
  const { errors } = validateProfile(profile, { requireAll: !partial });
  if (partial && !profile.id) errors.push("missing required field: id");
  return { ok: errors.length === 0, errors, profile: errors.length === 0 ? profile : null };
}

function writeAtomically(filePath, text, fsImpl = fs) {
  fsImpl.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.tmp`;
  fsImpl.writeFileSync(tmp, text, "utf8");
  fsImpl.renameSync(tmp, filePath);
}

/** Create the global config with the default template if absent. */
export function ensureGlobalConfig(options = {}) {
  const fsImpl = options.fs ?? fs;
  const filePath = options.globalPath ?? globalConfigPath(options.env ?? process.env);
  if (fsImpl.existsSync(filePath)) return { created: false, path: filePath };
  const doc = defaultTemplate();
  writeAtomically(filePath, serializeConfig(doc), fsImpl);
  return { created: true, path: filePath };
}

/**
 * Insert or replace a profile in a config file, preserving every other key.
 * @returns {{ok: boolean, errors: string[], created: boolean}}
 */
export function upsertProfile(targetPath, profile, options = {}) {
  const fsImpl = options.fs ?? fs;
  const loaded = readConfigFile(targetPath, fsImpl);
  if (!loaded.ok) return { ok: false, errors: [loaded.error], created: false };

  const prepared = prepareProfile(profile, { partial: options.partial === true });
  if (!prepared.ok) return { ok: false, errors: prepared.errors, created: false };

  const doc = loaded.doc ?? { version: 1 };
  const list = Array.isArray(doc.profiles) ? doc.profiles : [];
  const index = list.findIndex((entry) => entry?.id === prepared.profile.id);
  let created = false;
  if (index >= 0) list[index] = prepared.profile;
  else {
    list.push(prepared.profile);
    created = true;
  }
  doc.profiles = list;
  writeAtomically(targetPath, serializeConfig(doc), fsImpl);
  return { ok: true, errors: [], created };
}

/** Remove a profile by id. Missing ids are reported, not invented. */
export function deleteProfile(targetPath, id, options = {}) {
  const fsImpl = options.fs ?? fs;
  const loaded = readConfigFile(targetPath, fsImpl);
  if (!loaded.ok) return { ok: false, errors: [loaded.error], removed: false };
  if (!loaded.doc) return { ok: false, errors: [`${targetPath}: config not found`], removed: false };
  const list = Array.isArray(loaded.doc.profiles) ? loaded.doc.profiles : [];
  const next = list.filter((entry) => entry?.id !== id);
  if (next.length === list.length) {
    return { ok: false, errors: [`profile "${id}" not found in ${targetPath}`], removed: false };
  }
  loaded.doc.profiles = next;
  writeAtomically(targetPath, serializeConfig(loaded.doc), fsImpl);
  return { ok: true, errors: [], removed: true };
}

export { writeAtomically };
