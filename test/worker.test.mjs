import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  compareWorker,
  findWorkerRecord,
  inspectWorker,
  launchFingerprint,
  launchLabels,
  launchRecord,
  recordWorker,
} from "../src/core/worker.mjs";
import { cleanup, tempDir } from "./helpers.mjs";

const LAUNCH = { harness: "claude", args: ["--model", "opus", "--effort", "high"], env: { API_KEY: "secret-1" } };
const FP = launchFingerprint(LAUNCH);

/** A host CLI stand-in: answers by the first two arguments. */
function fakeRun(answers) {
  return (command, args) => {
    const key = [command, ...args.slice(0, 2)].join(" ");
    const value = answers[key];
    if (!value) return { status: 1, stdout: "", stderr: `unexpected: ${key}` };
    return { status: value.status ?? 0, stdout: JSON.stringify(value.json), stderr: "" };
  };
}

const hcWorker = (labels, foreground = { name: "claude.exe", argv: ["claude.exe", ...LAUNCH.args] }, state = "live") =>
  fakeRun({ "hc get w1": { json: { state, foreground, labels } } });

function check({ run, host = "hc", fileRecord = null, expectedProfile, current = { fingerprint: FP, args: LAUNCH.args } }) {
  const live = inspectWorker(host, "w1", { run });
  return compareWorker({ host, name: "w1", live, record: launchRecord(live, fileRecord), expectedProfile, current }).map((p) => p.code);
}

const LABELS = Object.fromEntries(launchLabels("builder", FP).map((label) => label.split("=")));

test("the fingerprint follows harness, args, and env names, never env values", () => {
  assert.equal(launchFingerprint({ ...LAUNCH, env: { API_KEY: "secret-2" } }), FP);
  assert.notEqual(launchFingerprint({ ...LAUNCH, args: ["--model", "opus", "--effort", "low"] }), FP);
  assert.notEqual(launchFingerprint({ ...LAUNCH, env: { API_KEY: "x", OTHER: "y" } }), FP);
  assert.ok(!launchLabels("builder", FP).join(" ").includes("secret"));
});

test("app: a labelled worker matches until its profile is edited, renamed, or another is expected", () => {
  assert.deepEqual(check({ run: hcWorker(LABELS) }), []);
  assert.deepEqual(check({ run: hcWorker(LABELS), current: { fingerprint: "000000000000", args: [] } }), ["profile-edited"]);
  assert.deepEqual(check({ run: hcWorker(LABELS), current: null }), ["profile-missing"]);
  assert.deepEqual(check({ run: hcWorker(LABELS), expectedProfile: "reviewer" }), ["other-profile"]);
});

test("app: missing labels, a shell in place of the harness, and an exited worker all fail", () => {
  assert.deepEqual(check({ run: hcWorker({ "herdr.space": "sp1" }) }), ["no-record"]);
  assert.deepEqual(check({ run: hcWorker(LABELS, { name: "pwsh.exe", argv: ["C:\\Program Files\\PowerShell\\7\\pwsh.exe"] }) }), ["shell"]);
  assert.deepEqual(check({ run: hcWorker(LABELS, {}, "finished") }), ["not-running"]);
  const removed = () => ({ status: 3, stdout: "", stderr: JSON.stringify({ error: { kind: "not_found", message: 'no terminal "w1"' } }) });
  assert.deepEqual(check({ run: removed }), ["not-running"]);
});

function herdrWorker(argvs) {
  return fakeRun({
    "herdr agent get": { json: { result: { agent: { name: "w1", pane_id: "w1:p2" } } } },
    "herdr pane process-info": { json: { result: { process_info: { foreground_processes: argvs.map((argv) => ({ argv0: argv[0], argv })) } } } },
  });
}

test("TUI: the record comes from workers.json and the live command line must carry the profile's args", () => {
  const fileRecord = { profile: "builder", fingerprint: FP, file: "workers.json" };
  assert.deepEqual(check({ host: "herdr", run: herdrWorker([["claude", ...LAUNCH.args]]), fileRecord }), []);
  // A wrapper process ahead of the harness still counts.
  assert.deepEqual(check({ host: "herdr", run: herdrWorker([["node", "cli.js", ...LAUNCH.args]]), fileRecord }), []);
  // Herdr resumes a worker after a restart without its launch arguments.
  assert.deepEqual(check({ host: "herdr", run: herdrWorker([["claude", "--resume", "abc"]]), fileRecord }), ["launch-args-lost"]);
  assert.deepEqual(check({ host: "herdr", run: herdrWorker([["powershell.exe", "-NoExit"]]), fileRecord }), ["shell"]);
  assert.deepEqual(check({ host: "herdr", run: herdrWorker([["claude", ...LAUNCH.args]]) }), ["no-record"]);
});

test("records are kept per worker, and the newest one across task folders wins", () => {
  const dir = tempDir();
  try {
    const runs = path.join(dir, ".herdr", "runs");
    const older = path.join(runs, "2026-11-20-a");
    const newer = path.join(runs, "2026-11-21-b");
    fs.mkdirSync(older, { recursive: true });
    fs.mkdirSync(newer, { recursive: true });
    recordWorker(older, "w1", { profile: "scout", fingerprint: "a", recorded: "2026-11-20T10:00:00.000Z" });
    recordWorker(older, "w2", { profile: "builder", fingerprint: "b", recorded: "2026-11-20T10:00:00.000Z" });
    recordWorker(newer, "w1", { profile: "builder", fingerprint: "c", recorded: "2026-11-21T10:00:00.000Z" });

    assert.equal(findWorkerRecord({ name: "w1", projectRoot: dir }).profile, "builder");
    assert.equal(findWorkerRecord({ name: "w1", taskDir: older }).profile, "scout");
    assert.equal(findWorkerRecord({ name: "w2", projectRoot: dir }).fingerprint, "b");
    assert.equal(findWorkerRecord({ name: "w3", projectRoot: dir }), null);
  } finally {
    cleanup(dir);
  }
});
