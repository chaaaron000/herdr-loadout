/**
 * API key store: provider keys saved once and picked by profiles.
 *
 * A profile names a stored key with `api = "<key id>"`. At launch the key turns
 * into the environment the harness reads to reach that provider, so a harness
 * that normally signs in to its own vendor runs on another provider's API:
 *
 *   claude  + deepseek  DeepSeek's Anthropic-compatible endpoint
 *   agy     + google    the Gemini API (Google AI Studio)
 *
 * Keys live in `keys.toml` beside the global config, never in a project file,
 * so a key cannot be committed with a repository. Everything that prints a key
 * shows only its last four characters.
 */
import fs from "node:fs";
import path from "node:path";
import { parse, stringify } from "smol-toml";
import { configDir } from "./paths.mjs";

export const KEYS_FILE_NAME = "keys.toml";
export const KEY_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;

const HEADER = [
  "# herdr-loadout API keys. Private: never commit or share this file.",
  "# Manage it with `herdr-loadout keys` or the editor's API tab.",
  "",
].join("\n");

/**
 * Providers and the harnesses each one can drive.
 *
 * `harnesses.<id>.env(key, model)` is the environment that points that harness
 * at the provider. `models` is the fallback list when the provider's own list
 * cannot be read; `modelsUrl` answers with the OpenAI `{data: [{id}]}` shape.
 */
export const PROVIDERS = {
  deepseek: {
    label: "DeepSeek",
    site: "platform.deepseek.com",
    modelsUrl: "https://api.deepseek.com/models",
    models: [
      { id: "deepseek-v4-pro", label: "DeepSeek V4 Pro", context: 1048576 },
      { id: "deepseek-flash", label: "DeepSeek Flash", context: 1048576 },
    ],
    harnesses: {
      claude: {
        // DeepSeek's Claude Code guide: the main model on every tier but Haiku,
        // which Claude Code uses for small background calls. `[1m]` tells Claude
        // Code the window is 1M tokens; it is removed before the request.
        env(key, model) {
          const main = longContext(model || "deepseek-v4-pro");
          return {
            ANTHROPIC_BASE_URL: "https://api.deepseek.com/anthropic",
            ANTHROPIC_AUTH_TOKEN: key,
            // An inherited ANTHROPIC_API_KEY would be sent to DeepSeek instead.
            ANTHROPIC_API_KEY: "",
            ANTHROPIC_MODEL: main,
            ANTHROPIC_DEFAULT_OPUS_MODEL: main,
            ANTHROPIC_DEFAULT_SONNET_MODEL: main,
            ANTHROPIC_DEFAULT_HAIKU_MODEL: "deepseek-flash",
            CLAUDE_CODE_AUTO_COMPACT_WINDOW: "786432",
          };
        },
        model: (model) => longContext(model),
      },
    },
  },
  google: {
    label: "Google AI Studio",
    site: "aistudio.google.com",
    harnesses: {
      // agy's own API route (see agy.mjs): the key in GEMINI_API_KEY plus a
      // settings file that selects the Gemini provider.
      agy: { env: (key) => ({ GEMINI_API_KEY: key }) },
    },
  },
};

export const PROVIDER_IDS = Object.keys(PROVIDERS);

function longContext(model) {
  return /\[1m\]$/i.test(model) ? model : `${model}[1m]`;
}

/** Providers that can drive this harness. */
export function providersFor(harness) {
  return PROVIDER_IDS.filter((id) => Object.hasOwn(PROVIDERS[id].harnesses, harness));
}

/** Harnesses that can run on a stored API key. */
export const API_HARNESSES = [...new Set(PROVIDER_IDS.flatMap((id) => Object.keys(PROVIDERS[id].harnesses)))];

export function keysPath(env = process.env) {
  return path.join(configDir(env), KEYS_FILE_NAME);
}

