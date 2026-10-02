import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { buildLaunchArgs, claudeCatalogFromOmp, detectHarnesses, dryRun, effortLevels, EFFORT_LEVELS, listModels, which, NO_CATALOG } from "../src/core/detect.mjs";
import { cleanup, memoryFs, tempDir } from "./helpers.mjs";

/** Run `fn` with an isolated state dir so no cached or machine catalog leaks in. */
function withEmptyState(fn) {
  const dir = tempDir();
  const saved = process.env.HERDR_PLUGIN_STATE_DIR;
  process.env.HERDR_PLUGIN_STATE_DIR = dir;
  try {
    return fn();
  } finally {
    if (saved === undefined) delete process.env.HERDR_PLUGIN_STATE_DIR;
    else process.env.HERDR_PLUGIN_STATE_DIR = saved;
    cleanup(dir);
  }
}

const win = path.win32;
const posix = path.posix;

const winEnv = {
  PATH: ["C:\\tools\\bin", "C:\\other"].join(";"),
  PATHEXT: ".COM;.EXE;.BAT;.CMD;.PS1",
};

test("which resolves a bare executable on PATH", () => {
  const fs = memoryFs({
    [win.resolve("C:/tools/bin/claude.exe")]: "",
  });
  const found = which("claude", { env: winEnv, fs, platform: "win32" });
  assert.equal(found, win.resolve("C:/tools/bin/claude.exe"));
});

test("which honours PATHEXT order and prefers the first match", () => {
  const fs = memoryFs({
    [win.resolve("C:/tools/bin/codex.cmd")]: "",
    [win.resolve("C:/other/codex.exe")]: "",
  });
  const found = which("codex", { env: winEnv, fs, platform: "win32" });
  assert.equal(found, win.resolve("C:/tools/bin/codex.cmd"), "PATH order wins over extension order");
});

test("which finds .cmd shims that have no extension", () => {
  const fs = memoryFs({
    [win.resolve("C:/tools/bin/opencode.cmd")]: "",
  });
  assert.ok(which("opencode", { env: winEnv, fs, platform: "win32" }));
});

test("which returns null for missing tools", () => {
  const fs = memoryFs({});
  assert.equal(which("pi", { env: winEnv, fs, platform: "win32" }), null);
});

test("which accepts POSIX-style lookups without extensions", () => {
  const fs = memoryFs({ [posix.resolve("/usr/local/bin/claude")]: "" });
  const found = which("claude", { env: { PATH: "/usr/local/bin:/usr/bin" }, fs, platform: "linux" });
  assert.equal(found, posix.resolve("/usr/local/bin/claude"));
});

test("detectHarnesses reports every known harness with candidates", () => {
  const fs = memoryFs({ [win.resolve("C:/tools/bin/omp.exe")]: "" });
  const result = detectHarnesses({ env: { ...winEnv, PATH: "C:\\tools\\bin" }, fs, platform: "win32" });
  const byId = new Map(result.map((entry) => [entry.id, entry]));
  assert.equal(byId.get("omp").detected, true);
  assert.equal(byId.get("pi").detected, false);
  assert.ok(byId.get("claude").candidates.length > 0);
  assert.deepEqual([...byId.keys()].sort(), ["claude", "codex", "omp", "opencode", "pi"]);
});

test("effort levels fall back to the static table", () => {
  assert.deepEqual(effortLevels("claude"), EFFORT_LEVELS.claude);
  assert.deepEqual(effortLevels("unknown-harness"), []);
});

test("effort levels prefer levels reported by the live catalog", () => {
  const models = [{ id: "m", efforts: ["low", "high"] }, { id: "n", efforts: ["high"] }];
  assert.deepEqual(effortLevels("codex", { models }).sort(), ["high", "low"]);
});

test("listModels reports a reason instead of throwing when there is no catalog", () => {
  // pi has neither a listing command nor a static set
  const result = listModels("pi", { cache: false });
  assert.equal(result.ok, true);
  assert.deepEqual(result.models, []);
  assert.equal(result.noCatalog, true);
  assert.match(result.error, /no catalog/);
});

test("listModels surfaces spawn failures without throwing", () => {
  const result = listModels("codex", {
    cache: false,
    executablePath: path.join("Z:", "definitely-missing", "codex.exe"),
  });
  assert.equal(result.ok, false);
  assert.ok(result.error.length > 0);
});

