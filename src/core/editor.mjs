/**
 * Profile editing shared by the Ink TUI and the Herdr app editor.
 *
 * Both editors open a draft, change one field at a time, and save it to the
 * global or the project layer. The rules for which fields show, how a typed
 * value becomes a field value, and what a save or a delete writes live here so
 * the two front ends cannot drift apart.
 */
import { deleteProfile, deleteProfileFrom, ensureGlobalConfig, loadConfig, reorderProfiles, upsertProfile } from "./store.mjs";
import { diffFields, mergeProfiles, overrideDelta, patchProfile, sameValue } from "./merge.mjs";
import { COSTS, KNOWN_HARNESSES } from "./schema.mjs";
import { findProjectConfig, globalConfigPath, projectConfigPath } from "./paths.mjs";
import { cachedModels, detectHarnesses, dryRun, effortLevels, groupModelLevels, listModelsAsync, modelBase, modelEffort, withModelEffort } from "./detect.mjs";
import { PERMISSION_FIELDS, permissionOptions, permissionValue, validatePermissions } from "./permissions.mjs";
import { formatEnvInput, maskEnv, parseEnvInput } from "./env.mjs";
import { AUTH_OPTIONS, catalogIdOf, findApiKey } from "./agy.mjs";
import { API_HARNESSES, findKey, listKeys, PROVIDERS, removeKey, saveKey, testKey } from "./keys.mjs";

/** Effort levels from least to most; a level not listed sorts last. */
const EFFORT_ORDER = ["off", "none", "minimal", "low", "medium", "high", "xhigh", "max", "auto"];

export const EDITABLE = ["name", "harness", "api", "auth", "model", "effort", "sandbox", "approval_policy", "permission_mode", "cost", "when_to_use", "avoid_when", "extra_args", "env", "tags"];

export function labelOf(field) {
  return {
    name: "Name",
    harness: "Harness",
    api: "API",
    auth: "Auth (agy)",
    model: "Model",
    effort: "Effort",
    sandbox: "Sandbox (Codex)",
    approval_policy: "Approval (Codex)",
    permission_mode: "Permissions",
    cost: "Cost",
    when_to_use: "When",
    avoid_when: "Avoid",
    extra_args: "Extra args",
    env: "Env",
    tags: "Tags",
  }[field];
}

/**
 * Fields the editor shows. API shows for harnesses a stored key can drive.
 * agy's older Auth switch (a key from the worker's environment) shows only on a
 * profile that still sets it, so it can be cleared.
 */
export function editableFields(draft) {
  return EDITABLE.filter((field) => {
    if (field === "api") return API_HARNESSES.includes(draft?.harness ?? "claude");
    if (field === "auth") return draft?.harness === "agy" && Boolean(draft?.auth);
    return !PERMISSION_FIELDS.includes(field) || permissionOptions(draft?.harness, field).length > 0;
  });
}

/** Value of an editable field as the editor compares it: permissions can be inherited. */
export function fieldValueOf(profile, field) {
  return PERMISSION_FIELDS.includes(field) ? permissionValue(profile, field) : profile?.[field];
}

/**
 * What a field shows when it is not being typed into; secrets stay masked, and
 * an agy model shows without the level its Effort field holds.
 */
export function fieldDisplay(draft, field) {
  const value = fieldValueOf(draft, field);
  if (PERMISSION_FIELDS.includes(field)) return value || "inherit";
  if (field === "auth") return value || "subscription";
  if (field === "api") return value || "subscription";
  if (field === "model") return modelBase(draft?.harness, value) ?? "";
  return formatListInputValue(field, value);
}