/** `sk-…1a2b`: enough to tell two keys apart, not enough to use one. */
export function maskKey(key) {
  const text = String(key ?? "");
  if (!text) return "";
  if (text.length <= 8) return "…";
  const prefix = /^[A-Za-z]{2,5}[-_]/.exec(text)?.[0] ?? "";
  return `${prefix}…${text.slice(-4)}`;
}

/**
 * Every stored key. A missing file is an empty store; an unreadable one is an
 * error, and nothing is guessed from it.
 * @returns {{ok: boolean, path: string, keys: Array<{id, provider, key, label?}>, error?: string}}
 */
export function readKeys(env = process.env, fsImpl = fs) {
  const file = keysPath(env);
  if (!fsImpl.existsSync(file)) return { ok: true, path: file, keys: [] };
  let doc;
  try {
    doc = parse(fsImpl.readFileSync(file, "utf8"));
  } catch (error) {
    return { ok: false, path: file, keys: [], error: `${file}: ${error.message}` };
  }
  const keys = [];
  for (const [id, entry] of Object.entries(doc.keys ?? {})) {
    if (!entry || typeof entry !== "object" || typeof entry.key !== "string") continue;
    keys.push({
      id,
      provider: typeof entry.provider === "string" ? entry.provider : id,
      key: entry.key,
      ...(typeof entry.label === "string" && entry.label ? { label: entry.label } : {}),
    });
  }
  return { ok: true, path: file, keys };
}

/** The stored key a profile's `api` names, or null. */
export function findKey(id, env = process.env) {
  if (!id) return null;
  return readKeys(env).keys.find((entry) => entry.id === id) ?? null;
}

/** Stored keys as they may be shown: the key itself masked. */
export function listKeys(env = process.env) {
  const store = readKeys(env);
  return {
    ...store,
    keys: store.keys.map(({ key, ...rest }) => ({
      ...rest,
      masked: maskKey(key),
      providerLabel: PROVIDERS[rest.provider]?.label ?? rest.provider,
      harnesses: Object.keys(PROVIDERS[rest.provider]?.harnesses ?? {}),
    })),
  };
}

function writeStore(keys, env, fsImpl = fs) {
  const file = keysPath(env);
  const doc = { keys: {} };
  for (const entry of keys) {
    doc.keys[entry.id] = { provider: entry.provider, key: entry.key, ...(entry.label ? { label: entry.label } : {}) };
  }
  fsImpl.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  // 0600 on POSIX; Windows keeps the profile folder's own permissions.
  fsImpl.writeFileSync(temp, `${HEADER}${stringify(doc)}\n`, { mode: 0o600 });
  fsImpl.renameSync(temp, file);
  return file;
}

/**
 * Add or replace one key. An empty `key` on an existing id keeps the stored key,
 * so a rename or a provider change does not need the key again.
 * @returns {{ok: boolean, id?: string, error?: string}}
 */
export function saveKey({ id, provider, key, label }, env = process.env) {
  const store = readKeys(env);
  if (!store.ok) return { ok: false, error: store.error };
  const providerId = String(provider ?? "").trim();
  if (!PROVIDERS[providerId]) return { ok: false, error: `provider must be one of ${PROVIDER_IDS.join(" | ")}` };
  const keyId = String(id ?? "").trim() || providerId;
  if (!KEY_ID_PATTERN.test(keyId)) return { ok: false, error: `key id "${keyId}" must match ${KEY_ID_PATTERN}` };
  const existing = store.keys.find((entry) => entry.id === keyId);
  const secret = String(key ?? "").trim() || existing?.key || "";
  if (!secret) return { ok: false, error: "the API key is empty" };
  if (/\s/.test(secret)) return { ok: false, error: "the API key must not contain spaces" };
  const entry = { id: keyId, provider: providerId, key: secret, ...(label ? { label: String(label).trim() } : {}) };
  const keys = existing ? store.keys.map((item) => (item.id === keyId ? entry : item)) : [...store.keys, entry];
  writeStore(keys, env);
  return { ok: true, id: keyId };
}

