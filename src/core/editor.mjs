/**
 * Profile editing shared by the Ink TUI and the Herdr app editor.
 *
 * Both editors open a draft, change one field at a time, and save it to the
 * global or the project layer. The rules for which fields show, how a typed
 * value becomes a field value, and what a save or a delete writes live here so
 * the two front ends cannot drift apart.
 */
import { deleteProfile, ensureGlobalConfig, loadConfig, upsertProfile } from "./store.mjs";
import { diffFields, mergeProfiles, overrideDelta, patchProfile, sameValue } from "./merge.mjs";
import { COSTS, KNOWN_HARNESSES } from "./schema.mjs";
import { findProjectConfig, globalConfigPath, projectConfigPath } from "./paths.mjs";
import { cachedModels, detectHarnesses, dryRun, effortLevels, listModelsAsync, modelEffort, withModelEffort } from "./detect.mjs";
import { PERMISSION_FIELDS, permissionOptions, permissionValue, validatePermissions } from "./permissions.mjs";

export const EDITABLE = ["name", "harness", "model", "effort", "sandbox", "approval_policy", "permission_mode", "cost", "when_to_use", "avoid_when", "extra_args", "tags"];

export function labelOf(field) {
  return {
    name: "Name",
    harness: "Harness",
    model: "Model",
    effort: "Effort",
    sandbox: "Sandbox (Codex)",
    approval_policy: "Approval (Codex)",
    permission_mode: "Permissions",
    cost: "Cost",
    when_to_use: "When",
    avoid_when: "Avoid",
    extra_args: "Extra args",
    tags: "Tags",
  }[field];
}

/** Fields the editor shows; effort is hidden when the model id already fixes it. */
export function editableFields(draft) {
  return EDITABLE.filter((field) => {
    if (field === "effort") return !modelEffort(draft?.harness, draft?.model);
    return !PERMISSION_FIELDS.includes(field) || permissionOptions(draft?.harness, field).length > 0;
  });
}

/** Value of an editable field as the editor shows it (permissions can be inherited). */
export function fieldValueOf(profile, field) {
  return PERMISSION_FIELDS.includes(field) ? permissionValue(profile, field) : profile?.[field];
}

/** Editable fields whose value differs from the global profile. */
export function differingFields(draft, globalProfile) {
  if (!draft || !globalProfile) return new Set();
  return new Set(
    editableFields(draft).filter((field) => !sameValue(fieldValueOf(draft, field), fieldValueOf(globalProfile, field))),
  );
}

/** Lower-case field names for the "differs from global" summary. */
export function fieldNames(keys) {
  const order = (key) => (EDITABLE.includes(key) ? EDITABLE.indexOf(key) : EDITABLE.length);
  return [...keys].sort((a, b) => order(a) - order(b)).map((key) => (labelOf(key) ?? key).replace(/ (.*)$/, "").toLowerCase()).join(", ");
}

/**
 * Rows offered for the focused field; empty means free-form text.
 *
 * Every row is a record — never a bare string — so the picker keeps the
 * metadata it filters and sorts on (a model's label and context size). The
 * effort levels come from the *selected* model, not the union of the catalog,
 * because a harness can reject a level its other models accept.
 */
export function fieldOptions(draft, cursor, catalog, detection) {
  const field = editableFields(draft)[cursor];
  if (PERMISSION_FIELDS.includes(field)) {
    return ["inherit", ...permissionOptions(draft.harness, field)].map((id) => ({ id }));
  }
  if (field === "harness") {
    const ids = new Set([...KNOWN_HARNESSES, "custom"]);
    for (const entry of detection ?? []) ids.add(entry.id);
    return [...ids].map((id) => ({ id }));
  }
  if (field === "cost") return COSTS.map((id) => ({ id }));
  if (field === "effort") {
    const models = catalog?.models ?? [];
    const selected = models.find((model) => model.id === draft.model);
    const levels = effortLevels(draft.harness, { models: selected ? [selected] : models });
    return levels.map((id) => ({ id }));
  }
  if (field === "model") {
    return (catalog?.models ?? []).map((model) => ({ ...model }));
  }
  return [];
}

