/**
 * Output renderers: `list`, `list --compact`, and `show`.
 *
 * Compact output is the Director-facing contract: one line per profile with no
 * header, colour, or decoration. Keep it stable — orchestrators parse it.
 */

/** Trim to a single line and cap at `width` characters. */
export function firstSentence(text, width = 40) {
  if (typeof text !== "string") return "";
  const oneLine = text.replace(/\s+/g, " ").trim();
  if (!oneLine) return "";
  const match = oneLine.match(/^.*?[.!?](\s|$)/);
  const sentence = match ? match[0] : oneLine;
  const trimmed = sentence.trim();
  if (trimmed.length <= width) return trimmed;
  return `${trimmed.slice(0, width - 1).trimEnd()}…`;
}

export function purposeOf(profile, width = 40) {
  const tags = Array.isArray(profile.tags) ? profile.tags.filter(Boolean) : [];
  if (tags.length > 0) return tags.join("/");
  const sentence = firstSentence(profile.when_to_use ?? "", width);
  return sentence || "(no description)";
}

/**
 * `id | cost | purpose` — one line per profile, stable order as given.
 */
export function renderCompact(profiles) {
  return profiles
    .map((profile) => {
      const cost = profile.cost ?? "normal";
      return `${profile.id} | ${cost} | ${purposeOf(profile)}`;
    })
    .join("\n");
}

/** A field value as one short token for diff summaries. */
function showValue(value) {
  if (value === undefined || value === null || value === "") return "(unset)";
  if (Array.isArray(value)) return value.length ? value.join(" ") : "(unset)";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/**
 * "effort (global: medium), model (global: x)" — what a project override changes.
 * Falls back to bare field names when the global profile is not at hand.
 */
export function diffSummary(profile, globalProfile) {
  const fields = profile.differs ?? profile.overrides ?? [];
  return fields
    .map((field) => (globalProfile ? `${field} (global: ${showValue(globalProfile[field])})` : field))
    .join(", ");
}

/**
 * Human-readable list, mirroring the requirement's sample output.
 *
 * Merged profiles (they carry `origin`) are split into the global profiles and
 * the profiles that exist only in this project, matching the editor.
 *
 * @param {object[]} profiles
 * @param {{detection?: object[], globalProfiles?: object[], projectPath?: string|null}} [options]
 */
export function renderList(profiles, options = {}) {
  const detection = options.detection ?? null;
  const globalById = new Map((options.globalProfiles ?? []).map((entry) => [entry.id, entry]));
  const render = (profile) => {
    const lines = [];
    lines.push(profile.name ?? profile.id);
    const harness = displayHarness(profile, detection);
    const model = profile.model ?? "?";
    const effort = profile.effort ?? "?";
    lines.push(`  ${harness} / ${model} / ${effort}`);
    lines.push(`  Cost: ${profile.cost ?? "normal"}`);
    lines.push(`  Use: ${firstSentence(profile.when_to_use ?? "", 100)}`);
    if (profile.origin === "project-override") {
      const summary = diffSummary(profile, globalById.get(profile.id));
      if (summary) lines.push(`  Overridden: ${summary}`);
    } else if (profile.origin === "project-only") {
      lines.push("  Source: project-only profile");
    }
    return lines.join("\n");
  };

  // Without origin information (a plain list) there is nothing to separate.
  if (!profiles.some((profile) => profile.origin)) return profiles.map(render).join("\n\n");

  const globals = profiles.filter((profile) => profile.origin !== "project-only");
  const projectOnly = profiles.filter((profile) => profile.origin === "project-only");
  const where = options.projectPath ?? "no project file";
  const sections = [
    ["Global profiles", globals],
    [`Project profiles${projectOnly.length === 0 ? " (none)" : ""} · ${where}`, projectOnly],
  ];
  return sections
    .map(([heading, items]) => [heading, ...items.map((item) => `\n${render(item)}`)].join("\n"))
    .join("\n\n");
}

function displayHarness(profile, detection) {
  const harness = profile.harness ?? "?";
  if (!detection) return harness;
  const entry = detection.find?.((item) => item.id === harness);
  if (!entry) return harness;
  return entry.detected ? `${harness} (detected)` : `${harness} (not found)`;
}

export function renderShow(profile, options = {}) {
  const detection = options.detection ?? null;
  const globalProfile = options.globalProfile ?? null;
  const lines = [];
  lines.push(`ID: ${profile.id}`);
  lines.push(`Name: ${profile.name ?? profile.id}`);
  lines.push(`Harness: ${displayHarness(profile, detection)}`);
  if (profile.provider) lines.push(`Provider: ${profile.provider}`);
  lines.push(`Model: ${profile.model ?? "?"}`);
  lines.push(`Effort: ${profile.effort ?? "?"}`);
  lines.push(`Cost: ${profile.cost ?? "normal"}`);
  if (profile.mode) lines.push(`Mode: ${profile.mode}`);
  for (const [field, label] of [["sandbox", "Sandbox"], ["approval_policy", "Approval policy"], ["permission_mode", "Permission mode"]]) {
    if (Object.hasOwn(profile, field)) lines.push(`${label}: ${profile[field] || "inherit"}`);
  }
  lines.push("");
  lines.push("When to use:");
  lines.push((profile.when_to_use ?? "").trim() || "(unspecified)");
  lines.push("");
  lines.push("Avoid when:");
  lines.push((profile.avoid_when ?? "").trim() || "(unspecified)");
  if (Array.isArray(profile.tags) && profile.tags.length > 0) {
    lines.push("");
    lines.push(`Tags: ${profile.tags.join(", ")}`);
  }
  if (Array.isArray(profile.extra_args) && profile.extra_args.length > 0) {
    lines.push(`Extra args: ${profile.extra_args.join(" ")}`);
  }
  if (profile.env && Object.keys(profile.env).length > 0) {
    lines.push(`Env: ${Object.entries(profile.env).map(([k, v]) => `${k}=${v}`).join(" ")}`);
  }
  if (profile.notes) {
    lines.push("");
    lines.push("Notes:");
    lines.push(profile.notes.trim());
  }
  if (profile.origin === "project-override") {
    const summary = diffSummary(profile, globalProfile);
    if (summary) {
      lines.push("");
      lines.push(`Overridden fields: ${summary}`);
    }
  } else if (profile.origin === "project-only") {
    lines.push("");
    lines.push("Source: project-only profile");
  }
  return lines.join("\n");
}
