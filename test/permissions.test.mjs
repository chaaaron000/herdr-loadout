import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { PERMISSION_FIELDS, PERMISSION_OPTIONS, buildLaunchEnv, permissionValue } from "../src/core/permissions.mjs";
import { validateProfile } from "../src/core/schema.mjs";
import { buildLaunchArgs, dryRun } from "../src/core/detect.mjs";
import { profileFromFlags, mergeProfileInput } from "../src/core/input.mjs";
import { renderShow } from "../src/core/format.mjs";
import { mergeProfiles, overrideDelta } from "../src/core/merge.mjs";
import { upsertProfile, readConfigFile } from "../src/core/store.mjs";
import { editableFields, applyFieldValue, fieldOptions } from "../src/tui/app.mjs";
import { cleanup, memoryFs, tempDir } from "./helpers.mjs";

const base = { id: "builder", name: "Builder", harness: "codex", model: "test-model", effort: "high", when_to_use: "Implement changes." };

for (const [harness, fields] of Object.entries(PERMISSION_OPTIONS)) {
  test(`${harness} accepts its supported permission values and rejects typos`, () => {
    for (const [field, values] of Object.entries(fields)) {
      for (const value of values) {
        assert.deepEqual(validateProfile({ ...base, harness, [field]: value }).errors, []);
      }
      assert.match(validateProfile({ ...base, harness, [field]: "typo" }).errors.join(" "), new RegExp(field));
    }
  });
}

test("permission validation handles partial overrides, inheritance, types, and unsupported harnesses", () => {
  assert.deepEqual(validateProfile({ id: "builder", permission_mode: "plan" }, { requireAll: false }).errors, []);
  assert.deepEqual(validateProfile({ ...base, harness: "pi", sandbox: "", permission_mode: "" }).errors, []);
  assert.match(validateProfile({ ...base, harness: "pi", sandbox: "read-only" }).errors.join(" "), /not supported/);
  assert.match(validateProfile({ ...base, permission_mode: "plan" }).errors.join(" "), /not supported/);
  assert.match(validateProfile({ ...base, sandbox: 1 }).errors.join(" "), /must be a string/);
});

test("permission flags map into known fields without losing empty overrides", () => {
  const { profile } = profileFromFlags({ sandbox: "read-only", "approval-policy": "never", "permission-mode": "" });
  assert.deepEqual(profile, { sandbox: "read-only", approval_policy: "never", permission_mode: "" });
  assert.deepEqual(mergeProfileInput({}, profile).unknown, []);
});

test("Codex emits sandbox and approval flags, followed by extra args", () => {
  assert.deepEqual(buildLaunchArgs({ ...base, sandbox: "workspace-write", approval_policy: "on-request", extra_args: ["--search"] }),
    ["-m", "test-model", "-c", "model_reasoning_effort=high", "--sandbox", "workspace-write", "--ask-for-approval", "on-request", "--search"]);
});

test("Claude and OMP emit native permission flags while OpenCode uses env", () => {
  assert.deepEqual(buildLaunchArgs({ harness: "claude", permission_mode: "plan" }), ["--permission-mode", "plan"]);
  assert.deepEqual(buildLaunchArgs({ harness: "omp", permission_mode: "write" }), ["--approval-mode=write"]);
  assert.deepEqual(buildLaunchArgs({ harness: "opencode", permission_mode: "ask" }), []);
});

test("new permission fields replace legacy mode, including explicit inheritance", () => {
  assert.deepEqual(buildLaunchArgs({ harness: "claude", mode: "plan" }), ["--permission-mode", "plan"]);
  assert.deepEqual(buildLaunchArgs({ harness: "claude", mode: "plan", permission_mode: "acceptEdits" }), ["--permission-mode", "acceptEdits"]);
  assert.deepEqual(buildLaunchArgs({ harness: "claude", mode: "plan", permission_mode: "" }), []);
  assert.deepEqual(buildLaunchArgs({ harness: "codex", mode: "never" }), ["-a", "never"]);
  assert.deepEqual(buildLaunchArgs({ harness: "codex", mode: "never", approval_policy: "on-request" }), ["--ask-for-approval", "on-request"]);
  assert.deepEqual(buildLaunchArgs({ harness: "codex", mode: "never", approval_policy: "" }), []);
  assert.equal(permissionValue({ harness: "claude", mode: "plan" }, "permission_mode"), "plan");
  assert.equal(permissionValue({ harness: "claude", mode: "plan", permission_mode: "" }, "permission_mode"), "");
});

