/**
 * Filesystem locations and executable resolution.
 *
 * Resolution order (any command, shim or source checkout):
 *   1. this file's own location  (src/core/paths.mjs -> plugin root)
 *   2. HERDR_PLUGIN_ROOT  (env injected by Herdr for plugin commands)
 *   3. HERDR_PLUGIN_CONFIG_DIR resolved relative to the plugin root
 *   4. XDG / APPDATA herdr plugin config fallback for plain shells
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const PLUGIN_ID = "herdr-loadout";
export const CONFIG_FILE_NAME = "loadout.toml";
export const PROJECT_DIR_NAME = ".herdr";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));

/** Plugin root when running from a source checkout. */
export function sourceRoot() {
  return path.resolve(moduleDir, "..", "..");
}

/** Candidate plugin roots, most specific first. */
export function rootCandidates(env = process.env) {
  const roots = [sourceRoot()];
  if (env.HERDR_PLUGIN_ROOT) roots.push(path.resolve(env.HERDR_PLUGIN_ROOT));
  if (env.HERDR_PLUGIN_CONFIG_DIR) {
    // <...>/plugins/config/<plugin_id>
    roots.push(path.resolve(env.HERDR_PLUGIN_CONFIG_DIR, "..", "..", ".."));
  }
  return roots;
}

/** Config directory holding loadout.toml. */
export function configDir(env = process.env) {
  if (env.HERDR_PLUGIN_CONFIG_DIR) return path.resolve(env.HERDR_PLUGIN_CONFIG_DIR);
  const base =
    env.APPDATA ??
    (process.platform === "win32" ? path.join(os.homedir(), "AppData", "Roaming") : null) ??
    env.XDG_CONFIG_HOME ??
    path.join(os.homedir(), ".config");
  return path.join(base, "herdr", "plugins", "config", PLUGIN_ID);
}

/** Runtime state directory (caches). */
export function stateDir(env = process.env) {
  if (env.HERDR_PLUGIN_STATE_DIR) return path.resolve(env.HERDR_PLUGIN_STATE_DIR);
  const base =
    env.LOCALAPPDATA ??
    (process.platform === "win32" ? path.join(os.homedir(), "AppData", "Local") : null) ??
    env.XDG_STATE_HOME ??
    path.join(os.homedir(), ".local", "state");
  return path.join(base, "herdr", "plugins", PLUGIN_ID);
}

export function globalConfigPath(env = process.env) {
  return path.join(configDir(env), CONFIG_FILE_NAME);
}

/**
 * Walk up from `start` looking for <dir>/.herdr/loadout.toml.
 * Returns the project config path or null.
 */
export function findProjectConfig(start = process.cwd(), fsImpl = fs) {
  let dir = path.resolve(start);
  for (;;) {
    const candidate = path.join(dir, PROJECT_DIR_NAME, CONFIG_FILE_NAME);
    if (fsImpl.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** Directory to create project overrides in (project root, not .herdr). */
export function projectConfigPath(projectRoot) {
  return path.join(path.resolve(projectRoot), PROJECT_DIR_NAME, CONFIG_FILE_NAME);
}
