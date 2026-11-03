#!/usr/bin/env node
/**
 * Install the Agent Profiles editor into the Herdr app.
 *
 *   node scripts/install-app-mod.mjs                  install or update the mod
 *   node scripts/install-app-mod.mjs --key ctrl-alt-p also bind a key that opens it
 *   node scripts/install-app-mod.mjs --home <dir>     another app home (default: $HERDR_APP_HOME or ~/.config/herdr-app)
 *
 * The app runs mods from `<home>/mods/<name>/` and gives them no Node, so the
 * installer writes two files beside the mod's own: `cli.js`, which says where
 * node and this checkout's CLI are, and `picker.js`, the model filter shared
 * with the terminal editor. Run it again after moving the checkout.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { sourceRoot } from "../src/core/paths.mjs";

export const MOD_NAME = "herdr-loadout";
const OPEN_ACTION = `mod.open:${MOD_NAME}`;
// Present in our main.js: tells our own earlier install from someone else's mod.
const MARKER = "herdr-loadout editor";

export function appHome(env = process.env) {
  return path.resolve(env.HERDR_APP_HOME ?? path.join(os.homedir(), ".config", "herdr-app"));
}

/** Files the installed mod consists of, by name. */
export function modFiles(root = sourceRoot(), nodePath = process.execPath) {
  const read = (...parts) => fs.readFileSync(path.join(root, ...parts), "utf8");
  const cli = { command: nodePath, args: [path.join(root, "bin", "herdr-loadout.mjs")] };
  return {
    "main.js": read("app-mod", "main.js"),
    "mod.json": read("app-mod", "mod.json"),
    "picker.js": read("src", "core", "picker.mjs"),
    "cli.js": `// Written by herdr-loadout's scripts/install-app-mod.mjs: where node and the CLI are.\nexport const CLI = ${JSON.stringify(cli, null, 2)};\n`,
  };
}

/** Copy the mod into `<home>/mods/<name>/`, refusing to replace a folder that is not ours. */
export function installMod(home, files = modFiles()) {
  const target = path.join(home, "mods", MOD_NAME);
  const existing = path.join(target, "main.js");
  if (fs.existsSync(target) && !(fs.existsSync(existing) && fs.readFileSync(existing, "utf8").includes(MARKER))) {
    throw new Error(`${target} holds another mod; move it aside first`);
  }
  fs.mkdirSync(target, { recursive: true });
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(target, name), text);
  return target;
}

/**
 * Bind `key` to open the mod, in keys.json's `global` section and in its
 * `terminal` section, so it also works while a terminal has the keyboard (the
 * terminal section wins there). A key the person already uses for something
 * else, in either section, is left alone.
 * @returns {"added" | "present"}
 */
export function bindKey(home, key) {
  const file = path.join(home, "keys.json");
  const text = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "{}\n";
  const keys = JSON.parse(text);
  const sections = ["global", "terminal"];
  for (const section of sections) {
    const current = keys[section]?.[key];
    if (current !== undefined && current !== OPEN_ACTION) {
      throw new Error(`${key} already runs "${current}" (${section}); pick another key`);
    }
  }
  if (sections.every((section) => keys[section]?.[key] === OPEN_ACTION)) return "present";
  for (const section of sections) {
    keys[section] ??= {};
    keys[section][key] = OPEN_ACTION;
  }
  // The person's file keeps its line endings.
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  fs.writeFileSync(file, `${JSON.stringify(keys, null, 2)}\n`.replace(/\n/g, eol));
  return "added";
}

function main() {
  const { values } = parseArgs({
    options: {
      home: { type: "string" },
      key: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) {
    process.stdout.write("usage: node scripts/install-app-mod.mjs [--key KEYS] [--home DIR]\n");
    return;
  }
  const home = values.home ? path.resolve(values.home) : appHome();
  if (!fs.existsSync(home)) {
    process.stderr.write(`${home} does not exist; start the Herdr app once first\n`);
    process.exit(1);
  }
  const target = installMod(home);
  const lines = [`Installed the Agent Profiles editor in ${target}`];

  // `herdr-app check` loads the mod once and names what is wrong.
  const check = spawnSync("herdr-app", ["check", target], { encoding: "utf8", env: { ...process.env, HERDR_APP_HOME: home } });
  if (check.error) lines.push("herdr-app is not on PATH; skipped `herdr-app check`");
  else if (check.status !== 0) {
    process.stderr.write(`${lines.join("\n")}\nherdr-app check failed:\n${check.stdout}${check.stderr}`);
    process.exit(1);
  } else lines.push("herdr-app check passed");

  if (values.key) {
    const result = bindKey(home, values.key);
    lines.push(result === "added" ? `${values.key} now opens it (keys.json)` : `${values.key} already opens it`);
  } else {
    lines.push(`Open it with \`herdr-app do mod.open --name ${MOD_NAME}\`, or bind a key: --key <keys>`);
  }
  process.stdout.write(`${lines.join("\n")}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  }
}