test("buildLaunchArgs maps each harness to its native flags", () => {
  assert.deepEqual(
    buildLaunchArgs({ harness: "claude", model: "m", effort: "high" }),
    ["--model", "m", "--effort", "high"],
  );
  assert.deepEqual(
    buildLaunchArgs({ harness: "codex", model: "m", effort: "high" }),
    ["-m", "m", "-c", "model_reasoning_effort=high"],
  );
  // interactive opencode has no effort flag; --variant exists only on `run`
  assert.deepEqual(
    buildLaunchArgs({ harness: "opencode", model: "p/m", effort: "high" }),
    ["-m", "p/m"],
  );
  assert.deepEqual(
    buildLaunchArgs({ harness: "omp", model: "m", effort: "high" }),
    ["--model=m", "--thinking=high"],
  );
});

test("buildLaunchArgs appends mode and extra args last", () => {
  const args = buildLaunchArgs({
    harness: "claude",
    model: "m",
    effort: "low",
    mode: "plan",
    extra_args: ["--add-dir", "Assets"],
  });
  assert.deepEqual(args, ["--model", "m", "--effort", "low", "--permission-mode", "plan", "--add-dir", "Assets"]);
});

test("buildLaunchArgs omits flags for empty fields", () => {
  assert.deepEqual(buildLaunchArgs({ harness: "codex" }), []);
  assert.deepEqual(buildLaunchArgs({ harness: "omp", model: "m" }), ["--model=m"]);
});

test("claude always offers rows, derived or curated", () => {
  // An isolated state dir keeps this test off the machine's omp installation.
  const result = withEmptyState(() => listModels("claude", { cache: false, offline: true }));
  assert.equal(result.ok, true);
  assert.ok(result.derived || result.static, "either source is acceptable");
  const ids = result.models.map((model) => model.id);
  // the curated aliases lead; verified against the CLI as accepted values
  assert.deepEqual(ids.slice(0, 3), ["opus", "sonnet", "haiku"]);
  assert.ok(ids.includes("fable"));
  for (const model of result.models) assert.ok(model.label, `${model.id} needs a label`);
});

test("claude effort levels are never empty", () => {
  const levels = effortLevels("claude", { models: withEmptyState(() => listModels("claude", { cache: false, offline: true })).models });
  assert.ok(levels.length > 0, "the effort picker must not be empty");
  for (const level of ["low", "medium", "high"]) {
    assert.ok(levels.includes(level), `missing ${level}`);
  }
});

test("a harness with no catalog at all stays free-form", () => {
  const result = listModels("pi", { cache: false });
  assert.equal(result.ok, true);
  assert.equal(result.models.length, 0);
  assert.equal(result.noCatalog, true);
});

test("claude is no longer reported as having no catalog", () => {
  assert.ok(!NO_CATALOG.includes("claude"), "claude has a static alias catalog");
});

test("claude's catalog is derived from omp when omp is available", () => {
  // only meaningful when omp is installed; skip rather than pay a spawn
  if (!which("omp")) {
    assert.ok(NO_CATALOG.every((id) => id !== "claude"));
    return;
  }
  const derived = claudeCatalogFromOmp({ cache: false });
  if (!derived) {
    // omp is not installed here; the static alias fallback still applies
    assert.equal(withEmptyState(() => listModels("claude", { cache: false, offline: true })).static, true);
    return;
  }
  const ids = derived.map((model) => model.id);
  assert.ok(ids.length > 4, `expected a derived list, got ${ids.length}`);
  assert.ok(ids.includes("opus"), "curated aliases stay on top");
  assert.ok(ids.includes("claude-opus-5"), "current ids come from omp");
  // retired generations and dated snapshots must not reach the picker
  for (const id of ids) {
    assert.ok(!/^claude-3/.test(id), `retired generation leaked: ${id}`);
    assert.ok(!/-\d{8}$/.test(id), `dated snapshot leaked: ${id}`);
    assert.ok(id !== "claude-sonnet-4-0", `retired sonnet-4-0 leaked: ${id}`);
    assert.ok(!/^claude-mythos-/.test(id), `inaccessible mythos leaked: ${id}`);
  }
  // every derived row carries effort levels, so the effort picker is populated
  for (const model of derived.filter((m) => m.id.startsWith("claude-"))) {
    assert.ok(model.efforts?.length, `${model.id} has no effort levels`);
  }
});

