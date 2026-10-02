import assert from "node:assert/strict";
import test from "node:test";
import { firstSentence, purposeOf, renderCompact, renderList, renderShow } from "../src/core/format.mjs";

const builder = {
  id: "builder",
  name: "Builder",
  harness: "claude",
  model: "deepseek-v4.1",
  effort: "medium",
  cost: "normal",
  when_to_use: "General implementation, refactoring, and bug fixes.",
  avoid_when: "Pure research.",
  tags: ["implementation", "refactor"],
};

const reviewer = {
  id: "reviewer",
  name: "Reviewer",
  harness: "codex",
  model: "gpt-6.1-sol",
  effort: "medium",
  cost: "cheap",
  when_to_use: "Independent review after substantial implementation.",
};

test("compact output is one pipe-delimited line per profile", () => {
  const out = renderCompact([builder, reviewer]);
  const lines = out.split("\n");
  assert.equal(lines.length, 2);
  assert.equal(lines[0], "builder | normal | implementation/refactor");
  assert.match(lines[1], /^reviewer \| cheap \| Independent review after substantial/);
  assert.ok(lines[1].endsWith("…"), "long purpose is truncated");
  assert.equal(lines[1].split(" | ")[2].length, 40);
  assert.ok(!out.includes("\u001b["), "no ANSI escapes");
});

test("compact falls back to the first sentence when tags are missing", () => {
  const out = renderCompact([reviewer]);
  assert.equal(out.split(" | ").length, 3);
  assert.ok(out.split(" | ")[2].startsWith("Independent review"));
});

test("firstSentence collapses whitespace and truncates", () => {
  assert.equal(firstSentence("one   two\n three."), "one two three.");
  assert.equal(firstSentence(""), "");
  assert.equal(firstSentence(undefined), "");
  const long = firstSentence("a".repeat(80), 20);
  assert.equal(long.length, 20);
  assert.ok(long.endsWith("…"));
});

test("compact truncation is bounded at 40 characters", () => {
  const profile = { ...reviewer, when_to_use: "x".repeat(200), tags: undefined };
  const [, , purpose] = renderCompact([profile]).split(" | ");
  assert.equal(purpose.length, 40);
});

test("purposeOf prefers tags", () => {
  assert.equal(purposeOf(builder), "implementation/refactor");
  assert.equal(purposeOf({ tags: [], when_to_use: "Fallback text." }), "Fallback text.");
});

test("compact never emits an empty third field", () => {
  const bare = { id: "bare", cost: "cheap", tags: [], when_to_use: "" };
  const line = renderCompact([bare]);
  assert.equal(line, "bare | cheap | (no description)");
  assert.equal(line.split(" | ").length, 3);
  for (const profile of [{ ...bare, tags: undefined, when_to_use: undefined }, { id: "x" }]) {
    const parts = renderCompact([profile]).split(" | ");
    assert.equal(parts.length, 3, `malformed line for ${profile.id}`);
    assert.ok(parts[2].length > 0, "third field must be non-empty");
  }
});

test("list output reports cost and use for each profile", () => {
  const out = renderList([builder, reviewer]);
  assert.match(out, /Builder/);
  assert.match(out, /claude \/ deepseek-v4\.1 \/ medium/);
  assert.match(out, /Cost: normal/);
  assert.match(out, /Cost: cheap/);
  assert.ok(out.includes("\n\n"), "profiles are separated by a blank line");
});

test("list marks project overrides and project-only profiles", () => {
  const out = renderList([
    { ...builder, origin: "project-override", overrides: ["effort"] },
    { ...reviewer, origin: "project-only" },
  ]);
  assert.match(out, /Overridden: effort/);
  assert.match(out, /Source: project-only profile/);
});

test("list shows detection state when available", () => {
  const detection = [
    { id: "claude", detected: true },
    { id: "codex", detected: false },
  ];
  const out = renderList([builder, reviewer], { detection });
  assert.match(out, /claude \(detected\)/);
  assert.match(out, /codex \(not found\)/);
});

test("show prints labelled fields, usage text, and optionals", () => {
  const out = renderShow({
    ...builder,
    provider: "anthropic",
    mode: "plan",
    notes: "personal note",
    extra_args: ["--add-dir", "Assets"],
    env: { FOO: "bar" },
  });
  assert.match(out, /^ID: builder$/m);
  assert.match(out, /^Harness: claude$/m);
  assert.match(out, /^Provider: anthropic$/m);
  assert.match(out, /^Model: deepseek-v4\.1$/m);
  assert.match(out, /^Effort: medium$/m);
  assert.match(out, /^Cost: normal$/m);
  assert.match(out, /^Mode: plan$/m);
  assert.match(out, /When to use:\nGeneral implementation, refactoring, and bug fixes\./);
  assert.match(out, /Avoid when:\nPure research\./);
  assert.match(out, /Tags: implementation, refactor/);
  assert.match(out, /Extra args: --add-dir Assets/);
  assert.match(out, /Env: FOO=bar/);
  assert.match(out, /Notes:\npersonal note/);
});

test("show marks unspecified usage text rather than printing blanks", () => {
  const out = renderShow({ id: "x", name: "X", harness: "claude", model: "m", effort: "low" });
  assert.match(out, /When to use:\n\(unspecified\)/);
  assert.match(out, /Avoid when:\n\(unspecified\)/);
  assert.match(out, /^Cost: normal$/m, "cost defaults to normal");
});