/** True when the draft differs from the snapshot taken when editing began. */
export function draftIsDirty(draft, baseline) {
  return baseline === null || JSON.stringify(draft) !== baseline;
}

export function blankDraft() {
  return {
    id: "",
    name: "",
    harness: "claude",
    model: "",
    effort: "medium",
    cost: "normal",
    when_to_use: "",
    avoid_when: "",
  };
}

/**
 * Text -> value for a field.
 *
 * List fields split on whitespace and commas, but a quoted segment keeps its
 * spaces, so an argument like "C:/Program Files/app" survives a round trip. Without
 * this, opening Extra args and confirming would shred any path containing a
 * space into separate arguments.
 */
function parseFieldValue(field, raw) {
  if (field === "extra_args" || field === "tags") return splitListInput(raw);
  return raw;
}

/**
 * Changing harness must not carry a permission policy into a different adapter,
 * and a model id that fixes the effort sets it.
 */
export function applyFieldValue(draft, field, raw) {
  const value = PERMISSION_FIELDS.includes(field) && raw === "inherit" ? "" : parseFieldValue(field, raw);
  const next = { ...draft, [field]: value };
  if (field === "harness" && value !== draft.harness) {
    for (const key of PERMISSION_FIELDS) {
      if (Object.hasOwn(draft, key)) next[key] = "";
    }
    if ((draft.harness === "claude" || draft.harness === "codex") && draft.mode) next.mode = "";
  }
  return withModelEffort(next);
}

