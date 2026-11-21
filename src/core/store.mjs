/**
 * Config store: read both config layers, save profiles, write atomically.
 *
 * A save edits the file as text: it changes only the keys and blocks it was
 * asked to change, so comments, unknown keys, other tables, blank lines and
 * line endings stay as the user wrote them. A layout that cannot be edited
 * that way is refused and the file is left as it was. Writes go through a
 * temp file plus rename to avoid truncating a valid file on failure.
 */
import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  defaultTemplate,
  isPlainObject,
  parseConfig,
  serializeConfig,
  validateProfile,
  KNOWN_FIELDS,
  OPTIONAL_MAP_FIELDS,
} from "./schema.mjs";
import { findProjectConfig, globalConfigPath } from "./paths.mjs";

export function readConfigFile(filePath, fsImpl = fs) {
  if (!fsImpl.existsSync(filePath)) {
    return { ok: true, exists: false, doc: null, profiles: [], invalid: [], source: filePath };
  }
  const text = fsImpl.readFileSync(filePath, "utf8");
  const result = parseConfig(text, filePath);
  return { ...result, exists: true };
}

/**
 * Load global and project layers.
 * @returns {{
 *   global: object, project: object|null,
 *   profiles: object[], invalid: Array<object>, errors: string[]
 * }}
 */
export function loadConfig(options = {}) {
  const fsImpl = options.fs ?? fs;
  const globalPath = options.globalPath ?? globalConfigPath(options.env ?? process.env);
  const projectPath =
    options.projectPath ?? findProjectConfig(options.cwd ?? process.cwd(), fsImpl);

  const global = readConfigFile(globalPath, fsImpl);
  const project = projectPath ? readConfigFile(projectPath, fsImpl) : null;

  const errors = [];
  if (!global.ok) errors.push(global.error);
  if (project && !project.ok) errors.push(project.error);

  return {
    globalPath,
    projectPath: projectPath ?? null,
    global,
    project,
    profiles: global.profiles ?? [],
    invalid: [...(global.invalid ?? []), ...((project?.invalid) ?? [])],
    errors,
  };
}

/** Deep-clone a TOML value so callers never mutate the parsed doc. */
function clone(value) {
  if (Array.isArray(value)) return value.map(clone);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clone(item)]));
  }
  return value;
}

/** Copy only known profile fields from `input`; unknown keys are dropped. */
export function pickKnownFields(input) {
  const out = {};
  for (const [key, value] of Object.entries(input)) {
    if (KNOWN_FIELDS.has(key)) out[key] = clone(value);
  }
  return out;
}

/**
 * Validate and normalize a profile before writing.
 * @param {object} input
 * @param {{partial?: boolean}} [options] partial accepts a project override that
 *   only carries the fields it changes; an id is still required.
 * @returns {{ok: boolean, errors: string[], profile: object|null}}
 */
export function prepareProfile(input, options = {}) {
  const profile = pickKnownFields(input);
  const partial = options.partial === true;
  const { errors } = validateProfile(profile, { requireAll: !partial });
  if (partial && !profile.id) errors.push("missing required field: id");
  return { ok: errors.length === 0, errors, profile: errors.length === 0 ? profile : null };
}

