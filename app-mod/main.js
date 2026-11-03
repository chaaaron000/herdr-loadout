// Agent Profiles: the herdr-loadout registry, edited in the Herdr app.
//
// Opened as a dialog (`mod.open herdr-loadout`, usually from a key). The list
// shows the global profiles and the profiles of the project the focused
// terminal is in; Enter edits one, a adds, c copies, d deletes, r drops a
// project override, j lists the harnesses on this machine, Esc closes.
//
// Every read and write goes through `herdr-loadout editor <action>`, the CLI's
// JSON backend, so this editor follows the same rules as the terminal one.
// `cli.js` (where node and the CLI are) and `picker.js` (the model filter and
// orders) are written by the installer, scripts/install-app-mod.mjs.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { exec, focused, spaces, home, theme, settings, props, closeOverlay } from "herdr";
import { CLI } from "./cli.js";
import { pickerView, nextSort, SORT_LABELS } from "./picker.js";

const SPINNER = "mods/workspace-chrome/spinner.svg";
const ROW = { head: 28, profile: 50, field: 30, option: 28, harness: 54 };
// The editor opens as a window (so Esc reaches it instead of closing it), and
// a window drags on any press its mod doesn't stop: controls stop theirs.
const keepPress = (_e, cx) => cx.stop_propagation();

/** Lays rows out in a fixed-height box and shows only the ones in view. */
class Strip {
  constructor() {
    this.scroll = 0;
    this.follow = true;
  }

  /** Keep `index` in view on the next render (after a key moved it). */
  reveal() {
    this.follow = true;
  }

  render(id, rows, height, selected, draw) {
    const tops = [];
    let y = 0;
    for (const row of rows) {
      tops.push(y);
      y += row.h;
    }
    const total = y;
    const maxScroll = Math.max(0, total - height);
    if (this.follow && selected >= 0 && selected < rows.length) {
      if (tops[selected] < this.scroll) this.scroll = tops[selected];
      if (tops[selected] + rows[selected].h > this.scroll + height) this.scroll = tops[selected] + rows[selected].h - height;
    }
    this.scroll = Math.max(0, Math.min(this.scroll, maxScroll));
    const shown = [];
    rows.forEach((row, i) => {
      const top = tops[i] - this.scroll;
      if (top + row.h <= 0 || top >= height) return;
      shown.push(draw(row, i).absolute().left(0).right(0).top(top).h(row.h));
    });
    return div()
      .id(id)
      .on_mouse_down("left", keepPress)
      .relative()
      .w_full()
      .h(Math.max(0, Math.min(height, total)))
      .overflow_hidden()
      .on_scroll_wheel((e, cx) => {
        this.follow = false;
        this.scroll = Math.max(0, Math.min(this.scroll - e.delta.y, maxScroll));
        cx.notify();
      })
      .children(shown);
  }
}

/** The folder whose project profiles this copy shows. */
function projectRoot() {
  const here = focused();
  if (here?.cwd) return here.cwd;
  const space = spaces().find((s) => s.active);
  return space?.folder ?? home();
}

export default class Profiles extends View {
  init(_props, cx) {
    this.project = projectRoot();
    this.page = "list"; // list | edit | detect
    this.registry = null; // the `state` answer
    this.loadError = null;
    this.selected = 0;
    this.pending = null; // { id, action, question } waiting for y
    this.message = null; // { text, ok }
    this.ed = null; // the open editor
    this.busy = 0;
    this.catalogAsked = new Set();
    this.catalogErrors = {};
    this.catalogCounts = {};
    this.listStrip = new Strip();
    this.fieldStrip = new Strip();
    this.optionStrip = new Strip();
    this.harnessStrip = new Strip();
    this.listHeight = 300;
    this.fieldHeight = 300;

    this.handle = cx.focus_handle();
    this.text = InputState.new({});
    this.text.on("submit", (_e, cx) => this.commitText(cx));
    this.filter = InputState.new({ placeholder: "Filter: words match the id, provider or label" });
    this.filter.on("change", (_e, cx) => {
      if (!this.ed) return;
      this.ed.query = this.filter.value();
      this.ed.option = 0;
      this.optionStrip.reveal();
      cx.notify();
    });
    this.filter.on("submit", (_e, cx) => this.applyOption(cx));

    this.handle.focus();
    // The dialog takes the keyboard a moment after it opens.
    cx.timer.after(600, () => this.focusNow());
    this.reload(cx);
  }

