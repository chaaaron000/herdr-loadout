/**
 * Profile schema: validation, defaults, and the seed document.
 *
 * Validation never mutates or discards the source document. Callers keep the
 * parsed TOML object and only patch known fields, so unknown user keys survive.
 */
import { parse, stringify } from "smol-toml";
import { PERMISSION_FIELDS, validatePermissions } from "./permissions.mjs";
import { validateAuth } from "./agy.mjs";
import { API_HARNESSES, KEY_ID_PATTERN } from "./keys.mjs";

export const COSTS = ["cheap", "normal", "expensive"];
export const REQUIRED_FIELDS = ["id", "name", "harness", "model", "effort", "when_to_use"];
export const OPTIONAL_SCALAR_FIELDS = ["avoid_when", "cost", "provider", "mode", "notes", "auth", "api", ...PERMISSION_FIELDS];
export const OPTIONAL_ARRAY_FIELDS = ["extra_args", "tags", "skills"];
export const OPTIONAL_MAP_FIELDS = ["env"];
export const KNOWN_FIELDS = new Set([
  ...REQUIRED_FIELDS,
  ...OPTIONAL_SCALAR_FIELDS,
  ...OPTIONAL_ARRAY_FIELDS,
  ...OPTIONAL_MAP_FIELDS,
]);

export const ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;

/** Harness ids accepted without an adapter. Anything else needs `custom`. */
export const KNOWN_HARNESSES = ["claude", "codex", "opencode", "omp", "pi", "agy"];

export function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Set `key` as an own property. Plain `obj[key] = value` with the key
 * `__proto__` changes the prototype instead and the entry is lost, while TOML
 * and JSON both allow that key; every copy of a parsed table goes through this
 * (or `Object.fromEntries`, spread) so the key survives.
 */
export function setOwn(obj, key, value) {
  Object.defineProperty(obj, key, { value, enumerable: true, writable: true, configurable: true });
  return obj;
}

/**
 * Validate one profile object.
 * @param {unknown} profile
 * @param {{requireAll?: boolean}} [options]
 * @returns {{errors: string[]}}
 */
export function validateProfile(profile, options = {}) {
  const requireAll = options.requireAll ?? true;
  const errors = [];
  if (!isPlainObject(profile)) return { errors: ["profile is not a table"] };

  for (const field of REQUIRED_FIELDS) {
    if (!(field in profile)) {
      if (requireAll) errors.push(`missing required field: ${field}`);
      continue;
    }
    // The merge treats an empty required field as missing and hides the
    // profile, so it must never get as far as the file.
    const value = profile[field];
    if (field !== "id" && typeof value === "string" && value.trim() === "") {
      errors.push(`${field} must not be empty`);
    }
  }
  if ("id" in profile) {
    if (typeof profile.id !== "string" || profile.id.length === 0) {
      errors.push("id must be a non-empty string");
    } else if (!ID_PATTERN.test(profile.id)) {
      errors.push(`id "${profile.id}" must match ${ID_PATTERN}`);
    }
  }
  for (const field of ["name", "harness", "model", "effort", ...OPTIONAL_SCALAR_FIELDS]) {
    if (field in profile && typeof profile[field] !== "string") {
      errors.push(`${field} must be a string`);
    }
  }
  if ("cost" in profile && typeof profile.cost === "string" && !COSTS.includes(profile.cost)) {
    errors.push(`cost must be one of ${COSTS.join(" | ")}`);
  }
  if ("harness" in profile && typeof profile.harness === "string") {
    const h = profile.harness;
    if (h !== "custom" && !KNOWN_HARNESSES.includes(h)) {
      // unknown harnesses are allowed but must declare themselves as custom
      errors.push(`harness "${h}" is not known; use "custom" or a supported id`);
    }
  }
  for (const field of OPTIONAL_ARRAY_FIELDS) {
    if (!(field in profile)) continue;
    const value = profile[field];
    if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
      errors.push(`${field} must be an array of strings`);
    }
  }
  for (const field of OPTIONAL_MAP_FIELDS) {
    if (!(field in profile)) continue;
    const value = profile[field];
    if (!isPlainObject(value) || Object.values(value).some((item) => typeof item !== "string")) {
      errors.push(`${field} must be a table of strings`);
    }
  }
  errors.push(...validatePermissions(profile).filter((error) => !errors.includes(error)));
  errors.push(...validateAuth(profile).filter((error) => !errors.includes(error)));
  // Only the shape is checked here; whether the key exists is a launch check,
  // since keys live outside the config and can be added after the profile.
  if (typeof profile.api === "string" && profile.api !== "") {
    if (!KEY_ID_PATTERN.test(profile.api)) errors.push(`api "${profile.api}" must name a stored key (${KEY_ID_PATTERN})`);
    else if (profile.harness && !API_HARNESSES.includes(profile.harness)) {
      errors.push(`api is supported by ${API_HARNESSES.join(", ")}, not ${profile.harness}`);
    }
  }
  return { errors };
}

