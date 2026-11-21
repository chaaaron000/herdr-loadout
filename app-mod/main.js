// Agent Profiles: the herdr-loadout registry, edited in the Herdr app.
//
// Opened as a window (`mod.open herdr-loadout`, usually from a key). The list
// on the left shows the global profiles and the profiles of the project the
// focused terminal is in, the selected one in full on the right. Enter edits
// it, a adds, c copies, d deletes, r drops a project override, [ and ] move it
// up or down its group (so do the Up and Down buttons beside its name), j lists
// the harnesses on this machine, k manages stored API keys, Esc closes.
//
// Every read and write goes through `herdr-loadout editor <action>`, the CLI's
// JSON backend, so this editor follows the same rules as the terminal one.
// `cli.js` (where node and the CLI are) and `picker.js` (the model filter and
// orders) are written by the installer, scripts/install-app-mod.mjs.

import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, TextareaState, Textarea } from "gpui-base";
import { exec, focused, spaces, home, theme, settings, props, closeOverlay } from "herdr";
import { CLI } from "./cli.js";
import { pickerView, nextSort, SORT_LABELS } from "./picker.js";

const SPINNER = "mods/workspace-chrome/spinner.svg";
const AGENT_ICON = "icons/agent.svg";
const CLOSE_ICON = "mods/workspace-chrome/x.svg";
const CHEVRON_ICON = "mods/workspace-chrome/chevron-down.svg";
const CHECK_ICON = "mods/workspace-chrome/check.svg";
const SEARCH_ICON = "mods/workspace-chrome/search.svg";
const ROW = { head: 32, profile: 50, empty: 28, fieldHead: 36, field: 40, name: 70, long: 78, option: 30, harness: 62, key: 58 };

/** Fields whose text is a sentence or two: shown wrapped, typed in a textarea. */
const LONG_FIELDS = new Set(["when_to_use", "avoid_when"]);

/** Which group each editor field sits under; the name heads the page on its own. */
const GROUP_OF = {
  name: null,
  harness: "Launch",
  api: "Launch",
  auth: "Launch",
  model: "Launch",
  effort: "Launch",
  // Permissions are part of how the worker starts, not a section of their own.
  sandbox: "Launch",
  approval_policy: "Launch",
  permission_mode: "Launch",
  cost: "Routing",
  when_to_use: "Routing",
  avoid_when: "Routing",
  // The editor lists extra args, env, then tags, so all three sit in the last group.
  extra_args: "More",
  env: "More",
  tags: "More",
};

// The app's own program icons: full-color ones draw as images, one-color ones take the text color.
const HARNESS_ICONS = {
  claude: ["icons/claude.svg", false],
  codex: ["icons/codex.svg", false],
  agy: ["icons/antigravity.svg", false],
  opencode: ["icons/opencode.svg", true],
  pi: ["icons/pi.svg", true],
};

function harnessIcon(t, harness, size) {
  const [path, tint] = HARNESS_ICONS[harness] ?? [AGENT_ICON, true];
  return tint ? svg(path).size(size).flex_none().text_color(t.muted) : image(path).w(size).h(size).flex_none();
}