/** @returns {{ok: boolean, error?: string}} */
export function removeKey(id, env = process.env) {
  const store = readKeys(env);
  if (!store.ok) return { ok: false, error: store.error };
  if (!store.keys.some((entry) => entry.id === id)) return { ok: false, error: `key "${id}" not found` };
  writeStore(store.keys.filter((entry) => entry.id !== id), env);
  return { ok: true };
}

/**
 * What a profile's `api` resolves to at launch.
 * @returns {{ok: true, entry, provider, env: Record<string,string>, model?: string} | {ok: false, error: string} | null}
 *   null when the profile names no key
 */
export function resolveApi(profile, env = process.env) {
  const id = profile?.api;
  if (!id) return null;
  const store = readKeys(env);
  if (!store.ok) return { ok: false, error: store.error };
  const entry = store.keys.find((item) => item.id === id);
  if (!entry) return { ok: false, error: `no stored key "${id}" (herdr-loadout keys list)` };
  const provider = PROVIDERS[entry.provider];
  if (!provider) return { ok: false, error: `key "${id}" has unknown provider "${entry.provider}"` };
  const harness = profile.harness ?? "claude";
  const route = provider.harnesses[harness];
  if (!route) {
    const fits = Object.keys(provider.harnesses).join(", ");
    return { ok: false, error: `${provider.label} keys run on ${fits}, not ${harness}` };
  }
  return {
    ok: true,
    entry,
    provider: entry.provider,
    env: route.env(entry.key, profile.model),
    model: profile.model && route.model ? route.model(profile.model) : profile.model,
  };
}

const FETCH_TIMEOUT_MS = 10000;

/**
 * Ask a provider which models a key can use (OpenAI `GET /models` shape).
 * @returns {Promise<{ok: boolean, models: Array<{id, label?, context?}>, error?: string}>}
 */
export async function fetchProviderModels(providerId, key, options = {}) {
  const provider = PROVIDERS[providerId];
  if (!provider?.modelsUrl) return { ok: false, models: [], error: `${providerId} has no model list` };
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? FETCH_TIMEOUT_MS);
  try {
    const response = await fetchImpl(provider.modelsUrl, {
      headers: { Authorization: `Bearer ${key}` },
      signal: controller.signal,
    });
    if (!response?.ok) {
      const reason = response?.status === 401 ? "the key was rejected (401)" : `HTTP ${response?.status ?? "error"}`;
      return { ok: false, models: [], error: reason };
    }
    const data = await response.json();
    const known = new Map(provider.models?.map((model) => [model.id, model]) ?? []);
    const models = (data?.data ?? [])
      .filter((row) => typeof row?.id === "string")
      .map((row) => ({ id: row.id, label: known.get(row.id)?.label ?? row.id, context: known.get(row.id)?.context }));
    return { ok: true, models };
  } catch (error) {
    return { ok: false, models: [], error: error.name === "AbortError" ? "timed out" : error.message };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Check a stored key against its provider without starting a harness.
 * @returns {Promise<{ok: boolean, detail: string}>}
 */
export async function testKey(id, env = process.env, options = {}) {
  const entry = readKeys(env).keys.find((item) => item.id === id);
  if (!entry) return { ok: false, detail: `key "${id}" not found` };
  if (entry.provider === "google") {
    const { discoverApiModels } = await import("./agy.mjs");
    const found = await discoverApiModels(env, { ...options, apiKey: entry.key });
    return found ? { ok: true, detail: `${found.length} Gemini models` } : { ok: false, detail: "the Gemini API refused the key or could not be reached" };
  }
  const result = await fetchProviderModels(entry.provider, entry.key, options);
  return result.ok ? { ok: true, detail: `${result.models.length} models: ${result.models.map((m) => m.id).join(", ")}` } : { ok: false, detail: result.error };
}
