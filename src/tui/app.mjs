/**
 * Interactive profile editor (Ink).
 *
 * Runs inside a Herdr plugin pane, which provides a real PTY. The pane closes
 * when this process exits, so the app stays resident until the user quits.
 */
import React, { useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, useApp, useInput } from "ink";
import { diffFields } from "../core/merge.mjs";
import { detectHarnesses, dryRun, listModelsAsync } from "../core/detect.mjs";
import { visibleWindow } from "../core/window.mjs";
import { layoutFor, listWindow as listWindowFor } from "../core/layout.mjs";
import { pickerView, nextSort, SORT_LABELS } from "../core/picker.mjs";
import { clipStartToWidth, clipToWidth, displayWidth, padToWidth } from "../core/textwidth.mjs";
import { PERMISSION_FIELDS, permissionValue } from "../core/permissions.mjs";
import {
  applyFieldValue,
  applyRemoval,
  deriveId,
  differingFields,
  draftGlobalOf,
  draftIsDirty,
  editableFields,
  fieldNames,
  fieldOptions,
  fieldValueOf,
  formatListInputValue,
  labelOf,
  loadEditorState,
  openDraft,
  planRemoval,
  revertField,
  saveProfileDraft,
} from "../core/editor.mjs";

const h = React.createElement;

/**
 * Rows to give the scrolling option list.
 *
 * Sized from the live terminal so a tall pane shows more models, leaving room
 * for the header, the fields, the hint line, and the "more below" indicator.
 * The measured popup case (60x16) is the floor this keeps usable.
 */
function optionWindowHeight() {
  const rows = Number(process.stdout.rows) || 24;
  return Math.max(3, Math.min(14, rows - 11));
}

/** Live terminal size; re-renders when the pane is resized. */
function useTerminalLayout() {
  const read = () => layoutFor(process.stdout.rows ?? 24, process.stdout.columns ?? 80);
  const [layout, setLayout] = useState(read);
  useEffect(() => {
    const onChange = () => setLayout(read());
    process.stdout.on("resize", onChange);
    return () => process.stdout.off("resize", onChange);
  }, []);
  return layout;
}

/**
 * Window top after moving the cursor. Computed in the input handler rather than
 * during render, so the component never schedules work while rendering.
 */
function scrollOffset(total, cursor, offset) {
  return visibleWindow(total, cursor, optionWindowHeight(), offset).offset;
}

function Field({ label, value, width = 44, active = false, differs = false }) {
  const shown = clipToWidth(value, width);
  return h(
    Box,
    { flexDirection: "row" },
    h(Text, { dimColor: !active, color: active ? "cyan" : undefined }, `${label.padEnd(11)}`),
    h(Text, { inverse: active }, ` ${padToWidth(shown, width)} `),
    differs ? h(Text, { color: "magenta" }, " ≠") : null,
  );
}

/** Global profiles (and their project overrides) first, project-only profiles after. */
function sectionOf(profile) {
  return profile.origin === "project-only" ? "project" : "global";
}

