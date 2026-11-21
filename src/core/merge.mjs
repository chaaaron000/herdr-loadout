/**
 * Merge global profiles with project overrides.
 *
 * Only fields present in the project entry are overridden; everything else
 * falls back to the global profile. Project-only profiles are included and
 * marked as such so the UI and CLI can show their origin.
 */
import { OPTIONAL_ARRAY_FIELDS, OPTIONAL_MAP_FIELDS, KNOWN_FIELDS } from "./schema.mjs";

function clone(value) {
  if (Array.isArray(value)) return value.map(clone);
  if (value && typeof value === "object") {
    // fromEntries keeps a key named `__proto__`; bracket assignment would drop it.
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clone(item)]));
  }
  return value;
}

/**
 * @param {object[]} globalProfiles
 * @param {object[]} projectProfiles
 * @returns {{profiles: object[], byId: Map<string, object>}}
 */
export function mergeProfiles(globalProfiles = [], projectProfiles = []) {
  const projectById = new Map();
  for (const entry of projectProfiles) {
    if (entry?.id) projectById.set(entry.id, entry);
  }

  const merged = [];
  const seen = new Set();

  for (const base of globalProfiles) {
    if (!base?.id) continue;
    seen.add(base.id);
    const override = projectById.get(base.id);
    if (!override) {
      merged.push({ ...clone(base), origin: "global", overrides: [], differs: [] });
      continue;
    }
    const result = clone(base);
    const overrides = [];
    for (const [key, value] of Object.entries(override)) {
      if (!KNOWN_FIELDS.has(key)) continue;
      if (key === "id") continue;
      if (value === undefined) continue;
      // arrays and tables replace wholesale; that keeps "extra_args" predictable
      result[key] = clone(value);
      overrides.push(key);
    }
    // `overrides` lists what the project file sets; `differs` what actually
    // resolves differently from global (a restated global value does not count).
    merged.push({ ...result, origin: "project-override", overrides, differs: diffFields(result, base) });
  }

  for (const entry of projectProfiles) {
    if (!entry?.id || seen.has(entry.id)) continue;
    // A project-only profile must be complete enough to work on its own;
    // otherwise the merge would surface a half-formed profile.
    const missing = ["name", "harness", "model", "effort", "when_to_use"].filter((field) => !entry[field]);
    if (missing.length > 0) continue;
    const result = {};
    for (const [key, value] of Object.entries(entry)) {
      if (KNOWN_FIELDS.has(key)) result[key] = clone(value);
    }
    merged.push({ ...result, origin: "project-only", overrides: [], differs: [] });
  }

  const byId = new Map(merged.map((profile) => [profile.id, profile]));
  return { profiles: merged, byId };
}

export { OPTIONAL_ARRAY_FIELDS, OPTIONAL_MAP_FIELDS };

function equalValue(a, b) {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, index) => equalValue(item, b[index]));
  }
  if (a && b && typeof a === "object" && typeof b === "object") {
    const keysA = Object.keys(a);
    const keysB = Object.keys(b);
    return keysA.length === keysB.length && keysA.every((key) => equalValue(a[key], b[key]));
  }
  return false;
}

/** Absent, empty string, empty list, and empty table all mean "not set". */
function isBlank(value) {
  if (value === undefined || value === null || value === "") return true;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === "object") return Object.keys(value).length === 0;
  return false;
}

/** Equality that treats every "not set" shape as the same value. */
export function sameValue(a, b) {
  if (isBlank(a) && isBlank(b)) return true;
  return equalValue(a, b);
}

/**
 * Profile fields whose value differs from the global profile.
 *
 * Compares what the profile actually resolves to, not what the project file
 * lists, so an override that restates the global value is not reported.
 *
 * @param {object} profile merged or edited profile
 * @param {object|null|undefined} globalProfile
 * @returns {string[]} field names, empty when there is no global profile
 */
export function diffFields(profile, globalProfile) {
  if (!globalProfile) return [];
  const keys = new Set([...Object.keys(profile ?? {}), ...Object.keys(globalProfile)]);
  return [...keys].filter(
    (key) => key !== "id" && KNOWN_FIELDS.has(key) && !sameValue(profile?.[key], globalProfile[key]),
  );
}

/**
 * Apply the edits made since `baseline` onto `base`.
 *
 * The editor shows a profile merged with its project override. Saving that draft
 * to the global file as-is would bake the override into every project, so only
 * the fields the user actually changed are carried over.
 */
export function patchProfile(base, baseline, draft) {
  const result = clone(base);
  for (const key of KNOWN_FIELDS) {
    if (key === "id") continue;
    if (sameValue(draft?.[key], baseline?.[key])) continue;
    if (isBlank(draft?.[key])) delete result[key];
    else result[key] = clone(draft[key]);
  }
  return result;
}

/**
 * Build a project override entry from an edited profile.
 *
 * A project entry only needs the fields it changes, so anything identical to
 * the global profile is left out; that keeps global changes visible to every
 * project instead of being shadowed by a stale full copy. When there is no
 * global profile (a project-only profile) the whole body is written.
 *
 * @param {object} draft edited profile
 * @param {object|null|undefined} globalProfile matching global profile, if any
 * @returns {{entry: object, changed: string[]}}
 */
export function overrideDelta(draft, globalProfile) {
  const entry = { id: draft.id };

  if (!globalProfile) {
    for (const [key, value] of Object.entries(draft)) {
      if (key === "id" || key === "origin" || key === "overrides") continue;
      if (!KNOWN_FIELDS.has(key)) continue;
      entry[key] = clone(value);
    }
    return { entry, changed: Object.keys(entry).filter((key) => key !== "id") };
  }

  const changed = [];
  for (const [key, value] of Object.entries(draft)) {
    if (key === "id" || key === "origin" || key === "overrides") continue;
    if (!KNOWN_FIELDS.has(key)) continue;
    if (!sameValue(value, globalProfile[key])) {
      entry[key] = clone(value);
      changed.push(key);
    }
  }
  return { entry, changed };
}
