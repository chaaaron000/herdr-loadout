import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { cleanup, memoryFs, tempDir } from "./helpers.mjs";
import { looksLikeToml, mergeProfileInput, normalizePayload, parseEnvPair, profileFromFlags, readProfilePayload } from "../src/core/input.mjs";

test("flags map to profile fields", () => {
  const { ok, profile } = profileFromFlags({
    id: "builder",
    name: "Builder",
    harness: "claude",
    model: "m",
    effort: "medium",
    cost: "normal",
    when: "Implement things.",
    avoid: "Review.",
  });
  assert.equal(ok, true);
  assert.deepEqual(profile, {
    id: "builder",
    name: "Builder",
    harness: "claude",
    model: "m",
    effort: "medium",
    cost: "normal",
    when_to_use: "Implement things.",
    avoid_when: "Review.",
  });
});

test("repeatable flags collect into arrays", () => {
  const { profile } = profileFromFlags({ tag: ["a", "b"], skill: "x", "extra-arg": ["--verbose"] });
  assert.deepEqual(profile.tags, ["a", "b"]);
  assert.deepEqual(profile.skills, ["x"]);
  assert.deepEqual(profile.extra_args, ["--verbose"]);
});

test("env flags parse KEY=VALUE and reject malformed pairs", () => {
  const good = profileFromFlags({ env: ["A=1", "B=2=3"] });
  assert.equal(good.ok, true);
  assert.deepEqual(good.profile.env, { A: "1", B: "2=3" });

  const bad = profileFromFlags({ env: ["NOEQUALS"] });
  assert.equal(bad.ok, false);
  assert.match(bad.errors[0], /KEY=VALUE/);

  assert.deepEqual(parseEnvPair("EMPTY="), { ok: true, key: "EMPTY", value: "" });
  assert.equal(parseEnvPair("=x").ok, false);
});

test("flags override payload fields", () => {
  const { profile, unknown } = mergeProfileInput(
    { id: "x", name: "From payload", effort: "low" },
    { effort: "high" },
  );
  assert.equal(profile.name, "From payload");
  assert.equal(profile.effort, "high");
  assert.deepEqual(unknown, []);
});

test("unknown payload fields are reported instead of silently dropped", () => {
  const { unknown } = mergeProfileInput({ id: "x", not_a_field: "y" }, {});
  assert.deepEqual(unknown, ["not_a_field"]);
});

test("normalizePayload unwraps a single [[profiles]] entry", () => {
  const result = normalizePayload({ version: 1, profiles: [{ id: "a" }] });
  assert.equal(result.ok, true);
  assert.deepEqual(result.profile, { id: "a" });
});

test("normalizePayload rejects multi-profile input with guidance", () => {
  const result = normalizePayload({ profiles: [{ id: "a" }, { id: "b" }] });
  assert.equal(result.ok, false);
  assert.match(result.errors[0], /import/);
});

test("normalizePayload rejects empty and non-object input", () => {
  assert.equal(normalizePayload({ profiles: [] }).ok, false);
  assert.equal(normalizePayload("nope").ok, false);
  assert.equal(normalizePayload(null).ok, false);
});

test("looksLikeToml distinguishes TOML from JSON", () => {
  assert.equal(looksLikeToml('[[profiles]]\nid = "x"\n'), true);
  assert.equal(looksLikeToml('name = "x"\n'), true);
  assert.equal(looksLikeToml('{"id":"x"}'), false);
  assert.equal(looksLikeToml('[{"id":"x"}]'), false);
  assert.equal(looksLikeToml('["x"]'), false);
});

test("readProfilePayload parses a TOML file", () => {
  const dir = tempDir();
  try {
    const file = path.join(dir, "p.toml");
    fs.writeFileSync(file, 'id = "from-file"\nname = "File"\n');
    const result = readProfilePayload({ file });
    assert.equal(result.ok, true);
    assert.equal(result.profile.id, "from-file");
    assert.equal(result.profile.name, "File");
  } finally {
    cleanup(dir);
  }
});

test("readProfilePayload parses a JSON file with a [[profiles]] wrapper", () => {
  const dir = tempDir();
  try {
    const file = path.join(dir, "p.json");
    fs.writeFileSync(file, JSON.stringify({ profiles: [{ id: "json-one", name: "One" }] }));
    const result = readProfilePayload({ file });
    assert.equal(result.ok, true);
    assert.equal(result.profile.id, "json-one");
  } finally {
    cleanup(dir);
  }
});

test("readProfilePayload reports a missing file rather than throwing", () => {
  const result = readProfilePayload({ file: path.join("Z:", "nope.json") });
  assert.equal(result.ok, false);
  assert.match(result.errors[0], /not found/);
});

test("readProfilePayload reports parse errors with the source name", () => {
  const dir = tempDir();
  try {
    const file = path.join(dir, "broken.json");
    fs.writeFileSync(file, "{not json");
    const result = readProfilePayload({ file });
    assert.equal(result.ok, false);
    assert.match(result.errors[0], /broken\.json/);
    assert.match(result.errors[0], /JSON parse failed/);
  } finally {
    cleanup(dir);
  }
});

test("readProfilePayload rejects empty input", () => {
  const dir = tempDir();
  try {
    const file = path.join(dir, "empty.json");
    fs.writeFileSync(file, "   \n");
    const result = readProfilePayload({ file });
    assert.equal(result.ok, false);
    assert.match(result.errors[0], /empty/);
  } finally {
    cleanup(dir);
  }
});

test("readProfilePayload with neither file nor stdin yields an empty profile", () => {
  const result = readProfilePayload({});
  assert.equal(result.ok, true);
  assert.deepEqual(result.profile, {});
});