function ListView({ profiles, selected, detection, globalProfiles, projectPath, projectTarget, layout }) {
  const detectedById = new Map((detection ?? []).map((entry) => [entry.id, entry]));
  const globalById = new Map((globalProfiles ?? []).map((entry) => [entry.id, entry]));
  // Two section headings can be on screen at once: the one the window starts
  // under and the one it crosses into.
  const listWindow = listWindowFor(layout, 0, profiles.length, { selected, headerRows: 2 });
  const cols = layout?.cols ?? 80;
  const nameWidth = Math.max(20, cols - 8);
  const projectCount = profiles.filter((profile) => sectionOf(profile) === "project").length;

  const header = (section) => {
    if (section === "global") {
      return h(Text, { key: "__global", bold: true, color: "cyan" }, "Global profiles");
    }
    const where = projectPath ? projectPath : `${projectTarget} (created on first save)`;
    const lead = `Project profiles${projectCount === 0 ? " (none)" : ""} · `;
    return h(
      Text,
      { key: "__project", bold: true, color: "magenta" },
      lead,
      h(Text, { bold: false, dimColor: true }, clipStartToWidth(where, Math.max(10, cols - 6 - displayWidth(lead)))),
    );
  };

  const rows = [];
  let previous = null;
  for (let index = listWindow.start; index < listWindow.end; index++) {
    const profile = profiles[index];
    const section = sectionOf(profile);
    if (section !== previous) rows.push(header(section));
    previous = section;

    const isActive = index === selected;
    const entry = detectedById.get(profile.harness);
    const mark = detection && entry ? (entry.detected ? "✓" : "✗") : " ";
    // Only a global profile can be overridden; say which fields now differ.
    const differing = profile.origin === "project-override" ? diffFields(profile, globalById.get(profile.id)) : [];
    const namePart = clipToWidth(`${isActive ? ">" : " "} ${profile.name ?? profile.id}`, nameWidth);
    const diffPart =
      profile.origin === "project-override"
        ? clipToWidth(
            differing.length ? `  ≠ ${fieldNames(differing)}` : "  ≠ override (same values)",
            Math.max(0, nameWidth - displayWidth(namePart)),
          )
        : "";
    // In a short pane the selected row keeps its description but others drop it.
    const showDetail = isActive || !layout?.compact;
    rows.push(
      h(
        Box,
        { key: profile.id, flexDirection: "column", marginBottom: layout?.compact ? 0 : 1 },
        h(
          Text,
          { inverse: isActive },
          namePart,
          diffPart ? h(Text, { color: isActive ? undefined : "magenta" }, diffPart) : null,
        ),
        h(
          Text,
          { dimColor: !isActive },
          `    ${mark} ${profile.harness} · ${profile.model} · ${profile.effort} · ${profile.cost ?? "normal"}`,
        ),
        isActive && showDetail
          ? h(Text, { color: "gray" }, `    ${clipToWidth((profile.when_to_use ?? "").split("\n")[0], Math.max(20, cols - 10))}`)
          : null,
      ),
    );
  }
  // An empty project section has no entry to hang its heading on.
  if (projectCount === 0 && listWindow.end >= profiles.length) rows.push(header("project"));

  return h(Box, { flexDirection: "column" }, ...rows);
}

function DetectView({ detection, catalogs, layout }) {
  // Error strings are long enough to wrap; trim them so each harness stays one
  // row and the view cannot overflow the pane.
  const width = Math.max(20, (layout?.cols ?? 80) - 16);
  const clip = (text) => {
    const oneLine = String(text ?? "").replace(/\s+/g, " ").trim();
    return oneLine.length > width ? `${oneLine.slice(0, width - 1)}…` : oneLine;
  };
  return h(
    Box,
    { flexDirection: "column", overflow: "hidden" },
    ...detection.slice(0, layout?.detectRows ?? detection.length).map((entry) => {
      const catalog = catalogs[entry.id];
      const status = entry.detected ? "✓ detected" : "✗ not found";
      const models = catalog?.error ? `— ${clip(catalog.error)}` : catalog ? `— ${catalog.models.length} models` : "";
      return h(
        Box,
        { key: entry.id, flexDirection: "column", marginBottom: layout?.compact ? 0 : 1 },
        h(Text, {}, `${entry.id.padEnd(10)} ${status} ${models}`),
        entry.detected && !layout?.compact ? h(Text, { dimColor: true }, `    ${clip(entry.path)}`) : null,
      );
    }),
    h(Text, { dimColor: true }, catalogs.__loading ? "loading catalogs…" : ""),
  );
}

/** One line saying what the editor is working on and what each save key does. */
function scopeLineFor(kind, projectTarget, width) {
  if (kind === "project") {
    // The end of a path is the part that tells projects apart.
    const lead = "project profile · p saves to ";
    return lead + clipStartToWidth(projectTarget, Math.max(10, width - displayWidth(lead)));
  }
  const text = {
    global: "global profile · g global · p project override",
    override: "global + override · ≠ differs · g global · p project",
    new: "new profile · g global · p project",
  }[kind];
  return clipToWidth(text, width);
}

