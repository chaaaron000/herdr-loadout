/**
 * Visible-window math for scrolling option lists.
 *
 * The option list (model ids run into the hundreds) must keep the highlighted
 * row on screen while the cursor moves, and report where the list is cut so the
 * user can tell there is more above or below.
 */

/**
 * Compute the slice of `items` to render so that `cursor` stays visible.
 *
 * The window only moves when the cursor would leave it, so scrolling never
 * jitters while the cursor moves inside the visible block.
 *
 * @param {number} total     number of items
 * @param {number} cursor    index of the highlighted item
 * @param {number} [height]  rows available for the list
 * @param {number} [offset]  current top index (kept when possible)
 * @returns {{start: number, end: number, offset: number, hiddenAbove: number, hiddenBelow: number}}
 */
export function visibleWindow(total, cursor, height, offset = 0) {
  const size = Math.max(1, Math.floor(height) || 1);
  const count = Math.max(0, Math.floor(total) || 0);

  if (count === 0) {
    return { start: 0, end: 0, offset: 0, hiddenAbove: 0, hiddenBelow: 0 };
  }

  const maxIndex = count - 1;
  const index = Math.min(Math.max(0, Math.floor(cursor) || 0), maxIndex);

  // A list shorter than the window always starts at 0.
  if (count <= size) {
    return { start: 0, end: count, offset: 0, hiddenAbove: 0, hiddenBelow: 0 };
  }

  let top = Math.min(Math.max(0, Math.floor(offset) || 0), count - size);

  // Scroll only when the cursor leaves the window.
  if (index < top) top = index;
  else if (index >= top + size) top = index - size + 1;

  const start = top;
  const end = Math.min(count, start + size);
  return {
    start,
    end,
    offset: start,
    hiddenAbove: start,
    hiddenBelow: count - end,
  };
}
