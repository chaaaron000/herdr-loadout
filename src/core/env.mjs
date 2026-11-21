/**
 * A profile's `env` often holds a secret (an API key). Everything that prints a
 * profile shows the names and masks the values, so a key never lands in an
 * agent's transcript or memory. Only `exec` and `env-value` read the real values.
 */
import { parseEnvPair } from "./input.mjs";
import { setOwn } from "./schema.mjs";

export const MASK = "***";

/** The same table with every value masked; undefined stays undefined. */
export function maskEnv(env) {
  if (!env || typeof env !== "object") return env;
  return Object.fromEntries(Object.keys(env).map((key) => [key, MASK]));
}

/** `KEY=*** KEY2=***` for an editor field. */
export function formatEnvInput(env) {
  if (!env || typeof env !== "object") return "";
  return Object.keys(env).map((key) => `${key}=${MASK}`).join(" ");
}

/**
 * Editor text -> env table. A masked value keeps the value `previous` holds for
 * that name, so opening the field and confirming it changes nothing; a name that
 * had no value yet is dropped, since its value is unknown. Malformed entries
 * (no `=`, empty name) are dropped too.
 *
 * @param {string[]} items the field text split into `KEY=VALUE` items
 * @param {Record<string,string>|undefined} previous
 */
export function parseEnvInput(items, previous) {
  const env = {};
  for (const item of items) {
    const pair = parseEnvPair(item);
    if (!pair.ok) continue;
    if (pair.value !== MASK) setOwn(env, pair.key, pair.value);
    else if (previous && Object.hasOwn(previous, pair.key)) setOwn(env, pair.key, previous[pair.key]);
  }
  return env;
}
