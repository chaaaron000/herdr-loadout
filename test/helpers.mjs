/**
 * Shared test helpers: temp dirs and in-memory fs shims.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function tempDir(prefix = "herdr-loadout-test-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

/**
 * A stand-in harness CLI that prints `stdout` whatever its arguments. Keep
 * `stdout` to one line with no shell metacharacters. Returns its path.
 */
export function fakeCli(dir, name, stdout) {
  const win = process.platform === "win32";
  const file = path.join(dir, win ? `${name}.cmd` : name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, win ? `@echo ${stdout}\r\n` : `#!/bin/sh\necho '${stdout}'\n`, { mode: 0o755 });
  return file;
}

/** Minimal in-memory fs implementing the subset the core modules use. */
export function memoryFs(initial = {}) {
  const files = new Map(Object.entries(initial));
  const dirs = new Set();

  // Keys follow the shape of the path, so a test can simulate Windows or POSIX
  // lookups on any host. Real host paths resolve exactly as path.resolve does.
  const normalize = (value) =>
    /^[A-Za-z]:[\\/]/.test(value) ? path.win32.resolve(value)
      : value.startsWith("/") ? path.posix.resolve(value)
      : path.resolve(value);

  return {
    files,
    existsSync(target) {
      const key = normalize(target);
      return files.has(key) || dirs.has(key);
    },
    readFileSync(target) {
      const key = normalize(target);
      if (!files.has(key)) {
        const error = new Error(`ENOENT: ${key}`);
        error.code = "ENOENT";
        throw error;
      }
      return files.get(key);
    },
    writeFileSync(target, text) {
      files.set(normalize(target), String(text));
    },
    mkdirSync(target) {
      dirs.add(normalize(target));
    },
    renameSync(from, to) {
      const key = normalize(from);
      if (!files.has(key)) {
        const error = new Error(`ENOENT: ${key}`);
        error.code = "ENOENT";
        throw error;
      }
      files.set(normalize(to), files.get(key));
      files.delete(key);
    },
    rmSync(target) {
      files.delete(normalize(target));
    },
  };
}
