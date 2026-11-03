/** Per-harness permissions. Empty strings explicitly inherit harness settings. */
export const PERMISSION_FIELDS = ["sandbox", "approval_policy", "permission_mode"];

export const PERMISSION_OPTIONS = {
  codex: {
    sandbox: ["read-only", "workspace-write", "danger-full-access"],
    // approve-for-me: approvals go to Codex's automatic reviewer; bypass: no prompts, no sandbox
    approval_policy: ["on-request", "never", "approve-for-me", "bypass"],
  },
  claude: {
    permission_mode: ["manual", "acceptEdits", "auto", "dontAsk", "plan", "bypassPermissions"],
  },
  omp: { permission_mode: ["always-ask", "always-ask-cached", "write", "yolo"] },
  // auto: approve what is not explicitly denied (`--auto`); the others set OpenCode's `permission`
  opencode: { permission_mode: ["ask", "allow", "deny", "auto"] },
  agy: { permission_mode: ["accept-edits", "auto", "plan", "dangerously-skip-permissions"] },
};

export function permissionOptions(harness, field) {
  return PERMISSION_OPTIONS[harness]?.[field] ?? [];
}

export function permissionValue(profile, field) {
  if (Object.hasOwn(profile, field)) return profile[field];
  if (((profile.harness === "claude" || profile.harness === "agy") && field === "permission_mode") ||
      (profile.harness === "codex" && field === "approval_policy")) return profile.mode;
  return undefined;
}

/** Partial overrides without a harness are checked against the union of values. */
export function validatePermissions(profile) {
  const errors = [];
  for (const field of PERMISSION_FIELDS) {
    const value = profile[field];
    if (value === undefined || value === "") continue;
    if (typeof value !== "string") {
      errors.push(`${field} must be a string`);
      continue;
    }
    const options = profile.harness
      ? permissionOptions(profile.harness, field)
      : [...new Set(Object.values(PERMISSION_OPTIONS).flatMap((fields) => fields[field] ?? []))];
    if (options.length === 0) errors.push(`${field} is not supported by ${profile.harness}`);
    else if (!options.includes(value)) errors.push(`${field} must be one of ${options.join(" | ")}`);
  }
  // Codex refuses these approval switches next to an explicit sandbox: each sets its own.
  if (profile.harness === "codex" && CODEX_APPROVAL_SWITCHES[profile.approval_policy] && profile.sandbox) {
    errors.push(`approval_policy ${profile.approval_policy} sets the sandbox itself; leave sandbox on inherit`);
  }
  return errors;
}

/**
 * Codex approval values that are switches of their own rather than
 * `--ask-for-approval` values. Codex rejects each next to `--ask-for-approval`.
 */
const CODEX_APPROVAL_SWITCHES = {
  "approve-for-me": "--approve-for-me",
  bypass: "--dangerously-bypass-approvals-and-sandbox",
};

/** Permission flags follow legacy mode but precede caller-supplied extra args. */
export function permissionArgs(profile) {
  const args = [];
  if (profile.harness === "codex") {
    if (profile.sandbox) args.push("--sandbox", profile.sandbox);
    const approval = profile.approval_policy;
    if (approval) args.push(...(CODEX_APPROVAL_SWITCHES[approval] ? [CODEX_APPROVAL_SWITCHES[approval]] : ["--ask-for-approval", approval]));
  } else if (profile.harness === "claude" && profile.permission_mode) {
    args.push("--permission-mode", profile.permission_mode);
  } else if (profile.harness === "omp" && profile.permission_mode) {
    args.push(`--approval-mode=${profile.permission_mode}`);
  } else if (profile.harness === "agy" && profile.permission_mode) {
    // agy takes its modes through `--mode`; skipping prompts is a separate flag
    args.push(...(profile.permission_mode === "dangerously-skip-permissions"
      ? ["--dangerously-skip-permissions"]
      : ["--mode", profile.permission_mode]));
  } else if (profile.harness === "opencode" && profile.permission_mode === "auto") {
    // The other OpenCode values go through its config (buildLaunchEnv); auto is a flag.
    args.push("--auto");
  }
  return args;
}

/** OpenCode accepts runtime permissions via inline JSON, rather than a CLI flag. */
export function buildLaunchEnv(profile, inheritedEnv = process.env) {
  const env = { ...profile.env };
  if (profile.harness === "opencode" && profile.permission_mode && profile.permission_mode !== "auto") {
    let config = {};
    const inlineConfig = env.OPENCODE_CONFIG_CONTENT ?? inheritedEnv.OPENCODE_CONFIG_CONTENT;
    if (inlineConfig) {
      try {
        config = JSON.parse(inlineConfig);
      } catch {
        throw new Error("env.OPENCODE_CONFIG_CONTENT must be valid JSON when permission_mode is set");
      }
      if (!config || typeof config !== "object" || Array.isArray(config)) {
        throw new Error("env.OPENCODE_CONFIG_CONTENT must be a JSON object");
      }
    }
    env.OPENCODE_CONFIG_CONTENT = JSON.stringify({ ...config, permission: profile.permission_mode });
  }
  return env;
}
