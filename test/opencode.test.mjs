import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { buildLaunchArgs, dryRun } from "../src/core/detect.mjs";
import { buildLaunchEnv } from "../src/core/permissions.mjs";
import { isOpencodeV2, opencodeModel, parseVersion } from "../src/core/opencode.mjs";
import { memoryFs } from "./helpers.mjs";

test("the version is read from both v1 and v2 output, and unknown stays v1", () => {
  assert.equal(parseVersion("opencode v2.3.0\n"), "2.3.0");
  assert.equal(parseVersion("1.14.2"), "1.14.2");
  assert.equal(parseVersion("garbage"), null);
  assert.equal(isOpencodeV2("2.3.0"), true);
  assert.equal(isOpencodeV2("1.14.2"), false);
  assert.equal(isOpencodeV2(null), false);
});

test("v2 carries the effort as the model's variant", () => {
  assert.equal(opencodeModel({ model: "p/m", effort: "high" }), "p/m#high");
  assert.equal(opencodeModel({ model: "p/m" }), "p/m");
  assert.equal(opencodeModel({ model: "p/m#max", effort: "high" }), "p/m#max");
  assert.equal(opencodeModel({ effort: "high" }), null);
});

test("v2 puts model and permission in inline config and keeps the other keys", () => {
  const profile = { harness: "opencode", model: "p/m", effort: "low", permission_mode: "ask", env: { OPENCODE_CONFIG_CONTENT: '{"theme":"x"}' } };
  const env = buildLaunchEnv(profile, {}, { version: "2.3.0" });
  assert.deepEqual(JSON.parse(env.OPENCODE_CONFIG_CONTENT), { theme: "x", model: "p/m#low", permission: "ask" });
  // v1 keeps -m on the command line, so its config gains only the permission
  assert.deepEqual(JSON.parse(buildLaunchEnv(profile, {}).OPENCODE_CONFIG_CONTENT), { theme: "x", permission: "ask" });
  assert.throws(() => buildLaunchEnv({ harness: "opencode", model: "p/m", env: { OPENCODE_CONFIG_CONTENT: "bad" } }, {}, { version: "2.0.0" }), /model/);
});

test("v2 adds --standalone only when config must reach the server", () => {
  const v2 = { version: "2.3.0" };
  assert.deepEqual(buildLaunchArgs({ harness: "opencode" }, v2), []);
  assert.deepEqual(buildLaunchArgs({ harness: "opencode", permission_mode: "auto" }, v2), ["--auto"]);
  assert.deepEqual(buildLaunchArgs({ harness: "opencode", permission_mode: "deny" }, v2), ["--standalone"]);
  assert.deepEqual(buildLaunchArgs({ harness: "opencode", model: "p/m", extra_args: ["--standalone"] }, v2), ["--standalone"]);
  assert.deepEqual(buildLaunchArgs({ harness: "opencode", model: "p/m", extra_args: ["--server", "http://x"] }, v2), ["--server", "http://x"]);
});

test("dry-run uses the installed version for args, env, and the effort check", () => {
  const executable = path.win32.resolve("C:/test-bin/opencode.cmd");
  const options = {
    fs: memoryFs({ [executable]: "" }),
    env: { PATH: path.win32.dirname(executable), PATHEXT: ".CMD" },
    platform: "win32",
    cache: false,
    offline: true,
    harnessVersions: { opencode: "2.3.0" },
  };
  const result = dryRun({ harness: "opencode", model: "p/m", effort: "high" }, options);
  assert.equal(result.executable, executable);
  assert.deepEqual(result.args, ["--standalone"]);
  assert.equal(JSON.parse(result.env.OPENCODE_CONFIG_CONTENT).model, "p/m#high");
  assert.match(result.checks.find((check) => check.label === "opencode executable").detail, /v2\.3\.0/);
  assert.doesNotMatch(result.checks.find((check) => check.label.startsWith("effort")).detail, /ignored/);
});