  // ---- backend ----

  async call(action, input) {
    const args = [...CLI.args, "editor", action, "--project", this.project, "--input", JSON.stringify(input ?? {})];
    const r = await exec(CLI.command, args, { cwd: home() }).catch((error) => ({ code: -1, stdout: "", stderr: String(error) }));
    try {
      return JSON.parse(r.stdout);
    } catch {
      const why = (r.stderr || r.stdout || "herdr-loadout did not answer").trim().split("\n")[0];
      return { ok: false, error: why };
    }
  }

  /** Run backend work in the background; the view shows a spinner meanwhile. */
  task(cx, work) {
    this.busy++;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        await work(cx);
      } finally {
        this.busy--;
        cx.notify();
      }
    });
  }

  reload(cx, message = null) {
    this.task(cx, async () => {
      const r = await this.call("state");
      if (!r.ok) {
        this.loadError = r.error;
        return;
      }
      this.loadError = null;
      this.registry = r;
      this.selected = Math.max(0, Math.min(this.selected, r.profiles.length - 1));
      this.listStrip.reveal();
      if (message) this.message = message;
    });
  }

  // ---- list ----

  profile() {
    return this.registry?.profiles[this.selected] ?? null;
  }

  ask(cx, action) {
    const p = this.profile();
    if (!p) return;
    this.task(cx, async () => {
      const r = await this.call("remove", { id: p.id, action });
      if (!r.ok) this.message = { text: r.error, ok: false };
      else {
        this.pending = { id: p.id, action, question: r.question };
        this.message = null;
      }
    });
  }

  answer(cx, yes) {
    const plan = this.pending;
    this.pending = null;
    if (!yes) {
      this.message = { text: "delete cancelled", ok: true };
      cx.notify();
      return;
    }
    this.task(cx, async (cx) => {
      const r = await this.call("remove", { id: plan.id, action: plan.action, confirmed: true });
      if (!r.ok) {
        this.message = { text: r.error, ok: false };
        return;
      }
      if (plan.action === "delete") this.selected = Math.max(0, this.selected - 1);
      this.reload(cx, { text: r.message, ok: true });
    });
  }

  // ---- editor ----

  open(cx, mode) {
    const p = this.profile();
    if (mode !== "new" && !p) return;
    this.message = null;
    this.task(cx, async (cx) => {
      const r = await this.call("open", { mode, id: p?.id });
      if (!r.ok) {
        this.message = { text: r.error, ok: false };
        return;
      }
      this.ed = {
        draft: r.draft,
        baseline: r.baseline,
        kind: r.kind,
        fields: [],
        dirty: r.baseline === null,
        cursor: 0,
        mode: "fields", // fields | pick | type
        option: 0,
        query: "",
        sort: "catalog",
        status: null,
        discardArmed: false,
        seq: 0,
      };
      this.page = "edit";
      this.fieldStrip = new Strip();
      await this.view({}, cx);
      this.focusNow();
    });
  }

  /**
   * Ask the backend for the draft's fields, after one change. A later request
   * wins: an answer that arrives after a newer one is dropped.
   */
  async view(change, cx) {
    const ed = this.ed;
    if (!ed) return;
    const seq = ++ed.seq;
    const harness = ed.draft.harness ?? "claude";
    const r = await this.call("view", {
      draft: ed.draft,
      kind: ed.kind,
      baseline: ed.baseline,
      catalogError: this.catalogErrors[harness] ?? null,
      ...change,
    });
    if (this.ed !== ed || seq !== ed.seq) return;
    if (!r.ok) {
      ed.status = { text: r.error, ok: false };
      return;
    }
    ed.draft = r.draft;
    ed.fields = r.fields;
    ed.dirty = r.dirty;
    ed.cursor = Math.min(ed.cursor, Math.max(0, r.fields.length - 1));
    if (r.status) ed.status = { text: r.status, ok: true };
    if (!r.catalogReady) this.loadCatalog(r.draft.harness ?? "claude", cx);
  }

  /** Read a harness's model list once per session, then show the fields again. */
  loadCatalog(harness, cx) {
    if (this.catalogAsked.has(harness)) return;
    this.catalogAsked.add(harness);
    const showing = () => this.ed && (this.ed.draft.harness ?? "claude") === harness;
    this.task(cx, async (cx) => {
      const r = await this.call("models", { harness });
      if (r.ok) this.catalogCounts[harness] = r.count;
      else this.catalogErrors[harness] = r.error;
      if (showing()) await this.view({}, cx);
      // A cached list can predate a provider login or logout, so read the CLI
      // once more behind it. A failed read keeps the cached rows.
      if (r.ok && r.revalidate) {
        const fresh = await this.call("models", { harness, refresh: true });
        if (fresh.ok) {
          this.catalogCounts[harness] = fresh.count;
          if (showing()) await this.view({}, cx);
        }
      }
    });
  }

  change(cx, change) {
    const ed = this.ed;
    ed.mode = "fields";
    ed.discardArmed = false;
    ed.status = null;
    this.focusNow();
    this.task(cx, (cx) => this.view(change, cx));
  }

  field() {
    return this.ed?.fields[this.ed.cursor] ?? null;
  }

  openField(cx) {
    const ed = this.ed;
    const f = this.field();
    if (!f) return;
    ed.status = null;
    if (f.options) {
      ed.mode = "pick";
      ed.query = "";
      ed.sort = "catalog";
      this.filter.set_value("");
      const at = f.options.findIndex((o) => o.id === f.value);
      ed.option = Math.max(0, at);
      this.optionStrip = new Strip();
      this.focusNow();
    } else {
      ed.mode = "type";
      this.text.set_value(f.text);
      this.text.focus();
    }
    cx.notify();
  }

  shownOptions() {
    const f = this.field();
    if (!f?.options) return { models: [], total: 0, matched: 0 };
    return pickerView(f.options, { query: this.ed.query, sort: this.ed.sort });
  }

  /** The option list has a filter line when there is enough to filter. */
  filtering() {
    const f = this.field();
    return Boolean(f && (f.field === "model" || (f.options?.length ?? 0) > 8));
  }

  applyOption(cx) {
    const ed = this.ed;
    if (!ed || ed.mode !== "pick") return;
    const shown = this.shownOptions().models;
    const row = shown[Math.min(ed.option, shown.length - 1)];
    if (!row) return;
    this.change(cx, { set: { field: this.field().field, value: row.id } });
  }

  commitText(cx) {
    const ed = this.ed;
    if (!ed || ed.mode !== "type") return;
    this.change(cx, { set: { field: this.field().field, value: this.text.value() } });
  }

  save(cx, target) {
    const ed = this.ed;
    this.task(cx, async (cx) => {
      const r = await this.call("save", { draft: ed.draft, baseline: ed.baseline, kind: ed.kind, target });
      if (!r.ok) {
        ed.status = { text: r.error, ok: false };
        return;
      }
      this.leaveEditor();
      this.reload(cx, { text: r.message, ok: true });
    });
  }

  test(cx) {
    const ed = this.ed;
    ed.status = { text: "testing the launch…", ok: true };
    this.task(cx, async () => {
      const r = await this.call("test", { draft: ed.draft });
      ed.status = r.ok
        ? { text: r.checks.map((c) => `${c.ok ? "✓" : "✗"} ${c.label}`).join("   "), ok: r.launchable }
        : { text: r.error, ok: false };
    });
  }

  back(cx) {
    const ed = this.ed;
    if (ed.dirty && !ed.discardArmed) {
      ed.discardArmed = true;
      ed.status = { text: "unsaved changes — Esc again to discard, g or p to save", ok: false };
      cx.notify();
      return;
    }
    this.leaveEditor();
    cx.notify();
  }

  leaveEditor() {
    this.ed = null;
    this.page = "list";
    this.focusNow();
  }

  // ---- harnesses ----

  showHarnesses(cx) {
    this.page = "detect";
    this.message = null;
    for (const h of this.registry?.detection ?? []) if (h.detected) this.loadCatalog(h.id, cx);
    cx.notify();
  }

  // ---- keys ----

  focusNow() {
    this.handle.focus();
    if (this.ed?.mode === "pick" && this.filtering()) this.filter.focus();
    if (this.ed?.mode === "type") this.text.focus();
  }

  dismiss() {
    if (props()?.overlay) closeOverlay(props().overlay);
  }

  key(e, cx) {
    const k = e.key;
    const handled = this.page === "edit" && this.ed ? this.editKey(k, cx) : this.page === "detect" ? this.detectKey(k, cx) : this.listKey(k, cx);
    if (handled) {
      cx.stop_propagation();
      cx.notify();
    }
  }

  listKey(k, cx) {
    if (this.pending) {
      if (k === "y") this.answer(cx, true);
      else if (k === "n" || k === "escape") this.answer(cx, false);
      else return false;
      return true;
    }
    const count = this.registry?.profiles.length ?? 0;
    if (k === "escape") this.dismiss();
    else if (k === "down" && count) this.selected = Math.min(count - 1, this.selected + 1);
    else if (k === "up" && count) this.selected = Math.max(0, this.selected - 1);
    else if ((k === "enter" || k === "e") && count) this.open(cx, "edit");
    else if (k === "a") this.open(cx, "new");
    else if (k === "c" && count) this.open(cx, "copy");
    else if (k === "d" && count) this.ask(cx, "delete");
    else if (k === "r" && count) this.ask(cx, "reset");
    else if (k === "j") this.showHarnesses(cx);
    else return false;
    this.listStrip.reveal();
    return true;
  }

  detectKey(k, cx) {
    if (k !== "escape" && k !== "j") return false;
    this.page = "list";
    return true;
  }

  editKey(k, cx) {
    const ed = this.ed;
    if (ed.mode === "type") {
      if (k !== "escape") return false; // the input takes the rest; Enter submits it
      ed.mode = "fields";
      this.focusNow();
      return true;
    }
    if (ed.mode === "pick") {
      const shown = this.shownOptions().models;
      if (k === "down") ed.option = Math.min(Math.max(0, shown.length - 1), ed.option + 1);
      else if (k === "up") ed.option = Math.max(0, ed.option - 1);
      else if (k === "tab") {
        ed.sort = nextSort(ed.sort);
        ed.option = 0;
      } else if (k === "escape") {
        // First Escape clears a filter; a second one leaves the picker.
        if (ed.query) {
          ed.query = "";
          ed.option = 0;
          this.filter.set_value("");
        } else {
          ed.mode = "fields";
          this.focusNow();
        }
      } else if (k === "enter" && !this.filtering()) this.applyOption(cx);
      else return false;
      this.optionStrip.reveal();
      return true;
    }
    if (this.busy && k !== "escape") return true;
    if (ed.discardArmed && k !== "escape") {
      ed.discardArmed = false;
      ed.status = null;
    }
    const count = ed.fields.length;
    if (k === "down") ed.cursor = Math.min(count - 1, ed.cursor + 1);
    else if (k === "up") ed.cursor = Math.max(0, ed.cursor - 1);
    else if (k === "enter" || k === "e") this.openField(cx);
    else if (k === "g" && ed.kind !== "project") this.save(cx, "global");
    else if (k === "p") this.save(cx, "project");
    else if (k === "r" && this.field()) this.change(cx, { revert: this.field().field });
    else if (k === "t") this.test(cx);
    else if (k === "escape") this.back(cx);
    else return false;
    this.fieldStrip.reveal();
    return true;
  }

  // ---- drawing ----

  button(t, id, keys, label, onClick, { primary = false, enabled = true } = {}) {
    return h_flex()
      .id(id)
      .on_mouse_down("left", keepPress)
      .h(26)
      .px(9)
      .gap(6)
      .items_center()
      .rounded(7)
      .text_size(12)
      .when(primary, (el) => el.bg(t.solid).text_color(t.solid_foreground))
      .when(!primary, (el) => el.border_1().border_color(t.input).bg(t.raised).text_color(t.foreground))
      .when(!enabled, (el) => el.opacity(0.4))
      .when(enabled, (el) => el.cursor_pointer().hover((s) => (primary ? s.opacity(0.85) : s.bg(t.hover))).on_click((_e, cx) => onClick(cx)))
      .child(div().text_size(11).font_semibold().text_color(primary ? t.solid_foreground : t.accent).child(keys))
      .child(label);
  }

  /** One line of feedback: `tone` is "ok", "error", or "diff" (how a field differs from global). */
  statusLine(t, status) {
    if (!status) return null;
    const color = { ok: t.done, error: t.blocked, diff: t.ansi5 }[status.tone ?? (status.ok ? "ok" : "error")];
    return div().text_size(12).line_height("18px").text_color(color).child(status.text);
  }

  measured(id, onHeight, child) {
    return v_flex()
      .id(id)
      .flex_1()
      .min_h(0)
      .on_size_change((size, cx) => {
        const height = size.height / (settings().zoom ?? 1);
        if (Math.abs(height - (this[onHeight] ?? 0)) < 1) return;
        this[onHeight] = height;
        cx.notify();
      })
      .child(child);
  }

  listPage(t) {
    const reg = this.registry;
    if (!reg) {
      return v_flex().flex_1().items_center().justify_center().text_color(this.loadError ? t.blocked : t.dim).child(this.loadError ?? "Reading profiles…");
    }
    const detected = new Map(reg.detection.map((d) => [d.id, d.detected]));
    const rows = [];
    const projectRows = reg.profiles.filter((p) => p.origin === "project-only").length;
    let section = null;
    reg.profiles.forEach((p, index) => {
      const s = p.origin === "project-only" ? "project" : "global";
      if (s !== section) rows.push({ kind: "head", section: s, h: ROW.head });
      section = s;
      rows.push({ kind: "profile", p, index, h: ROW.profile });
    });
    if (projectRows === 0) rows.push({ kind: "head", section: "project", h: ROW.head });
    const selectedRow = rows.findIndex((r) => r.kind === "profile" && r.index === this.selected);
    const where = reg.projectPath ?? `${reg.projectTarget} (created on first save)`;

    const draw = (r) => {
      if (r.kind === "head") {
        const global = r.section === "global";
        return h_flex()
          .px(10)
          .pt(8)
          .gap(8)
          .items_center()
          .text_size(11.5)
          .font_semibold()
          .text_color(global ? t.accent : t.ansi5)
          .child(global ? "Global profiles" : `Project profiles${projectRows === 0 ? " (none)" : ""}`)
          .when(!global, (el) => el.child(div().flex_1().min_w(0).truncate().font_normal().text_color(t.dim).child(where)));
      }
      const p = r.p;
      const on = r.index === this.selected;
      const mark = detected.get(p.harness);
      const override = p.origin === "project-override";
      return v_flex()
        .id(`lo-p-${p.id}`)
        .on_mouse_down("left", keepPress)
        .mx(4)
        .px(10)
        .py(6)
        .gap(2)
        .rounded(8)
        .cursor_pointer()
        .when(on, (el) => el.bg(t.selected))
        .when(!on, (el) => el.hover((s) => s.bg(t.hover)))
        .on_click((e, cx) => {
          const again = this.selected === r.index;
          this.selected = r.index;
          this.pending = null;
          if (again || e.click_count > 1) this.open(cx, "edit");
          cx.notify();
        })
        .child(
          h_flex()
            .gap(8)
            .items_center()
            .child(div().flex_none().text_size(13.5).font_semibold().text_color(t.foreground).child(p.name ?? p.id))
            .child(div().flex_none().text_size(11.5).text_color(t.dim).child(p.id))
            .when(override, (el) => el.child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(t.ansi5).child(p.differing ? `≠ ${p.differing}` : "≠ override (same values)"))),
        )
        .child(
          h_flex()
            .gap(6)
            .items_center()
            .text_size(12)
            .text_color(t.muted)
            .child(div().flex_none().w(12).text_color(mark === undefined ? t.dim : mark ? t.ansi2 : t.blocked).child(mark === undefined ? "·" : mark ? "✓" : "✗"))
            .child(div().flex_1().min_w(0).truncate().child(`${p.harness} · ${p.model} · ${p.effort} · ${p.cost ?? "normal"}`)),
        );
    };

    const p = this.profile();
    return v_flex()
      .flex_1()
      .min_h(0)
      .gap(10)
      .child(this.measured("lo-list", "listHeight", this.listStrip.render("lo-list-strip", rows, this.listHeight, selectedRow, draw)))
      .when(Boolean(p), (el) =>
        el.child(
          v_flex()
            .flex_none()
            .p(10)
            .gap(4)
            .rounded(8)
            .bg(t.background)
            .border_1()
            .border_color(t.border)
            .text_size(12.5)
            .line_height("18px")
            .child(h_flex().gap(6).child(div().flex_none().w(52).text_color(t.dim).child("When")).child(div().flex_1().min_w(0).text_color(t.foreground).child(p.when_to_use ?? "")))
            .when(Boolean(p.avoid_when), (el) => el.child(h_flex().gap(6).child(div().flex_none().w(52).text_color(t.dim).child("Avoid")).child(div().flex_1().min_w(0).text_color(t.muted).child(p.avoid_when)))),
        ),
      );
  }

  listFooter(t) {
    if (this.pending) {
      return h_flex()
        .gap(8)
        .items_center()
        .child(div().flex_1().text_size(12.5).text_color(t.blocked).child(this.pending.question))
        .child(this.button(t, "lo-yes", "y", this.pending.action === "reset" ? "Reset" : "Delete", (cx) => this.answer(cx, true), { primary: true }))
        .child(this.button(t, "lo-no", "n", "Cancel", (cx) => this.answer(cx, false)));
    }
    const p = this.profile();
    return h_flex()
      .gap(6)
      .items_center()
      .flex_wrap()
      .child(this.button(t, "lo-edit", "Enter", "Edit", (cx) => this.open(cx, "edit"), { enabled: Boolean(p) }))
      .child(this.button(t, "lo-add", "a", "Add", (cx) => this.open(cx, "new")))
      .child(this.button(t, "lo-copy", "c", "Copy", (cx) => this.open(cx, "copy"), { enabled: Boolean(p) }))
      .child(this.button(t, "lo-del", "d", "Delete", (cx) => this.ask(cx, "delete"), { enabled: Boolean(p) }))
      .when(p?.origin === "project-override", (el) => el.child(this.button(t, "lo-reset", "r", "Reset override", (cx) => this.ask(cx, "reset"))))
      .child(this.button(t, "lo-detect", "j", "Harnesses", (cx) => this.showHarnesses(cx)))
      .child(div().flex_1())
      .child(this.button(t, "lo-close", "Esc", "Close", () => this.dismiss()));
  }

  scopeLine() {
    const ed = this.ed;
    const target = this.registry?.projectTarget ?? "";
    return {
      project: `project profile · p saves to ${target}`,
      global: "global profile · g saves global · p saves a project override",
      override: "global profile with a project override · ≠ differs from global · g global · p project",
      new: "new profile · g saves to global · p saves to this project",
    }[ed.kind];
  }

  editPage(t) {
    const ed = this.ed;
    const rows = ed.fields.map((f, i) => ({ f, i, h: ROW.field }));
    const picking = ed.mode === "pick";
    const f = this.field();
    const drawField = (r) => {
      const on = r.i === ed.cursor;
      const typing = on && ed.mode === "type";
      return h_flex()
        .id(`lo-f-${r.f.field}`)
        .on_mouse_down("left", keepPress)
        .mx(2)
        .px(10)
        .gap(10)
        .items_center()
        .rounded(7)
        .cursor_pointer()
        .when(on, (el) => el.bg(t.selected))
        .when(!on, (el) => el.hover((s) => s.bg(t.hover)))
        .on_click((_e, cx) => {
          if (this.busy) return;
          const again = ed.cursor === r.i && ed.mode === "fields";
          ed.cursor = r.i;
          ed.mode = "fields";
          this.focusNow();
          if (again) this.openField(cx);
          cx.notify();
        })
        .child(div().flex_none().w(130).text_size(12.5).text_color(on ? t.accent : t.muted).child(r.f.label))
        .child(
          typing
            ? Input.new(this.text).flex_1().h(24).px(8).rounded(6).border_1().border_color(t.accent).bg(t.background).text_size(12.5).text_color(t.foreground)
            : div().flex_1().min_w(0).truncate().text_size(12.5).text_color(r.f.value ? t.foreground : t.dim).child(r.f.value || "(unset)"),
        )
        .child(div().flex_none().w(14).text_size(12).text_color(t.ansi5).child(r.f.differs ? "≠" : ""))
        .child(div().flex_none().w(12).text_size(11).text_color(t.dim).child(r.f.options ? "▾" : ""));
    };

    const note = ed.status
      ? null
      : f?.note
        ? { text: f.note, ok: false }
        : f?.differs
          ? { text: `≠ global: ${f.global}${ed.kind === "project" || ed.kind === "new" ? "" : "  ·  r reverts this field"}`, tone: "diff" }
          : null;

    return v_flex()
      .flex_1()
      .min_h(0)
      .gap(8)
      .child(
        h_flex()
          .gap(10)
          .items_center()
          .child(div().text_size(14).font_semibold().text_color(t.foreground).child(ed.draft.id ? `Edit ${ed.draft.id}` : "New profile"))
          .when(ed.dirty, (el) => el.child(div().text_size(12).text_color(t.ansi3).child("● unsaved"))),
      )
      .child(div().text_size(12).text_color(ed.kind === "project" || ed.kind === "override" ? t.ansi5 : t.dim).truncate().child(this.scopeLine()))
      .child(
        picking
          ? v_flex().flex_none().child(this.fieldStrip.render("lo-fields", rows, Math.min(rows.length * ROW.field, 4 * ROW.field), ed.cursor, drawField))
          : this.measured("lo-fields-box", "fieldHeight", this.fieldStrip.render("lo-fields", rows, this.fieldHeight, ed.cursor, drawField)),
      )
      .when(picking, (el) => el.child(this.pickerPanel(t)))
      .when(Boolean(ed.status ?? note), (el) => el.child(this.statusLine(t, ed.status ?? note)));
  }

  pickerPanel(t) {
    const ed = this.ed;
    const f = this.field();
    const view = this.shownOptions();
    const shown = view.models;
    ed.option = Math.min(ed.option, Math.max(0, shown.length - 1));
    const rows = shown.map((o, i) => ({ o, i, h: ROW.option }));
    const draw = (r) => {
      const on = r.i === ed.option;
      const current = r.o.id === f.value;
      return h_flex()
        .id(`lo-o-${r.i}`)
        .on_mouse_down("left", keepPress)
        .mx(2)
        .px(10)
        .gap(10)
        .items_center()
        .rounded(6)
        .cursor_pointer()
        .when(on, (el) => el.bg(t.selected))
        .when(!on, (el) => el.hover((s) => s.bg(t.hover)))
        .on_click((_e, cx) => {
          ed.option = r.i;
          this.applyOption(cx);
        })
        .child(div().flex_none().w(10).text_color(t.accent).child(current ? "•" : ""))
        .child(div().flex_none().text_size(12.5).text_color(t.foreground).child(r.o.id))
        .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(t.dim).child(r.o.label && r.o.label !== r.o.id ? r.o.label : ""))
        .when(Boolean(r.o.context), (el) => el.child(div().flex_none().text_size(11).text_color(t.dim).child(`${Math.round(r.o.context / 1000)}k`)));
    };
    const header = h_flex()
      .gap(8)
      .items_center()
      .text_size(11.5)
      .text_color(t.dim)
      .child(div().font_semibold().text_color(t.muted).child(f.label))
      .child(div().child(`${SORT_LABELS[ed.sort]} (Tab)`))
      .child(div().flex_1())
      .child(div().child(shown.length ? `${ed.option + 1}/${shown.length}${shown.length !== view.total ? ` of ${view.total}` : ""}` : ""));
    return v_flex()
      .flex_1()
      .min_h(0)
      .gap(6)
      .p(8)
      .rounded(8)
      .bg(t.background)
      .border_1()
      .border_color(t.border)
      .child(header)
      .when(this.filtering(), (el) =>
        el.child(
          h_flex()
            .id("lo-filter")
            .on_mouse_down("left", keepPress)
            .h(30)
            .flex_none()
            .px(8)
            .gap(8)
            .items_center()
            .rounded(7)
            .border_1()
            .border_color(t.accent)
            .bg(t.popover)
            .child(svg("mods/workspace-chrome/search.svg").size(14).text_color(t.dim))
            .child(Input.new(this.filter).flex_1().h_full().text_size(12.5).text_color(t.foreground)),
        ),
      )
      .child(
        f.pending
          ? h_flex().gap(8).items_center().px(10).py(6).text_size(12.5).text_color(t.dim).child(svg(SPINNER).size(12).text_color(t.working).spin(900)).child(`reading ${this.ed.draft.harness} models…`)
          : shown.length === 0
            ? div().px(10).py(6).text_size(12.5).text_color(t.dim).child("nothing matches")
            : this.measured("lo-options", "optionHeight", this.optionStrip.render("lo-options-strip", rows, this.optionHeight ?? 200, ed.option, draw)),
      );
  }

  editFooter(t) {
    const ed = this.ed;
    if (ed.mode === "pick") {
      return h_flex()
        .gap(6)
        .items_center()
        .child(this.button(t, "lo-apply", "Enter", "Apply", (cx) => this.applyOption(cx), { primary: true }))
        .child(this.button(t, "lo-order", "Tab", "Order", (cx) => {
          ed.sort = nextSort(ed.sort);
          ed.option = 0;
          cx.notify();
        }))
        .child(div().flex_1())
        .child(this.button(t, "lo-pick-back", "Esc", ed.query ? "Clear filter" : "Back", (cx) => this.editKey("escape", cx) && cx.notify()));
    }
    if (ed.mode === "type") {
      return h_flex()
        .gap(6)
        .items_center()
        .child(this.button(t, "lo-confirm", "Enter", "Confirm", (cx) => this.commitText(cx), { primary: true }))
        .child(div().flex_1())
        .child(this.button(t, "lo-type-back", "Esc", "Cancel", (cx) => this.editKey("escape", cx) && cx.notify()));
    }
    const f = this.field();
    return h_flex()
      .gap(6)
      .items_center()
      .flex_wrap()
      .child(this.button(t, "lo-open", "Enter", "Change", (cx) => this.openField(cx), { enabled: Boolean(f) }))
      .when(ed.kind !== "project", (el) => el.child(this.button(t, "lo-save-g", "g", "Save global", (cx) => this.save(cx, "global"), { primary: true })))
      .child(this.button(t, "lo-save-p", "p", ed.kind === "project" ? "Save" : "Save project", (cx) => this.save(cx, "project"), { primary: ed.kind === "project" }))
      .when(Boolean(f?.differs) && (ed.kind === "global" || ed.kind === "override"), (el) => el.child(this.button(t, "lo-revert", "r", "Revert field", (cx) => this.change(cx, { revert: f.field }))))
      .child(this.button(t, "lo-test", "t", "Test launch", (cx) => this.test(cx)))
      .child(div().flex_1())
      .child(this.button(t, "lo-back", "Esc", ed.discardArmed ? "Discard" : "Back", (cx) => this.back(cx)));
  }

  detectPage(t) {
    const rows = (this.registry?.detection ?? []).map((d) => ({ d, h: ROW.harness }));
    const draw = (r) => {
      const d = r.d;
      const err = this.catalogErrors[d.id];
      const count = this.catalogCounts[d.id];
      const models = !d.detected ? "" : err ? err.replace(/\s+/g, " ") : count !== undefined ? `${count} models` : "reading models…";
      return v_flex()
        .px(10)
        .py(5)
        .gap(2)
        .child(
          h_flex()
            .gap(10)
            .items_center()
            .text_size(13)
            .child(div().flex_none().w(80).font_semibold().text_color(t.foreground).child(d.id))
            .child(div().flex_none().w(96).text_color(d.detected ? t.ansi2 : t.blocked).child(d.detected ? "✓ detected" : "✗ not found"))
            .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(err ? t.blocked : t.muted).child(models)),
        )
        .child(div().pl(90).truncate().text_size(11.5).text_color(t.dim).child(d.path ?? ""));
    };
    return v_flex()
      .flex_1()
      .min_h(0)
      .gap(8)
      .child(div().text_size(14).font_semibold().text_color(t.foreground).child("Harnesses on this machine"))
      .child(this.measured("lo-harness", "harnessHeight", this.harnessStrip.render("lo-harness-strip", rows, this.harnessHeight ?? 300, -1, draw)));
  }

  render(cx) {
    const t = theme();
    const page = this.page === "edit" && this.ed ? "edit" : this.page;
    const body = page === "edit" ? this.editPage(t) : page === "detect" ? this.detectPage(t) : this.listPage(t);
    const footer =
      page === "edit"
        ? this.editFooter(t)
        : page === "detect"
          ? h_flex().child(div().flex_1()).child(this.button(t, "lo-detect-back", "Esc", "Back", (cx) => {
              this.page = "list";
              cx.notify();
            }))
          : this.listFooter(t);
    return v_flex()
      .id("herdr-loadout")
      .track_focus(this.handle)
      .on_key_down((e, cx) => this.key(e, cx))
      .size_full()
      .min_h(0)
      .p(18)
      .gap(12)
      .bg(t.popover)
      .text_color(t.foreground)
      .child(
        h_flex()
          .flex_none()
          .gap(10)
          .items_center()
          .child(div().text_size(15).font_semibold().child("Agent Profiles"))
          .when(this.busy > 0, (el) => el.child(svg(SPINNER).size(13).text_color(t.working).spin(900)))
          .child(div().flex_1())
          .child(div().text_size(11).text_color(t.dim).child("herdr-loadout")),
      )
      .child(body)
      .when(page === "list" && Boolean(this.message), (el) => el.child(this.statusLine(t, this.message)))
      .child(div().flex_none().child(footer));
  }
}
