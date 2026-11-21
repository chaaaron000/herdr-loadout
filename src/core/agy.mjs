/**
 * agy (Antigravity CLI) runs on either the Google sign-in quota or a Gemini API
 * key. A profile picks one with `auth`:
 *
 *   subscription (or unset)  agy's own sign-in, as configured on this machine
 *   api-key                  the Gemini API: `modelProvider: "gemini"` plus
 *                            GEMINI_API_KEY, from the profile's env or the
 *                            environment the worker starts in
 *
 * The API route lists a different set of models, so it has its own catalog.
 * agy's own list of API models is fixed at its build, so the models the API
 * offers today are looked up with the key and added as agy custom models.
 */
import fs from "node:fs";
import path from "node:path";
import { stateDir } from "./paths.mjs";
import { findKey, PROVIDERS, readKeys } from "./keys.mjs";

export const AUTH_OPTIONS = ["subscription", "api-key"];
export const AGY_KEY_ENV = "GEMINI_API_KEY";
/** Catalog id of the models agy offers through the Gemini API. */
export const AGY_API_CATALOG = "agy-api";

/** agy on the Gemini API: a stored key (`api`), or `auth = "api-key"` with the key from the environment. */
export function usesApiKey(profile) {
  return profile?.harness === "agy" && (profile.auth === "api-key" || Boolean(profile.api));
}

/** Catalog id of a provider's own model list (`api-deepseek`). */
export function providerCatalogId(provider) {
  return `api-${provider}`;
}

/**
 * The catalog a profile's model comes from: its harness, agy's API list, or the
 * model list of the provider its stored key belongs to.
 */
export function catalogIdOf(profile, env = process.env) {
  const harness = profile?.harness ?? "claude";
  if (usesApiKey(profile)) return AGY_API_CATALOG;
  if (profile?.api) {
    const provider = findKey(profile.api, env)?.provider;
    if (provider && PROVIDERS[provider]?.modelsUrl) return providerCatalogId(provider);
  }
  return harness;
}

export function validateAuth(profile) {
  const value = profile?.auth;
  if (value === undefined || value === "") return [];
  if (typeof value !== "string") return ["auth must be a string"];
  if (profile.harness && profile.harness !== "agy") return [`auth is only supported by agy, not ${profile.harness}`];
  return AUTH_OPTIONS.includes(value) ? [] : [`auth must be one of ${AUTH_OPTIONS.join(" | ")}`];
}

/** agy reads this to send Gemini API requests to another endpoint; so does the model lookup. */
export const AGY_BASE_URL_ENV = "GOOGLE_GEMINI_BASE_URL";
const DEFAULT_GEMINI_BASE = "https://generativelanguage.googleapis.com";
const FETCH_TIMEOUT_MS = 10000;

function apiDir(env) {
  return path.join(stateDir(env), AGY_API_CATALOG);
}

function apiModelsFile(env) {
  return path.join(apiDir(env), "gemini-models.json");
}

/** The Gemini API's REST root, with its version: `https://host/v1beta`. */
function geminiApiRoot(env) {
  const base = String(env[AGY_BASE_URL_ENV] || DEFAULT_GEMINI_BASE).replace(/\/+$/, "");
  return /\/v1(beta)?$/.test(base) ? base : `${base}/v1beta`;
}

/**
 * Models the Gemini API offered at the last lookup, beyond the ones built into
 * agy. Each is `{id, label, context?}`; an unreadable file means none.
 */
export function readApiModels(env = process.env) {
  try {
    const data = JSON.parse(fs.readFileSync(apiModelsFile(env), "utf8"));
    return Array.isArray(data?.models) ? data.models.filter((model) => typeof model?.id === "string") : [];
  } catch {
    return [];
  }
}

/**
 * agy only knows the API models compiled into it, so a model released since
 * that build is missing from `agy models` and refused by `--model`. Each model
 * the API lists is registered as a custom model (`customModelsConfig`), which
 * agy accepts by its key. agy reads those only with `GEMINI_API_KEY` set.
 */
function apiSettings(env) {
  const settings = { modelProvider: "gemini" };
  const models = readApiModels(env);
  if (models.length === 0) return settings;
  const customModels = {};
  for (const model of models) {
    // Only the bare id: agy sends it to `GOOGLE_GEMINI_BASE_URL` (or Google's
    // endpoint) as `/v1beta/models/<id>`. A host written into the name, as its
    // documentation shows, ends up inside that path and the API answers 404.
    const entry = { modelName: `gemini-api://${model.id}`, label: model.label ?? model.id };
    if (Number.isInteger(model.context) && model.context > 0) entry.maxTokens = model.context;
    customModels[model.id] = entry;
  }
  settings.customModelsConfig = { customModels };
  return settings;
}

/**
 * A model id from the API that suits an agent: a Gemini text model that
 * generates content. Speech, image, embedding, live and robotics variants are
 * left out.
 */
