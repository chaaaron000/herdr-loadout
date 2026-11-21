/**
 * The host command that starts a worker from a profile, quoted for the
 * caller's shell. An orchestrator copies these lines instead of retyping
 * harness, model, or effort flags from memory.
 */

export const SHELLS = ["sh", "powershell"];

const SH_SAFE = /^[A-Za-z0-9_@%+=:,./-]+$/;
// PowerShell reads `,` as an array and a leading `@` as splatting, so both get quoted.
const PS_SAFE = /^[A-Za-z0-9_%+=:./\\-]+$/;

export function quoteArg(value, shell) {
  const text = String(value);
  if (shell === "powershell") return PS_SAFE.test(text) ? text : `'${text.replaceAll("'", "''")}'`;
  return SH_SAFE.test(text) ? text : `'${text.replaceAll("'", "'\\''")}'`;
}

/** A value the caller has not given, printed unquoted (`<pane_id>`) for them to fill in. */
class Slot {
  constructor(text) {
    this.text = text;
  }
}

const slot = (value, name) => value ?? new Slot(`<${name}>`);

function join(words, shell) {
  return words.map((word) => (word instanceof Slot ? word.text : quoteArg(word, shell))).join(" ");
}

/**
 * `KEY=<value>` as one shell word whose value is read when the line runs, so a
 * secret never appears in the printed command.
 */
function envWord(key, valueCommand, shell) {
  const fetch = join([...valueCommand, key], shell);
  return new Slot(shell === "powershell" ? `"${key}=$(& ${fetch})"` : `"${key}=$(${fetch})"`);
}

/**
 * @param {object} spec
 * @param {string} spec.id profile id
 * @param {object} spec.result `dryRun` result (`harness`, `model`, `effort`, `args`, `env`)
 * @param {string[]} spec.argv whole worker command for `hc run --`
 * @param {string[]} spec.envValueCommand prints one env value given its name (`env-value <id>`)
 * @param {"herdr"|"hc"} spec.host
 * @param {"sh"|"powershell"} spec.shell
 * @param {string} spec.cwd absolute working directory for the worker
 * @param {string} [spec.name] worker name
 * @param {string} [spec.pane] TUI: the pane to start the agent in
 * @param {string} [spec.space] App: `herdr.space` label
 * @param {string} [spec.tab] App: `herdr.tab` label
 * @param {string[]} [spec.launchLabels] App: more `key=value` labels (what the worker was launched as)
 * @returns {string[]} lines; those starting with `#` are comments in both shells
 */
export function renderStartCommand({ id, result, argv, envValueCommand, host, shell, cwd, name, pane, space, tab, launchLabels = [] }) {
  const lines = [`# ${id}: ${[result.harness, result.model, result.effort].filter(Boolean).join(" · ")}`];
  const worker = slot(name, "worker-name");

  if (host === "hc") {
    const labels = ["--label", space ? `herdr.space=${space}` : new Slot("herdr.space=<space_id>")];
    if (tab) labels.push("--label", `herdr.tab=${tab}`);
    for (const label of launchLabels) labels.push("--label", label);
    lines.push(join(["hc", "run", "--bg", "--name", worker, "--cwd", cwd, ...labels, "--", ...argv], shell));
    return lines;
  }

  const envFlags = Object.keys(result.env).flatMap((key) => ["--env", envWord(key, envValueCommand, shell)]);
  if (pane) {
    if (envFlags.length) lines.push(`# pane ${pane} must have been opened with: ${join(envFlags, shell)}`);
  } else {
    lines.push(`# open the worker's pane (herdr tab create / herdr pane split) with: ${join(["--cwd", cwd, ...envFlags], shell)}`);
  }
  const quoted = [...result.args, ...Object.values(result.env)].some((value) => value.includes('"'));
  if (shell === "powershell" && quoted) {
    lines.push('# needs PowerShell 7+: Windows PowerShell 5.1 strips the " inside arguments');
  }
  lines.push(join(["herdr", "agent", "start", worker, "--kind", result.harness, "--pane", slot(pane, "pane_id"), "--", ...result.args], shell));
  return lines;
}
