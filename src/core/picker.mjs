/**
 * Filtering and ordering for the model picker.
 *
 * A catalog can hold hundreds of ids (openrouter alone has 387), so the picker
 * needs both a text filter and useful orders. Both functions are pure so the
 * TUI can call them during render without surprises.
 */

/** Orderings offered by the picker, in cycle order. */
export const SORT_CRITERIA = ["catalog", "name", "provider", "context"];

export const SORT_LABELS = {
  catalog: "catalog order",
  name: "name",
  provider: "provider",
  context: "context size",
};

/** Advance to the next ordering. */
export function nextSort(current) {
  const index = SORT_CRITERIA.indexOf(current);
  return SORT_CRITERIA[(index === -1 ? 0 : index + 1) % SORT_CRITERIA.length];
}

/**
 * Split a model id into its provider prefix and bare name.
 * `ollama-cloud/deepseek-v4.1-flash` -> { provider: "ollama-cloud", name: "deepseek-v4.1-flash" }
 */
export function splitModelId(id) {
  const text = String(id ?? "");
  const slash = text.indexOf("/");
  if (slash === -1) return { provider: "", name: text };
  return { provider: text.slice(0, slash), name: text.slice(slash + 1) };
}

/**
 * Keep models matching every whitespace-separated term.
 *
 * Each term may match the id, the provider, or the label, so `claude opus`
 * narrows to id, `ollama flash` narrows by provider, and `sonnet` matches
 * either. Terms are ANDed, which is what makes a long list tractable with a
 * few keystrokes.
 */
export function filterModels(models, query) {
  const terms = String(query ?? "")
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  if (terms.length === 0) return models;

  return models.filter((model) => {
    const id = String(model?.id ?? "").toLowerCase();
    const label = String(model?.label ?? "").toLowerCase();
    const { provider, name } = splitModelId(id);
    return terms.every(
      (term) => id.includes(term) || label.includes(term) || name.includes(term) || provider.includes(term),
    );
  });
}

/**
 * Return a sorted copy of `models`. The catalog order is preserved as-is, so
 * the caller can offer "no reordering" without special casing.
 */
export function sortModels(models, criterion = "catalog") {
  if (criterion === "catalog") return models;

  const copy = [...models];
  switch (criterion) {
    case "name":
      return copy.sort((a, b) => splitModelId(a?.id).name.localeCompare(splitModelId(b?.id).name));
    case "provider":
      return copy.sort((a, b) => {
        const pa = splitModelId(a?.id).provider;
        const pb = splitModelId(b?.id).provider;
        return pa === pb ? splitModelId(a?.id).name.localeCompare(splitModelId(b?.id).name) : pa.localeCompare(pb);
      });
    case "context":
      // Largest context first; unknown sizes sort last rather than first.
      return copy.sort((a, b) => (b?.context ?? -1) - (a?.context ?? -1));
    default:
      return models;
  }
}

/**
 * Apply the picker's view options in one place.
 * @returns {{models: object[], query: string, sort: string, total: number, matched: number}}
 */
export function pickerView(models, options = {}) {
  const query = options.query ?? "";
  const sort = options.sort ?? "catalog";
  const matched = filterModels(models, query);
  return {
    models: sortModels(matched, sort),
    query,
    sort,
    total: models.length,
    matched: matched.length,
  };
}
