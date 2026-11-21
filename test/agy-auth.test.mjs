import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { agyApiHome, discoverApiModels, findApiKey, readApiModels } from "../src/core/agy.mjs";
import { buildLaunchArgs, dryRun, listModels, listModelsAsync } from "../src/core/detect.mjs";
import { applyFieldValue, describeFields, editableFields, runEditorAction } from "../src/core/editor.mjs";
import { validateProfile } from "../src/core/schema.mjs";
import { cleanup, tempDir } from "./helpers.mjs";

const agy = { id: "g", name: "G", harness: "agy", model: "gemini-3.8-flash-medium", effort: "medium", when_to_use: "x" };

/** A stand-in `agy models` that answers from whichever home it runs in. */
function fakeAgy(dir) {
  const win = process.platform === "win32";
  const file = path.join(dir, win ? "agy.cmd" : "agy");
  const body = win
    ? '@if exist "%USERPROFILE%\\.gemini\\antigravity-cli\\settings.json" (echo api-model\tAPI) else (echo plain-model\tPlain)\r\n'
    : '#!/bin/sh\nif [ -f "$HOME/.gemini/antigravity-cli/settings.json" ]; then printf "api-model\\tAPI\\n"; else printf "plain-model\\tPlain\\n"; fi\n';
  fs.writeFileSync(file, body, { mode: 0o755 });
  return file;
}

test("api-key lists agy's models from a home whose settings pick the Gemini API", () => {
  const dir = tempDir();
  try {
    const env = { ...process.env, HERDR_PLUGIN_STATE_DIR: path.join(dir, "state"), HOME: dir, USERPROFILE: dir };
    const executablePath = fakeAgy(dir);
    const api = listModels("agy-api", { env, executablePath, cache: false });
    assert.deepEqual(api.models.map((model) => model.id), ["api-model"]);
    const plain = listModels("agy", { env, executablePath, cache: false });
    assert.deepEqual(plain.models.map((model) => model.id), ["plain-model"], "the user's own home is untouched");
  } finally {
    cleanup(dir);
  }
});

test("api-key launches agy with a settings file that selects the Gemini API", () => {
  const dir = tempDir();
  try {
    const env = { ...process.env, HERDR_PLUGIN_STATE_DIR: dir };
    const args = buildLaunchArgs({ ...agy, auth: "api-key" }, { env });
    const at = args.indexOf("--settings");
    assert.ok(at > 0, args.join(" "));
    assert.deepEqual(JSON.parse(fs.readFileSync(args[at + 1], "utf8")), { modelProvider: "gemini" });
    assert.ok(!buildLaunchArgs({ ...agy, auth: "subscription" }, { env }).includes("--settings"));
    assert.ok(!buildLaunchArgs(agy, { env }).includes("--settings"));
  } finally {
    cleanup(dir);
  }
});

test("dryRun reports where an api-key profile gets its key, and fails without one", () => {
  const options = { cache: false, executablePath: "no-such-agy" };
  const keyCheck = (profile, env) => dryRun(profile, { ...options, env }).checks.find((check) => check.label === "API key");
  const bare = { PATH: "" };
  assert.equal(keyCheck({ ...agy, auth: "api-key" }, bare).ok, false);
  assert.match(keyCheck({ ...agy, auth: "api-key", env: { GEMINI_API_KEY: "k" } }, bare).detail, /profile/);
  assert.match(keyCheck({ ...agy, auth: "api-key" }, { ...bare, GEMINI_API_KEY: "k" }).detail, /environment/);
  assert.equal(keyCheck(agy, bare), undefined, "a subscription profile needs no key");
});

test("auth is agy-only and takes subscription or api-key", () => {
  assert.deepEqual(validateProfile({ ...agy, auth: "api-key" }).errors, []);
  assert.match(validateProfile({ ...agy, auth: "token" }).errors.join(" "), /auth must be one of/);
  assert.match(validateProfile({ ...agy, harness: "codex", auth: "api-key" }).errors.join(" "), /only supported by agy/);
});