const NOT_FOR_AGENTS = /(tts|image|embedding|live|native-audio|transcribe|robotics|computer-use|banana|aqa)/i;
function suitsAgent(model) {
  const id = String(model?.name ?? "").replace(/^models\//, "");
  if (!/^gemini-/.test(id) || NOT_FOR_AGENTS.test(id)) return false;
  return Array.isArray(model.supportedGenerationMethods) && model.supportedGenerationMethods.includes("generateContent");
}

/**
 * Ask the Gemini API which models the key can use, and register the ones agy
 * lacks. Returns the stored rows, or null when the lookup failed (the previous
 * rows stay). Never throws.
 * @param {{fetchImpl?: Function, signal?: AbortSignal, timeoutMs?: number, apiKey?: string}} [options]
 */
export async function discoverApiModels(env = process.env, options = {}) {
  const key = options.apiKey || env[AGY_KEY_ENV];
  const fetchImpl = "fetchImpl" in options ? options.fetchImpl : globalThis.fetch;
  if (!key || key === LISTING_KEY || typeof fetchImpl !== "function") return null;
  const controller = new AbortController();
  const stop = () => controller.abort();
  options.signal?.addEventListener("abort", stop, { once: true });
  const timer = setTimeout(stop, options.timeoutMs ?? FETCH_TIMEOUT_MS);
  try {
    const found = [];
    let pageToken = "";
    for (let page = 0; page < 20; page += 1) {
      const query = `pageSize=1000${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ""}`;
      const response = await fetchImpl(`${geminiApiRoot(env)}/models?${query}`, {
        headers: { "x-goog-api-key": key },
        signal: controller.signal,
      });
      if (!response?.ok) return null;
      const data = await response.json();
      for (const model of data?.models ?? []) {
        if (!suitsAgent(model)) continue;
        const id = model.name.replace(/^models\//, "");
        if (found.some((row) => row.id === id)) continue;
        found.push({ id, label: model.displayName || id, context: model.inputTokenLimit || undefined });
      }
      pageToken = data?.nextPageToken ?? "";
      if (!pageToken) break;
    }
    if (found.length === 0) return null;
    // agy picks a custom model by key or label, so two models sharing a
    // display name fall back to their ids.
    const labels = new Map();
    for (const row of found) labels.set(row.label, (labels.get(row.label) ?? 0) + 1);
    for (const row of found) if (labels.get(row.label) > 1) row.label = row.id;
    fs.mkdirSync(apiDir(env), { recursive: true });
    fs.writeFileSync(apiModelsFile(env), `${JSON.stringify({ fetchedAt: Date.now(), models: found }, null, 2)}\n`);
    return found;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", stop);
  }
}

/**
 * `agy models` prints a custom model as `label<TAB>label`. Give those rows their
 * API id back, so a profile stores what `--model` takes, and drop the ones that
 * repeat a model agy already lists by level (`gemini-4-argon-high`).
 */
export function apiModelRows(rows, env = process.env) {
  const known = readApiModels(env);
  const byLabel = new Map(known.map((model) => [model.label ?? model.id, model]));
  const builtIn = new Set();
  for (const row of rows) {
    if (byLabel.has(row.id)) continue;
    builtIn.add(row.id);
    builtIn.add(row.id.replace(/-(minimal|low|medium|high|xhigh|max)$/, ""));
  }
  const out = [];
  for (const row of rows) {
    const custom = byLabel.get(row.id);
    if (!custom) out.push(row);
    else if (!builtIn.has(custom.id)) out.push({ id: custom.id, label: custom.label ?? custom.id, context: custom.context });
  }
  return out;
}

/**
 * A home directory whose agy settings select the Gemini API. Listing models
 * there shows the API's models without touching the user's own settings; its
 * settings file is also what `--settings` passes at launch, so no JSON has to
 * survive a shell's quoting.
 * @returns {{home: string, settings: string}}
 */
export function agyApiHome(env = process.env) {
  const home = apiDir(env);
  const settings = path.join(home, ".gemini", "antigravity-cli", "settings.json");
  const content = `${JSON.stringify(apiSettings(env))}\n`;
  try {
    if (fs.readFileSync(settings, "utf8") === content) return { home, settings };
  } catch {
    /* first use */
  }
  fs.mkdirSync(path.dirname(settings), { recursive: true });
  fs.writeFileSync(settings, content);
  return { home, settings };
}

/** Environment for listing the API's models: the API home, and a key if there is one. */
export function agyApiListEnv(env = process.env) {
  const { home } = agyApiHome(env);
  // agy lists the API's models without checking the key, so a stand-in keeps
  // the list readable before the user has entered one.
  return { ...env, HOME: home, USERPROFILE: home, [AGY_KEY_ENV]: env[AGY_KEY_ENV] || LISTING_KEY };
}

const LISTING_KEY = "listing-only";

/**
 * A key to look the Gemini API's models up with: the environment's, a profile's
 * own GEMINI_API_KEY, or a stored Google key.
 */
export function findApiKey(env = process.env, profiles = []) {
  if (env[AGY_KEY_ENV]) return env[AGY_KEY_ENV];
  for (const profile of profiles) {
    const key = usesApiKey(profile) ? profile.env?.[AGY_KEY_ENV] : undefined;
    if (typeof key === "string" && key) return key;
  }
  return readKeys(env).keys.find((entry) => entry.provider === "google")?.key;
}