function EditorView({ draft, dirty, cursor, fieldState, catalogs, detection, editKind, globalProfile, projectTarget, layout }) {
  const harness = draft.harness ?? "claude";
  const fields = editableFields(draft);
  const catalog = catalogs[harness];
  const options = fieldOptions(draft, cursor, catalog, detection);
  const scopeLine = scopeLineFor(editKind, projectTarget, Math.max(20, (layout?.cols ?? 80) - 4));
  // Fields that no longer match the global profile; empty when there is none to compare.
  const differs = differingFields(draft, globalProfile);
  const activeField = fields[cursor];
  const globalNote =
    globalProfile && differs.has(activeField)
      ? clipToWidth(
          `≠ global: ${formatListInputValue(activeField, fieldValueOf(globalProfile, activeField)) || "(unset)"}  ·  r reverts this field`,
          Math.max(20, (layout?.cols ?? 80) - 4),
        )
      : "";

  // Below ~60 columns the label and value cannot share a row, so stack them.
  const stacked = layout?.narrow ?? false;
  // Short terminals drop blank separators to buy rows back for the list.
  const tight = layout?.compact ?? false;
  const optionHeight = layout?.optionRows ?? optionWindowHeight();

  // The picker filters and orders its rows; the field list stays in its own order.
  const picking = fieldState.mode === "picking";
  const view = pickerView(options, { query: fieldState.query, sort: fieldState.sort });
  const rows0 = view.models;
  // Clamp for display too: a late catalog or a filter can shrink the list below
  // the stored index, and an unclamped highlight would point at nothing.
  const activeIndex = Math.min(fieldState.optionIndex, Math.max(0, rows0.length - 1));
  const win = visibleWindow(rows0.length, activeIndex, optionHeight, fieldState.optionOffset);
  const fieldWindowOffset = fieldState.fieldOffset ?? 0;

  // Explain an empty picker instead of showing nothing. A harness with no
  // catalog accepts a free-form value; a failed lookup is a different problem.
  const catalogNote =
    fields[cursor] === "model" && options.length === 0
      ? catalog?.noCatalog
        ? `${harness} does not list models — type the id`
        : catalog?.error
          ? `${harness} model list failed: ${String(catalog.error).split("\n")[0].slice(0, 60)}`
          : `${harness} model list is empty`
      : null;

  return h(
    Box,
    { flexDirection: "column" },
    h(
      Text,
      { bold: true },
      draft.id ? `Edit ${draft.id}` : "New profile",
      dirty ? h(Text, { color: "yellow" }, "  ● unsaved") : null,
    ),
    h(Text, { color: editKind === "project" || editKind === "override" ? "magenta" : "gray" }, scopeLine),
    h(
      Box,
      { marginTop: tight ? 0 : 1, flexDirection: "column" },
      ...(() => {
        // Short panes show a window of fields around the cursor, so the picker
        // below them stays on screen.
        const limit = layout?.visibleFields ?? fields.length;
        const fieldWin = visibleWindow(fields.length, cursor, limit, fieldWindowOffset);
        const hidden = fields.length - (fieldWin.end - fieldWin.start);
        const rows = fields.slice(fieldWin.start, fieldWin.end).map((field, i) => {
          const index = fieldWin.start + i;
          const editing = fieldState.mode === "editing" && index === cursor;
          const shown = editing ? fieldState.buffer : PERMISSION_FIELDS.includes(field)
            ? permissionValue(draft, field) || "inherit"
            : draft[field];
          const active = index === cursor;
          if (!stacked) {
            return h(Field, { key: field, label: labelOf(field), value: shown, active, differs: differs.has(field) });
          }
          return h(
            Box,
            { key: field, flexDirection: "column" },
            h(Text, { dimColor: !active, color: active ? "cyan" : undefined }, `${labelOf(field)}${differs.has(field) ? " ≠" : ""}`),
            h(Text, { inverse: active }, ` ${String(shown ?? "").slice(0, Math.max(8, (layout?.cols ?? 40) - 4))} `),
          );
        });
        if (hidden > 0) {
          rows.push(h(Text, { key: "__more", dimColor: true }, `  … ${hidden} more fields`));
        }
        return rows;
      })(),
    ),
    picking && options.length > 0
      ? (() => {
          const rows = rows0.slice(win.start, win.end).map((model, i) => {
            const index = win.start + i;
            const isActive = activeIndex === index;
            return h(
              Text,
              { key: model.id, inverse: isActive },
              `${isActive ? ">" : " "} ${model.id}`,
            );
          });

          const filterLabel = fieldState.searching
            ? `  filter: ${fieldState.query}▌`
            : fieldState.query
              ? `  filter: ${fieldState.query}`
              : "";
          const header = h(
            Text,
            { color: fieldState.searching ? "yellow" : undefined, dimColor: !fieldState.searching },
            `  ${labelOf(fields[cursor])} · ${SORT_LABELS[fieldState.sort]}${filterLabel}`,
          );
          const more = h(
            Text,
            { color: "gray" },
            `  ↑${win.hiddenAbove}  ↓${win.hiddenBelow}  (${activeIndex + 1}/${rows0.length}${
              rows0.length !== view.total ? ` of ${view.total}` : ""
            })`,
          );
          return h(
            Box,
            { flexDirection: "column", marginTop: tight ? 0 : 1 },
            header,
            ...rows,
            more,
          );
        })()
      : catalogNote
        ? h(
            Box,
            { marginTop: tight ? 0 : 1 },
            h(Text, { color: "yellow" }, `  ${catalogNote}`),
          )
        : null,

    // A free-form field shows its live buffer while typing.
    fieldState.mode === "editing"
      ? h(
          Box,
          { marginTop: tight ? 0 : 1 },
          h(Text, { color: "yellow" }, `  ${labelOf(fields[cursor])}: ${fieldState.buffer}▌`),
        )
      : null,
    // A status message wins; otherwise say how the focused field differs from global.
    h(
      Box,
      { marginTop: tight ? 0 : 1 },
      h(
        Text,
        { color: fieldState.status ? (fieldState.statusOk ? "green" : "red") : "magenta" },
        fieldState.status || globalNote,
      ),
    ),
  );
}

