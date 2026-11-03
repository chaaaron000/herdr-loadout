import assert from "node:assert/strict";
import test from "node:test";
import { App } from "../src/tui/app.mjs";
import { deriveId } from "../src/core/editor.mjs";

test("deriveId slugs human names into valid profile ids", () => {
  assert.equal(deriveId("Unity Builder"), "unity-builder");
  assert.equal(deriveId("  Heavy  "), "heavy");
  assert.equal(deriveId("Reviewer (Unity/FishNet)"), "reviewer-unity-fishnet");
  assert.equal(deriveId("a.b_c-d"), "a.b_c-d");
});

test("deriveId yields an empty string for unusable names", () => {
  assert.equal(deriveId(""), "");
  assert.equal(deriveId("   "), "");
  assert.equal(deriveId("///"), "");
  assert.equal(deriveId(undefined), "");
});

test("deriveId output satisfies the profile id pattern", () => {
  const pattern = /^[a-z0-9][a-z0-9._-]*$/;
  for (const name of ["Unity Builder", "Unity 2023 LTS Builder", "review-bot", "X"]) {
    assert.match(deriveId(name), pattern, `failed for ${name}`);
  }
});

test("App is exported as a component function", () => {
  assert.equal(typeof App, "function");
});