/** Text a field opens with for typing; secrets stay masked. */
export function fieldText(draft, field) {
  return formatListInputValue(field, fieldValueOf(draft, field));
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
 * because a harness can reject a level its other models accept. agy lists one
 * id per level; those show as one model whose levels are its efforts.
 */
export function fieldOptions(draft, cursor, catalog, detection) {
  const field = editableFields(draft)[cursor];
  if (PERMISSION_FIELDS.includes(field)) {
    return ["inherit", ...permissionOptions(draft.harness, field)].map((id) => ({ id }));
  }
  if (field === "auth") return AUTH_OPTIONS.map((id) => ({ id }));
  if (field === "api") return apiOptions(draft);
  if (field === "harness") {
    const ids = new Set([...KNOWN_HARNESSES, "custom"]);
    for (const entry of detection ?? []) ids.add(entry.id);
    return [...ids].map((id) => ({ id }));
  }
  if (field === "cost") return COSTS.map((id) => ({ id }));
  if (field === "effort") {
    const models = modelRows(draft, catalog);
    const selected = models.find((model) => model.id === modelBase(draft.harness, draft.model));
    const levels = effortLevels(draft.harness, { models: selected ? [selected] : models });
    // A catalog can list a model's levels in any order; show them low to high.
    const rank = (level) => (EFFORT_ORDER.includes(level) ? EFFORT_ORDER.indexOf(level) : EFFORT_ORDER.length);
    return [...levels].sort((a, b) => rank(a) - rank(b)).map((id) => ({ id }));
  }
  if (field === "model") {
    return modelRows(draft, catalog).map((model) => ({ ...model }));
  }
  return [];
}

/**
 * The API field's choices: the harness's own sign-in, then every stored key
 * whose provider can drive this harness.
 */
function apiOptions(draft) {
  const harness = draft?.harness ?? "claude";
  const rows = [{ id: "subscription", label: `${harness} sign-in (no API key)` }];
  for (const entry of listKeys().keys) {
    if (!entry.harnesses.includes(harness)) continue;
    rows.push({ id: entry.id, label: `${entry.providerLabel} · ${entry.masked}${entry.label ? ` · ${entry.label}` : ""}` });
  }
  return rows;
}

function modelRows(draft, catalog) {
  const models = catalog?.models ?? [];
  return draft?.harness === "agy" ? groupModelLevels(models) : models;
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
 * space into separate arguments. Env shows masked values, so a masked entry
 * keeps the value it had (`previous`).
 */
function parseFieldValue(field, raw, previous) {
  if (field === "extra_args" || field === "tags") return splitListInput(raw);
  if (field === "env") return parseEnvInput(splitListInput(raw), previous);
  return raw;
}

/**
 * Changing harness must not carry a permission policy or agy's Auth into a
 * different adapter, and a model id that fixes the effort sets it.
 *
 * agy's leveled ids are edited as a model and an effort: picking a model from
 * the grouped list (`catalog`) adds the level, keeping the current effort when
 * that model offers it, and changing Effort swaps the id's level.
 */
export function applyFieldValue(draft, field, raw, catalog = null) {
  const inherits = (PERMISSION_FIELDS.includes(field) && raw === "inherit") ||
    ((field === "auth" || field === "api") && raw === "subscription");
  let value = inherits ? "" : parseFieldValue(field, raw, draft[field]);
  if (field === "model" && draft.harness === "agy") value = withLevel(value, draft.effort, catalog);
  const next = { ...draft, [field]: value };
  if (field === "effort" && modelEffort(draft.harness, draft.model)) {
    next.model = `${modelBase(draft.harness, draft.model)}-${value}`;
  }
  if (field === "harness" && value !== draft.harness) {
    for (const key of PERMISSION_FIELDS) {
      if (Object.hasOwn(draft, key)) next[key] = "";
    }
    if (Object.hasOwn(draft, "auth")) next.auth = "";
    // A key whose provider cannot drive the new harness would only fail at launch.
    const provider = draft.api ? findKey(draft.api)?.provider : null;
    if (draft.api && !(provider && Object.hasOwn(PROVIDERS[provider]?.harnesses ?? {}, value))) next.api = "";
    if ((draft.harness === "claude" || draft.harness === "codex") && draft.mode) next.mode = "";
  }
  return withModelEffort(next);
}

/** A grouped agy model id with a level appended: `effort` when offered, else medium, else its first. */
function withLevel(model, effort, catalog) {
  const group = groupModelLevels(catalog?.models ?? []).find((row) => row.id === model && row.efforts?.length);
  if (!group) return model;
  const level = group.efforts.includes(effort) ? effort : group.efforts.includes("medium") ? "medium" : group.efforts[0];
  return `${model}-${level}`;
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

/** Text a field is opened with for typing; env values stay masked. */
export function formatListInputValue(field, value) {
  if (field === "extra_args" || field === "tags") return formatListInput(value);
  if (field === "env") return formatEnvInput(value);
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

/** Carry out a plan from `planRemoval`: the profile and its override go together or not at all. */
export function applyRemoval(plan) {
  const result = deleteProfileFrom(plan.overridePath ? [plan.overridePath, plan.path] : [plan.path], plan.id);
  if (!result.ok) return { ok: false, error: result.errors.join("; ") };
  return {
    ok: true,
    message: plan.action === "reset" ? `reset ${plan.id} — it follows the global profile again` : `deleted ${plan.id} from ${plan.scope}`,
  };
}

/**
 * Move a listed profile within its group.
 *
 * The list shows global profiles in the order of the global file, then the
 * project-only profiles in the order of the project file. A project override
 * only changes fields, never the place: moving an overridden profile reorders
 * the global file, and where the override sits in the project file does not
 * matter. So a profile moves only among the profiles of its own group.
 *
 * `how` is one of {direction: "up"|"down"}, {before: id}, {after: id}.
 * `index` in the answer is the profile's new place in `state.profiles`, so an
 * editor's selection can follow it; moving past either end changes nothing.
 */
export function moveProfile(state, id, how = {}) {
  const profile = state.profiles.find((entry) => entry.id === id);
  if (!profile) return { ok: false, error: `profile "${id}" not found` };
  const scope = profile.origin === "project-only" ? "project" : "global";
  const groupOf = (entry) => (entry.origin === "project-only" ? "project" : "global");
  const group = state.profiles.filter((entry) => groupOf(entry) === scope).map((entry) => entry.id);
  const offset = scope === "project" ? state.profiles.length - group.length : 0;
  const from = group.indexOf(id);

  const before = how.before ?? null;
  const after = how.after ?? null;
  const direction = how.direction ?? null;
  if ([before, after, direction].filter((value) => value !== null).length !== 1) {
    return { ok: false, error: "say where to move: exactly one of up, down, before ID, after ID" };
  }
  const anchor = before ?? after;
  const where = anchor !== null ? `${after !== null ? "after" : "before"} ${anchor}` : direction;
  let to;
  if (anchor !== null) {
    if (anchor === id) return { ok: false, error: `cannot move ${id} relative to itself` };
    const other = state.profiles.find((entry) => entry.id === anchor);
    if (!other) return { ok: false, error: `profile "${anchor}" not found` };
    if (groupOf(other) !== scope) {
      return { ok: false, error: `${id} is a ${scope} profile and ${anchor} is a ${groupOf(other)} profile; a profile moves only among the ${scope} profiles` };
    }
    to = group.filter((entry) => entry !== id).indexOf(anchor) + (after !== null ? 1 : 0);
  } else if (direction === "up" || direction === "down") {
    to = Math.max(0, Math.min(group.length - 1, from + (direction === "up" ? -1 : 1)));
  } else {
    return { ok: false, error: `unknown direction "${direction}": use up or down` };
  }

  const answer = { ok: true, id, scope, index: offset + to };
  if (to === from) {
    const already = anchor !== null ? where : direction === "up" ? "first" : "last";
    return { ...answer, moved: false, path: null, message: `${id} is already ${already} among the ${scope} profiles` };
  }
  const order = group.filter((entry) => entry !== id);
  order.splice(to, 0, id);
  const file = scope === "project" ? state.projectPath : state.globalPath;
  const result = reorderProfiles(file, order);
  if (!result.ok) return { ok: false, error: result.errors.join("; ") };
  return { ...answer, moved: true, path: file, order, message: `moved ${id} ${where}` };
}

/**
 * Every editable field of a draft as an editor shows it: its display value, the
 * text it opens with for typing, whether it differs from the global profile,
 * and the choices it offers (null for free-form text).
 *
 * `catalog` is the draft's model list (see `catalogIdOf`), or null while it is
 * still being read; the model field then offers an empty, pending list rather than text.
 */
export function describeFields(draft, { globalProfile = null, catalog = null, detection = [] } = {}) {
  const differs = differingFields(draft, globalProfile);
  const harness = draft.harness ?? "claude";
  return editableFields(draft).map((field, cursor) => {
    const options = fieldOptions(draft, cursor, catalog, detection);
    const row = {
      field,
      label: labelOf(field),
      value: fieldDisplay(draft, field),
      text: fieldText(draft, field),
      differs: differs.has(field),
      global: differs.has(field) ? fieldText(globalProfile, field) || "(unset)" : null,
      options: options.length > 0 ? options : null,
      pending: false,
      note: null,
    };
    if (field === "api") {
      const stored = draft.api ? findKey(draft.api) : null;
      if (draft.api && !stored) row.note = `no stored key "${draft.api}": add it in the API tab`;
      else if (stored) row.note = `${PROVIDERS[stored.provider]?.label ?? stored.provider} API, billed to that key`;
      else if (options.length <= 1) row.note = `no stored key for ${harness}: add one in the API tab`;
    }
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
 *           set?, revert?, catalogError?}  or reverting one to its global value; `catalog`
 *                                       names the model list the draft uses
 *   models {catalog, refresh?}          read a model list into the cache (a harness
 *                                       id, or `agy-api`)
 *   test   {draft}                      the launch dry run
 *   save   {draft, baseline, kind, target}
 *   remove {id, action, confirmed?}     "delete" or "reset"; unconfirmed returns the question
 *   move   {id, direction|before|after}  move a profile up or down within its group
 *                                       (`index` is its new place in the list)
 *   keys                                stored API keys (masked), who uses them, and providers
 *   key.save {id, provider, key, label?}  store a key; an empty key keeps the stored one
 *   key.remove {id} / key.test {id}     delete a key / ask its provider whether it works
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
        profiles: state.profiles.map((profile) => ({ ...profile, env: maskEnv(profile.env), differing: fieldNames(profile.differs ?? []) })),
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
      if (input.set) draft = applyFieldValue(draft, input.set.field, input.set.value, cachedModels(catalogIdOf(draft)));
      if (input.revert) {
        const reverted = revertField(draft, globalProfile, input.revert);
        if (reverted.ok) draft = reverted.draft;
        status = reverted.message;
      }
      const catalogId = catalogIdOf(draft);
      const catalog = cachedModels(catalogId) ?? (input.catalogError ? { ok: false, models: [], error: input.catalogError } : null);
      return {
        ok: true,
        draft,
        dirty: draftIsDirty(draft, input.baseline ?? null),
        fields: describeFields(draft, { globalProfile, catalog, detection: detectHarnesses() }),
        catalog: catalogId,
        catalogReady: Boolean(catalog),
        status,
      };
    }
    case "models": {
      // The models.dev refresh behind claude's list would hold the answer back;
      // only an explicit refresh waits for it.
      const refresh = input.refresh === true;
      // A key saved in an api-key profile can look up agy's API models too.
      const apiKey = findApiKey(process.env, state.profiles);
      const result = await listModelsAsync(input.catalog, { refresh, offline: !refresh, apiKey });
      return {
        ok: result.ok,
        catalog: input.catalog,
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
    case "move":
      return moveProfile(state, input.id, input);
    case "keys": {
      const store = listKeys();
      if (!store.ok) return { ok: false, error: store.error };
      return {
        ok: true,
        path: store.path,
        keys: store.keys.map((key) => ({ ...key, profiles: state.profiles.filter((profile) => profile.api === key.id).map((profile) => profile.id) })),
        providers: Object.entries(PROVIDERS).map(([id, provider]) => ({ id, label: provider.label, site: provider.site, harnesses: Object.keys(provider.harnesses) })),
      };
    }
    case "key.save":
      return saveKey(input);
    case "key.remove":
      return removeKey(input.id);
    case "key.test":
      return { ...(await testKey(input.id)), id: input.id };
    default:
      return { ok: false, error: `unknown editor action: ${action}` };
  }
}