function writeAtomically(filePath, text, fsImpl = fs) {
  fsImpl.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.tmp`;
  fsImpl.writeFileSync(tmp, text, "utf8");
  fsImpl.renameSync(tmp, filePath);
}

/** Create the global config with the default template if absent. */
export function ensureGlobalConfig(options = {}) {
  const fsImpl = options.fs ?? fs;
  const filePath = options.globalPath ?? globalConfigPath(options.env ?? process.env);
  if (fsImpl.existsSync(filePath)) return { created: false, path: filePath };
  const doc = defaultTemplate();
  writeAtomically(filePath, serializeConfig(doc), fsImpl);
  return { created: true, path: filePath };
}

/**
 * Open a config file for a text edit: its text (a byte-order mark kept as
 * text) and the parsed document. Bytes that are not UTF-8 are refused rather
 * than replaced.
 * @returns {{text: string, doc: object} | {error: string, refused?: boolean}}
 */
function openForEdit(targetPath, fsImpl) {
  const raw = fsImpl.readFileSync(targetPath);
  let text = raw;
  if (typeof raw !== "string") {
    try {
      text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(raw);
    } catch {
      return { error: "the file is not valid UTF-8", refused: true };
    }
  }
  const loaded = parseConfig(text, targetPath);
  if (!loaded.ok) return { error: loaded.error };
  return { text, doc: loaded.doc };
}

function refuseSave(targetPath, reason) {
  return `${targetPath}: not saved, the file is unchanged: ${reason}. Edit the file by hand.`;
}

/**
 * Check that `text` parses to exactly `expected`.
 * @returns {string|null} the refusal, or null when it does
 */
function checkEdit(targetPath, text, expected) {
  const check = parseConfig(text, targetPath);
  if (!check.ok || !sameValue(check.doc, expected)) {
    return refuseSave(targetPath, "editing the file as text would change more than the profile");
  }
  return null;
}

/** Write `text` only when it parses to exactly `expected`; otherwise refuse. */
function writeChecked(targetPath, text, expected, fsImpl) {
  const refused = checkEdit(targetPath, text, expected);
  if (!refused) writeAtomically(targetPath, text, fsImpl);
  return refused;
}

/**
 * Deep equality of TOML values. The parser makes tables without a prototype,
 * so prototypes are ignored; own keys are compared, `__proto__` included.
 */
function sameValue(a, b) {
  return isDeepStrictEqual(structuredClone(a), structuredClone(b));
}

function ownValue(table, key) {
  return Object.hasOwn(table, key) ? table[key] : undefined;
}

/**
 * Insert or replace a profile in a config file.
 *
 * A new profile is appended as a `[[profiles]]` block. An existing one is
 * edited in place: only its known fields that change are written, and its
 * unknown keys stay. Every other byte of the file stays as it was.
 * @returns {{ok: boolean, errors: string[], created: boolean}}
 */
export function upsertProfile(targetPath, profile, options = {}) {
  const fsImpl = options.fs ?? fs;
  const exists = fsImpl.existsSync(targetPath);
  const opened = exists ? openForEdit(targetPath, fsImpl) : { text: "", doc: { version: 1 } };
  if (opened.error) {
    return { ok: false, errors: [opened.refused ? refuseSave(targetPath, opened.error) : opened.error], created: false };
  }

  const prepared = prepareProfile(profile, { partial: options.partial === true });
  if (!prepared.ok) return { ok: false, errors: prepared.errors, created: false };

  const { doc } = opened;
  const list = Array.isArray(doc.profiles) ? doc.profiles : [];
  const index = list.findIndex((entry) => entry?.id === prepared.profile.id);
  const created = index < 0;
  // An existing entry keeps the keys this tool does not know.
  const next = created ? prepared.profile : { ...unknownFieldsOf(list[index]), ...prepared.profile };
  const expected = { ...doc, profiles: created ? [...list, next] : list.map((entry, i) => (i === index ? next : entry)) };
  if (!exists) {
    writeAtomically(targetPath, serializeConfig(expected), fsImpl);
    return { ok: true, errors: [], created };
  }

  const change = created ? { append: next } : { index, before: list[index], after: next };
  const edited = editProfiles(opened.text, list.length, change);
  if (edited.error) return { ok: false, errors: [refuseSave(targetPath, edited.error)], created: false };
  const refused = writeChecked(targetPath, edited.text, expected, fsImpl);
  if (refused) return { ok: false, errors: [refused], created: false };
  return { ok: true, errors: [], created };
}

/**
 * Remove a profile by id: its `[[profiles]]` block, its sub-tables and the
 * comment lines directly above its header. Missing ids are reported, not
 * invented.
 */
export function deleteProfile(targetPath, id, options = {}) {
  return deleteProfileFrom([targetPath], id, options);
}

/**
 * Remove a profile by id from several files, all or none: every file must
 * hold the id and be editable before any is written. They are written in the
 * order given, so put a project override before its global profile: if a
 * write fails midway, the override is gone and the profile is still whole.
 * @returns {{ok: boolean, errors: string[], removed: boolean}}
 */
export function deleteProfileFrom(targetPaths, id, options = {}) {
  const fsImpl = options.fs ?? fs;
  const planned = [];
  for (const targetPath of targetPaths) {
    const plan = planDelete(targetPath, id, fsImpl);
    if (plan.error) {
      const others = targetPaths.filter((other) => other !== targetPath);
      const errors = [plan.error];
      if (others.length > 0) errors.push(`nothing was removed from ${others.join(", ")} either`);
      return { ok: false, errors, removed: false };
    }
    planned.push({ targetPath, text: plan.text });
  }
  for (const { targetPath, text } of planned) writeAtomically(targetPath, text, fsImpl);
  return { ok: true, errors: [], removed: true };
}

/** The text of `targetPath` with profile `id` removed, checked, or the reason it cannot be. */
function planDelete(targetPath, id, fsImpl) {
  if (!fsImpl.existsSync(targetPath)) return { error: `${targetPath}: config not found` };
  const opened = openForEdit(targetPath, fsImpl);
  if (opened.error) return { error: opened.refused ? refuseSave(targetPath, opened.error) : opened.error };
  const { doc } = opened;
  const list = Array.isArray(doc.profiles) ? doc.profiles : [];
  const indexes = list.flatMap((entry, index) => (entry?.id === id ? [index] : []));
  if (indexes.length === 0) return { error: `profile "${id}" not found in ${targetPath}` };
  const rest = list.filter((entry) => entry?.id !== id);
  // With its last block gone the file has no `profiles` key at all.
  const { profiles: _profiles, ...others } = doc;
  const expected = rest.length > 0 ? { ...others, profiles: rest } : others;

  const edited = editProfiles(opened.text, list.length, { remove: indexes });
  if (edited.error) return { error: refuseSave(targetPath, edited.error) };
  const refused = checkEdit(targetPath, edited.text, expected);
  return refused ? { error: refused } : { text: edited.text };
}

function unknownFieldsOf(entry) {
  return Object.fromEntries(Object.entries(entry ?? {}).filter(([key]) => !KNOWN_FIELDS.has(key)));
}

/**
 * Read a table header line, `[a.b]` or `[[a.b]]`, into its key parts, so a
 * quoted key such as `["profiles.env"]` stays one part and `"profiles"` is the
 * same key as `profiles`. Returns null when the line is not a header this
 * reader understands.
 * @returns {{array: boolean, parts: string[]} | null}
 */
function parseHeader(s) {
  const array = s.startsWith("[[");
  const key = readKey(s, array ? 2 : 1);
  if (!key) return null;
  const close = array ? "]]" : "]";
  if (!s.startsWith(close, key.i)) return null;
  const rest = s.slice(key.i + close.length).trimStart();
  return rest === "" || rest.startsWith("#") ? { array, parts: key.parts } : null;
}

/**
 * Read a dotted TOML key from `i` into its parts: bare, basic-string and
 * literal-string parts, with spaces around the dots. Stops after the spaces
 * that follow the key. Returns null when the text is not a key.
 * @returns {{parts: string[], i: number} | null}
 */
function readKey(s, i) {
  const parts = [];
  const skipSpace = () => {
    while (s[i] === " " || s[i] === "\t") i++;
  };
  for (;;) {
    skipSpace();
    if (s[i] === '"') {
      let j = i + 1;
      while (j < s.length && s[j] !== '"') j += s[j] === "\\" ? 2 : 1;
      if (j >= s.length) return null;
      const raw = s.slice(i, j + 1);
      // TOML's basic-string escapes are JSON's plus a few rare ones; an escape
      // JSON cannot read keeps its raw text, and the parse check catches any mismatch.
      try {
        parts.push(JSON.parse(raw));
      } catch {
        parts.push(raw);
      }
      i = j + 1;
    } else if (s[i] === "'") {
      const close = s.indexOf("'", i + 1);
      if (close < 0) return null;
      parts.push(s.slice(i + 1, close));
      i = close + 1;
    } else {
      const bare = /^[A-Za-z0-9_-]+/.exec(s.slice(i));
      if (!bare) return null;
      parts.push(bare[0]);
      i += bare[0].length;
    }
    skipSpace();
    if (s[i] !== ".") break;
    i++;
  }
  return { parts, i };
}

/**
 * Follow one line of a TOML value from `i`: strings, brackets, and a comment
 * to the end of the line. `state` carries what is still open into the next
 * line: a multi-line string's delimiter, and the depth of open `[`/`{`.
 * Returns where the line's comment starts, or the line's length.
 */
function scanValue(s, i, state) {
  while (i < s.length) {
    if (state.open !== null) {
      if (state.open === '"""' && s[i] === "\\") {
        i += 2;
      } else if (s.startsWith(state.open, i)) {
        // Up to two more quotes right before the closing three belong to the string.
        let run = 3;
        while (run < 5 && s[i + run] === state.open[0]) run++;
        i += run;
        state.open = null;
      } else {
        i++;
      }
      continue;
    }
    const c = s[i];
    if (c === "#") return i;
    if (s.startsWith('"""', i) || s.startsWith("'''", i)) {
      state.open = s.slice(i, i + 3);
      i += 3;
    } else if (c === '"') {
      i++;
      while (i < s.length && s[i] !== '"') i += s[i] === "\\" ? 2 : 1;
      i++;
    } else if (c === "'") {
      const close = s.indexOf("'", i + 1);
      i = close < 0 ? s.length : close + 1;
    } else {
      if (c === "[" || c === "{") state.depth++;
      else if (c === "]" || c === "}") state.depth--;
      i++;
    }
  }
  return s.length;
}

/**
 * Split a TOML text into lines that keep their own line ending, and say what
 * each line is: "header" (with `header: {array, parts}`), "comment", "blank",
 * or "value" (a key/value line, or a line inside a multi-line string or
 * array). Values are followed across lines, so a `[[profiles]]` line inside a
 * string or an array is never taken for a header. A value line also says
 * whether a key/value starts on it (`start`) and where its comment starts
 * (`end`).
 */
function scanLines(text) {
  const state = { open: null, depth: 0 };
  return text.split(/(?<=\n)/).map((raw) => {
    const eol = raw.endsWith("\r\n") ? "\r\n" : raw.endsWith("\n") ? "\n" : "";
    const line = { text: raw.slice(0, raw.length - eol.length), eol, kind: "value", header: null };
    const top = state.open === null && state.depth === 0;
    if (top) {
      const lead = line.text.replace(/^[\s\uFEFF]+/, "");
      if (lead === "") line.kind = "blank";
      else if (lead.startsWith("#")) line.kind = "comment";
      else if (lead.startsWith("[")) {
        line.kind = "header";
        // A header this reader cannot read is some other table, never a profile.
        line.header = parseHeader(lead) ?? { array: false, parts: [] };
      }
    }
    if (line.kind === "value") {
      line.start = top;
      line.end = scanValue(line.text, 0, state);
    }
    return line;
  });
}

/**
 * Find the `[[profiles]]` blocks of scanned lines. A block is a
 * `[[profiles]]` header, the `[profiles.…]` tables after it, and the comment
 * lines directly above its header; it ends at the next header of any other
 * table. `detached` says a `[profiles.…]` table stands apart from its entry.
 * @returns {{starts: number[], ends: number[], detached: boolean}}
 */
function findBlocks(lines) {
  const starts = [];
  const ends = [];
  let inBlock = false;
  let detached = false;
  lines.forEach((line, i) => {
    if (line.kind !== "header") return;
    let top = i;
    while (top > 0 && lines[top - 1].kind === "comment") top--;
    const { array, parts } = line.header;
    if (array && parts.length === 1 && parts[0] === "profiles") {
      if (inBlock) ends.push(top);
      starts.push(top);
      inBlock = true;
    } else if (parts.length > 1 && parts[0] === "profiles") {
      if (!inBlock) detached = true;
    } else if (inBlock) {
      ends.push(top);
      inBlock = false;
    }
  });
  if (inBlock) ends.push(lines.length);
  return { starts, ends, detached };
}

/** Where the lines `start`..`end` end once the blank lines after them are left out. */
function bodyEnd(lines, start, end) {
  let cut = end;
  while (cut > start + 1 && lines[cut - 1].kind === "blank") cut--;
  return cut;
}

/**
 * Reorder the `[[profiles]]` blocks of a config text without touching any
 * other byte. A block is a `[[profiles]]` header, the `[profiles.…]` tables
 * after it, and the comment lines directly above its header; it ends at the
 * next header of any other table, which stays in its slot. Blank lines after
 * a block stay where they were, and every line keeps its own line ending.
 * `permutation[k]` is the old index of the block that goes to slot k.
 * @returns {{text: string} | {error: string}}
 */
function reorderBlocks(text, permutation) {
  const lines = scanLines(text);
  const { starts, ends, detached } = findBlocks(lines);
  if (detached) {
    return { error: "a [profiles.…] table stands apart from its [[profiles]] entry, so the entries cannot be moved as blocks" };
  }
  if (starts.length !== permutation.length) {
    return { error: "the profiles are not all written as [[profiles]] tables (an inline array, for example)" };
  }

  // A last line without a line ending may move up. The line that ends up last
  // gives its ending to it, so every line ending stays at its place in the file.
  const last = lines.at(-1);
  const bare = last.eol === "";

  const bodies = [];
  const gaps = [];
  starts.forEach((start, k) => {
    const cut = bodyEnd(lines, start, ends[k]);
    bodies.push(lines.slice(start, cut));
    gaps.push(lines.slice(cut, ends[k]));
  });
  const out = [];
  let cursor = 0;
  permutation.forEach((from, slot) => {
    out.push(...lines.slice(cursor, starts[slot]), ...bodies[from], ...gaps[slot]);
    cursor = ends[slot];
  });
  out.push(...lines.slice(cursor));
  const newLast = out.at(-1);
  const eolOf = (line) => (!bare ? line.eol : line === newLast ? "" : line === last ? newLast.eol : line.eol);
  return { text: out.map((line) => line.text + eolOf(line)).join("") };
}

/**
 * Put some profiles of a config file in a new order.
 *
 * `ids` lists the profiles to reorder, in their new order; they take the
 * places those profiles held, so every other entry keeps its place. Only the
 * order changes: the blocks are moved as text, and nothing outside them
 * changes. A layout that cannot be reordered that way is refused and the
 * file is left as it was; it is never rewritten through the serializer.
 * @returns {{ok: boolean, errors: string[]}}
 */
export function reorderProfiles(targetPath, ids, options = {}) {
  const fsImpl = options.fs ?? fs;
  if (!fsImpl.existsSync(targetPath)) return { ok: false, errors: [`${targetPath}: config not found`] };
  const refuse = (reason) => ({
    ok: false,
    errors: [`${targetPath}: not reordered, the file is unchanged: ${reason}. Move the [[profiles]] entries by hand.`],
  });
  const opened = openForEdit(targetPath, fsImpl);
  if (opened.error) return opened.refused ? refuse(opened.error) : { ok: false, errors: [opened.error] };
  const { text, doc } = opened;
  const list = Array.isArray(doc.profiles) ? doc.profiles : [];
  const wanted = new Set(ids);
  const slots = list.flatMap((entry, index) => (wanted.has(entry?.id) ? [index] : []));
  if (wanted.size !== ids.length || slots.length !== ids.length) {
    return { ok: false, errors: [`${targetPath}: ${ids.join(", ")} do not match the profiles in the file`] };
  }
  const indexOf = new Map(slots.map((index) => [list[index].id, index]));
  const permutation = list.map((_entry, index) => index);
  slots.forEach((slot, k) => {
    permutation[slot] = indexOf.get(ids[k]);
  });
  doc.profiles = permutation.map((index) => list[index]);

  const moved = reorderBlocks(text, permutation);
  if (moved.error) return refuse(moved.error);
  if (!isDeepStrictEqual(parseConfig(moved.text, targetPath).doc, doc)) {
    return refuse("moving the entries as text would change what the file means");
  }
  writeAtomically(targetPath, moved.text, fsImpl);
  return { ok: true, errors: [] };
}

const MAP_FIELDS = new Set(OPTIONAL_MAP_FIELDS);

/**
 * Edit the `[[profiles]]` blocks of a config text and nothing else:
 * `{append: profile}` adds a block after the last one, `{remove: [index…]}`
 * deletes blocks, and `{index, before, after}` rewrites the known fields of
 * one block that differ between `before` and `after`. Every other line,
 * a byte-order mark and a missing final newline stay as they were; a new
 * line takes the ending of the line it follows.
 * @param {number} count how many profiles the parsed file has
 * @returns {{text: string} | {error: string}}
 */
function editProfiles(text, count, change) {
  const bom = text.startsWith("\uFEFF") ? "\uFEFF" : "";
  const body = text.slice(bom.length);
  const lines = body === "" ? [] : scanLines(body);
  const { starts, ends, detached } = findBlocks(lines);
  if (detached) {
    return { error: "a [profiles.…] table stands apart from its [[profiles]] entry, so the entries cannot be edited as blocks" };
  }
  if (starts.length !== count) {
    return { error: "the profiles are not all written as [[profiles]] tables (an inline array, for example)" };
  }
  const fileEol = lines.find((line) => line.eol)?.eol ?? "\n";
  const eolAt = (i) => lines[i]?.eol || fileEol;
  const layouts = starts.map((start, k) => blockTables(lines, start, ends[k]));
  // A new table field follows the file: inline when some profile writes one inline.
  const inlineMaps = layouts.some(([main]) => main.entries.some((entry) => entry.parts?.length === 1 && MAP_FIELDS.has(entry.parts[0])));

  const edits = [];
  if (change.append) {
    const at = starts.length ? bodyEnd(lines, starts.at(-1), ends.at(-1)) : lines.length;
    const texts = formatBlock(change.append, inlineMaps);
    if (at > 0 && lines[at - 1].kind !== "blank") texts.unshift("");
    edits.push(insertion(at, texts, eolAt(at - 1)));
  } else if (change.remove) {
    for (const k of change.remove) {
      // The blank lines before the block go with it; at the top of the file, the ones after it.
      let from = starts[k];
      while (from > 0 && lines[from - 1].kind === "blank") from--;
      edits.push({ from, to: from === 0 ? ends[k] : bodyEnd(lines, starts[k], ends[k]), lines: [] });
    }
  } else {
    const fields = fieldEdits(lines, layouts[change.index], change.before, change.after, inlineMaps, eolAt);
    if (fields.error) return fields;
    edits.push(...fields.edits);
  }

  const out = applyEdits(lines, edits);
  const bare = lines.length > 0 && lines.at(-1).eol === "";
  const last = out.length - 1;
  return { text: bom + out.map((line, k) => line.text + (k === last && bare ? "" : line.eol || fileEol)).join("") };
}

/**
 * Split one profile block into its tables: its own keys first (`path` []),
 * then each `[profiles.…]` table, which starts at the comment lines directly
 * above its header. Each entry is one key/value over lines `first`..`last`,
 * its value starting at `valueStart` on the first line; `parts` is null for a
 * key this reader cannot read.
 */
function blockTables(lines, start, end) {
  const tables = [];
  for (let i = start; i < end; i++) {
    const line = lines[i];
    if (line.kind === "header") {
      let top = i;
      while (top > start && lines[top - 1].kind === "comment") top--;
      if (tables.length > 0) tables.at(-1).end = top;
      tables.push({ path: line.header.parts.slice(1), array: line.header.array, top, header: i, end, entries: [] });
    } else if (line.kind === "value" && tables.length > 0) {
      const { entries } = tables.at(-1);
      if (line.start) entries.push(entryAt(line, i));
      else if (entries.length > 0) entries.at(-1).last = i;
    }
  }
  return tables;
}

function entryAt(line, i) {
  const s = line.text;
  const key = readKey(s, s.length - s.trimStart().length);
  if (!key || s[key.i] !== "=") return { parts: null, first: i, last: i, valueStart: 0 };
  let valueStart = key.i + 1;
  while (s[valueStart] === " " || s[valueStart] === "\t") valueStart++;
  return { parts: key.parts, first: i, last: i, valueStart };
}

/**
 * The line edits that turn one profile block from `before` into `after`,
 * known fields only. A changed value is rewritten in place, keeping the key
 * as written and the comment after the value; a removed key's lines go; a new
 * key goes after the block's last own key, a new table field at the end of
 * the block. A table field written key by key (`[profiles.env]` or
 * `env.KEY = …`) is edited key by key the same way.
 * @returns {{edits: object[]} | {error: string}}
 */
function fieldEdits(lines, tables, before, after, inlineMaps, eolAt) {
  if (tables.some((table) => table.entries.some((entry) => entry.parts === null))) {
    return { error: `a key in the "${after.id}" entry cannot be read` };
  }
  const [main, ...subTables] = tables;
  const entries = tables.flatMap((table) => table.entries.map((entry) => ({ ...entry, path: [...table.path, ...entry.parts] })));
  const mainEnd = main.entries.at(-1)?.last ?? main.header;
  const blockEnd = bodyEnd(lines, main.top, tables.at(-1).end);
  const edits = [];
  const fields = new Set([...Object.keys(before), ...Object.keys(after)].filter((key) => KNOWN_FIELDS.has(key)));
  for (const field of fields) {
    const from = before[field];
    const to = after[field];
    if (sameValue(from, to)) continue;
    const own = entries.filter((entry) => entry.path[0] === field);
    const ownTables = subTables.filter((table) => table.path[0] === field);

    if (own.length === 0 && ownTables.length === 0) {
      if (isPlainObject(to) && !inlineMaps) {
        // After the block's last line, and after any key added to its own table.
        edits.push({ ...insertion(blockEnd, ["", `[profiles.${formatKey(field)}]`, ...assignments(to)], eolAt(blockEnd - 1)), rank: 1 });
      } else {
        edits.push(insertion(mainEnd + 1, [`${formatKey(field)} = ${formatValue(to)}`], eolAt(mainEnd)));
      }
      continue;
    }
    if (ownTables.length === 0 && own.length === 1 && own[0].path.length === 1) {
      edits.push(to === undefined ? removal(own[0]) : rewrite(lines, own[0], to));
      continue;
    }

    const holder = ownTables[0] ?? null;
    const keyed =
      isPlainObject(from) &&
      (to === undefined || isPlainObject(to)) &&
      ownTables.length <= 1 &&
      (!holder || (holder.path.length === 1 && !holder.array)) &&
      own.every((entry) => entry.path.length === 2);
    if (!keyed) return { error: `${field} of "${after.id}" is written in a layout this tool cannot edit` };
    if (to === undefined) {
      edits.push(...own.map(removal));
      // Like a removed key: the header line goes with its inline comment, while
      // the comment lines above it and inside the table stay.
      if (holder) edits.push({ from: holder.header, to: holder.header + 1, lines: [] });
      continue;
    }
    const added = [];
    for (const key of new Set([...Object.keys(from), ...Object.keys(to)])) {
      const was = ownValue(from, key);
      const now = ownValue(to, key);
      if (sameValue(was, now)) continue;
      const entry = own.find((item) => item.path[1] === key);
      if (entry) edits.push(now === undefined ? removal(entry) : rewrite(lines, entry, now));
      else added.push(`${holder ? "" : `${formatKey(field)}.`}${formatKey(key)} = ${formatValue(now)}`);
    }
    if (added.length > 0) {
      const anchor = own.length > 0 ? Math.max(...own.map((entry) => entry.last)) : holder.header;
      edits.push(insertion(anchor + 1, added, eolAt(anchor)));
    }
  }
  return { edits };
}

function insertion(at, texts, eol) {
  return { from: at, to: at, lines: texts.map((text) => ({ text, eol })) };
}

function removal(entry) {
  return { from: entry.first, to: entry.last + 1, lines: [] };
}

/** One key/value with a new value: the key as written, and the comment after the old value. */
function rewrite(lines, entry, value) {
  const head = lines[entry.first].text.slice(0, entry.valueStart);
  const tail = lines[entry.last];
  let end = tail.end;
  while (end > 0 && (tail.text[end - 1] === " " || tail.text[end - 1] === "\t")) end--;
  return { from: entry.first, to: entry.last + 1, lines: [{ text: head + formatValue(value) + tail.text.slice(end), eol: tail.eol }] };
}

/**
 * Apply `{from, to, lines}` edits: lines `from`..`to` are replaced by `lines`
 * (an insertion has `from === to`). At the same place, insertions come before
 * a replacement, and a higher `rank` comes later; overlapping removals join.
 */
function applyEdits(lines, edits) {
  const sorted = [...edits].sort((a, b) => a.from - b.from || a.to - b.to || (a.rank ?? 0) - (b.rank ?? 0));
  const out = [];
  let cursor = 0;
  for (const edit of sorted) {
    out.push(...lines.slice(cursor, edit.from), ...edit.lines);
    cursor = Math.max(cursor, edit.to);
  }
  out.push(...lines.slice(cursor));
  return out;
}

/** A new `[[profiles]]` block, laid out like the serializer: tables last. */
function formatBlock(profile, inlineMaps) {
  const texts = ["[[profiles]]"];
  const tables = [];
  for (const [key, value] of Object.entries(profile)) {
    if (isPlainObject(value) && !inlineMaps) tables.push("", `[profiles.${formatKey(key)}]`, ...assignments(value));
    else texts.push(`${formatKey(key)} = ${formatValue(value)}`);
  }
  return [...texts, ...tables];
}

function assignments(table) {
  return Object.entries(table).map(([key, value]) => `${formatKey(key)} = ${formatValue(value)}`);
}

const ESCAPES = { "\\": "\\\\", '"': '\\"', "\b": "\\b", "\t": "\\t", "\n": "\\n", "\f": "\\f", "\r": "\\r" };

/** A TOML basic string. */
function formatString(value) {
  const escaped = value.replace(/[\\"\u0000-\u001f\u007f]/g, (c) => ESCAPES[c] ?? `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
  return `"${escaped}"`;
}

function formatKey(key) {
  return /^[A-Za-z0-9_-]+$/.test(key) ? key : formatString(key);
}

/** Strings as basic strings, arrays and tables inline. */
function formatValue(value) {
  if (typeof value === "string") return formatString(value);
  if (Array.isArray(value)) return value.length > 0 ? `[ ${value.map(formatValue).join(", ")} ]` : "[]";
  if (isPlainObject(value)) {
    const items = assignments(value);
    return items.length > 0 ? `{ ${items.join(", ")} }` : "{}";
  }
  return String(value);
}

export { writeAtomically };
