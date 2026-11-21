import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { cleanup, fakeCli, tempDir } from "./helpers.mjs";
import { CACHE_TTL_MS, listModelsAsync } from "../src/core/detect.mjs";
import { CATALOG_TTL_MS } from "../src/core/modelsdev.mjs";

function sampleCatalog() {
  return {
    anthropic: {
      id: "anthropic",
      models: {
        "claude-opus-5": {
          id: "claude-opus-5",
          name: "Claude Opus 5",
          reasoning_options: [{ type: "effort", values: ["low", "high"] }],
        },
      },
    },
  };
}

/** A state dir holding a models.dev snapshot of the given age. */
function withSnapshot(ageMs, fn) {
  const dir = tempDir();
  const env = { HERDR_PLUGIN_STATE_DIR: dir, PATH: "" };
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "models-dev.json"), JSON.stringify({ fetchedAt: Date.now() - ageMs, data: sampleCatalog() }));
  return fn({ dir, env }).finally(() => cleanup(dir));
}

test("an expired snapshot still answers for claude, and the rows are cached", async () => {
  await withSnapshot(CATALOG_TTL_MS + 1000, async ({ dir, env }) => {
    const first = await listModelsAsync("claude", { env, offline: true });
    assert.equal(first.derived, "models.dev");
    assert.ok(first.models.some((model) => model.id === "claude-opus-5"));

    // The second lookup must not need the multi-megabyte snapshot at all.
    fs.rmSync(path.join(dir, "models-dev.json"));
    const second = await listModelsAsync("claude", { env, offline: true });
    assert.equal(second.cached, true);
    assert.equal(second.revalidate, true, "rows from an expired snapshot ask to be read again");
    assert.deepEqual(second.models.map((model) => model.id), first.models.map((model) => model.id));
  });
});

test("rows from a fresh snapshot do not ask to be read again", async () => {
  await withSnapshot(0, async ({ env }) => {
    const first = await listModelsAsync("claude", { env, offline: true });
    assert.equal(first.revalidate, undefined);
    const second = await listModelsAsync("claude", { env, offline: true });
    assert.equal(second.cached, true);
    assert.equal(second.revalidate, undefined);
  });
});

test("a refresh waits for a new snapshot and lists the models it adds", async () => {
  const newer = sampleCatalog();
  newer.anthropic.models["claude-fable-9"] = { id: "claude-fable-9", name: "Claude Fable 9" };
  const fetchImpl = async () => ({ ok: true, json: async () => newer });
  await withSnapshot(CATALOG_TTL_MS + 1000, async ({ env }) => {
    const cached = await listModelsAsync("claude", { env, offline: true });
    assert.ok(!cached.models.some((model) => model.id === "claude-fable-9"));
    assert.equal(cached.revalidate, true);

    const fresh = await listModelsAsync("claude", { env, refresh: true, offline: false, fetchImpl });
    assert.ok(fresh.models.some((model) => model.id === "claude-fable-9"));
    assert.equal(fresh.revalidate, undefined);

    const next = await listModelsAsync("claude", { env, offline: true });
    assert.equal(next.cached, true);
    assert.equal(next.revalidate, undefined);
    assert.ok(next.models.some((model) => model.id === "claude-fable-9"));
  });
});

test("an expired snapshot is refreshed in the background, a fresh one is not", async () => {
  const fetched = async (ageMs) => {
    let calls = 0;
    await withSnapshot(ageMs, ({ env }) =>
      listModelsAsync("claude", { env, cache: false, fetchImpl: async () => { calls += 1; return { ok: false }; } }),
    );
    return calls;
  };
  assert.equal(await fetched(CATALOG_TTL_MS + 1000), 1);
  assert.equal(await fetched(0), 0);
});

test("offline suppresses the background refresh", async () => {
  let calls = 0;
  const fetchImpl = async () => { calls += 1; return { ok: false }; };
  await withSnapshot(CATALOG_TTL_MS + 1000, async ({ env }) => {
    await listModelsAsync("claude", { env, cache: false, offline: true, fetchImpl });
    await listModelsAsync("claude", { env: { ...env, HERDR_LOADOUT_OFFLINE: "1" }, cache: false, fetchImpl });
  });
  assert.equal(calls, 0);
});