export default function App({ initialProject }) {
  const { exit } = useApp();
  const [tab, setTab] = useState("list");
  const [selected, setSelected] = useState(0);
  const [cursor, setCursor] = useState(0);
  const [draft, setDraft] = useState(null);
  const [fieldState, setFieldState] = useState({
    // "fields": moving between profile fields
    // "picking": inside one field's option list (model, harness, effort, cost)
    // "editing": typing a free-form value
    mode: "fields",
    buffer: "",
    optionIndex: 0,
    optionOffset: 0,
    fieldOffset: 0,
    query: "",
    searching: false,
    sort: "catalog",
    status: "",
    statusOk: true,
  });
  // Snapshot of the draft when editing began, to tell unsaved changes from none.
  // null marks a draft with no saved original (a copy), which is always unsaved.
  const [baseline, setBaseline] = useState(null);
  // A delete waits here for a y/n answer so one stray key cannot remove a profile.
  const [pendingDelete, setPendingDelete] = useState(null);
  const [reload, setReload] = useState(0);
  const [catalogs, setCatalogs] = useState({});
  const [detection, setDetection] = useState([]);
  const [message, setMessage] = useState("");
  const layout = useTerminalLayout();
  // What the open editor is working on. It decides which save keys apply:
  //   "global"   a global profile            g edits it, p saves a project override
  //   "override" a global profile that this project already overrides (same keys)
  //   "project"  a project-only profile      p saves it; there is no global copy
  //   "new"      a new or copied profile     g saves to global, p to the project
  const [editKind, setEditKind] = useState("global");
  const [projectRoot, setProjectRoot] = useState(initialProject ?? process.cwd());

  // reload is the explicit invalidation key
  const editorState = useMemo(() => loadEditorState({ projectRoot }), [projectRoot, reload]);
  const { projectPath, projectTarget, profiles, globalProfiles } = editorState;

  useEffect(() => {
    setDetection(detectHarnesses());
  }, []);

  // Catalogs load on demand and off the event loop: a harness CLI can take the
  // better part of a second, and the pane must keep taking keys meanwhile. Each
  // harness is asked once per session.
  const requested = useRef(new Set());
  const abort = useRef(null);
  useEffect(() => {
    abort.current = new AbortController();
    // Quitting must not wait on a CLI that is still listing models.
    return () => abort.current.abort();
  }, []);
  const ensureCatalog = (harness) => {
    if (!harness || requested.current.has(harness)) return;
    requested.current.add(harness);
    const signal = abort.current.signal;
    const show = (catalog) =>
      setCatalogs((prev) => ({
        ...prev,
        [harness]: {
          models: catalog.models,
          error: catalog.ok && catalog.models.length > 0 ? null : catalog.error ?? null,
          noCatalog: Boolean(catalog.noCatalog),
        },
      }));
    listModelsAsync(harness, { signal }).then((catalog) => {
      if (signal.aborted) return;
      show(catalog);
      // A cached list can predate a provider login or logout, so read the CLI
      // once more behind it. A failed read keeps the cached rows.
      if (!catalog.revalidate) return;
      listModelsAsync(harness, { signal, refresh: true }).then((fresh) => {
        if (!signal.aborted && fresh.ok) show(fresh);
      });
    });
  };

  // The list never needs a catalog; only the editor's pickers and the detect view do.
  const editorHarness = tab === "edit" ? draft?.harness : undefined;
  useEffect(() => {
    ensureCatalog(editorHarness);
  }, [editorHarness]);
  useEffect(() => {
    if (tab !== "detect") return;
    for (const entry of detection) if (entry.detected) ensureCatalog(entry.id);
  }, [tab, detection]);

  const selectedProfile = profiles[selected] ?? null;
  const fields = editableFields(draft);
  // The global profile the open draft is compared against (none for new/project-only).
  const draftGlobal = draftGlobalOf(draft, editKind, globalProfiles);

  /** Save the open draft to one explicit target ("global" or "project"). */
  const saveDraft = (target) => {
    const result = saveProfileDraft({ draft, baseline, target, kind: editKind, state: editorState });
    if (!result.ok) {
      setFieldState((prev) => ({ ...prev, statusOk: false, status: result.error }));
      return;
    }
    setReload((value) => value + 1);
    setTab("list");
    setMessage(result.message);
    setDraft(null);
  };

  /** Open the editor on a draft from `openDraft`. */
  const startEditing = (opened) => {
    setDraft(opened.draft);
    setBaseline(opened.baseline);
    setEditKind(opened.kind);
    setCursor(0);
    setMessage("");
    setFieldState({ mode: "fields", buffer: "", optionIndex: 0, optionOffset: 0, fieldOffset: 0, query: "", searching: false, sort: "catalog", status: "", statusOk: true });
    setTab("edit");
  };

  useInput((input, key) => {
    // A pane below the minimum shows only a notice, so q must still work from
    // any mode — otherwise shrinking the pane while editing traps the user.
    if (layout.tooSmall) {
      if (input === "q" || key.escape) exit();
      return;
    }

    // ---- editor ----
    if (tab === "edit" && draft) {
      const field = fields[cursor];
      const catalog = catalogs[draft.harness];
      const options = fieldOptions(draft, cursor, catalog, detection);

      // Enter on a field that has options opens the picker; a field without
      // options goes straight to typing. Escape always backs out one level.
      const openPicker = () =>
        setFieldState((prev) => ({
          ...prev,
          mode: options.length > 0 ? "picking" : "editing",
          buffer: options.length > 0 ? "" : formatListInputValue(field, draft[field]),
          optionIndex: PERMISSION_FIELDS.includes(field)
            ? Math.max(0, options.findIndex((row) => row.id === (permissionValue(draft, field) || "inherit")))
            : 0,
          optionOffset: 0,
          query: "",
          searching: false,
        }));

      // ---- typing a free-form value ----
      if (fieldState.mode === "editing") {
        if (key.escape) {
          setFieldState((prev) => ({ ...prev, mode: "fields", buffer: "" }));
          return;
        }
        if (key.return) {
          const raw = fieldState.buffer;
          setDraft((prev) => applyFieldValue(prev, field, raw));
          setFieldState((prev) => ({ ...prev, mode: "fields", buffer: "" }));
          return;
        }
        if (key.backspace || key.delete) {
          setFieldState((prev) => ({ ...prev, buffer: prev.buffer.slice(0, -1) }));
          return;
        }
        if (input && !key.ctrl && !key.meta) {
          setFieldState((prev) => ({ ...prev, buffer: prev.buffer + input }));
          return;
        }
        return;
      }

      // ---- inside the option list ----
      if (fieldState.mode === "picking") {
        const view = pickerView(options, { query: fieldState.query, sort: fieldState.sort });
        const shown = view.models;
        // The list can shrink under the cursor (a catalog arrives late, or the
        // filter narrows it). Every read below uses this clamped index so a
        // stale value can never select nothing.
        const index = Math.min(fieldState.optionIndex, Math.max(0, shown.length - 1));

        // `/` starts filtering. Escape clears the filter and stays in the
        // picker; a second Escape leaves it. Enter applies the highlighted row
        // directly, so a filtered search is one keystroke from a decision.
        if (fieldState.searching) {
          if (key.escape) {
            setFieldState((prev) => ({
              ...prev,
              searching: false,
              query: prev.query ? "" : prev.query,
              optionIndex: prev.query ? 0 : prev.optionIndex,
              optionOffset: prev.query ? 0 : prev.optionOffset,
            }));
            return;
          }
          if (key.return) {
            const row = shown[index];
            if (row) {
              setDraft((prev) => applyFieldValue(prev, field, row.id));
              setFieldState((prev) => ({ ...prev, mode: "fields", searching: false, optionIndex: 0, optionOffset: 0, query: "" }));
              return;
            }
            setFieldState((prev) => ({ ...prev, searching: false }));
            return;
          }
          if (key.upArrow) {
            setFieldState((prev) => {
              const optionIndex = Math.max(0, prev.optionIndex - 1);
              return { ...prev, optionIndex, optionOffset: scrollOffset(shown.length, optionIndex, prev.optionOffset) };
            });
            return;
          }
          if (key.downArrow) {
            setFieldState((prev) => {
              const optionIndex = Math.min(Math.max(0, shown.length - 1), prev.optionIndex + 1);
              return { ...prev, optionIndex, optionOffset: scrollOffset(shown.length, optionIndex, prev.optionOffset) };
            });
            return;
          }
          if (key.backspace || key.delete) {
            setFieldState((prev) => {
              const query = prev.query.slice(0, -1);
              // Widening the results should not throw the cursor back to the
              // top; keep it where it is and let the clamp handle the rest.
              return { ...prev, query };
            });
            return;
          }
          if (input && !key.ctrl && !key.meta) {
            setFieldState((prev) => ({ ...prev, query: prev.query + input, optionIndex: 0, optionOffset: 0 }));
            return;
          }
          return;
        }

        if (input === "/") {
          setFieldState((prev) => ({ ...prev, searching: true }));
          return;
        }
        if (input === "o") {
          setFieldState((prev) => ({ ...prev, sort: nextSort(prev.sort), optionIndex: 0, optionOffset: 0 }));
          return;
        }
        if (key.upArrow) {
          setFieldState((prev) => {
            const optionIndex = Math.max(0, prev.optionIndex - 1);
            return { ...prev, optionIndex, optionOffset: scrollOffset(shown.length, optionIndex, prev.optionOffset) };
          });
          return;
        }
        if (key.downArrow) {
          setFieldState((prev) => {
            const optionIndex = Math.min(Math.max(0, shown.length - 1), prev.optionIndex + 1);
            return { ...prev, optionIndex, optionOffset: scrollOffset(shown.length, optionIndex, prev.optionOffset) };
          });
          return;
        }
        if (key.return) {
          const row = shown[index];
          // Refuse to write an absent row: the picker may have no options yet.
          if (!row) return;
          setDraft((prev) => applyFieldValue(prev, field, row.id));
          setFieldState((prev) => ({ ...prev, mode: "fields", optionIndex: 0, optionOffset: 0, query: "" }));
          return;
        }
        if (key.escape) {
          // First Escape clears a filter; a second one leaves the picker.
          if (fieldState.query) {
            setFieldState((prev) => ({ ...prev, query: "", optionIndex: 0, optionOffset: 0 }));
          } else {
            setFieldState((prev) => ({ ...prev, mode: "fields" }));
          }
          return;
        }
        return;
      }

      // ---- moving between profile fields ----
      // Any key other than a second Esc withdraws a pending "discard changes".
      if (fieldState.discardArmed && !key.escape) {
        setFieldState((prev) => ({ ...prev, discardArmed: false, status: "", statusOk: true }));
      }
      if (key.upArrow) {
        setCursor((value) => {
          const next = Math.max(0, value - 1);
          setFieldState((prev) => ({
            ...prev,
            optionIndex: 0,
            optionOffset: 0,
            fieldOffset: visibleWindow(fields.length, next, layout.visibleFields, prev.fieldOffset ?? 0).offset,
          }));
          return next;
        });
        return;
      }
      if (key.downArrow) {
        setCursor((value) => {
          const next = Math.min(fields.length - 1, value + 1);
          setFieldState((prev) => ({
            ...prev,
            optionIndex: 0,
            optionOffset: 0,
            fieldOffset: visibleWindow(fields.length, next, layout.visibleFields, prev.fieldOffset ?? 0).offset,
          }));
          return next;
        });
        return;
      }
      if (key.return || input === "e") {
        openPicker();
        return;
      }
      // One key per save target, so the same key never means two things.
      if (input === "g") {
        saveDraft("global");
        return;
      }
      if (input === "p") {
        saveDraft("project");
        return;
      }
      if (input === "r") {
        // Put the focused field back to the global value.
        const result = revertField(draft, draftGlobal, field);
        if (result.ok) setDraft(result.draft);
        setFieldState((prev) => ({ ...prev, statusOk: true, status: result.message }));
        return;
      }
      if (input === "t") {
        const result = dryRun(draft);
        setFieldState((prev) => ({
          ...prev,
          statusOk: result.ok,
          status: result.checks.map((check) => `${check.ok ? "✓" : "✗"} ${check.label}`).join("  "),
        }));
        return;
      }
      if (input === "n" && !draft.id) {
        setDraft((prev) => ({ ...prev, id: deriveId(prev.name) }));
        return;
      }
      if (key.escape) {
        if (draftIsDirty(draft, baseline) && !fieldState.discardArmed) {
          setFieldState((prev) => ({
            ...prev,
            discardArmed: true,
            statusOk: false,
            status: "unsaved changes — Esc again to discard, s to save",
          }));
          return;
        }
        setTab("list");
        setDraft(null);
        return;
      }
      return;
    }

    // ---- detect view ----
    // The list underneath is hidden here, so its keys (a, d, c, Enter) must not act.
    if (tab === "detect") {
      if (input === "q") exit();
      else if (input === "j" || key.escape) {
        setMessage("");
        setTab("list");
      }
      return;
    }

    // ---- delete confirmation ----
    if (pendingDelete) {
      const plan = pendingDelete;
      setPendingDelete(null);
      if (input !== "y") {
        setMessage("delete cancelled");
        return;
      }
      const result = applyRemoval(plan);
      if (!result.ok) {
        setMessage(result.error);
        return;
      }
      setReload((value) => value + 1);
      if (plan.action === "delete") setSelected((value) => Math.max(0, value - 1));
      setMessage(result.message);
      return;
    }


    // ---- list mode ----
    if (key.upArrow) setSelected((value) => Math.max(0, value - 1));
    else if (key.downArrow) setSelected((value) => Math.min(Math.max(0, profiles.length - 1), value + 1));
    else if (input === "q") exit();
    else if (input === "j") {
      setMessage("");
      setTab("detect");
    }
    else if (input === "a") startEditing(openDraft("new"));
    else if ((input === "d" || input === "r") && selectedProfile) {
      const plan = planRemoval(selectedProfile, input === "r" ? "reset" : "delete", editorState);
      if (!plan.ok) {
        setMessage(plan.error);
        return;
      }
      setPendingDelete(plan);
      setMessage(plan.question);
    } else if ((input === "e" || key.return) && selectedProfile) startEditing(openDraft("edit", selectedProfile));
    else if (input === "c" && selectedProfile) startEditing(openDraft("copy", selectedProfile));
  });

  // A pane too small for the frame cannot render any layout correctly; say so
  // instead of drawing past the edge and wrapping.
  if (layout.tooSmall) {
    return h(
      Box,
      { flexDirection: "column" },
      h(Text, { color: "yellow", bold: true }, "pane too small"),
      h(Text, { color: "white" }, `${layout.cols}x${layout.rows} — widen the pane or use the overlay`),
      h(Text, { color: "cyan", bold: true }, " q "),
      h(Text, { color: "white" }, "quit"),
    );
  }

  const body =
    tab === "edit" && draft
      ? h(EditorView, {
          draft,
          dirty: draftIsDirty(draft, baseline),
          cursor,
          fieldState,
          catalogs,
          detection,
          editKind,
          globalProfile: draftGlobal,
          projectTarget,
          layout,
        })
      : tab === "detect"
        ? h(DetectView, { detection, catalogs, layout })
        : h(ListView, { profiles, selected, detection, globalProfiles, projectPath, projectTarget, layout });

  const canRevert = Boolean(draftGlobal) && differingFields(draft, draftGlobal).has(fields[cursor]);
  // A third entry is the terse label used when the line would not fit the pane.
  const saveHints =
    editKind === "project"
      ? [["p", "save project", "save"]]
      : [
          ["g", "save global", "global"],
          ["p", "save project", "project"],
        ];

  // Hints are built from the live mode and drawn with the keys highlighted, so
  // the current set of actions is obvious without reading a dim line of text.
  const hint =
    tab === "edit"
      ? fieldState.mode === "picking"
        ? fieldState.searching
          ? [
              ["type", "filter"],
              ["↑↓", "choose"],
              ["Enter", "apply"],
              ["Esc", "clear"],
            ]
          : [
              ["↑↓", "choose"],
              ["Enter", "apply"],
              ["/", "find"],
              ["o", "order"],
              ["Esc", "back"],
            ]
        : fieldState.mode === "editing"
          ? [
              ["type", "value"],
              ["Enter", "confirm"],
              ["Esc", "cancel"],
            ]
          : fitHints(
              [
                ["Enter", "open"],
                ...saveHints,
                ...(canRevert ? [["r", "revert"]] : []),
                ["t", "test"],
                ["Esc", "back"],
              ],
              layout.cols - 4,
              ["t", "r"],
            )
      : tab === "detect"
        ? [
            ["j/Esc", "back"],
            ["q", "quit"],
          ]
        : pendingDelete
          ? [
              ["y", pendingDelete.action === "reset" ? "reset" : "delete"],
              ["any key", "cancel"],
            ]
          : fitHints(
              [
                ["↑↓", "move"],
                ["Enter", "edit"],
                ["a", "add"],
                ["c", "copy"],
                ["d", "delete", "del"],
                ...(selectedProfile?.origin === "project-override" ? [["r", "reset"]] : []),
                ["j", "detect"],
                ["q", "quit"],
              ],
              layout.cols - 4,
              ["j", "c", "a"],
            );

  return h(
    Box,
    {
      flexDirection: "column",
      borderStyle: "round",
      paddingX: 1,
      // Bound the frame to the pane: content taller than the terminal makes Ink
      // scroll the viewport, which leaves the previous frame on screen.
      height: layout.rows,
      width: layout.cols,
      overflow: "hidden",
    },
    h(Text, { bold: true, color: "cyan" }, "Agent Profiles"),
    h(Box, { marginY: 0, flexDirection: "column", overflow: "hidden" }, body),
    message ? h(Text, { color: "yellow" }, message) : null,
    h(
      Box,
      { flexDirection: "row", flexWrap: "nowrap" },
      ...hint.flatMap(([keys, label], i) => [
        h(Text, { key: `${keys}-k`, color: "cyan", bold: true }, ` ${keys} `),
        h(Text, { key: `${keys}-l`, color: "white" }, `${label} `),
        i < hint.length - 1 ? h(Text, { key: `${keys}-s`, color: "gray" }, "·") : null,
      ]),
    ),
  );
}

/** Columns a key-hint line takes: each key and label padded, plus separators. */
function hintWidth(items) {
  const keys = items.reduce((sum, [keys, label]) => sum + displayWidth(keys) + 2 + displayWidth(label) + 1, 0);
  return keys + Math.max(0, items.length - 1);
}

/**
 * Make a key-hint line fit `width` columns. An over-wide line is squeezed by
 * the layout, which eats the spaces between hints, so shrink it deliberately:
 * first swap in the terse labels (third entry), then drop low-value keys.
 */
function fitHints(items, width, dropOrder = []) {
  let current = items.map(([key, label]) => [key, label]);
  if (hintWidth(current) <= width) return current;
  current = items.map(([key, label, terse]) => [key, terse ?? label]);
  for (const key of dropOrder) {
    if (hintWidth(current) <= width) break;
    current = current.filter(([item]) => item !== key);
  }
  return current;
}

export { App };
