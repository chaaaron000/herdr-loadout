/**
 * Profile input parsing for non-interactive creation.
 *
 * Agents cannot drive the Ink TUI, so `add` accepts a structured payload
 * (JSON or TOML file, or stdin) plus convenience flags. Flags win over the
 * payload so a caller can tweak one field without rewriting the whole object.
 */
import fs from "node:fs";
import { parse as parseToml } from "smol-toml";
import { KNOWN_FIELDS, isPlainObject, setOwn } from "./schema.mjs";

/** Fields exposed as CLI flags, mapped to their profile key. */
const FLAG_FIELDS = {
  id: "id",
  name: "name",
  harness: "harness",
  model: "model",
  effort: "effort",
  cost: "cost",
  when: "when_to_use",
  avoid: "avoid_when",
  provider: "provider",
  mode: "mode",
  sandbox: "sandbox",
  "approval-policy": "approval_policy",
  "permission-mode": "permission_mode",
  notes: "notes",
  auth: "auth",
  api: "api",
};

/** Repeatable flags. */
const REPEATABLE_FIELDS = {
  tag: "tags",
  "extra-arg": "extra_args",
  skill: "skills",
};

function splitOnce(text, separator) {
  const index = text.indexOf(separator);
  if (index === -1) return null;
  return [text.slice(0, index), text.slice(index + separator.length)];
}

/** Parse `KEY=VALUE` into an env table entry. */
export function parseEnvPair(pair) {
  const split = splitOnce(String(pair), "=");
  if (!split) return { ok: false, error: `env entry "${pair}" must look like KEY=VALUE` };
  const [key, value] = split;
  if (!key) return { ok: false, error: `env entry "${pair}" has an empty key` };
  return { ok: true, key, value };
}

/**
 * Read a profile object from a file or stdin.
 * `.toml` files are parsed as TOML; anything else as JSON. A single
 * `[[profiles]]` entry, a bare profile object, or `{profiles:[...]}` are all
 * accepted so a hand-written config file can be reused as input.
 * @returns {{ok: boolean, profile?: object, errors: string[]}}
 */
export function readProfilePayload({ file, stdin, fsImpl = fs }) {
  if (!file && !stdin) return { ok: true, profile: {}, errors: [] };
  let text;
  let label;
  if (file) {
    if (!fsImpl.existsSync(file)) return { ok: false, errors: [`file not found: ${file}`] };
    text = fsImpl.readFileSync(file, "utf8");
    label = file;
  } else {
    try {
      text = fsImpl.readFileSync(0, "utf8");
    } catch (error) {
      return { ok: false, errors: [`could not read stdin: ${error.message}`] };
    }
    label = "<stdin>";
  }
  if (!text.trim()) return { ok: false, errors: [`${label}: input is empty`] };

  const isToml = file ? String(file).toLowerCase().endsWith(".toml") : looksLikeToml(text);
  let parsed;
  try {
    parsed = isToml ? parseToml(text) : JSON.parse(text);
  } catch (error) {
    return { ok: false, errors: [`${label}: ${isToml ? "TOML" : "JSON"} parse failed: ${error.message}`] };
  }

  return normalizePayload(parsed, label);
}

/** Heuristic so stdin can accept both formats without a flag. */
export function looksLikeToml(text) {
  const trimmed = String(text).trimStart();
  if (trimmed.startsWith("{")) return false;
  // JSON arrays start with [{ or [" ; TOML table headers start with [[ or [name
  if (trimmed.startsWith("[{") || trimmed.startsWith('["') || trimmed.startsWith("[]")) return false;
  return /\[\[?[A-Za-z_]|^[A-Za-z_][\w-]*\s*=/m.test(text);
}

/** Accept a bare profile, a [[profiles]] array, or {profiles:[...]}. */
export function normalizePayload(parsed, label = "<input>") {
  if (!isPlainObject(parsed)) {
    return { ok: false, errors: [`${label}: expected an object, got ${Array.isArray(parsed) ? "array" : typeof parsed}`] };
  }
  if (Array.isArray(parsed.profiles)) {
    if (parsed.profiles.length === 0) return { ok: false, errors: [`${label}: profiles array is empty`] };
    if (parsed.profiles.length > 1) {
      return {
        ok: false,
        errors: [`${label}: contains ${parsed.profiles.length} profiles; use \`import\` or pass a single profile`],
      };
    }
    const entry = parsed.profiles[0];
    if (!isPlainObject(entry)) return { ok: false, errors: [`${label}: profiles[0] is not a table`] };
    return { ok: true, profile: entry, errors: [] };
  }
  return { ok: true, profile: parsed, errors: [] };
}

/**
 * Build a profile from CLI flags.
 * @returns {{ok: boolean, profile: object, errors: string[]}}
 */
export function profileFromFlags(values = {}) {
  const profile = {};
  const errors = [];

  for (const [flag, field] of Object.entries(FLAG_FIELDS)) {
    const value = values[flag];
    if (value !== undefined) profile[field] = String(value);
  }

  for (const [flag, field] of Object.entries(REPEATABLE_FIELDS)) {
    const value = values[flag];
    if (value !== undefined) profile[field] = (Array.isArray(value) ? value : [value]).map(String);
  }

  if (values.env !== undefined) {
    const list = Array.isArray(values.env) ? values.env : [values.env];
    const env = {};
    for (const pair of list) {
      const result = parseEnvPair(pair);
      if (!result.ok) errors.push(result.error);
      else setOwn(env, result.key, result.value);
    }
    if (Object.keys(env).length > 0) profile.env = env;
  }

  return { ok: errors.length === 0, profile, errors };
}

/**
 * Merge a payload with flags: flags override payload fields.
 * Unknown keys are dropped by the store, so they are reported here instead.
 */
export function mergeProfileInput(payload = {}, flags = {}) {
  const merged = {};
  for (const [key, value] of Object.entries(payload)) {
    if (isPlainObject(value) || Array.isArray(value) || typeof value === "string" || typeof value === "number") {
      setOwn(merged, key, value);
    }
  }
  for (const [key, value] of Object.entries(flags)) {
    if (value !== undefined) setOwn(merged, key, value);
  }
  const unknown = Object.keys(merged).filter((key) => !KNOWN_FIELDS.has(key));
  return { profile: merged, unknown };
}
