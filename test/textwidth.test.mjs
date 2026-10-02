import test from "node:test";
import assert from "node:assert/strict";
import { clipToWidth, displayWidth, padToWidth } from "../src/core/textwidth.mjs";

test("displayWidth counts CJK and emoji as two columns", () => {
  assert.equal(displayWidth("abc"), 3);
  assert.equal(displayWidth("한글"), 4);
  assert.equal(displayWidth("日本語x"), 7);
  assert.equal(displayWidth(""), 0);
  assert.equal(displayWidth(undefined), 0);
});

test("clipToWidth never exceeds the column budget", () => {
  assert.equal(clipToWidth("hello", 10), "hello");
  assert.equal(clipToWidth("hello world", 6), "hello…");
  const clipped = clipToWidth("코드 변경의 독립 리뷰", 9);
  assert.ok(displayWidth(clipped) <= 9, clipped);
  assert.ok(clipped.endsWith("…"));
});

test("clipToWidth does not split a wide character across the limit", () => {
  // 5 columns: two wide chars (4) plus an ellipsis would be 5, a third would be 7.
  assert.equal(clipToWidth("한글한글", 5), "한글…");
});

test("padToWidth pads by columns, not characters", () => {
  assert.equal(displayWidth(padToWidth("한", 6)), 6);
  assert.equal(padToWidth("ab", 4), "ab  ");
  assert.equal(padToWidth("toolong", 3), "toolong");
});
