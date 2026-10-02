import { visibleWindow } from "./window.mjs";

/**
 * Terminal layout budget for the TUI.
 *
 * A popup pane can be as small as 16 rows, while the editor needs a list, the
 * fields, the option picker, and a hint line. Rather than a fixed layout that
 * overflows, compute how much room each region gets from the live size.
 */

/** Rows consumed by the frame: border (2) + app title (1) + hint line (1). */
const FRAME_ROWS = 4;
/** Rows consumed by the editor header: title + save-target line + blank. */
const EDITOR_HEADER_ROWS = 3;
/** Rows consumed by the option picker chrome: heading + indicator. */
const OPTION_CHROME_ROWS = 3;

/**
 * @param {number} rows terminal rows
 * @param {number} cols terminal columns
 * @returns {{rows: number, cols: number, narrow: boolean, compact: boolean,
 *            visibleFields: number, listRows: number, detectRows: number,
 *            fieldRows: number, optionRows: number}}
 */
export function layoutFor(rows, cols) {
  // Never report more than the terminal has: the root frame uses these numbers
  // directly, and a floor above the real size makes it draw past the pane,
  // which forces wrapping and scrolls the previous frame out of view.
  const actualRows = Math.floor(rows) || 24;
  const actualCols = Math.floor(cols) || 80;
  const height = Math.max(1, actualRows);
  const width = Math.max(1, actualCols);
  // Below these sizes the two-column layout cannot work at all.
  const tooSmall = actualRows < 8 || actualCols < 30;

  // Below ~60 columns the two-column field rows wrap, so stack them instead.
  const narrow = width < 60;

  // A compact layout drops blank separator lines to buy rows for the list.
  const compact = height < 28;

  const frame = 4; // border (2) + app title + hint line
  const usable = Math.max(3, height - frame);

  // Fields occupy one row each (two when stacked). When the pane is short the
  // field list itself must shrink, otherwise the picker is pushed off-screen.
  const rowPerField = narrow ? 2 : 1;
  const headerRows = compact ? 2 : 3; // title + save target (+ blank)
  const pickerChrome = 2; // the indicator line, plus one blank when not compact
  const reservedForPicker = 3; // at least a couple of options must stay reachable

  // One extra row is reserved for the "… N more fields" indicator, which is
  // drawn whenever the field list is trimmed.
  const indicatorRows = 1;
  const fieldBudget = usable - headerRows - pickerChrome - reservedForPicker - indicatorRows;
  const maxFields = Math.max(2, Math.floor(fieldBudget / rowPerField));
  const visibleFields = Math.min(10, maxFields);
  const fieldRows = visibleFields * rowPerField;

  const optionBudget = usable - headerRows - pickerChrome - fieldRows - indicatorRows;

  return {
    rows: height,
    cols: width,
    tooSmall,
    narrow,
    compact,
    visibleFields,
    listRows: Math.max(2, usable - 2),
    // detect rows: one per harness, two when there is room for the path line
    detectRows: Math.max(2, Math.floor(usable / (compact ? 1 : 2))),
    fieldRows,
    optionRows: Math.max(2, Math.min(14, optionBudget)),
  };
}

/**
 * How many profiles fit the list view.
 *
 * An entry is not one row: each profile draws a name line, a detail line, an
 * optional description on the selected entry, and (outside compact mode) a
 * blank separator. Treating the row budget as a profile count overflowed the
 * pane, which made Ink scroll instead of redraw and left stale frames behind.
 *
 * @param {number} rows terminal rows
 * @param {number} cols terminal columns
 * @param {number} count profiles available
 * @param {{ selected?: number, compact?: boolean, headerRows?: number }} [options]
 *   headerRows: section headings drawn between entries (global / project)
 * @returns {{start: number, end: number, visible: number, rowHeight: number}}
 */
export function listWindow(rows, cols, count, options = {}) {
  // Accept either a size pair or an already-computed layout.
  const layout = typeof rows === "object" && rows !== null ? rows : layoutFor(rows, cols);
  const compact = options.compact ?? layout.compact;
  // name + detail, plus a separator outside compact mode
  const rowHeight = compact ? 2 : 3;
  // Reserve one extra row for the selected entry's description, and the rows
  // the section headings take.
  const budget = Math.max(1, layout.listRows - 1 - Math.max(0, options.headerRows ?? 0));
  const visible = Math.max(1, Math.floor(budget / rowHeight));
  const selected = Math.min(Math.max(0, options.selected ?? 0), Math.max(0, count - 1));
  const win = visibleWindow(count, selected, visible, 0);
  return { start: win.start, end: win.end, visible, rowHeight };
}
