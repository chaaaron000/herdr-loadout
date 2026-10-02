#!/usr/bin/env node
/**
 * Cwd-independent bootstrap for manifest commands.
 *
 * Herdr launches a plugin pane command with the pane's cwd, so a relative
 * manifest path like `bin/ui.mjs` breaks as soon as a caller passes `--cwd`
 * (a real user project). The manifest therefore runs this tiny launcher, which
 * resolves the real module from HERDR_PLUGIN_ROOT.
 *
 * Usage: node bootstrap.mjs <relative-module> [args...]
 */
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const [target, ...rest] = process.argv.slice(2);

if (!target) {
  process.stderr.write("bootstrap: missing module path\n");
  process.exit(2);
}

/** Plugin root: Herdr injects this for every plugin command. */
function pluginRoot() {
  const fromEnv = process.env.HERDR_PLUGIN_ROOT;
  if (fromEnv) return fromEnv;
  // Fall back to the manifest location (bootstrap.mjs sits next to it).
  return path.dirname(fileURLToPath(import.meta.url));
}

const root = path.resolve(pluginRoot());
const modulePath = path.resolve(root, target);

// Refuse path traversal out of the plugin directory.
const relative = path.relative(root, modulePath);
if (relative.startsWith("..") || path.isAbsolute(relative)) {
  process.stderr.write(`bootstrap: refusing to run outside the plugin root: ${target}\n`);
  process.exit(2);
}

// Forward the arguments the manifest appended after the module path.
process.argv = [process.argv[0], modulePath, ...rest];

try {
  await import(pathToFileURL(modulePath).href);
} catch (error) {
  process.stderr.write(`bootstrap: ${modulePath}\n${error?.stack ?? String(error)}\n`);
  process.exit(1);
}