test("the derived catalog does not depend on omp's own cache", () => {
  const derived = claudeCatalogFromOmp({ cache: false, env: { PATH: "" } });
  assert.equal(derived, null, "a missing omp falls back rather than throwing");
});

test("listModels reports a derived catalog for claude when omp is present", () => {
  const result = withEmptyState(() => listModels("claude", { cache: false, offline: true }));
  assert.equal(result.ok, true);
  assert.ok(result.models.length > 0);
  assert.equal(result.noCatalog, undefined, "claude is never reported as catalog-less now");
});

test("preferNoSpaces picks a launchable path when the first match has a space", () => {
  // measured: an nvm layout puts .cmd shims under "Author Software", and
  // `herdr agent start` cannot launch a path containing a space
  const spaced = win.resolve("C:/Users/x/Author Software/nvm/codex.cmd");
  const clean = win.resolve("C:/Users/x/nvm/.nodejs/codex.exe");
  const env = {
    PATH: [
      win.dirname(spaced),
      win.dirname(clean),
    ].join(";"),
    PATHEXT: ".EXE;.CMD",
  };
  const fs = memoryFs({ [spaced]: "", [clean]: "" });

  // default: PATH order wins
  assert.equal(which("codex", { env, fs, platform: "win32" }), spaced);
  // opt-in: the caller wants something Herdr can actually launch
  assert.equal(which("codex", { env, fs, platform: "win32", preferNoSpaces: true }), clean);
});

test("preferNoSpaces still returns the spaced path when nothing else exists", () => {
  const spaced = win.resolve("C:/Users/x/Author Software/nvm/codex.cmd");
  const env = { PATH: win.dirname(spaced), PATHEXT: ".CMD" };
  const fs = memoryFs({ [spaced]: "" });
  assert.equal(which("codex", { env, fs, platform: "win32", preferNoSpaces: true }), spaced);
});

test("preferNoSpaces is ignored on POSIX", () => {
  const dir = posix.resolve("/usr/local/bin");
  const env = { PATH: dir };
  const fs = memoryFs({ [posix.join(dir, "codex")]: "" });
  assert.equal(which("codex", { env, fs, platform: "linux", preferNoSpaces: true }), posix.join(dir, "codex"));
});

test("dryRun prefers a launchable path over an nvm wrapper's spaced shim on Windows", () => {
  const spaced = win.resolve("C:/Users/x/Author Software/nvm/codex.cmd");
  const clean = win.resolve("C:/Users/x/nvm/.nodejs/codex.exe");
  const env = {
    PATH: [win.dirname(spaced), win.dirname(clean)].join(";"),
    PATHEXT: ".EXE;.CMD",
  };
  const fs = memoryFs({ [spaced]: "", [clean]: "" });
  const result = dryRun(
    { id: "r", harness: "codex", effort: "low" },
    { env, fs, platform: "win32", cache: false, offline: true },
  );
  assert.equal(result.ok, true);
  assert.equal(result.executable, clean);
  assert.equal(result.checks.find((entry) => entry.label === "codex executable").detail, clean);
  assert.ok(!result.checks.some((entry) => entry.label === "launchable path"));
  assert.deepEqual(result.args, ["-c", "model_reasoning_effort=low"]);
  assert.equal(result.checks.find((entry) => entry.label === "launch command").detail, `${clean} -c model_reasoning_effort=low`);
});

test("dryRun flags an unlaunchable spaced path on Windows when no alternative exists", () => {
  const spaced = win.resolve("C:/Users/x/Author Software/nvm/codex.cmd");
  const env = { PATH: win.dirname(spaced), PATHEXT: ".CMD" };
  const fs = memoryFs({ [spaced]: "" });
  const result = dryRun(
    { id: "r", harness: "codex", effort: "low" },
    { env, fs, platform: "win32", cache: false, offline: true },
  );
  const check = result.checks.find((entry) => entry.label === "launchable path");
  assert.ok(check, "the warning must be present");
  assert.equal(check.ok, false);
  assert.match(check.detail, /space/);
  assert.equal(result.ok, false, "an unlaunchable path makes the profile not launchable");
});
