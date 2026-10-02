/** Per-harness permissions. Empty strings explicitly inherit harness settings. */
export const PERMISSION_FIELDS = ["sandbox", "approval_policy", "permission_mode"];

export const PERMISSION_OPTIONS = {
  codex: {
    sandbox: ["read-only", "workspace-write", "danger-full-access"],
    approval_policy: ["on-request", "never"],
  },
  claude: {
    permission_mode: ["manual", "acceptEdits", "auto", "dontAsk", "plan", "bypassPermissions"],
  },
  omp: { permission_mode: ["always-ask", "write", "yolo"] },
  opencode: { permission_mode: ["ask", "allow", "deny"] },
};

export function permissionOptions(harness, field) {
  return PERMISSION_OPTIONS[harness]?.[field] ?? [];
}

export function permissionValue(profile, field) {
  if (Object.hasOwn(profile, field)) return profile[field];
  if ((profile.harness === "claude" && field === "permission_mode") ||
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
  return errors;
}

/** Permission flags follow legacy mode but precede caller-supplied extra args. */
export function permissionArgs(profile) {
  const args = [];
  if (profile.harness === "codex") {
    if (profile.sandbox) args.push("--sandbox", profile.sandbox);
    if (profile.approval_policy) args.push("--ask-for-approval", profile.approval_policy);
  } else if (profile.harness === "claude" && profile.permission_mode) {
    args.push("--permission-mode", profile.permission_mode);
  } else if (profile.harness === "omp" && profile.permission_mode) {
    args.push(`--approval-mode=${profile.permission_mode}`);
  }
  return args;
}

/** OpenCode accepts runtime permissions via inline JSON, rather than a CLI flag. */
export function buildLaunchEnv(profile, inheritedEnv = process.env) {
  const env = { ...profile.env };
  if (profile.harness === "opencode" && profile.permission_mode) {
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
