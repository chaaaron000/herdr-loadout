/**
 * Terminal column width of text.
 *
 * `String#length` counts UTF-16 units, so Korean, Japanese, Chinese, and emoji
 * (two columns each) overflow a box sized by character count. This covers the
 * ranges that matter for profile text without pulling in a dependency.
 */
function isWide(code) {
  return (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe6f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x1f300 && code <= 0x1faff) ||
    (code >= 0x20000 && code <= 0x3fffd)
  );
}

export function displayWidth(text) {
  let width = 0;
  for (const char of String(text ?? "")) width += isWide(char.codePointAt(0)) ? 2 : 1;
  return width;
}

/** Cut to at most `max` columns, ending in an ellipsis when anything was dropped. */
export function clipToWidth(text, max) {
  const value = String(text ?? "");
  if (displayWidth(value) <= max) return value;
  let out = "";
  let used = 0;
  for (const char of value) {
    const w = isWide(char.codePointAt(0)) ? 2 : 1;
    if (used + w > max - 1) break;
    out += char;
    used += w;
  }
  return `${out}…`;
}

/** Keep the last `max` columns, starting with an ellipsis when anything was dropped. */
export function clipStartToWidth(text, max) {
  const value = String(text ?? "");
  if (displayWidth(value) <= max) return value;
  const chars = [...value];
  let out = "";
  let used = 0;
  for (let i = chars.length - 1; i >= 0; i--) {
    const w = isWide(chars[i].codePointAt(0)) ? 2 : 1;
    if (used + w > max - 1) break;
    out = chars[i] + out;
    used += w;
  }
  return `…${out}`;
}

/** Right-pad with spaces to `width` columns. */
export function padToWidth(text, width) {
  const value = String(text ?? "");
  return value + " ".repeat(Math.max(0, width - displayWidth(value)));
}
