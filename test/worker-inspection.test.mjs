import assert from "node:assert/strict";
import test from "node:test";
import { appPlace, compareWorker, inspectWorker, launchFingerprint } from "../src/core/worker.mjs";

test("app: an unavailable hc CLI does not establish that a worker is absent", () => {
  const live = inspectWorker("hc", "qa-worker", {
    run: () => ({ status: null, stdout: "", stderr: "spawnSync hc ENOENT" }),
  });
  const problems = compareWorker({ host: "hc", name: "qa-worker", live, record: null, current: null });
  assert.equal(problems.length, 1);
  assert.equal(problems[0].code, "host-unavailable");
  assert.match(problems[0].message, /hc ENOENT/i);
});

test("TUI: a stopped session does not establish that a recorded worker is absent", () => {
  const live = inspectWorker("herdr", "qa-worker", {
    run: () => ({
      status: 1,
      stdout: "",
      stderr: JSON.stringify({
        id: "cli:agent:get",
        error: { code: "server_not_running", message: "no herdr server is running at the session socket" },
      }),
    }),
  });
  const launch = { harness: "omp", args: ["--thinking=medium"], env: {} };
  const fingerprint = launchFingerprint(launch);
  const problems = compareWorker({
    host: "herdr",
    name: "qa-worker",
    live,
    record: { profile: "junior", fingerprint },
    current: { fingerprint, args: launch.args },
  });
  assert.deepEqual(problems.map(({ code }) => code), ["host-unavailable"]);
});

/** A host CLI that fails every call with `error` as JSON on stderr, as hc 0.1.21 and Herdr 0.9.5 do. */
const failing = (status, error) => () => ({ status, stdout: "", stderr: JSON.stringify({ error }) });

test("app: an unreachable core does not establish that a worker is absent", () => {
  // hc 0.1.21 with no core it can reach: exit 5 after trying to start one.
  const live = inspectWorker("hc", "qa-worker", {
    run: failing(5, { kind: "unavailable", message: "core did not stop or start within 15 s", hint: "check the core log in the state directory" }),
  });
  const problems = compareWorker({ host: "hc", name: "qa-worker", live, record: null, current: null });
  assert.deepEqual(problems.map(({ code }) => code), ["host-unavailable"]);
  assert.match(problems[0].message, /core did not stop or start/);
});

test("only the hosts' own not-found answers mean a worker is gone", () => {
  const gone = (host, run) => compareWorker({ host, name: "qa-worker", live: inspectWorker(host, "qa-worker", { run }), record: null, current: null })
    .map(({ code }) => code);
  assert.deepEqual(gone("hc", failing(3, { kind: "not_found", message: 'no terminal "qa-worker"' })), ["not-running"]);
  assert.deepEqual(gone("herdr", failing(1, { code: "agent_not_found", message: "agent target qa-worker not found" })), ["not-running"]);
  // An answer the check does not recognise leaves the worker unknown.
  assert.deepEqual(gone("herdr", () => ({ status: 1, stdout: "", stderr: "unexpected failure" })), ["host-unavailable"]);
});

test("TUI: a failed process probe cannot validate a worker's launch arguments", () => {
  const live = inspectWorker("herdr", "qa-worker", {
    run: (_command, args) => {
      if (args[0] === "agent") {
        return {
          status: 0,
          stdout: JSON.stringify({ result: { agent: { pane_id: "w1:p2" } } }),
          stderr: "",
        };
      }
      return { status: 1, stdout: "", stderr: "pane process query failed" };
    },
  });
  const launch = { harness: "codex", args: ["-m", "gpt-6.1-sol"], env: {} };
  const fingerprint = launchFingerprint(launch);
  const problems = compareWorker({
    host: "herdr",
    name: "qa-worker",
    live,
    record: { profile: "qa", fingerprint },
    current: { fingerprint, args: launch.args },
  });
  assert.equal(problems.length, 1);
  assert.equal(problems[0].code, "process-unknown");
});

/** `herdr-app ls` as Herdr App 0.1.16 prints it, trimmed to what `appPlace` reads. */
const layout = {
  spaces: [
    { id: "sp-other", tabs: [{ id: "tb-other", terminals: [{ terminal: "t1" }] }] },
    {
      id: "sp-work",
      tabs: [
        { id: "tb-orch", terminals: [{ terminal: "t2" }] },
        { id: "tb-lead", terminals: [{ terminal: "t1bg" }, { terminal: "t1bk" }] },
      ],
    },
  ],
};

test("app: a lead's tab comes from the window layout even without a herdr.tab label", () => {
  const calls = [];
  const run = (command) => {
    calls.push(command);
    if (command === "herdr-app") return { status: 0, stdout: JSON.stringify(layout), stderr: "" };
    return { status: 0, stdout: JSON.stringify({ labels: { "herdr.space": "sp-work" } }), stderr: "" };
  };
  assert.deepEqual(appPlace("t1bg", { run }), { space: "sp-work", tab: "tb-lead" });
  assert.deepEqual(calls, ["herdr-app"]);
});

test("app: a terminal shown in no tab has no tab to share", () => {
  const run = () => ({ status: 0, stdout: JSON.stringify(layout), stderr: "" });
  assert.match(appPlace("t9z", { run }).error, /no tab/);
});

test("app: without the window's layout, a lead's labels give its tab", () => {
  const missing = { status: null, stdout: "", stderr: "spawnSync herdr-app ENOENT" };
  const withLabels = (labels) => (command) => command === "herdr-app"
    ? missing
    : { status: 0, stdout: JSON.stringify({ labels }), stderr: "" };
  const labelled = withLabels({ "herdr.space": "sp-work", "herdr.tab": "tb-lead" });
  assert.deepEqual(appPlace("t1bg", { run: labelled }), { space: "sp-work", tab: "tb-lead" });
  assert.match(appPlace("t1bg", { run: withLabels({ "herdr.space": "sp-work" }) }).error, /herdr-app ENOENT/);
});
