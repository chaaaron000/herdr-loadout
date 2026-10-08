/**
 * models.dev catalog client.
 *
 * models.dev is a public, provider-maintained catalog of model metadata
 * (https://models.dev/api.json). omp sources its list from it, which is why
 * `omp models` knows the Anthropic catalog that claude itself never exposes.
 *
 * Reading it directly gives us the same data without spawning another CLI, and
 * supplies the per-model reasoning levels that each harness maps to its own
 * effort flag.
 *
 * The snapshot is cached on disk with a long TTL because it changes on the
 * order of weeks, and every lookup must still work offline.
 */
import fs from "node:fs";
import path from "node:path";
import { stateDir } from "./paths.mjs";

export const MODELS_DEV_URL = "https://models.dev/api.json";
/** The catalog moves slowly; a day is plenty and keeps lookups offline. */
export const CATALOG_TTL_MS = 24 * 60 * 60 * 1000;
/** Guard against a hung fetch; the caller falls back to local sources. */
const FETCH_TIMEOUT_MS = 12000;

function snapshotFile(env) {
  return path.join(stateDir(env), "models-dev.json");
}

/** Read the cached snapshot, or null when absent/stale. */
export function readSnapshot(options = {}) {
  const maxAge = options.maxAgeMs ?? CATALOG_TTL_MS;
  const entry = readSnapshotEntry(options);
  return entry && entry.ageMs <= maxAge ? entry.data : null;
}

/**
 * The cached snapshot whatever its age, so a caller can serve an expired one
 * while it refreshes. Null when absent or unreadable.
 * @returns {{data: object, ageMs: number}|null}
 */
export function readSnapshotEntry(options = {}) {
  const env = options.env ?? process.env;
  try {
    const raw = fs.readFileSync(snapshotFile(env), "utf8");
    const parsed = JSON.parse(raw);
    if (typeof parsed?.fetchedAt !== "number" || !parsed.data) return null;
    return { data: parsed.data, ageMs: Date.now() - parsed.fetchedAt };
  } catch {
    return null;
  }
}

function writeSnapshot(data, env) {
  const file = snapshotFile(env);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ fetchedAt: Date.now(), data }));
  } catch {
    /* a cache write failure must never break a lookup */
  }
}

/**
 * Fetch the catalog. Returns the parsed document or null; never throws.
 * @param {{env?: object, fetchImpl?: Function, url?: string, timeoutMs?: number}} [options]
 */
export async function fetchCatalog(options = {}) {
  const env = options.env ?? process.env;
  const url = options.url ?? env.HERDR_LOADOUT_MODELS_URL ?? MODELS_DEV_URL;
  // `in` check, not `??`: passing fetchImpl: null must mean "no network",
  // while omitting it means "use the platform fetch".
  const fetchImpl = "fetchImpl" in options ? options.fetchImpl : globalThis.fetch;
  if (typeof fetchImpl !== "function") return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? FETCH_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, { signal: controller.signal });
    if (!response?.ok) return null;
    const data = await response.json();
    if (!data || typeof data !== "object") return null;
    writeSnapshot(data, env);
    return data;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Cached catalog, fetching once when the snapshot is missing or stale. */
export async function loadCatalog(options = {}) {
  const cached = readSnapshot(options);
  if (cached) return cached;
  if (options.offline) return null;
  return fetchCatalog(options);
}

/**
 * Model rows for one models.dev provider.
 * Each row carries the reasoning levels the model accepts, mapped to the
 * harness's own effort flag by the caller.
 * @returns {object[]|null}
 */
export function modelsForProvider(catalog, providerId, options = {}) {
  const provider = catalog?.[providerId];
  const models = provider?.models;
  if (!models || typeof models !== "object") return null;

  const rows = [];
  for (const model of Object.values(models)) {
    if (!model?.id) continue;
    if (model.experimental === true && options.includeExperimental !== true) continue;
    const efforts = [];
    for (const option of model.reasoning_options ?? []) {
      if (option?.type && option.type !== "effort") continue;
      for (const value of option?.values ?? []) if (!efforts.includes(value)) efforts.push(value);
    }
    rows.push({
      id: model.id,
      label: model.name ?? model.id,
      efforts: efforts.length > 0 ? efforts : undefined,
      context: model.limit?.context,
    });
  }
  return rows.length > 0 ? rows : null;
}