test("the editor shows API for agy, and the older Auth only on a profile that still sets it", () => {
  assert.ok(!editableFields({ ...agy, harness: "codex" }).includes("api"));
  assert.ok(editableFields(agy).includes("api"));
  assert.ok(!editableFields(agy).includes("auth"));

  const draft = applyFieldValue(agy, "auth", "api-key");
  assert.ok(editableFields(draft).includes("auth"), "a set Auth stays visible so it can be cleared");
  assert.equal(applyFieldValue(draft, "auth", "subscription").auth, "");
  assert.equal(applyFieldValue(draft, "harness", "codex").auth, "", "auth does not follow a harness change");
});

test("the editor's view names the model list the draft uses", async () => {
  const dir = tempDir();
  const saved = { config: process.env.HERDR_PLUGIN_CONFIG_DIR, state: process.env.HERDR_PLUGIN_STATE_DIR };
  try {
    process.env.HERDR_PLUGIN_CONFIG_DIR = path.join(dir, "config");
    process.env.HERDR_PLUGIN_STATE_DIR = path.join(dir, "state");
    const view = (draft) => runEditorAction("view", { draft, kind: "new", baseline: null }, { projectRoot: dir });
    assert.equal((await view(agy)).catalog, "agy");
    assert.equal((await view({ ...agy, auth: "api-key" })).catalog, "agy-api");
  } finally {
    for (const [key, value] of [["HERDR_PLUGIN_CONFIG_DIR", saved.config], ["HERDR_PLUGIN_STATE_DIR", saved.state]]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    cleanup(dir);
  }
});

/** A stand-in Gemini API `models.list` that answers in two pages. */
function fakeGeminiApi(calls) {
  const pages = {
    "": {
      models: [
        { name: "models/gemini-9-flash", displayName: "Gemini 9 Flash", inputTokenLimit: 1048576, supportedGenerationMethods: ["generateContent"] },
        { name: "models/gemini-4-argon", displayName: "Gemini 4 Argon", supportedGenerationMethods: ["generateContent"] },
        { name: "models/gemini-9-flash-tts", displayName: "Gemini 9 Flash TTS", supportedGenerationMethods: ["generateContent"] },
        { name: "models/gemma-9", displayName: "Gemma 9", supportedGenerationMethods: ["generateContent"] },
      ],
      nextPageToken: "p2",
    },
    p2: {
      models: [
        { name: "models/gemini-embedding-9", displayName: "Embedding", supportedGenerationMethods: ["embedContent"] },
        { name: "models/gemini-9-pro", displayName: "Twin", supportedGenerationMethods: ["generateContent"] },
        { name: "models/gemini-9-pro-preview", displayName: "Twin", supportedGenerationMethods: ["generateContent"] },
      ],
    },
  };
  return async (url, init) => {
    calls.push({ url, key: init.headers["x-goog-api-key"] });
    const token = new URL(url).searchParams.get("pageToken") ?? "";
    return { ok: true, json: async () => pages[token] };
  };
}

/** A stand-in `agy models` that lists one built-in model and the custom ones agy shows by label. */
function fakeAgyWithCustom(dir) {
  const rows = ["gemini-4-argon-high\tGemini 4 Argon (High)", "Gemini 4 Argon\tGemini 4 Argon", "Gemini 9 Flash\tGemini 9 Flash", "gemini-9-pro\tgemini-9-pro"];
  const win = process.platform === "win32";
  const file = path.join(dir, win ? "agy.cmd" : "agy");
  const body = win
    ? `@echo off\r\n${rows.map((row) => `echo ${row}`).join("\r\n")}\r\n`
    : `#!/bin/sh\n${rows.map((row) => `printf '${row.replace("\t", "\t")}\n'`).join("\n")}\n`;
  fs.writeFileSync(file, body, { mode: 0o755 });
  return file;
}

test("the Gemini API's current models become agy custom models", async () => {
  const dir = tempDir();
  try {
    const env = { ...process.env, HERDR_PLUGIN_STATE_DIR: dir, GEMINI_API_KEY: "k-1", GOOGLE_GEMINI_BASE_URL: "" };
    const calls = [];
    const found = await discoverApiModels(env, { fetchImpl: fakeGeminiApi(calls) });
    assert.deepEqual(found.map((model) => model.id), ["gemini-9-flash", "gemini-4-argon", "gemini-9-pro", "gemini-9-pro-preview"]);
    assert.equal(calls.length, 2, "follows nextPageToken");
    assert.equal(calls[0].key, "k-1");
    assert.ok(calls[0].url.startsWith("https://generativelanguage.googleapis.com/v1beta/models?"));
    assert.deepEqual(found.slice(2).map((model) => model.label), ["gemini-9-pro", "gemini-9-pro-preview"], "a shared display name falls back to the id");

    const settings = JSON.parse(fs.readFileSync(agyApiHome(env).settings, "utf8"));
    assert.equal(settings.modelProvider, "gemini");
    assert.deepEqual(settings.customModelsConfig.customModels["gemini-9-flash"], {
      modelName: "gemini-api://gemini-9-flash",
      label: "Gemini 9 Flash",
      maxTokens: 1048576,
    });
  } finally {
    cleanup(dir);
  }
});

test("a failed or keyless lookup keeps the models found before", async () => {
  const dir = tempDir();
  try {
    const env = { ...process.env, HERDR_PLUGIN_STATE_DIR: dir, GEMINI_API_KEY: "k-1" };
    await discoverApiModels(env, { fetchImpl: fakeGeminiApi([]) });
    assert.equal(await discoverApiModels(env, { fetchImpl: async () => ({ ok: false }) }), null);
    assert.equal(await discoverApiModels({ ...env, GEMINI_API_KEY: "" }, { fetchImpl: fakeGeminiApi([]) }), null);
    assert.equal(readApiModels(env).length, 4);
  } finally {
    cleanup(dir);
  }
});

test("the API catalog lists custom models by API id, without repeating agy's own", async () => {
  const dir = tempDir();
  try {
    const env = { ...process.env, HERDR_PLUGIN_STATE_DIR: path.join(dir, "state"), GEMINI_API_KEY: "" };
    const executablePath = fakeAgyWithCustom(dir);
    const calls = [];
    const result = await listModelsAsync("agy-api", { env, executablePath, cache: false, apiKey: "k-2", fetchImpl: fakeGeminiApi(calls) });
    assert.equal(calls[0].key, "k-2", "a key from a saved profile is used when the environment has none");
    assert.deepEqual(result.models.map((model) => model.id), ["gemini-4-argon-high", "gemini-9-flash", "gemini-9-pro"]);
    assert.equal(result.models[1].context, 1048576);

    const offline = await listModelsAsync("agy-api", { env, executablePath, cache: false, apiKey: "k-2", offline: true, fetchImpl: fakeGeminiApi(calls) });
    assert.equal(calls.length, 2, "offline asks the API nothing");
    assert.equal(offline.revalidate, true);
    assert.deepEqual(offline.models.map((model) => model.id), result.models.map((model) => model.id));
  } finally {
    cleanup(dir);
  }
});

test("findApiKey prefers the environment, then a saved api-key profile", () => {
  const keyed = { ...agy, auth: "api-key", env: { GEMINI_API_KEY: "saved" } };
  assert.equal(findApiKey({ GEMINI_API_KEY: "env" }, [keyed]), "env");
  assert.equal(findApiKey({}, [{ ...agy, env: { GEMINI_API_KEY: "sub" } }, keyed]), "saved");
  // An empty config dir, so the fallback never reads this machine's keys.toml; and no value in
  // the failure message, so a real key can never be printed.
  const config = tempDir();
  try {
    assert.ok(findApiKey({ HERDR_PLUGIN_CONFIG_DIR: config }, [agy]) === undefined, "no key without env, profile, or stored key");
  } finally {
    cleanup(config);
  }
});