test("OpenCode runtime permissions preserve unrelated inline JSON and environment values", () => {
  const profile = { harness: "opencode", permission_mode: "ask", env: { KEEP: "a b", OPENCODE_CONFIG_CONTENT: '{"theme":"test","permission":{"bash":"allow"}}' } };
  const snapshot = JSON.stringify(profile);
  const env = buildLaunchEnv(profile, {});
  assert.equal(env.KEEP, "a b");
  assert.deepEqual(JSON.parse(env.OPENCODE_CONFIG_CONTENT), { theme: "test", permission: "ask" });
  assert.equal(JSON.stringify(profile), snapshot);
  assert.deepEqual(JSON.parse(buildLaunchEnv({ harness: "opencode", permission_mode: "deny" }, { OPENCODE_CONFIG_CONTENT: '{"model":"test"}' }).OPENCODE_CONFIG_CONTENT), { model: "test", permission: "deny" });
  assert.equal(buildLaunchEnv({ harness: "opencode", permission_mode: "ask", env: { OPENCODE_CONFIG_CONTENT: "" } }, { OPENCODE_CONFIG_CONTENT: "bad json" }).OPENCODE_CONFIG_CONTENT, '{"permission":"ask"}');
});

test("inherited permissions preserve user env and bad OpenCode JSON fails explicitly", () => {
  assert.deepEqual(buildLaunchEnv({ harness: "opencode", permission_mode: "", env: { OPENCODE_CONFIG_CONTENT: "custom" } }, {}), { OPENCODE_CONFIG_CONTENT: "custom" });
  for (const value of ["bad json", "null", "[]", "true"]) {
    assert.throws(() => buildLaunchEnv({ harness: "opencode", permission_mode: "allow", env: { OPENCODE_CONFIG_CONTENT: value } }, {}), /JSON/);
  }
  assert.deepEqual(buildLaunchEnv(base, {}), {});
});

test("dry-run exposes effective permissions and env, and rejects invalid merged policies", () => {
  const executable = path.resolve("test-bin/opencode.cmd");
  const options = { fs: memoryFs({ [executable]: "" }), env: { PATH: path.dirname(executable), PATHEXT: ".CMD" }, platform: "win32", cache: false, offline: true };
  const result = dryRun({ harness: "opencode", permission_mode: "deny" }, options);
  assert.equal(result.ok, true);
  assert.deepEqual(JSON.parse(result.env.OPENCODE_CONFIG_CONTENT), { permission: "deny" });
  assert.equal(result.checks.find((check) => check.label === "permissions").detail, "deny");
  for (const profile of [{ harness: "opencode", sandbox: "read-only" }, { harness: "opencode", permission_mode: "ask", env: { OPENCODE_CONFIG_CONTENT: "bad" } }]) {
    const invalid = dryRun(profile, options);
    assert.equal(invalid.ok, false);
    assert.equal(invalid.checks.find((check) => check.label === "permissions").ok, false);
  }
});

test("TUI permission pickers offer only current harness values plus inherit", () => {
  for (const harness of ["codex", "claude", "omp", "opencode", "pi", "custom"]) {
    for (const field of PERMISSION_FIELDS) {
      const fields = editableFields({ harness });
      const values = PERMISSION_OPTIONS[harness]?.[field];
      assert.equal(fields.includes(field), Boolean(values), "only supported permission fields should be visible");
      if (values) {
        const rows = fieldOptions({ harness }, fields.indexOf(field));
        assert.deepEqual(rows.map((row) => row.id), ["inherit", ...values]);
      }
    }
  }
});

