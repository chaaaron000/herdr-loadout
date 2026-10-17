import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { cleanup, fakeCli, tempDir } from "./helpers.mjs";
import { CACHE_TTL_MS, dryRun, listModels } from "../src/core/detect.mjs";

function withStateDir(dir, fn) {
  const saved = process.env.HERDR_PLUGIN_STATE_DIR;
  process.env.HERDR_PLUGIN_STATE_DIR = dir;
  try {
    return fn();
  } finally {
    if (saved === undefined) delete process.env.HERDR_PLUGIN_STATE_DIR;
    else process.env.HERDR_PLUGIN_STATE_DIR = saved;
  }
}

test("a cached catalog is served without spawning the CLI again", () => {
  const dir = tempDir();
  try {
    withStateDir(dir, () => {
      const cacheFile = path.join(dir, "models", "omp.json");
      fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
      fs.writeFileSync(
        cacheFile,
        JSON.stringify({ fetchedAt: Date.now(), models: [{ id: "cached/model", label: "Cached" }] }),
      );

      const result = listModels("omp", { executablePath: path.join("Z:", "missing", "omp.exe") });
      assert.equal(result.ok, true);
      assert.equal(result.cached, true);
      assert.deepEqual(result.models.map((model) => model.id), ["cached/model"]);
    });
  } finally {
    cleanup(dir);
  }
});

test("an expired cache is ignored", () => {
  const dir = tempDir();
  try {
    withStateDir(dir, () => {
      const cacheFile = path.join(dir, "models", "omp.json");
      fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
      fs.writeFileSync(
        cacheFile,
        JSON.stringify({ fetchedAt: Date.now() - CACHE_TTL_MS - 1000, models: [{ id: "stale" }] }),
      );
      const result = listModels("omp", {
        executablePath: path.join("Z:", "missing", "omp.exe"),
        timeoutMs: 2000,
      });
      assert.equal(result.cached, undefined);
      assert.equal(result.ok, false, "stale cache must not satisfy the request");
    });
  } finally {
    cleanup(dir);
  }
});

test("refresh replaces a cache that is still inside its TTL", () => {
  const dir = tempDir();
  try {
    withStateDir(dir, () => {
      const cacheFile = path.join(dir, "models", "omp.json");
      const executablePath = fakeCli(path.join(dir, "bin"), "omp", '{"models":[{"selector":"anthropic/claude-opus-5"}]}');
      fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
      fs.writeFileSync(cacheFile, JSON.stringify({ fetchedAt: Date.now(), models: [{ id: "cached/model" }] }));

      const fresh = listModels("omp", { executablePath, refresh: true });
      assert.deepEqual(fresh.models.map((model) => model.id), ["anthropic/claude-opus-5"]);
      const next = listModels("omp", { executablePath: path.join("Z:", "missing", "omp.exe") });
      assert.equal(next.cached, true);
      assert.deepEqual(next.models.map((model) => model.id), ["anthropic/claude-opus-5"]);
    });
  } finally {
    cleanup(dir);
  }
});

test("a corrupt cache file is ignored rather than thrown", () => {
  const dir = tempDir();
  try {
    withStateDir(dir, () => {
      const cacheFile = path.join(dir, "models", "codex.json");
      fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
      fs.writeFileSync(cacheFile, "{not json");
      const result = listModels("codex", { executablePath: path.join("Z:", "missing", "codex.exe") });
      assert.equal(result.ok, false);
      assert.ok(result.error.length > 0);
    });
  } finally {
    cleanup(dir);
  }
});

test("dryRun fails when the harness executable is missing", () => {
  const dir = tempDir();
  try {
    withStateDir(dir, () => {
      const result = dryRun(
        { id: "x", harness: "pi", model: "any", effort: "low" },
        { env: { PATH: "" }, cache: false },
      );
      assert.equal(result.ok, false);
      const exec = result.checks.find((check) => check.label.includes("executable"));
      assert.equal(exec.ok, false);
    });
  } finally {
    cleanup(dir);
  }
});

test("dryRun tolerates a harness without a model catalog", () => {
  const dir = tempDir();
  try {
    withStateDir(dir, () => {
      const result = dryRun(
        { id: "x", harness: "claude", model: "some-model", effort: "high" },
        { cache: false },
      );
      const model = result.checks.find((check) => check.label.startsWith("model"));
      assert.equal(model.ok, true, "free-form model must be accepted when no catalog exists");
      assert.match(model.detail, /no catalog/);
    });
  } finally {
    cleanup(dir);
  }
});

test("dryRun surfaces the composed launch command", () => {
  const dir = tempDir();
  try {
    withStateDir(dir, () => {
      const result = dryRun({ id: "x", harness: "custom", model: "node", effort: "low" });
      const command = result.checks.find((check) => check.label === "launch command");
      assert.ok(command);
      assert.match(command.detail, /--model node/);
    });
  } finally {
    cleanup(dir);
  }
});