function costColor(t, cost) {
  return { cheap: t.ansi2, expensive: t.ansi3 }[cost] ?? t.muted;
}

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
    // Clicking elsewhere keeps what was typed, as a form would.
    this.text.on("blur", (_e, cx) => this.commitText(cx));
    this.filter = InputState.new({ placeholder: "Filter: words match the id, provider or label" });
    this.filter.on("change", (_e, cx) => {
      if (!this.ed) return;
      this.ed.query = this.filter.value();
      this.ed.option = 0;
      this.optionStrip.reveal();
      cx.notify();
    });
    this.filter.on("submit", (_e, cx) => this.applyOption(cx));

    // When and Avoid are a sentence or two: typed in a textarea that wraps.
    this.area = TextareaState.new({});
    this.area.set_rows(3);
    this.area.on("blur", (_e, cx) => this.commitText(cx));
    this.area.on("submit", (_e, cx) => this.commitText(cx));

    // API keys page
    this.keys = null; // the `keys` answer
    this.keySelected = 0;
    this.keyForm = null; // { provider } while adding a key
    this.keyPending = null; // the key waiting for y to delete it
    this.keyMessage = null;
    this.keyTests = {};
    this.keyStrip = new Strip();
    this.keySecret = InputState.new({ placeholder: "Paste the API key" });
    this.keySecret.set_masked(true);
    this.keyId = InputState.new({ placeholder: "Defaults to the provider id" });
    this.keyLabel = InputState.new({ placeholder: "Optional: personal, work…" });
    for (const input of [this.keySecret, this.keyId, this.keyLabel]) input.on("submit", (_e, cx) => this.saveKeyForm(cx));

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

  /** Move the selected profile one place within its group; the selection follows it. */
  move(cx, direction) {
    const p = this.profile();
    if (!p) return;
    this.pending = null;
    this.task(cx, async (cx) => {
      const r = await this.call("move", { id: p.id, direction });
      if (!r.ok) {
        this.message = { text: r.error, ok: false };
        return;
      }
      this.selected = r.index;
      if (r.moved) this.reload(cx, { text: r.message, ok: true });
      else this.message = { text: r.message, ok: true };
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
   * Ask the backend for the draft's fields, after one change. Requests run one
   * after another, each on the draft the previous one left, so two quick
   * changes (typing, then a click) both land.
   */
  view(change, cx) {
    const run = () => this.viewNow(change, cx);
    this.viewChain = (this.viewChain ?? Promise.resolve()).then(run, run);
    return this.viewChain;
  }

  /** An answer meant for a draft that has since been closed or replaced is dropped. */
  async viewNow(change, cx) {
    const ed = this.ed;
    if (!ed) return;
    const seq = ++ed.seq;
    const r = await this.call("view", {
      draft: ed.draft,
      kind: ed.kind,
      baseline: ed.baseline,
      catalogError: ed.catalog ? this.catalogErrors[ed.catalog] ?? null : null,
      ...change,
    });
    if (this.ed !== ed || seq !== ed.seq) return;
    if (!r.ok) {
      ed.status = { text: r.error, ok: false };
      return;
    }
    ed.draft = r.draft;
    ed.catalog = r.catalog;
    ed.fields = r.fields;
    ed.dirty = r.dirty;
    ed.cursor = Math.min(ed.cursor, Math.max(0, r.fields.length - 1));
    if (r.status) ed.status = { text: r.status, ok: true };
    if (!r.catalogReady) this.loadCatalog(r.catalog, cx);
  }

  /**
   * Read a model list once per session, then show the fields again. The id is
   * a harness, or a variant such as `agy-api` (agy through the Gemini API).
   */
  loadCatalog(catalog, cx) {
    if (this.catalogAsked.has(catalog)) return;
    this.catalogAsked.add(catalog);
    const showing = () => this.ed?.catalog === catalog;
    this.task(cx, async (cx) => {
      const r = await this.call("models", { catalog });
      if (r.ok) this.catalogCounts[catalog] = r.count;
      else this.catalogErrors[catalog] = r.error;
      if (showing()) await this.view({}, cx);
      // A cached list can predate a provider login or logout, so read the CLI
      // once more behind it. A failed read keeps the cached rows.
      if (r.ok && r.revalidate) {
        const fresh = await this.call("models", { catalog, refresh: true });
        if (fresh.ok) {
          this.catalogCounts[catalog] = fresh.count;
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
      const input = this.inputFor(f);
      input.set_value(f.text);
      input.focus();
    }
    cx.notify();
  }

  /** The text input a field is typed into. */
  inputFor(f) {
    return f && LONG_FIELDS.has(f.field) ? this.area : this.text;
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

  /** A short choice list drawn as buttons in the field itself; null when it needs the picker. */
  segments(f) {
    if (!f?.options || f.field === "model" || f.pending) return null;
    const chars = f.options.reduce((sum, option) => sum + String(option.id).length, 0);
    return f.options.length <= 7 && chars <= 56 ? f.options : null;
  }

  /** Step a button-row field to its next (or previous) choice. */
  stepChoice(cx, direction) {
    const f = this.field();
    const options = this.segments(f);
    if (!options) return false;
    const at = Math.max(0, options.findIndex((option) => option.id === f.value));
    const next = options[(at + direction + options.length) % options.length];
    this.change(cx, { set: { field: f.field, value: next.id } });
    return true;
  }

  applyOption(cx) {
    const ed = this.ed;
    if (!ed || ed.mode !== "pick") return;
    const shown = this.shownOptions().models;
    const row = shown[Math.min(ed.option, shown.length - 1)];
    if (!row) return;
    this.change(cx, { set: { field: this.field().field, value: row.id } });
  }

  /** Keep what is being typed before a click moves elsewhere. */
  leaveTyping(cx) {
    if (this.ed?.mode === "type") this.commitText(cx);
  }

  commitText(cx) {
    const ed = this.ed;
    if (!ed || ed.mode !== "type") return;
    const f = this.field();
    // A newline has no meaning in these fields; Enter in the textarea adds one.
    const value = this.inputFor(f).value().replace(/\s*\n\s*/g, " ").trim();
    if (value === f.text) {
      // Nothing typed: leave the field without a round trip.
      ed.mode = "fields";
      this.focusNow();
      cx.notify();
      return;
    }
    this.change(cx, { set: { field: f.field, value } });
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
    ed.status = { text: "Testing the launch…", ok: true };
    this.task(cx, async () => {
      const r = await this.call("test", { draft: ed.draft });
      if (!r.ok) {
        ed.status = { text: r.error, ok: false };
        return;
      }
      // A pass needs no detail; a failure names each check that failed.
      const failed = r.checks.filter((c) => !c.ok);
      ed.status = r.launchable
        ? { text: `Launches: ${r.checks.length} checks passed`, ok: true }
        : { text: failed.map((c) => `${c.label}: ${c.detail}`).join(" · "), ok: false };
    });
  }

  back(cx) {
    const ed = this.ed;
    if (ed.dirty && !ed.discardArmed) {
      ed.discardArmed = true;
      ed.status = { text: "Unsaved changes. Discard again to drop them, or save.", ok: false };
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

  // ---- API keys ----

  showKeys(cx) {
    this.page = "keys";
    this.message = null;
    this.keyForm = null;
    this.keyPending = null;
    this.reloadKeys(cx);
    this.focusNow();
    cx.notify();
  }

  reloadKeys(cx, message = null) {
    this.task(cx, async () => {
      const r = await this.call("keys");
      if (!r.ok) {
        this.keyMessage = { text: r.error, ok: false };
        return;
      }
      this.keys = r;
      this.keySelected = Math.max(0, Math.min(this.keySelected, r.keys.length - 1));
      this.keyStrip.reveal();
      if (message) this.keyMessage = message;
    });
  }

  selectedKey() {
    return this.keys?.keys[this.keySelected] ?? null;
  }

  openKeyForm(cx, provider = null) {
    const providers = this.keys?.providers ?? [];
    // Offer a provider that has no key yet first.
    const fresh = providers.find((entry) => !(this.keys?.keys ?? []).some((key) => key.provider === entry.id));
    this.keyForm = { provider: provider ?? fresh?.id ?? providers[0]?.id };
    this.keyPending = null;
    this.keyMessage = null;
    for (const input of [this.keySecret, this.keyId, this.keyLabel]) input.set_value("");
    this.keySecret.focus();
    cx.notify();
  }

  closeKeyForm() {
    this.keyForm = null;
    this.keySecret.set_value("");
    this.focusNow();
  }

  saveKeyForm(cx) {
    const form = this.keyForm;
    if (!form || this.busy) return;
    const input = {
      provider: form.provider,
      id: this.keyId.value().trim() || form.provider,
      key: this.keySecret.value().trim(),
      label: this.keyLabel.value().trim(),
    };
    this.task(cx, async (cx) => {
      const r = await this.call("key.save", input);
      if (!r.ok) {
        this.keyMessage = { text: r.error, ok: false };
        return;
      }
      this.closeKeyForm();
      this.reloadKeys(cx, { text: `Stored "${r.id}". Pick it in a profile's API field.`, ok: true });
    });
  }

  testKey(cx) {
    const key = this.selectedKey();
    if (!key) return;
    this.keyTests[key.id] = { pending: true };
    this.keyMessage = { text: `Asking ${key.providerLabel} about "${key.id}"…`, ok: true };
    this.task(cx, async () => {
      const r = await this.call("key.test", { id: key.id });
      const detail = r.detail ?? r.error ?? "no answer";
      this.keyTests[key.id] = { ok: r.ok };
      this.keyMessage = { text: `${key.id}: ${detail}`, ok: r.ok };
    });
  }

  answerKey(cx, yes) {
    const key = this.keyPending;
    this.keyPending = null;
    if (!yes || !key) {
      cx.notify();
      return;
    }
    this.task(cx, async (cx) => {
      const r = await this.call("key.remove", { id: key.id });
      if (!r.ok) {
        this.keyMessage = { text: r.error, ok: false };
        return;
      }
      this.keySelected = Math.max(0, this.keySelected - 1);
      this.reloadKeys(cx, { text: `Removed "${key.id}"`, ok: true });
    });
  }

  keysKey(k, cx) {
    if (this.keyPending) {
      if (k === "y") this.answerKey(cx, true);
      else if (k === "n" || k === "escape") this.answerKey(cx, false);
      else return false;
      return true;
    }
    if (this.keyForm) {
      if (k !== "escape") return false; // the inputs take the rest; Enter saves
      this.closeKeyForm();
      return true;
    }
    const count = this.keys?.keys.length ?? 0;
    if (k === "escape" || k === "k") {
      this.page = "list";
      this.keyMessage = null;
    } else if (k === "down" && count) this.keySelected = Math.min(count - 1, this.keySelected + 1);
    else if (k === "up" && count) this.keySelected = Math.max(0, this.keySelected - 1);
    else if (k === "a") this.openKeyForm(cx);
    else if (k === "t" && count) this.testKey(cx);
    else if (k === "d" && count) {
      this.keyPending = this.selectedKey();
      this.keyMessage = null;
    } else return false;
    this.keyStrip.reveal();
    return true;
  }

  // ---- keys ----

  focusNow() {
    // The key form keeps its inputs focused; the page handles keys otherwise.
    if (this.page === "keys" && this.keyForm) return;
    this.handle.focus();
    if (this.page !== "edit") return;
    if (this.ed?.mode === "pick" && this.filtering()) this.filter.focus();
    if (this.ed?.mode === "type") this.inputFor(this.field()).focus();
  }

  dismiss() {
    if (props()?.overlay) closeOverlay(props().overlay);
  }

  key(e, cx) {
    const k = e.key;
    const handled =
      this.page === "edit" && this.ed ? this.editKey(k, cx)
      : this.page === "detect" ? this.detectKey(k, cx)
      : this.page === "keys" ? this.keysKey(k, cx)
      : this.listKey(k, cx);
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
    // A message stands in for the action buttons until the next key.
    this.message = null;
    const count = this.registry?.profiles.length ?? 0;
    if (k === "escape") this.dismiss();
    else if (k === "down" && count) this.selected = Math.min(count - 1, this.selected + 1);
    else if (k === "up" && count) this.selected = Math.max(0, this.selected - 1);
    else if ((k === "enter" || k === "e") && count) this.open(cx, "edit");
    else if (k === "a") this.open(cx, "new");
    else if (k === "c" && count) this.open(cx, "copy");
    else if (k === "d" && count) this.ask(cx, "delete");
    else if (k === "r" && count) this.ask(cx, "reset");
    else if (k === "[" && count) this.move(cx, "up");
    else if (k === "]" && count) this.move(cx, "down");
    else if (k === "j") this.showHarnesses(cx);
    else if (k === "k") this.showKeys(cx);
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
    else if ((k === "left" || k === "right") && this.segments(this.field())) this.stepChoice(cx, k === "right" ? 1 : -1);
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

  /** A key as a small keycap. */
  kbd(t, key, { inverse = false } = {}) {
    return div()
      .flex_none()
      .h(18)
      .px(5)
      .flex()
      .items_center()
      .rounded(4)
      .border_1()
      .border_color(inverse ? t.solid_foreground : t.border)
      .text_size(10.5)
      .font_medium()
      .text_color(inverse ? t.solid_foreground : t.muted)
      .child(key);
  }

  button(t, id, keys, label, onClick, { primary = false, enabled = true } = {}) {
    return h_flex()
      .id(id)
      .on_mouse_down("left", keepPress)
      .flex_none()
      .h(30)
      .pl(6)
      .pr(10)
      .gap(7)
      .items_center()
      .rounded(7)
      .text_size(12.5)
      .when(primary, (el) => el.bg(t.solid).text_color(t.solid_foreground))
      .when(!primary, (el) => el.text_color(t.foreground))
      .when(!enabled, (el) => el.opacity(0.35))
      .when(enabled, (el) => el.cursor_pointer().hover((s) => (primary ? s.opacity(0.88) : s.bg(t.hover))).on_click((_e, cx) => onClick(cx)))
      .child(this.kbd(t, keys, { inverse: primary }))
      .child(label);
  }

  /** A rounded label: an origin, a cost, whether the harness is installed. */
  pill(t, text, color) {
    return div()
      .flex_none()
      .h(20)
      .px(8)
      .flex()
      .items_center()
      .rounded(10)
      .border_1()
      .border_color(color)
      .text_size(11)
      .text_color(color)
      .child(text);
  }

  /** One line of feedback with its mark: `tone` is "ok", "error", or "diff". */
  statusLine(t, status) {
    const tone = status.tone ?? (status.ok ? "ok" : "error");
    const color = { ok: t.ansi2, error: t.blocked, diff: t.ansi5 }[tone];
    return h_flex()
      .flex_1()
      .min_w(0)
      .gap(7)
      .items_center()
      .text_size(12)
      .child(div().flex_none().text_color(color).child({ ok: "✓", error: "✗", diff: "≠" }[tone]))
      .child(div().flex_1().min_w(0).truncate().text_color(tone === "error" ? t.blocked : t.muted).child(status.text));
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

  header(t) {
    const title =
      this.page === "detect" ? "Harnesses"
      : this.page === "keys" ? "API keys"
      : this.page === "edit" && this.ed ? (this.ed.draft.id ? `Edit ${this.ed.draft.id}` : "New profile")
      : "Agent Profiles";
    const project = this.project.split(/[\\/]/).filter(Boolean).pop() ?? this.project;
    return h_flex()
      .flex_none()
      .h(56)
      .px(20)
      .gap(12)
      .items_center()
      .border_b(1)
      .border_color(t.border)
      .child(svg(AGENT_ICON).size(18).flex_none().text_color(t.accent))
      .child(
        v_flex()
          .flex_1()
          .min_w(0)
          .child(
            h_flex()
              .gap(8)
              .items_center()
              .child(div().text_size(14.5).font_semibold().text_color(t.foreground).child(title))
              .when(this.page === "edit" && Boolean(this.ed?.dirty), (el) => el.child(div().text_size(11.5).text_color(t.ansi3).child("● unsaved"))),
          )
          .child(div().truncate().text_size(11.5).text_color(t.dim).child(this.page === "keys" ? this.keys?.path ?? "" : `project ${project}`)),
      )
      .when(this.busy > 0, (el) => el.child(svg(SPINNER).size(14).flex_none().text_color(t.working).spin(900)))
      .child(
        div()
          .id("lo-x")
          .on_mouse_down("left", keepPress)
          .flex_none()
          .size(28)
          .flex()
          .items_center()
          .justify_center()
          .rounded(7)
          .cursor_pointer()
          .hover((s) => s.bg(t.hover))
          .on_click(() => this.dismiss())
          .child(svg(CLOSE_ICON).size(14).text_color(t.muted)),
      );
  }

  footer(t, left, right) {
    return h_flex()
      .flex_none()
      .h(56)
      .px(16)
      .gap(6)
      .items_center()
      .border_t(1)
      .border_color(t.border)
      .child(h_flex().flex_1().min_w(0).gap(6).items_center().children(left))
      .children(right);
  }

  // -- list --

  listPage(t) {
    const reg = this.registry;
    if (!reg) {
      return v_flex().flex_1().items_center().justify_center().text_size(13).text_color(this.loadError ? t.blocked : t.dim).child(this.loadError ?? "Reading profiles…");
    }
    const detected = new Map(reg.detection.map((d) => [d.id, d.detected]));
    const global = reg.profiles.filter((p) => p.origin !== "project-only").length;
    const local = reg.profiles.length - global;
    const rows = [];
    let section = null;
    reg.profiles.forEach((p, index) => {
      const s = p.origin === "project-only" ? "project" : "global";
      if (s !== section) rows.push({ kind: "head", section: s, h: ROW.head });
      section = s;
      rows.push({ kind: "profile", p, index, h: ROW.profile });
    });
    if (local === 0) rows.push({ kind: "head", section: "project", h: ROW.head }, { kind: "empty", h: ROW.empty });
    const selectedRow = rows.findIndex((r) => r.kind === "profile" && r.index === this.selected);

    const draw = (r) => {
      if (r.kind === "head") {
        return h_flex()
          .px(10)
          .pt(10)
          .items_center()
          .text_size(11)
          .font_semibold()
          .text_color(t.dim)
          .child(div().flex_1().child(r.section === "global" ? "GLOBAL" : "THIS PROJECT"))
          .child(div().font_normal().child(String(r.section === "global" ? global : local)));
      }
      if (r.kind === "empty") {
        return div().px(10).pt(4).text_size(12).text_color(t.dim).child("Nothing here yet");
      }
      const p = r.p;
      const on = r.index === this.selected;
      return h_flex()
        .id(`lo-p-${p.id}`)
        .on_mouse_down("left", keepPress)
        .mx(2)
        .px(10)
        .gap(10)
        .items_center()
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
        .child(div().flex_none().when(detected.get(p.harness) === false, (el) => el.opacity(0.4)).child(harnessIcon(t, p.harness, 18)))
        .child(
          v_flex()
            .flex_1()
            .min_w(0)
            .gap(1)
            .child(
              h_flex()
                .gap(6)
                .items_center()
                .child(div().flex_none().text_size(13).font_semibold().text_color(t.foreground).child(p.name ?? p.id))
                .when(p.origin === "project-override", (el) => el.child(div().flex_none().text_size(11).text_color(t.ansi5).child("≠"))),
            )
            .child(div().truncate().text_size(11.5).text_color(t.muted).child(`${p.model} · ${p.effort}`)),
        );
    };

    return h_flex()
      .flex_1()
      .min_h(0)
      .items_start()
      .child(
        v_flex()
          .w(290)
          .h_full()
          .flex_none()
          .p(8)
          .border_r(1)
          .border_color(t.border)
          .child(this.measured("lo-list", "listHeight", this.listStrip.render("lo-list-strip", rows, this.listHeight, selectedRow, draw))),
      )
      .child(this.profileDetail(t, detected));
  }

  profileDetail(t, detected) {
    const p = this.profile();
    if (!p) {
      return v_flex().flex_1().h_full().items_center().justify_center().gap(6).text_size(13).text_color(t.dim).child("No profiles yet").child(div().text_size(12).child("Press a to add one."));
    }
    const installed = detected.get(p.harness);
    const origin = { global: ["Global", t.muted], "project-override": ["Project override", t.ansi5], "project-only": ["This project", t.ansi5] }[p.origin] ?? ["Global", t.muted];
    // A profile moves only among the profiles of its own group (global or this project).
    const group = this.registry.profiles.filter((q) => (q.origin === "project-only") === (p.origin === "project-only"));
    const place = group.indexOf(p);
    const permissions = [p.sandbox, p.approval_policy, p.permission_mode].filter(Boolean).join(" · ");
    const facts = [
      ["Harness", p.harness],
      ["API", p.api ? `${p.api} (stored key)` : p.harness === "agy" && p.auth === "api-key" ? "GEMINI_API_KEY from the environment" : ""],
      ["Model", p.model],
      ["Effort", p.effort],
      ["Permissions", permissions || "inherit"],
      ["Tags", (p.tags ?? []).join(", ")],
      ["Extra args", (p.extra_args ?? []).join(" ")],
      // The registry masks env values; only the names are shown.
      ["Env", Object.keys(p.env ?? {}).map((key) => `${key}=***`).join(" ")],
    ].filter(([, value]) => value);
    const block = (label, text, color) =>
      v_flex()
        .gap(4)
        .child(div().text_size(11).font_semibold().text_color(t.dim).child(label))
        .child(div().text_size(12.5).line_height("19px").text_color(color).child(text));
    return v_flex()
      .id("lo-detail")
      .flex_1()
      .h_full()
      .min_w(0)
      .p(20)
      .gap(16)
      .overflow_y_scroll()
      .child(
        h_flex()
          .gap(12)
          .items_center()
          .child(harnessIcon(t, p.harness, 28))
          .child(
            v_flex()
              .flex_1()
              .min_w(0)
              .child(div().truncate().text_size(17).font_semibold().text_color(t.foreground).child(p.name ?? p.id))
              .child(div().text_size(12).text_color(t.dim).child(p.id)),
          )
          .child(this.button(t, "lo-up", "[", "Up", (cx) => this.move(cx, "up"), { enabled: place > 0 }))
          .child(this.button(t, "lo-down", "]", "Down", (cx) => this.move(cx, "down"), { enabled: place < group.length - 1 })),
      )
      .child(
        h_flex()
          .gap(6)
          .flex_wrap()
          .child(this.pill(t, origin[0], origin[1]))
          .child(this.pill(t, p.cost ?? "normal", costColor(t, p.cost)))
          .when(installed !== undefined, (el) => el.child(this.pill(t, installed ? `${p.harness} installed` : `${p.harness} not found`, installed ? t.ansi2 : t.blocked))),
      )
      .child(
        v_flex()
          .gap(6)
          .p(12)
          .rounded(8)
          .bg(t.background)
          .border_1()
          .border_color(t.border)
          .children(
            facts.map(([label, value]) =>
              h_flex()
                .gap(12)
                .text_size(12.5)
                .child(div().flex_none().w(86).text_color(t.dim).child(label))
                .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(value)),
            ),
          ),
      )
      .when(p.origin === "project-override", (el) =>
        el.child(div().text_size(12).text_color(t.ansi5).child(p.differing ? `This project changes ${p.differing}.` : "This project restates the global values.")),
      )
      .child(block("WHEN TO USE", p.when_to_use ?? "", t.foreground))
      .when(Boolean(p.avoid_when), (el) => el.child(block("AVOID WHEN", p.avoid_when, t.muted)));
  }

  listFooter(t) {
    if (this.pending) {
      return this.footer(
        t,
        [div().flex_1().min_w(0).truncate().text_size(12.5).text_color(t.blocked).child(this.pending.question)],
        [
          this.button(t, "lo-no", "n", "Cancel", (cx) => this.answer(cx, false)),
          this.button(t, "lo-yes", "y", this.pending.action === "reset" ? "Reset" : "Delete", (cx) => this.answer(cx, true), { primary: true }),
        ],
      );
    }
    const p = this.profile();
    const left = this.message
      ? [this.statusLine(t, this.message)]
      : [
          this.button(t, "lo-add", "a", "New", (cx) => this.open(cx, "new")),
          this.button(t, "lo-copy", "c", "Copy", (cx) => this.open(cx, "copy"), { enabled: Boolean(p) }),
          this.button(t, "lo-del", "d", "Delete", (cx) => this.ask(cx, "delete"), { enabled: Boolean(p) }),
          ...(p?.origin === "project-override" ? [this.button(t, "lo-reset", "r", "Reset override", (cx) => this.ask(cx, "reset"))] : []),
          this.button(t, "lo-detect", "j", "Harnesses", (cx) => this.showHarnesses(cx)),
          this.button(t, "lo-keys", "k", "API keys", (cx) => this.showKeys(cx)),
        ];
    return this.footer(t, left, [this.button(t, "lo-edit", "Enter", "Edit", (cx) => this.open(cx, "edit"), { primary: true, enabled: Boolean(p) })]);
  }

  // -- editor --

  /** Where a save goes, as a label and its color. */
  scopeOf(t) {
    return {
      project: ["This project", t.ansi5],
      global: ["Global", t.muted],
      override: ["Project override", t.ansi5],
      new: ["New", t.accent],
    }[this.ed.kind];
  }

  /**
   * Choices joined into one control; the chosen one is filled. `onPick(cx, id)`
   * runs for a choice that is not the current one.
   */
  segmentedControl(t, id, options, value, onPick, { icons = false, active = false } = {}) {
    return h_flex()
      .flex_none()
      .h(30)
      .rounded(7)
      .border_1()
      .border_color(active ? t.accent : t.border)
      .bg(t.background)
      .overflow_hidden()
      .children(
        options.map((option, i) => {
          const chosen = option.id === value;
          return h_flex()
            .id(`${id}-${option.id}`)
            .on_mouse_down("left", keepPress)
            .h_full()
            .px(icons ? 9 : 11)
            .gap(6)
            .items_center()
            .when(i > 0, (el) => el.border_l_1().border_color(t.border))
            .text_size(12)
            .text_color(chosen ? t.foreground : t.muted)
            .when(chosen, (el) => el.bg(t.selected).font_semibold())
            .when(!chosen, (el) => el.cursor_pointer().hover((st) => st.bg(t.hover).text_color(t.foreground)))
            .on_click((_e, cx) => {
              if (this.busy) return;
              if (!chosen) onPick(cx, option.id);
              cx.notify();
            })
            .when(icons, (el) => el.child(harnessIcon(t, option.id, 13)))
            .child(option.label ?? option.id);
        }),
      );
  }

  /** A short list of a field's choices, set with one click. */
  choiceButtons(t, f, index, options, active) {
    return this.segmentedControl(
      t,
      `lo-c-${f.field}`,
      options.map((option) => ({ id: option.id })),
      f.value,
      (cx, id) => {
        this.leaveTyping(cx);
        this.ed.cursor = index;
        this.change(cx, { set: { field: f.field, value: id } });
      },
      { icons: f.field === "harness", active },
    );
  }

  /** Put one field back to its global value. */
  revertButton(t, f) {
    return div()
      .id(`lo-rv-${f.field}`)
      .on_mouse_down("left", keepPress)
      .flex_none()
      .w(26)
      .h(26)
      .flex()
      .items_center()
      .justify_center()
      .rounded(6)
      .text_size(14)
      .text_color(t.ansi5)
      .cursor_pointer()
      .hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => {
        if (this.busy) return;
        this.leaveTyping(cx);
        this.ed.cursor = this.ed.fields.indexOf(f);
        this.change(cx, { revert: f.field });
      })
      .child("↺");
  }

  /** Click on a field row: open it, or close the one already open. */
  clickField(cx, f, index) {
    const ed = this.ed;
    const on = index === ed.cursor;
    if (this.busy || (on && ed.mode === "type")) return;
    this.leaveTyping(cx);
    const open = on && ed.mode === "pick";
    ed.cursor = index;
    ed.mode = "fields";
    ed.status = null;
    if (!open && !this.segments(f)) this.openField(cx);
    else this.focusNow();
    cx.notify();
  }

  /** The page's head: harness icon, the name as a title, the id and where it saves. */
  nameRow(t, f, index, revertable) {
    const ed = this.ed;
    const on = index === ed.cursor;
    const typing = on && ed.mode === "type";
    const [scope, scopeColor] = this.scopeOf(t);
    return h_flex()
      .id("lo-f-name")
      .on_mouse_down("left", keepPress)
      .px(4)
      .gap(14)
      .items_center()
      .cursor_pointer()
      .on_click((_e, cx) => this.clickField(cx, f, index))
      .child(
        div()
          .flex_none()
          .size(46)
          .flex()
          .items_center()
          .justify_center()
          .rounded(10)
          .bg(t.background)
          .border_1()
          .border_color(t.border)
          .child(harnessIcon(t, ed.draft.harness, 24)),
      )
      .child(
        v_flex()
          .flex_1()
          .min_w(0)
          .gap(3)
          .child(
            h_flex()
              .h(34)
              .px(8)
              .items_center()
              .rounded(7)
              .border_1()
              .border_color(on ? t.accent : t.popover)
              .hover((st) => st.border_color(on ? t.accent : t.border))
              .child(
                typing
                  ? Input.new(this.text).flex_1().h_full().text_size(16).text_color(t.foreground)
                  : div().flex_1().min_w(0).truncate().text_size(16).font_semibold().text_color(f.value ? t.foreground : t.dim).child(f.value || "Name this profile"),
              ),
          )
          .child(
            h_flex()
              .px(9)
              .gap(8)
              .items_center()
              .child(div().flex_none().text_size(11.5).text_color(t.dim).child(ed.draft.id || "id follows the name"))
              .child(this.pill(t, scope, scopeColor))
              .when(f.differs, (el) => el.child(div().text_size(11.5).text_color(t.ansi5).child("≠ global name"))),
          ),
      )
      .when(revertable, (el) => el.child(f.differs ? this.revertButton(t, f) : div().flex_none().w(26)));
  }

  editPage(t) {
    const ed = this.ed;
    const picking = ed.mode === "pick";
    const rows = [];
    let group = null;
    ed.fields.forEach((f, i) => {
      // While a list is open only its field shows above it.
      if (picking) {
        if (i === ed.cursor) rows.push({ kind: "field", f, i, h: ROW.field });
        return;
      }
      const g = GROUP_OF[f.field] === undefined ? "More" : GROUP_OF[f.field];
      if (g && g !== group) rows.push({ kind: "head", label: g, h: ROW.fieldHead });
      if (g) group = g;
      const h = f.field === "name" ? ROW.name : LONG_FIELDS.has(f.field) ? ROW.long : ROW.field;
      rows.push({ kind: "field", f, i, h });
    });
    const selectedRow = rows.findIndex((r) => r.kind === "field" && r.i === ed.cursor);
    // Global and override drafts can put a field back to its global value.
    const revertable = ed.kind === "global" || ed.kind === "override";

    const draw = (r) => {
      if (r.kind === "head") {
        return h_flex()
          .px(4)
          .pt(14)
          .gap(10)
          .items_center()
          .child(div().flex_none().text_size(11).font_semibold().text_color(t.dim).child(r.label.toUpperCase()))
          .child(div().flex_1().h(1).bg(t.border));
      }
      const f = r.f;
      if (f.field === "name" && !picking) return this.nameRow(t, f, r.i, revertable);
      const on = r.i === ed.cursor;
      const typing = on && ed.mode === "type";
      const long = LONG_FIELDS.has(f.field);
      const segments = this.segments(f);
      const empty = !f.value;
      // An empty field draws no frame until it is the current one, so unset
      // extras stay quiet; a set value sits in a box.
      const box = (child) =>
        h_flex()
          .flex_1()
          .min_w(0)
          .h(long ? ROW.long - 10 : 30)
          .px(10)
          .gap(8)
          .when(long, (el) => el.items_start().py(6))
          .when(!long, (el) => el.items_center())
          .rounded(7)
          .border_1()
          .border_color(on ? t.accent : empty ? t.popover : t.border)
          .bg(empty && !on ? t.popover : t.background)
          .hover((st) => st.border_color(on ? t.accent : t.input))
          .child(child)
          .when(Boolean(f.options) && !typing, (el) => el.child(svg(CHEVRON_ICON).size(13).flex_none().text_color(on ? t.accent : t.dim)));
      const shown = long
        ? div().flex_1().min_w(0).h_full().overflow_hidden().whitespace_normal().text_size(12.5).line_height("19px").text_color(empty ? t.dim : t.foreground).child(f.value || "Add…")
        : div().flex_1().min_w(0).truncate().text_size(12.5).text_color(empty ? t.dim : t.foreground).child(f.value || (f.options ? "Choose…" : "Add…"));
      return h_flex()
        .id(`lo-f-${f.field}`)
        .on_mouse_down("left", keepPress)
        .px(4)
        .gap(12)
        .when(long, (el) => el.items_start().pt(4))
        .when(!long, (el) => el.items_center())
        .cursor_pointer()
        .on_click((_e, cx) => this.clickField(cx, f, r.i))
        .child(
          h_flex()
            .flex_none()
            .w(124)
            .gap(6)
            .when(long, (el) => el.pt(7))
            .items_center()
            .child(div().text_size(12.5).text_color(on ? t.foreground : t.muted).child(f.label))
            .when(f.differs, (el) => el.child(div().text_size(11.5).text_color(t.ansi5).child("≠"))),
        )
        .child(
          segments
            ? h_flex().flex_1().min_w(0).child(this.choiceButtons(t, f, r.i, segments, on))
            : typing
              ? box(long ? Textarea.new(this.area).flex_1().h_full().text_size(12.5).text_color(t.foreground) : Input.new(this.text).flex_1().h_full().text_size(12.5).text_color(t.foreground))
              : box(shown),
        )
        .when(revertable, (el) => el.child(f.differs ? this.revertButton(t, f) : div().flex_none().w(26)));
    };

    const fieldsHeight = picking ? ROW.field : this.fieldHeight;
    const fields = this.fieldStrip.render("lo-fields", rows, fieldsHeight, selectedRow, draw);
    return v_flex()
      .flex_1()
      .min_h(0)
      .px(20)
      .pt(14)
      .pb(8)
      .gap(10)
      .child(picking ? v_flex().flex_none().child(fields) : this.measured("lo-fields-box", "fieldHeight", fields))
      .when(picking, (el) => el.child(this.pickerPanel(t)));
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
        .child(div().flex_none().w(14).child(current ? svg(CHECK_ICON).size(13).text_color(t.accent) : div()))
        .child(div().flex_none().text_size(12.5).text_color(t.foreground).child(r.o.id))
        .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(t.dim).child(r.o.label && r.o.label !== r.o.id ? r.o.label : ""))
        .when(Boolean(r.o.context), (el) => el.child(div().flex_none().text_size(11).text_color(t.dim).child(`${Math.round(r.o.context / 1000)}k`)));
    };
    const header = h_flex()
      .flex_none()
      .gap(8)
      .items_center()
      .child(div().text_size(12.5).font_semibold().text_color(t.foreground).child(`Choose ${/^[A-Z]+$/.test(f.label) ? f.label : f.label.toLowerCase()}`))
      .child(div().flex_1())
      .when(shown.length > 1, (el) =>
        el.child(
          h_flex()
            .id("lo-sort")
            .on_mouse_down("left", keepPress)
            .gap(6)
            .items_center()
            .px(6)
            .h(22)
            .rounded(6)
            .cursor_pointer()
            .hover((s) => s.bg(t.hover))
            .on_click((_e, cx) => {
              ed.sort = nextSort(ed.sort);
              ed.option = 0;
              cx.notify();
            })
            .child(div().text_size(11.5).text_color(t.muted).child(SORT_LABELS[ed.sort]))
            .child(this.kbd(t, "Tab")),
        ),
      )
      .child(div().text_size(11.5).text_color(t.dim).child(shown.length ? `${ed.option + 1} / ${shown.length}${shown.length !== view.total ? ` of ${view.total}` : ""}` : ""))
      .child(
        div()
          .id("lo-pick-x")
          .on_mouse_down("left", keepPress)
          .flex_none()
          .size(22)
          .flex()
          .items_center()
          .justify_center()
          .rounded(6)
          .cursor_pointer()
          .hover((s) => s.bg(t.hover))
          .on_click((_e, cx) => {
            ed.mode = "fields";
            this.focusNow();
            cx.notify();
          })
          .child(svg(CLOSE_ICON).size(12).text_color(t.muted)),
      );
    return v_flex()
      .flex_1()
      .min_h(0)
      .gap(8)
      .p(10)
      .rounded(10)
      .bg(t.background)
      .border_1()
      .border_color(t.border)
      .child(header)
      .when(this.filtering(), (el) =>
        el.child(
          h_flex()
            .id("lo-filter")
            .on_mouse_down("left", keepPress)
            .h(32)
            .flex_none()
            .px(10)
            .gap(8)
            .items_center()
            .rounded(7)
            .border_1()
            .border_color(t.accent)
            .bg(t.popover)
            .child(svg(SEARCH_ICON).size(14).text_color(t.dim))
            .child(Input.new(this.filter).flex_1().h_full().text_size(12.5).text_color(t.foreground)),
        ),
      )
      .child(
        f.pending
          ? h_flex().gap(8).items_center().px(10).py(6).text_size(12.5).text_color(t.dim).child(svg(SPINNER).size(12).text_color(t.working).spin(900)).child(`Reading ${ed.draft.harness} models…`)
          : shown.length === 0
            ? div().px(10).py(6).text_size(12.5).text_color(t.dim).child("Nothing matches.")
            : this.measured("lo-options", "optionHeight", this.optionStrip.render("lo-options-strip", rows, this.optionHeight ?? 200, ed.option, draw)),
      );
  }

  editFooter(t) {
    const ed = this.ed;
    const f = this.field();
    const note = f?.note
      ? { text: f.note, ok: false }
      : f?.differs
        ? { text: `global: ${f.global}`, tone: "diff" }
        : null;
    const status = ed.status ?? note;
    const left = status ? [this.statusLine(t, status)] : [];
    if (ed.mode === "pick") {
      return this.footer(t, left, [
        this.button(t, "lo-pick-back", "Esc", ed.query ? "Clear filter" : "Back", (cx) => this.editKey("escape", cx) && cx.notify()),
        this.button(t, "lo-apply", "Enter", "Choose", (cx) => this.applyOption(cx), { primary: true }),
      ]);
    }
    if (ed.mode === "type") {
      return this.footer(t, left, [
        this.button(t, "lo-type-back", "Esc", "Cancel", (cx) => this.editKey("escape", cx) && cx.notify()),
        this.button(t, "lo-confirm", "Enter", "Set", (cx) => this.commitText(cx), { primary: true }),
      ]);
    }
    const canRevert = Boolean(f?.differs) && (ed.kind === "global" || ed.kind === "override");
    return this.footer(
      t,
      [
        this.button(t, "lo-back", "Esc", ed.discardArmed ? "Discard changes" : "Back", (cx) => this.back(cx)),
        ...(status ? [this.statusLine(t, status)] : []),
      ],
      [
        ...(canRevert ? [this.button(t, "lo-revert", "r", "Revert", (cx) => this.change(cx, { revert: f.field }))] : []),
        this.button(t, "lo-test", "t", "Test", (cx) => this.test(cx)),
        ed.kind === "project"
          ? this.button(t, "lo-save-p", "p", "Save", (cx) => this.save(cx, "project"), { primary: true })
          : this.button(t, "lo-save-p", "p", "Save to project", (cx) => this.save(cx, "project")),
        ...(ed.kind === "project" ? [] : [this.button(t, "lo-save-g", "g", "Save global", (cx) => this.save(cx, "global"), { primary: true })]),
      ],
    );
  }

  // -- API keys --

  keysPage(t) {
    const reg = this.keys;
    if (!reg) {
      return v_flex().flex_1().items_center().justify_center().text_size(13).text_color(t.dim).child("Reading keys…");
    }
    const rows = reg.keys.map((key, i) => ({ key, i, h: ROW.key }));
    const draw = (r) => {
      const key = r.key;
      const on = r.i === this.keySelected;
      const test = this.keyTests[key.id];
      const used = key.profiles.length ? `used by ${key.profiles.join(", ")}` : "no profile uses it yet";
      return h_flex()
        .id(`lo-k-${key.id}`)
        .on_mouse_down("left", keepPress)
        .mx(2)
        .px(12)
        .gap(12)
        .items_center()
        .rounded(8)
        .cursor_pointer()
        .when(on, (el) => el.bg(t.selected))
        .when(!on, (el) => el.hover((st) => st.bg(t.hover)))
        .on_click((_e, cx) => {
          this.keySelected = r.i;
          this.keyPending = null;
          cx.notify();
        })
        .child(h_flex().flex_none().gap(2).children(key.harnesses.map((harness) => harnessIcon(t, harness, 20))))
        .child(
          v_flex()
            .flex_1()
            .min_w(0)
            .gap(2)
            .child(
              h_flex()
                .gap(10)
                .items_center()
                .child(div().flex_none().text_size(13).font_semibold().text_color(t.foreground).child(key.id))
                .child(div().flex_none().text_size(12).text_color(t.muted).child(key.masked))
                .when(Boolean(key.label), (el) => el.child(div().min_w(0).truncate().text_size(12).text_color(t.dim).child(key.label))),
            )
            .child(div().truncate().text_size(11.5).text_color(t.dim).child(`${key.providerLabel} · runs ${key.harnesses.join(", ")} · ${used}`)),
        )
        .when(Boolean(test), (el) =>
          el.child(
            test.pending
              ? svg(SPINNER).size(13).flex_none().text_color(t.working).spin(900)
              : this.pill(t, test.ok ? "works" : "failed", test.ok ? t.ansi2 : t.blocked),
          ),
        );
    };
    const intro = v_flex()
      .flex_none()
      .gap(6)
      .p(16)
      .rounded(10)
      .border_1()
      .border_color(t.border)
      .bg(t.background)
      .child(div().text_size(13).font_semibold().text_color(t.foreground).child("No stored keys"))
      .child(
        div()
          .whitespace_normal()
          .text_size(12)
          .line_height("18px")
          .text_color(t.muted)
          .child("Store a provider's key once, then choose it in a profile's API field. A Claude profile then runs on DeepSeek's Anthropic-compatible API; an agy profile on the Gemini API. Keys stay in keys.toml beside the global config, never in a project."),
      );
    return v_flex()
      .flex_1()
      .min_h(0)
      .px(20)
      .pt(16)
      .pb(8)
      .gap(14)
      .when(reg.keys.length === 0 && !this.keyForm, (el) => el.child(intro))
      .when(reg.keys.length > 0, (el) => el.child(this.measured("lo-keys", "keysHeight", this.keyStrip.render("lo-keys-strip", rows, this.keysHeight ?? 200, this.keySelected, draw))))
      .when(Boolean(this.keyForm), (el) => el.child(this.keyFormCard(t)));
  }

  keyFormCard(t) {
    const form = this.keyForm;
    const providers = this.keys?.providers ?? [];
    const provider = providers.find((entry) => entry.id === form.provider) ?? providers[0];
    const line = (label, child) =>
      h_flex()
        .gap(12)
        .items_center()
        .child(div().flex_none().w(84).text_size(12.5).text_color(t.muted).child(label))
        .child(child);
    const input = (id, state) =>
      h_flex()
        .id(id)
        .on_mouse_down("left", keepPress)
        .flex_1()
        .min_w(0)
        .h(30)
        .px(10)
        .items_center()
        .rounded(7)
        .border_1()
        .border_color(t.border)
        .bg(t.background)
        .child(Input.new(state).flex_1().h_full().text_size(12.5).text_color(t.foreground));
    return v_flex()
      .flex_none()
      .gap(10)
      .p(16)
      .rounded(10)
      .border_1()
      .border_color(t.accent)
      .bg(t.background)
      .child(div().text_size(13).font_semibold().text_color(t.foreground).child("Add an API key"))
      .child(
        line(
          "Provider",
          this.segmentedControl(
            t,
            "lo-kp",
            providers.map((entry) => ({ id: entry.id, label: entry.label })),
            form.provider,
            (cx, id) => {
              this.keyForm.provider = id;
              this.keySecret.focus();
              cx.notify();
            },
          ),
        ),
      )
      .when(Boolean(provider), (el) =>
        el.child(
          div()
            .pl(96)
            .text_size(11.5)
            .text_color(t.dim)
            .child(`Runs ${provider.harnesses.join(", ")} · keys from ${provider.site}`),
        ),
      )
      .child(line("Key", input("lo-k-secret", this.keySecret)))
      .child(line("ID", input("lo-k-id", this.keyId)))
      .child(line("Label", input("lo-k-label", this.keyLabel)));
  }

  keysFooter(t) {
    if (this.keyPending) {
      const users = this.keyPending.profiles.length ? ` ${this.keyPending.profiles.join(", ")} will stop launching.` : "";
      return this.footer(
        t,
        [div().flex_1().min_w(0).truncate().text_size(12.5).text_color(t.blocked).child(`Delete key "${this.keyPending.id}"?${users}`)],
        [
          this.button(t, "lo-k-no", "n", "Cancel", (cx) => this.answerKey(cx, false)),
          this.button(t, "lo-k-yes", "y", "Delete", (cx) => this.answerKey(cx, true), { primary: true }),
        ],
      );
    }
    const status = this.keyMessage ? [this.statusLine(t, this.keyMessage)] : [];
    if (this.keyForm) {
      return this.footer(t, status, [
        this.button(t, "lo-k-cancel", "Esc", "Cancel", () => this.closeKeyForm()),
        this.button(t, "lo-k-save", "Enter", "Save key", (cx) => this.saveKeyForm(cx), { primary: true }),
      ]);
    }
    const any = (this.keys?.keys.length ?? 0) > 0;
    return this.footer(
      t,
      [
        this.button(t, "lo-k-back", "Esc", "Back", (cx) => {
          this.page = "list";
          this.keyMessage = null;
          cx.notify();
        }),
        ...status,
      ],
      [
        ...(any ? [this.button(t, "lo-k-del", "d", "Delete", (cx) => this.keysKey("d", cx) && cx.notify())] : []),
        ...(any ? [this.button(t, "lo-k-test", "t", "Test", (cx) => this.testKey(cx))] : []),
        this.button(t, "lo-k-add", "a", "Add key", (cx) => this.openKeyForm(cx), { primary: true }),
      ],
    );
  }

  // -- harnesses --

  detectPage(t) {
    const rows = (this.registry?.detection ?? []).map((d) => ({ d, h: ROW.harness }));
    const draw = (r) => {
      const d = r.d;
      const err = this.catalogErrors[d.id];
      const count = this.catalogCounts[d.id];
      const models = !d.detected ? "" : err ? err.replace(/\s+/g, " ") : count !== undefined ? `${count} models` : "reading models…";
      return h_flex()
        .px(12)
        .gap(12)
        .items_center()
        .border_b(1)
        .border_color(t.border)
        .child(div().flex_none().when(!d.detected, (el) => el.opacity(0.4)).child(harnessIcon(t, d.id, 22)))
        .child(
          v_flex()
            .flex_1()
            .min_w(0)
            .gap(2)
            .child(
              h_flex()
                .gap(10)
                .items_center()
                .child(div().flex_none().text_size(13).font_semibold().text_color(t.foreground).child(d.id))
                .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(err ? t.blocked : t.muted).child(models)),
            )
            .child(div().truncate().text_size(11.5).text_color(t.dim).child(d.path ?? "not on PATH")),
        )
        .child(this.pill(t, d.detected ? "installed" : "not found", d.detected ? t.ansi2 : t.blocked));
    };
    return v_flex()
      .flex_1()
      .min_h(0)
      .px(20)
      .py(12)
      .child(this.measured("lo-harness", "harnessHeight", this.harnessStrip.render("lo-harness-strip", rows, this.harnessHeight ?? 300, -1, draw)));
  }

  render(cx) {
    const t = theme();
    const page = this.page === "edit" && this.ed ? "edit" : this.page;
    const body = page === "edit" ? this.editPage(t) : page === "detect" ? this.detectPage(t) : page === "keys" ? this.keysPage(t) : this.listPage(t);
    const footer =
      page === "edit"
        ? this.editFooter(t)
        : page === "keys"
          ? this.keysFooter(t)
          : page === "detect"
          ? this.footer(t, [], [this.button(t, "lo-detect-back", "Esc", "Back", (cx) => {
              this.page = "list";
              cx.notify();
            })])
          : this.listFooter(t);
    return v_flex()
      .id("herdr-loadout")
      .track_focus(this.handle)
      .on_key_down((e, cx) => this.key(e, cx))
      .size_full()
      .min_h(0)
      .bg(t.popover)
      .text_color(t.foreground)
      .child(this.header(t))
      .child(body)
      .child(footer);
  }
}
