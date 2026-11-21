import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { fetchProviderModels, keysPath, listKeys, maskKey, readKeys, removeKey, resolveApi, saveKey } from "../src/core/keys.mjs";
import { catalogIdOf } from "../src/core/agy.mjs";
import { dryRun, listModelsAsync } from "../src/core/detect.mjs";
import { applyFieldValue, describeFields, editableFields, runEditorAction } from "../src/core/editor.mjs";
import { validateProfile } from "../src/core/schema.mjs";
import { cleanup, tempDir } from "./helpers.mjs";

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "herdr-loadout.mjs");
const claude = { id: "ds", name: "DS", harness: "claude", model: "deepseek-v4-pro", effort: "high", when_to_use: "x" };
const agy = { id: "g", name: "G", harness: "agy", model: "gemini-3.8-flash-medium", effort: "medium", when_to_use: "x" };

/** Point the config and state dirs at a temp dir for the length of `body`. */
async function withStore(body) {
  const dir = tempDir();
  const saved = { config: process.env.HERDR_PLUGIN_CONFIG_DIR, state: process.env.HERDR_PLUGIN_STATE_DIR };
  process.env.HERDR_PLUGIN_CONFIG_DIR = path.join(dir, "config");
  process.env.HERDR_PLUGIN_STATE_DIR = path.join(dir, "state");
  try {
    await body(dir);
  } finally {
    for (const [key, value] of [["HERDR_PLUGIN_CONFIG_DIR", saved.config], ["HERDR_PLUGIN_STATE_DIR", saved.state]]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    cleanup(dir);
  }
}

test("keys are stored beside the global config and only ever shown masked", () =>
  withStore(() => {
    assert.deepEqual(readKeys().keys, []);
    assert.deepEqual(saveKey({ id: "deepseek", provider: "deepseek", key: "sk-abcdef123456" }), { ok: true, id: "deepseek" });
    assert.equal(path.dirname(keysPath()), process.env.HERDR_PLUGIN_CONFIG_DIR);
    assert.match(fs.readFileSync(keysPath(), "utf8"), /never commit/);
    const [listed] = listKeys().keys;
    assert.equal(listed.masked, "sk-…3456");
    assert.equal(listed.key, undefined, "a listing never carries the key");
    assert.deepEqual(listed.harnesses, ["claude"]);

    // A rename or label change can leave the key out.
    assert.ok(saveKey({ id: "deepseek", provider: "deepseek", key: "", label: "work" }).ok);
    assert.equal(readKeys().keys[0].key, "sk-abcdef123456");
    assert.equal(readKeys().keys[0].label, "work");

    assert.match(saveKey({ provider: "nobody", key: "k" }).error, /provider must be one of/);
    assert.match(saveKey({ id: "Bad Id", provider: "deepseek", key: "k" }).error, /must match/);
    assert.match(saveKey({ id: "fresh", provider: "deepseek", key: "" }).error, /empty/);
    assert.ok(removeKey("deepseek").ok);
    assert.match(removeKey("deepseek").error, /not found/);
  }));

test("maskKey keeps a short prefix and the last four characters", () => {
  assert.equal(maskKey("AIzaSyD-0123456789wxyz"), "…wxyz");
  assert.equal(maskKey("sk-proj-0123456789"), "sk-…6789");
  assert.equal(maskKey("short"), "…");
  assert.equal(maskKey(""), "");
});

test("a DeepSeek key points Claude Code at DeepSeek's Anthropic endpoint", () =>
  withStore(() => {
    saveKey({ id: "ds", provider: "deepseek", key: "sk-secret-0001" });
    const api = resolveApi({ ...claude, api: "ds" });
    assert.equal(api.ok, true);
    assert.equal(api.env.ANTHROPIC_BASE_URL, "https://api.deepseek.com/anthropic");
    assert.equal(api.env.ANTHROPIC_AUTH_TOKEN, "sk-secret-0001");
    assert.equal(api.env.ANTHROPIC_API_KEY, "", "an inherited Anthropic key must not reach DeepSeek");
    assert.equal(api.env.ANTHROPIC_MODEL, "deepseek-v4-pro[1m]");
    assert.equal(api.env.ANTHROPIC_DEFAULT_HAIKU_MODEL, "deepseek-flash");

    const result = dryRun({ ...claude, api: "ds" }, { executablePath: "claude", cache: false });
    assert.equal(result.env.ANTHROPIC_AUTH_TOKEN, "sk-secret-0001");
    assert.deepEqual(result.args.slice(0, 2), ["--model", "deepseek-v4-pro[1m]"]);
    const check = result.checks.find((entry) => entry.label === "API key");
    assert.ok(check.ok);
    assert.match(check.detail, /DeepSeek key "ds" \(sk-…0001\)/);
    assert.ok(!JSON.stringify(result.checks).includes("sk-secret-0001"), "checks never print the key");
    assert.ok(result.checks.find((entry) => entry.label === 'model "deepseek-v4-pro"').ok, "the offline list knows the model");

    // The profile's own env still wins over the key's.
    assert.equal(dryRun({ ...claude, api: "ds", env: { ANTHROPIC_DEFAULT_HAIKU_MODEL: "deepseek-v4-pro" } }).env.ANTHROPIC_DEFAULT_HAIKU_MODEL, "deepseek-v4-pro");
  }));

test("a key that cannot drive the harness, or is missing, fails the launch check", () =>
  withStore(() => {
    saveKey({ id: "ds", provider: "deepseek", key: "sk-secret-0001" });
    saveKey({ id: "gg", provider: "google", key: "AIza-secret-0002" });
    assert.match(resolveApi({ ...claude, api: "gg" }).error, /Google AI Studio keys run on agy, not claude/);
    assert.match(resolveApi({ ...claude, api: "nope" }).error, /no stored key "nope"/);
    assert.equal(resolveApi(claude), null);
    const check = dryRun({ ...claude, api: "nope" }).checks.find((entry) => entry.label === "API key");
    assert.equal(check.ok, false);
  }));

test("a Google key runs agy on the Gemini API", () =>
  withStore(() => {
    saveKey({ id: "gg", provider: "google", key: "AIza-secret-0002" });
    // No real agy: listing its models would start it in the test's state dir.
    const result = dryRun({ ...agy, api: "gg" }, { executablePath: "no-such-agy", cache: false, env: { ...process.env, PATH: "" } });
    assert.equal(result.env.GEMINI_API_KEY, "AIza-secret-0002");
    assert.ok(result.args.includes("--settings"));
    assert.equal(catalogIdOf({ ...agy, api: "gg" }), "agy-api");
  }));

test("api is checked for shape and harness, not for whether the key exists yet", () => {
  assert.deepEqual(validateProfile({ ...claude, api: "later" }).errors, []);
  assert.match(validateProfile({ ...claude, api: "Bad Key" }).errors.join(" "), /must name a stored key/);
  assert.match(validateProfile({ ...claude, harness: "codex", api: "ds" }).errors.join(" "), /api is supported by claude, agy, not codex/);
});

test("the editor offers sign-in plus the stored keys that fit the harness", () =>
  withStore(() => {
    saveKey({ id: "ds", provider: "deepseek", key: "sk-secret-0001" });
    saveKey({ id: "gg", provider: "google", key: "AIza-secret-0002" });
    assert.ok(editableFields(claude).includes("api"));
    assert.ok(!editableFields({ ...claude, harness: "codex" }).includes("api"));

    const row = describeFields(claude).find((field) => field.field === "api");
    assert.equal(row.value, "subscription");
    assert.deepEqual(row.options.map((option) => option.id), ["subscription", "ds"]);
    assert.ok(!JSON.stringify(row).includes("secret"), "options show the masked key");

    const draft = applyFieldValue(claude, "api", "ds");
    assert.equal(draft.api, "ds");
    assert.match(describeFields(draft).find((field) => field.field === "api").note, /DeepSeek API/);
    assert.equal(applyFieldValue(draft, "api", "subscription").api, "");
    assert.equal(applyFieldValue(draft, "harness", "agy").api, "", "a DeepSeek key does not follow a switch to agy");
    assert.equal(applyFieldValue({ ...agy, api: "gg" }, "harness", "agy").api, "gg");
  }));

test("the editor's key actions store, list, and remove keys without returning them", () =>
  withStore(async (dir) => {
    const act = (action, input = {}) => runEditorAction(action, input, { projectRoot: dir });
    const saved = await act("key.save", { id: "ds", provider: "deepseek", key: "sk-secret-0001" });
    assert.equal(saved.ok, true);
    const listed = await act("keys");
    assert.deepEqual(listed.keys.map((key) => key.id), ["ds"]);
    assert.ok(listed.providers.some((provider) => provider.id === "google"));
    assert.ok(!JSON.stringify(listed).includes("sk-secret-0001"));
    assert.equal((await act("view", { draft: { ...claude, api: "ds" }, kind: "new", baseline: null })).catalog, "api-deepseek");
    assert.equal((await act("key.remove", { id: "ds" })).ok, true);
    assert.deepEqual((await act("keys")).keys, []);
  }));

test("a provider's model list is read with its key and falls back offline", () =>
  withStore(async () => {
    const calls = [];
    const fetchImpl = async (url, init) => {
      calls.push({ url, auth: init.headers.Authorization });
      return { ok: true, json: async () => ({ data: [{ id: "deepseek-v4-pro" }, { id: "deepseek-v9" }] }) };
    };
    const direct = await fetchProviderModels("deepseek", "sk-k", { fetchImpl });
    assert.deepEqual(direct.models.map((model) => model.id), ["deepseek-v4-pro", "deepseek-v9"]);
    assert.deepEqual(calls[0], { url: "https://api.deepseek.com/models", auth: "Bearer sk-k" });
    assert.match((await fetchProviderModels("deepseek", "sk-k", { fetchImpl: async () => ({ ok: false, status: 401 }) })).error, /rejected/);

    saveKey({ id: "ds", provider: "deepseek", key: "sk-k" });
    const listed = await listModelsAsync("api-deepseek", { fetchImpl, offline: false });
    assert.deepEqual(listed.models.map((model) => model.id), ["deepseek-v4-pro", "deepseek-v9"]);
    const offline = await listModelsAsync("api-deepseek", { offline: true, cache: false });
    assert.ok(offline.models.some((model) => model.id === "deepseek-flash"), "the built-in list stands in offline");
  }));

test("keys add reads the key from stdin and keys list never prints it", () =>
  withStore(() => {
    const env = { ...process.env };
    const run = (args, input) => spawnSync(process.execPath, [CLI, ...args], { env, input, encoding: "utf8" });
    const added = run(["keys", "add", "ds", "--provider", "deepseek"], "sk-from-stdin-7777\n");
    assert.equal(added.status, 0, added.stderr);
    assert.equal(readKeys().keys[0].key, "sk-from-stdin-7777");
    const listed = run(["keys", "list"]);
    assert.match(listed.stdout, /ds \| DeepSeek \| sk-…7777 \| claude/);
    assert.ok(!listed.stdout.includes("sk-from-stdin-7777"));
    assert.notEqual(run(["keys", "add", "x", "--provider", "deepseek"], "").status, 0, "an empty key is refused");
  }));