test("claude falls back to the aliases when no source is available", async () => {
  const dir = tempDir();
  try {
    const result = await listModelsAsync("claude", { env: { HERDR_PLUGIN_STATE_DIR: dir, PATH: "" }, offline: true });
    assert.equal(result.static, true);
    assert.ok(result.models.length > 0);
  } finally {
    cleanup(dir);
  }
});

test("a cached catalog is served without spawning, an expired one is not", async () => {
  const dir = tempDir();
  try {
    const env = { HERDR_PLUGIN_STATE_DIR: dir, PATH: "" };
    const cacheFile = path.join(dir, "models", "omp.json");
    const missing = path.join("Z:", "missing", "omp.exe");
    fs.mkdirSync(path.dirname(cacheFile), { recursive: true });

    fs.writeFileSync(cacheFile, JSON.stringify({ fetchedAt: Date.now(), models: [{ id: "cached/model" }] }));
    const hit = await listModelsAsync("omp", { env, executablePath: missing });
    assert.equal(hit.cached, true);
    assert.deepEqual(hit.models.map((model) => model.id), ["cached/model"]);

    fs.writeFileSync(cacheFile, JSON.stringify({ fetchedAt: Date.now() - CACHE_TTL_MS - 1000, models: [{ id: "stale" }] }));
    const miss = await listModelsAsync("omp", { env, executablePath: missing, timeoutMs: 2000 });
    assert.equal(miss.ok, false, "a spawn failure resolves instead of rejecting");
    assert.ok(miss.error.length > 0);
  } finally {
    cleanup(dir);
  }
});

test("refresh re-reads a cached catalog and replaces it", async () => {
  const dir = tempDir();
  try {
    // The cache was written while a provider was logged out; the CLI has it back.
    const env = { HERDR_PLUGIN_STATE_DIR: dir, PATH: "", ComSpec: process.env.ComSpec };
    const cacheFile = path.join(dir, "models", "omp.json");
    const executablePath = fakeCli(path.join(dir, "bin"), "omp", '{"models":[{"selector":"ollama/x"},{"selector":"anthropic/claude-opus-5"}]}');
    fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
    fs.writeFileSync(cacheFile, JSON.stringify({ fetchedAt: Date.now(), models: [{ id: "ollama/x" }] }));

    const hit = await listModelsAsync("omp", { env, executablePath });
    assert.equal(hit.revalidate, true, "a cached CLI list asks to be re-read");
    assert.deepEqual(hit.models.map((model) => model.id), ["ollama/x"]);

    const fresh = await listModelsAsync("omp", { env, executablePath, refresh: true });
    assert.equal(fresh.ok, true);
    assert.equal(fresh.cached, undefined);
    assert.deepEqual(fresh.models.map((model) => model.id), ["ollama/x", "anthropic/claude-opus-5"]);

    const next = await listModelsAsync("omp", { env, executablePath });
    assert.equal(next.cached, true);
    assert.equal(next.models.length, 2, "the refreshed list is what the cache now holds");
  } finally {
    cleanup(dir);
  }
});

test("a failed refresh leaves the cache alone", async () => {
  const dir = tempDir();
  try {
    const env = { HERDR_PLUGIN_STATE_DIR: dir, PATH: "" };
    const cacheFile = path.join(dir, "models", "omp.json");
    const missing = path.join("Z:", "missing", "omp.exe");
    fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
    fs.writeFileSync(cacheFile, JSON.stringify({ fetchedAt: Date.now(), models: [{ id: "cached/model" }] }));

    const failed = await listModelsAsync("omp", { env, executablePath: missing, refresh: true, timeoutMs: 2000 });
    assert.equal(failed.ok, false);
    const hit = await listModelsAsync("omp", { env, executablePath: missing });
    assert.deepEqual(hit.models.map((model) => model.id), ["cached/model"]);
  } finally {
    cleanup(dir);
  }
});

test("an aborted lookup resolves as a failure", async () => {
  const dir = tempDir();
  try {
    const controller = new AbortController();
    controller.abort();
    const result = await listModelsAsync("codex", {
      env: { HERDR_PLUGIN_STATE_DIR: dir, PATH: "" },
      executablePath: process.execPath,
      signal: controller.signal,
    });
    assert.equal(result.ok, false);
  } finally {
    cleanup(dir);
  }
});

test("a harness with no catalog reports that instead of failing", async () => {
  const result = await listModelsAsync("pi", { cache: false });
  assert.equal(result.noCatalog, true);
  assert.deepEqual(result.models, []);
});
