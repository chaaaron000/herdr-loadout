import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { cleanup, tempDir } from "./helpers.mjs";
import {
  CATALOG_TTL_MS,
  fetchCatalog,
  loadCatalog,
  modelsForProvider,
  readSnapshot,
} from "../src/core/modelsdev.mjs";
import { claudeCatalogFromModelsDev, listModels } from "../src/core/detect.mjs";

/** A models.dev-shaped document with only what the client reads. */
function sampleCatalog() {
  return {
    anthropic: {
      id: "anthropic",
      models: {
        "claude-opus-5": {
          id: "claude-opus-5",
          name: "Claude Opus 5",
          reasoning: true,
          reasoning_options: [{ type: "effort", values: ["low", "medium", "high", "xhigh", "max"] }],
          limit: { context: 1000000, output: 128000 },
        },
        "claude-sonnet-4-5": {
          id: "claude-sonnet-4-5",
          name: "Claude Sonnet 4.5",
          limit: { context: 200000 },
        },
        "claude-3-old": { id: "claude-3-old", name: "Claude 3 Old" },
      },
    },
    openai: {
      id: "openai",
      models: { "gpt-6.1-sol": { id: "gpt-6.1-sol", name: "GPT 6.1 Sol" } },
    },
  };
}

function withState(dir, fn) {
  const saved = process.env.HERDR_PLUGIN_STATE_DIR;
  process.env.HERDR_PLUGIN_STATE_DIR = dir;
  try {
    return fn();
  } finally {
    if (saved === undefined) delete process.env.HERDR_PLUGIN_STATE_DIR;
    else process.env.HERDR_PLUGIN_STATE_DIR = saved;
  }
}

test("a stored snapshot is read back with its models and effort levels", async () => {
  const dir = tempDir();
  try {
    await withState(dir, async () => {
      const env = { HERDR_PLUGIN_STATE_DIR: dir };
      await fetchCatalog({ env, fetchImpl: async () => ({ ok: true, json: async () => sampleCatalog() }) });

      const snapshot = readSnapshot({ env });
      assert.ok(snapshot);
      const rows = modelsForProvider(snapshot, "anthropic");
      assert.ok(rows);
      const opus = rows.find((row) => row.id === "claude-opus-5");
      assert.deepEqual(opus.efforts, ["low", "medium", "high", "xhigh", "max"]);
      assert.equal(opus.label, "Claude Opus 5");
      assert.equal(opus.context, 1000000);
    });
  } finally {
    cleanup(dir);
  }
});

test("a stale snapshot is ignored", () => {
  const dir = tempDir();
  try {
    withState(dir, () => {
      const env = { HERDR_PLUGIN_STATE_DIR: dir };
      const file = path.join(dir, "models-dev.json");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ fetchedAt: Date.now() - CATALOG_TTL_MS - 1000, data: sampleCatalog() }));
      assert.equal(readSnapshot({ env }), null, "expired snapshot must not be served");
      assert.ok(readSnapshot({ env, maxAgeMs: Number.MAX_SAFE_INTEGER }), "but is still readable on request");
    });
  } finally {
    cleanup(dir);
  }
});

test("a corrupt snapshot is ignored rather than thrown", () => {
  const dir = tempDir();
  try {
    withState(dir, () => {
      const env = { HERDR_PLUGIN_STATE_DIR: dir };
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "models-dev.json"), "{not json");
      assert.equal(readSnapshot({ env }), null);
    });
  } finally {
    cleanup(dir);
  }
});

test("fetch failures return null instead of throwing", async () => {
  assert.equal(await fetchCatalog({ fetchImpl: async () => ({ ok: false }) }), null);
  assert.equal(await fetchCatalog({ fetchImpl: async () => { throw new Error("offline"); } }), null);
  assert.equal(await fetchCatalog({ fetchImpl: null }), null);
});

test("offline loading never fetches", async () => {
  const dir = tempDir();
  try {
    await withState(dir, async () => {
      const env = { HERDR_PLUGIN_STATE_DIR: dir };
      let called = false;
      const result = await loadCatalog({ env, offline: true, fetchImpl: async () => { called = true; } });
      assert.equal(result, null);
      assert.equal(called, false, "offline must not touch the network");
    });
  } finally {
    cleanup(dir);
  }
});

test("an unknown provider yields null rather than an empty list", () => {
  assert.equal(modelsForProvider(sampleCatalog(), "nope"), null);
  assert.equal(modelsForProvider(null, "anthropic"), null);
});

test("claude rows come from models.dev with retired ids filtered", () => {
  const rows = claudeCatalogFromModelsDev({ catalog: sampleCatalog() });
  assert.ok(rows);
  const ids = rows.map((row) => row.id);
  assert.deepEqual(ids.slice(0, 4), ["opus", "sonnet", "haiku", "fable"], "aliases lead");
  assert.ok(ids.includes("claude-opus-5"));
  assert.ok(!ids.includes("claude-3-old"), "retired generation filtered");
  const opus = rows.find((row) => row.id === "claude-opus-5");
  assert.deepEqual(opus.efforts, ["low", "medium", "high", "xhigh", "max"]);
});

test("listModels prefers models.dev and still answers without it", () => {
  const dir = tempDir();
  try {
    withState(dir, () => {
      const env = { HERDR_PLUGIN_STATE_DIR: dir };
      // no snapshot: detection still returns rows from a local source
      const result = listModels("claude", { cache: false, env, offline: true });
      assert.equal(result.ok, true);
      assert.ok(result.models.length > 0, "a fallback source must always answer");
      assert.ok(result.derived || result.static);
    });
  } finally {
    cleanup(dir);
  }
});
