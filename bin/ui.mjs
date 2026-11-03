#!/usr/bin/env node
/**
 * TUI entrypoint.
 *
 * Two contexts:
 *  - Inside a plugin pane (stdin is a TTY): render Ink directly.
 *  - As a Herdr plugin action (no TTY): ask Herdr to open the UI pane, because
 *    action commands are detached and cannot host a raw-mode terminal.
 */
import process from "node:process";
import { parseArgs } from "node:util";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PLUGIN_ID = "herdr-loadout";
const PANE_ENTRYPOINT = "ui";
const PLACEMENTS = ["overlay", "popup", "split", "tab", "zoomed"];

function herdrBinary() {
  return process.env.HERDR_BIN_PATH ?? "herdr";
}

/**
 * Project root the UI should edit overrides for.
 *
 * The pane's cwd is the plugin directory when Herdr launches the pane, so the
 * user's project comes from the invocation context Herdr injects instead.
 * Priority: explicit flag, Herdr context, then the process cwd.
 */
export function resolveProjectRoot(explicit, env = process.env) {
  if (explicit) return explicit;

  const raw = env.HERDR_PLUGIN_CONTEXT_JSON;
  if (raw) {
    try {
      const context = JSON.parse(raw);
      const candidate = context.workspace_cwd ?? context.focused_pane_cwd ?? null;
      if (candidate) return candidate;
    } catch {
      /* a malformed context must not break the UI */
    }
  }
  return process.cwd();
}

/** Ask Herdr to open the profile pane; used when no TTY is available. */
export function openPane({ placement, focus = true, width, height } = {}) {
  const args = ["plugin", "pane", "open", "--plugin", PLUGIN_ID, "--entrypoint", PANE_ENTRYPOINT];
  if (placement && PLACEMENTS.includes(placement)) args.push("--placement", placement);
  // The editor needs room for its fields plus a scrolling model list; a small
  // popup clips it. Size is a percentage so it follows the current terminal.
  if (placement === "popup") {
    args.push("--width", width ?? "90%", "--height", height ?? "80%");
  }
  if (focus) args.push("--focus");
  else args.push("--no-focus");

  const result = spawnSync(herdrBinary(), args, { encoding: "utf8", timeout: 15000, windowsHide: true });
  return {
    ok: result.status === 0,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? result.error?.message ?? "",
  };
}

async function renderInk(projectRoot) {
  const React = (await import("react")).default;
  const { render } = await import("ink");
  const { App } = await import("../src/tui/app.mjs");
  const app = render(React.createElement(App, { initialProject: projectRoot }));
  await app.waitUntilExit();
}

export async function main(argv) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        placement: { type: "string" },
        project: { type: "string" },
        "in-pane": { type: "boolean" },
        "no-focus": { type: "boolean" },
        help: { type: "boolean", short: "h" },
      },
    });
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exit(2);
  }

  const { values } = parsed;
  if (values.help) {
    process.stdout.write(
      [
        "herdr-loadout ui — interactive profile editor",
        "",
        "  --placement overlay|popup|split|tab|zoomed   how Herdr opens the UI pane",
        "  --project PATH                              project to edit overrides for",
        "  --in-pane                                   run Ink here (already inside a pane)",
        "  --no-focus                                  do not steal focus when opening",
        "",
        "Without a TTY the command opens a Herdr pane and exits.",
        "Inside a pane the project comes from the Herdr invocation context.",
        "",
      ].join("\n"),
    );
    return;
  }

  const inPane = values["in-pane"] || process.stdin.isTTY;
  if (!inPane) {
    // Detached plugin action: hand off to a real terminal pane.
    const result = openPane({ placement: values.placement, focus: !values["no-focus"] });
    if (!result.ok) {
      const detail = result.stderr || result.stdout;
      let message = "Could not open the profiles pane.";
      try {
        const parsedError = JSON.parse(result.stdout);
        message = `Could not open the profiles pane: ${parsedError.error?.message ?? parsedError.error?.code}`;
      } catch {
        if (detail) message = `Could not open the profiles pane: ${detail}`;
      }
      process.stderr.write(`${message}\n`);
      process.exit(1);
    }
    return;
  }

  await renderInk(resolveProjectRoot(values.project));
  // The pane closes when this process exits; do not hold it open for a catalog
  // lookup or refresh that is still in flight.
  process.exit(0);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error?.stack ?? String(error)}\n`);
    process.exit(1);
  });
}
