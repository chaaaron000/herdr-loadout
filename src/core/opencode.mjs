/**
 * OpenCode launch differences between major versions.
 *
 * v1's interactive TUI takes `-m provider/model`. v2's TUI has no `-m`: it
 * prints its help and exits on one. v2 reads the model, a variant
 * (`provider/model#variant`, the effort) and permissions from config instead,
 * and `OPENCODE_CONFIG_CONTENT` reaches only a server the TUI starts itself
 * (`--standalone`); the shared background service ignores the worker's env.
 */

/** `opencode --version` prints `opencode v2.3.0` (v2) or a bare `1.x.y` (v1). */
export function parseVersion(stdout) {
  return String(stdout ?? "").match(/\d+\.\d+\.\d+/)?.[0] ?? null;
}

export function majorVersion(version) {
  const major = Number.parseInt(String(version ?? ""), 10);
  return Number.isFinite(major) ? major : null;
}

/** An unknown version keeps the v1 form, which every release before 2.0 needs. */
export function isOpencodeV2(version) {
  return (majorVersion(version) ?? 1) >= 2;
}

/**
 * The model value for v2 config: the effort rides along as the variant unless
 * the id already names one.
 */
export function opencodeModel(profile) {
  if (!profile.model) return null;
  if (!profile.effort || profile.model.includes("#")) return profile.model;
  return `${profile.model}#${profile.effort}`;
}

/** Keys the launch adds to OpenCode's inline config; empty when it adds none. */
export function opencodeConfigPatch(profile, version) {
  const patch = {};
  if (isOpencodeV2(version)) {
    const model = opencodeModel(profile);
    if (model) patch.model = model;
  }
  if (profile.permission_mode && profile.permission_mode !== "auto") patch.permission = profile.permission_mode;
  return patch;
}

/**
 * v2 flags that make the TUI read its own config. `--server` points at a
 * server the caller chose, so the launch leaves that alone.
 */
export function opencodeServerArgs(profile, version) {
  if (!isOpencodeV2(version) || Object.keys(opencodeConfigPatch(profile, version)).length === 0) return [];
  const extra = Array.isArray(profile.extra_args) ? profile.extra_args : [];
  if (extra.some((arg) => arg === "--standalone" || arg === "--server" || String(arg).startsWith("--server="))) return [];
  return ["--standalone"];
}