test("TUI harness changes clear permissions without mutating the original draft", () => {
  const draft = { ...base, sandbox: "workspace-write", approval_policy: "never", mode: "never" };
  const next = applyFieldValue(draft, "harness", "claude");
  assert.equal(next.sandbox, "");
  assert.equal(next.approval_policy, "");
  assert.equal(next.mode, "");
  assert.equal(draft.sandbox, "workspace-write");
  assert.deepEqual(validateProfile(next).errors, []);
  assert.deepEqual(applyFieldValue(draft, "harness", "codex"), draft);
  assert.equal(applyFieldValue(draft, "sandbox", "inherit").sandbox, "");
});

test("permission fields survive TOML and project overrides can clear global values", () => {
  const dir = tempDir();
  try {
    const global = { ...base, sandbox: "danger-full-access", approval_policy: "never" };
    const file = path.join(dir, "global.toml");
    assert.equal(upsertProfile(file, global).ok, true);
    assert.equal(readConfigFile(file).profiles[0].sandbox, "danger-full-access");
    const delta = overrideDelta({ ...global, sandbox: "read-only", approval_policy: "" }, global).entry;
    assert.deepEqual(delta, { id: "builder", sandbox: "read-only", approval_policy: "" });
    const overrideFile = path.join(dir, "override.toml");
    assert.equal(upsertProfile(overrideFile, delta, { partial: true }).ok, true);
    const merged = mergeProfiles(readConfigFile(file).profiles, readConfigFile(overrideFile).profiles).byId.get("builder");
    assert.equal(merged.sandbox, "read-only");
    assert.equal(merged.approval_policy, "");
    assert.equal(merged.model, base.model);
  } finally { cleanup(dir); }
});

test("show renders explicit permissions and inheritance", () => {
  assert.match(renderShow({ ...base, sandbox: "read-only", approval_policy: "" }), /Sandbox: read-only\nApproval policy: inherit/);
  assert.match(renderShow({ ...base, harness: "claude", permission_mode: "plan" }), /Permission mode: plan/);
});

test("CLI add, set, project override, show, and launch JSON carry profile permissions", () => {
  const dir = tempDir();
  try {
    const project = path.join(dir, "project");
    fs.mkdirSync(project);
    const cli = path.resolve("bin/herdr-loadout.mjs");
    const env = { ...process.env, HERDR_PLUGIN_CONFIG_DIR: path.join(dir, "config"), HERDR_PLUGIN_STATE_DIR: path.join(dir, "state") };
    const run = (...args) => spawnSync(process.execPath, [cli, ...args], { cwd: project, env, encoding: "utf8" });
    let result = run("add", "--id", "permission-test", "--name", "Permission Test", "--harness", "codex", "--model", "test-model", "--effort", "high", "--when", "Tests", "--sandbox", "workspace-write", "--approval-policy", "never", "--json");
    assert.equal(result.status, 0, result.stderr);
    result = run("set", "permission-test", "--sandbox", "read-only", "--project", project, "--json");
    assert.equal(result.status, 0, result.stderr);
    result = run("show", "permission-test", "--project", project, "--json");
    assert.equal(JSON.parse(result.stdout).sandbox, "read-only");
    result = run("set", "permission-test", "--permission-mode", "plan", "--project", project);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /not supported/);
    const projectProfile = readConfigFile(path.join(project, ".herdr/loadout.toml")).profiles[0];
    assert.deepEqual({ ...projectProfile }, { id: "permission-test", sandbox: "read-only" });
    result = run("launch", "permission-test", "--project", project, "--json");
    const launch = JSON.parse(result.stdout);
    assert.ok(launch.args.includes("read-only"));
    assert.ok(launch.args.includes("never"));
    assert.deepEqual(launch.env, {});
    assert.equal(launch.checks.find((check) => check.label === "permissions").ok, true);
  } finally { cleanup(dir); }
});