/** Split a list input, honouring single and double quotes. */
export function splitListInput(raw) {
  const text = String(raw ?? "");
  const out = [];
  let current = "";
  let quote = null;
  for (const char of text) {
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === "," || /\s/.test(char)) {
      if (current) out.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  if (current) out.push(current);
  return out;
}

/** Text a field is opened with for typing. */
export function formatListInputValue(field, value) {
  if (field === "extra_args" || field === "tags") return formatListInput(value);
  return String(value ?? "");
}

/** Render a list value so it round-trips through splitListInput. */
export function formatListInput(value) {
  if (!Array.isArray(value)) return "";
  return value
    .map((item) => {
      const text = String(item);
      return /\s/.test(text) ? `"${text}"` : text;
    })
    .join(" ");
}

/** Slug used when a new profile is saved without an explicit id. */
export function deriveId(name) {
  return String(name ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[-._]+|[-._]+$/g, "");
}

/** The registry as an editor sees it from one project. */
export function loadEditorState({ projectRoot, globalPath = globalConfigPath() }) {
  const projectPath = findProjectConfig(projectRoot);
  ensureGlobalConfig({ globalPath });
  const loaded = loadConfig({ globalPath, projectPath });
  const projectProfiles = loaded.project?.profiles ?? [];
  const merged = mergeProfiles(loaded.profiles, projectProfiles);
  return {
    globalPath,
    projectPath,
    // The project file that is actually in effect; a new one is created at the root.
    projectTarget: projectPath ?? projectConfigPath(projectRoot),
    profiles: merged.profiles,
    globalProfiles: loaded.profiles ?? [],
    projectProfiles,
  };
}

/**
 * What an open editor is working on. It decides which save targets apply:
 *   "global"   a global profile            global edits it, project saves an override
 *   "override" a global profile that this project already overrides (same targets)
 *   "project"  a project-only profile      project saves it; there is no global copy
 *   "new"      a new or copied profile     either target
 */
export function editKindOf(profile) {
  if (profile.origin === "project-only") return "project";
  if (profile.origin === "project-override") return "override";
  return "global";
}

/**
 * A draft to edit. `mode` is "edit" (the profile itself), "copy" (a new profile
 * seeded from it), or "new" (a blank one). `baseline` is the snapshot that
 * tells unsaved changes apart; null marks a draft that is always unsaved.
 */
export function openDraft(mode, profile = null) {
  if (mode === "new") {
    const draft = blankDraft();
    return { draft, baseline: JSON.stringify(draft), kind: "new" };
  }
  if (mode === "copy") {
    return {
      draft: { ...profile, id: `${profile.id}-copy`, name: `${profile.name ?? profile.id} Copy` },
      baseline: null,
      kind: "new",
    };
  }
  const draft = { ...profile };
  return { draft, baseline: JSON.stringify(draft), kind: editKindOf(profile) };
}

/** The global profile an open draft is compared against (none for new or project-only). */
export function draftGlobalOf(draft, kind, globalProfiles) {
  if (!draft?.id || (kind !== "global" && kind !== "override")) return null;
  return globalProfiles.find((entry) => entry?.id === draft.id) ?? null;
}

/** Put one field back to the global value. */
export function revertField(draft, globalProfile, field) {
  if (!globalProfile || !differingFields(draft, globalProfile).has(field)) {
    return { ok: false, message: globalProfile ? "this field already matches global" : "no global profile to revert to" };
  }
  const next = { ...draft };
  if (globalProfile[field] === undefined) delete next[field];
  else next[field] = structuredClone(globalProfile[field]);
  return { ok: true, draft: withModelEffort(next), message: `${labelOf(field)} back to the global value` };
}

/**
 * Save a draft to one explicit target.
 *
 * "global" edits the shared profile (only what was changed in this session, so
 * a project override is never baked into the global file). "project" writes
 * only what differs from global, or the whole body for a project-only profile.
 *
 * @returns {{ok: true, message: string} | {ok: false, error: string}}
 */
export function saveProfileDraft({ draft, baseline, target, kind, state }) {
  const refuse = (error) => ({ ok: false, error });
  if (target === "global" && kind === "project") return refuse("project profile — it has no global copy, save it with p");

  const candidate = { ...draft };
  const permissionErrors = validatePermissions(candidate);
  if (permissionErrors.length) return refuse(permissionErrors.join("; "));
  if (!candidate.id) candidate.id = deriveId(candidate.name);
  if (!candidate.id) return refuse("profile needs a name (or an id) before saving");

  const { globalPath, projectTarget, globalProfiles, projectProfiles } = state;
  const isNew = kind === "new";
  const globalProfile = globalProfiles.find((entry) => entry?.id === candidate.id) ?? null;
  const projectEntry = projectProfiles.find((entry) => entry?.id === candidate.id) ?? null;

  // A new or copied profile must never silently replace one that already exists.
  const taken = target === "global" ? globalProfile : globalProfile ?? projectEntry;
  if (isNew && taken) {
    return refuse(`"${candidate.id}" already exists ${taken === globalProfile ? "in global" : "in this project"} — use another name`);
  }

  if (target === "global") {
    const original = baseline ? JSON.parse(baseline) : {};
    const payload = !isNew && globalProfile ? patchProfile(globalProfile, original, candidate) : candidate;
    const result = upsertProfile(globalPath, payload);
    if (!result.ok) return refuse(result.errors.join("; "));
    // An edit to a field this project overrides will not show up here.
    const edited = isNew ? [] : diffFields(candidate, original);
    const shadowed = (draft.overrides ?? []).filter((key) => edited.includes(key));
    return {
      ok: true,
      message: `saved ${candidate.id} to global${shadowed.length ? ` — this project's override still sets ${fieldNames(shadowed)}` : ""}`,
    };
  }

  if (!globalProfile) {
    // Project-only profile: nothing to inherit from, so store the whole body.
    const result = upsertProfile(projectTarget, overrideDelta(candidate, null).entry);
    if (!result.ok) return refuse(result.errors.join("; "));
    return { ok: true, message: `saved ${candidate.id} to project` };
  }

  const { entry, changed } = overrideDelta(candidate, globalProfile);
  if (changed.length === 0) {
    // Back to the global values: the override has nothing left to say.
    if (!projectEntry) return refuse("no differences from global — nothing to save");
    const removed = deleteProfile(projectTarget, candidate.id);
    if (!removed.ok) return refuse(removed.errors.join("; "));
    return { ok: true, message: `${candidate.id} matches global again — project override removed` };
  }
  const result = upsertProfile(projectTarget, entry, { partial: true });
  if (!result.ok) return refuse(result.errors.join("; "));
  return { ok: true, message: `saved ${candidate.id} as project override (${fieldNames(changed)})` };
}

/**
 * What deleting or resetting a listed profile would do, with the question to
 * confirm it. Only a project-only profile lives in the project file; anything
 * else is a global profile, so delete removes it from global (and its project
 * override with it), while reset drops just the override.
 */
export function planRemoval(profile, action, state) {
  const name = profile.name ?? profile.id;
  if (action === "reset") {
    if (profile.origin !== "project-override") {
      return {
        ok: false,
        error: profile.origin === "project-only"
          ? "project profiles have no global copy to reset to — edit them directly"
          : "no project override to reset",
      };
    }
    return { ok: true, action, id: profile.id, scope: "project", path: state.projectTarget, question: `reset "${name}" to the global profile?` };
  }
  const projectOnly = profile.origin === "project-only";
  const overridden = profile.origin === "project-override";
  const scope = projectOnly ? "project" : "global";
  return {
    ok: true,
    action: "delete",
    id: profile.id,
    scope,
    path: projectOnly ? state.projectTarget : state.globalPath,
    // Deleting a global profile must not leave its override behind: it would
    // reappear as a half-formed project entry.
    overridePath: overridden ? state.projectTarget : null,
    question: `delete "${name}" from ${scope}${overridden ? " and its project override" : ""}?`,
  };
}

/** Carry out a plan from `planRemoval`. */
export function applyRemoval(plan) {
  const result = deleteProfile(plan.path, plan.id);
  if (!result.ok) return { ok: false, error: result.errors.join("; ") };
  if (plan.overridePath) deleteProfile(plan.overridePath, plan.id);
  return {
    ok: true,
    message: plan.action === "reset" ? `reset ${plan.id} — it follows the global profile again` : `deleted ${plan.id} from ${plan.scope}`,
  };
}

/**
 * Every editable field of a draft as an editor shows it: its display value, the
 * text it opens with for typing, whether it differs from the global profile,
 * and the choices it offers (null for free-form text).
 *
 * `catalog` is the draft harness's model list, or null while it is still being
 * read; the model field then offers an empty, pending list rather than text.
 */
export function describeFields(draft, { globalProfile = null, catalog = null, detection = [] } = {}) {
  const differs = differingFields(draft, globalProfile);
  const harness = draft.harness ?? "claude";
  return editableFields(draft).map((field, cursor) => {
    const value = fieldValueOf(draft, field);
    const options = fieldOptions(draft, cursor, catalog, detection);
    const row = {
      field,
      label: labelOf(field),
      value: PERMISSION_FIELDS.includes(field) ? value || "inherit" : formatListInputValue(field, value),
      text: formatListInputValue(field, draft[field]),
      differs: differs.has(field),
      global: differs.has(field) ? formatListInputValue(field, fieldValueOf(globalProfile, field)) || "(unset)" : null,
      options: options.length > 0 ? options : null,
      pending: false,
      note: null,
    };
    if (field === "model" && options.length === 0) {
      // Explain an empty picker instead of showing nothing. A harness with no
      // catalog accepts a free-form value; a failed lookup is a different problem.
      if (!catalog) Object.assign(row, { options: [], pending: true });
      else if (catalog.noCatalog) row.note = `${harness} does not list models — type the id`;
      else if (catalog.error) row.note = `${harness} model list failed: ${String(catalog.error).split("\n")[0].slice(0, 60)}`;
      else row.note = `${harness} model list is empty`;
    }
    return row;
  });
}

/**
 * One request from an editor that runs out of process (the Herdr app mod).
 * Every action reads the registry afresh, so the caller keeps nothing but its
 * draft between requests. The answer is JSON-safe; `ok: false` carries `error`.
 *
 *   state                               profiles, files, and detected harnesses
 *   open   {mode, id?}                  a draft: "edit" or "copy" a profile, or "new"
 *   view   {draft, kind, baseline,      the draft's fields, after setting one field
 *           set?, revert?, catalogError?}  or reverting one to its global value
 *   models {harness, refresh?}          read a harness's model list into the cache
 *   test   {draft}                      the launch dry run
 *   save   {draft, baseline, kind, target}
 *   remove {id, action, confirmed?}     "delete" or "reset"; unconfirmed returns the question
 */
export async function runEditorAction(action, input, { projectRoot }) {
  const state = loadEditorState({ projectRoot });
  const findProfile = (id) => state.profiles.find((profile) => profile.id === id) ?? null;
  switch (action) {
    case "state":
      return {
        ok: true,
        globalPath: state.globalPath,
        projectPath: state.projectPath,
        projectTarget: state.projectTarget,
        profiles: state.profiles.map((profile) => ({ ...profile, differing: fieldNames(profile.differs ?? []) })),
        detection: detectHarnesses().map(({ id, detected, path }) => ({ id, detected, path })),
      };
    case "open": {
      if (input.mode === "new") return { ok: true, ...openDraft("new") };
      const profile = findProfile(input.id);
      if (!profile) return { ok: false, error: `profile "${input.id}" not found` };
      return { ok: true, ...openDraft(input.mode === "copy" ? "copy" : "edit", profile) };
    }
    case "view": {
      let draft = input.draft;
      let status = null;
      const globalProfile = draftGlobalOf(draft, input.kind, state.globalProfiles);
      if (input.set) draft = applyFieldValue(draft, input.set.field, input.set.value);
      if (input.revert) {
        const reverted = revertField(draft, globalProfile, input.revert);
        if (reverted.ok) draft = reverted.draft;
        status = reverted.message;
      }
      const harness = draft.harness ?? "claude";
      const catalog = cachedModels(harness) ?? (input.catalogError ? { ok: false, models: [], error: input.catalogError } : null);
      return {
        ok: true,
        draft,
        dirty: draftIsDirty(draft, input.baseline ?? null),
        fields: describeFields(draft, { globalProfile, catalog, detection: detectHarnesses() }),
        catalogReady: Boolean(catalog),
        status,
      };
    }
    case "models": {
      // The models.dev refresh behind claude's list would hold the answer back;
      // only an explicit refresh waits for it.
      const refresh = input.refresh === true;
      const result = await listModelsAsync(input.harness, { refresh, offline: !refresh });
      return {
        ok: result.ok,
        harness: input.harness,
        count: result.models.length,
        error: result.ok ? null : result.error ?? "model list failed",
        revalidate: Boolean(result.revalidate),
      };
    }
    case "test": {
      const result = dryRun(input.draft);
      return { ok: true, launchable: result.ok, checks: result.checks };
    }
    case "save":
      return saveProfileDraft({ draft: input.draft, baseline: input.baseline ?? null, target: input.target, kind: input.kind, state });
    case "remove": {
      const profile = findProfile(input.id);
      if (!profile) return { ok: false, error: `profile "${input.id}" not found` };
      const plan = planRemoval(profile, input.action, state);
      if (!plan.ok || !input.confirmed) return plan;
      return applyRemoval(plan);
    }
    default:
      return { ok: false, error: `unknown editor action: ${action}` };
  }
}