/**
 * Parse a TOML document, keeping the raw table tree for lossless writes.
 * A parse failure is reported, never repaired.
 */
export function parseConfig(text, source = "<memory>") {
  let doc;
  try {
    doc = parse(text);
  } catch (error) {
    return { ok: false, error: `${source}: ${error.message}`, doc: null, profiles: [] };
  }
  if (!isPlainObject(doc)) {
    return { ok: false, error: `${source}: config root must be a table`, doc: null, profiles: [] };
  }
  if (doc.profiles !== undefined && !Array.isArray(doc.profiles)) {
    return { ok: false, error: `${source}: [[profiles]] must be an array of tables`, doc: null, profiles: [] };
  }
  const rawProfiles = doc.profiles ?? [];
  const profiles = [];
  const invalid = [];
  for (const [index, entry] of rawProfiles.entries()) {
    const { errors } = validateProfile(entry, { requireAll: false });
    if (errors.length > 0) invalid.push({ index, id: entry?.id ?? null, errors });
    else profiles.push(entry);
  }
  return { ok: true, doc, profiles, invalid, source };
}

export function serializeConfig(doc) {
  return stringify(doc);
}

export function defaultTemplate(now = new Date()) {
  return {
    version: 1,
    profiles: [
      {
        id: "builder",
        name: "Builder",
        harness: "omp",
        model: "ollama-cloud/deepseek-v4.1-flash",
        effort: "high",
        cost: "expensive",
        when_to_use:
          "Default implementation worker: scoped features, refactoring, bug fixes, design decisions, and difficult bugs. Splits large work across junior workers it runs as team members.",
        avoid_when: "Pure research, QA, code review, or narrow edits a junior can handle.",
        tags: ["implementation", "refactor", "design"],
      },
      {
        id: "junior",
        name: "Junior",
        harness: "claude",
        model: "deepseek-v4.1",
        effort: "medium",
        cost: "normal",
        when_to_use:
          "Light implementation that follows existing patterns, and slices of a larger task handed out by a builder.",
        avoid_when: "Design decisions, difficult bugs, pure research, QA, or code review.",
        tags: ["implementation", "light"],
      },
      {
        id: "qa",
        name: "QA",
        harness: "codex",
        model: "gpt-6.1-sol",
        effort: "high",
        cost: "normal",
        when_to_use:
          "Independent QA after substantial implementation: writes scenarios from the brief before reading the code, runs them against the real CLI and host, and turns every bug it finds into a regression test.",
        avoid_when: "Changing source code (fixes go back to the implementer), work this profile implemented, or pure research.",
        tags: ["qa", "testing"],
      },
      {
        id: "reviewer",
        name: "Reviewer",
        harness: "codex",
        model: "gpt-6.1-sol",
        effort: "medium",
        cost: "cheap",
        when_to_use:
          "Code review of security-sensitive changes (shell quoting, secrets, permissions), or when the user asks for a review.",
        avoid_when: "Routine changes, which get QA instead, and initial implementation.",
        tags: ["review", "security"],
      },
      {
        id: "scout",
        name: "Scout",
        harness: "opencode",
        model: "ollama-cloud/glm-5.3-flash",
        effort: "low",
        cost: "cheap",
        when_to_use: "Repository exploration, locating relevant files, and impact analysis.",
        avoid_when: "Writing, testing, or reviewing code.",
        tags: ["research"],
      },
    ],
  };
}
