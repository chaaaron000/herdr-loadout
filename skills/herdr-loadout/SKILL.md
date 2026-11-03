---
name: herdr-loadout
description: "Delegate work to Herdr workers using named agent profiles. Use when a task should be handed to another agent in a Herdr pane — parallel implementation, independent review, or repository exploration — and the role, harness, model, or effort level matters. Works in the Herdr TUI (HERDR_ENV=1, `herdr` CLI) and the Herdr app (HC_TERMINAL_ID set, `hc` CLI)."
---

# Herdr Loadout — orchestrate work with agent profiles

A **profile** names a role and pins the harness, model, and effort a worker runs with.
The registry is the policy layer; the host's CLI is the execution layer.

```text
herdr-loadout list --compact   →  who is available
herdr-loadout show <id>        →  exactly how they run
herdr agent start … / hc run … →  how the worker launches
```

## Know your host

Herdr comes in two forms, each with its own CLI. Decide once, at the start of the session:

| Host | Test | Execution CLI | Layout CLI |
|---|---|---|---|
| **TUI** (the `herdr` terminal multiplexer) | `HERDR_ENV=1` | `herdr` | `herdr` |
| **App** (the Herdr desktop app, terminals in herdr-core) | `HC_TERMINAL_ID` is set | `hc` | `herdr-app` |

```bash
if [ "${HERDR_ENV:-}" = 1 ]; then LOADOUT_HOST=herdr; elif [ -n "${HC_TERMINAL_ID:-}" ]; then LOADOUT_HOST=hc; fi
```

```powershell
$LOADOUT_HOST = if ($env:HERDR_ENV -eq '1') { 'herdr' } elseif ($env:HC_TERMINAL_ID) { 'hc' }
```

Check `HERDR_ENV` first. An hc terminal never inherits its caller's environment, so it never carries
`HERDR_ENV`. A TUI pane, however, can carry `HC_TERMINAL_ID` from the app terminal that started the
herdr server, and that address is not yours. When neither is set you are not inside Herdr: do not
start workers; tell the user.

Use only your host's commands. The TUI and the app are separate servers: a `herdr` command run from
the app opens panes in the TUI's window instead of beside you, and `hc` run from the TUI starts
terminals the TUI cannot show. Steps below mark host-specific commands with **TUI** and **App**.

## Resolve the CLI once

`herdr-loadout` answers from any working directory. Pick the first form that works and reuse it as
`$LOADOUT` for the rest of the session. `HERDR_PLUGIN_ROOT` is only set for commands the plugin
itself runs, never in an agent's shell, so do not rely on it.

```bash
# 1. on PATH
herdr-loadout list --compact

# 2. TUI: the launcher in the plugin config dir; needs no PATH (POSIX sh / Git Bash)
LOADOUT="$(herdr plugin config-dir herdr-loadout)/herdr-loadout"
# 2. App: the same launcher at its default location (there is no `herdr plugin` command)
LOADOUT="${APPDATA:-${XDG_CONFIG_HOME:-$HOME/.config}}/herdr/plugins/config/herdr-loadout/herdr-loadout"
"$LOADOUT" list --compact
```

```powershell
# 2. TUI, PowerShell
$LOADOUT = Join-Path (herdr plugin config-dir herdr-loadout) 'herdr-loadout.cmd'
# 2. App, PowerShell
$LOADOUT = Join-Path $env:APPDATA 'herdr\plugins\config\herdr-loadout\herdr-loadout.cmd'
& $LOADOUT list --compact
```

On Windows, `bash` may resolve to WSL, which sees neither `herdr` nor the Windows `node`. When the
POSIX form fails that way, use the PowerShell form.

If form 2 says the file does not exist, create the launchers once and retry. TUI:

```bash
herdr plugin action invoke herdr-loadout.install-shim
```

App: the app has no plugin actions. Run `node <checkout>/scripts/setup-shim.mjs` when you know where
the herdr-loadout checkout is; otherwise ask the user to run it.

If the launcher reports that the plugin is missing from its install path, run the same command again;
the plugin was reinstalled somewhere else.

An empty roster is a real answer: no profiles exist yet. Point the user at the `herdr-loadout-edit`
skill rather than inventing a profile.

## Read the workflow

The workflow holds the choices this skill leaves open: which profile class takes which work, how a
prompt, brief, and report look, how tabs are used, when a worker is closed or kept, and how workers
coordinate. It is the global workflow followed by this project's rules, which win where the two
conflict. Read it once per session, before the first delegation:

```bash
$LOADOUT workflow
```

Every step below that says "as the workflow says" follows it. The user edits it, not you; the
`herdr-loadout-edit` skill covers changing it.

## Delegate

1. **Read the roster.** One call, cheap and always current:

   ```bash
   $LOADOUT list --compact
   ```

   Each line is `id | cost | purpose`. The purpose is the routing signal; cost is the tiebreaker.

2. **Pick by description, not by name,** routing as the workflow says. Read the full description of
   the candidates that plausibly fit:

   ```bash
   $LOADOUT show <id>
   ```

   Match the task against `When to use`, and reject a candidate whose `Avoid when` describes your task.

3. **Get the launch arguments** right before every launch. Never transcribe model names or effort
   levels by hand:

   ```bash
   $LOADOUT launch <id> --json --host $LOADOUT_HOST
   ```

   The response carries `harness`, `args`, `env`, `argv`, and `ok`. Continue only when `ok` is true.
   `args` includes the profile's permission flags. `env` includes its environment overrides
   and, for OpenCode, generated runtime permissions. `--host hc` adds what the app needs (Codex's
   `--no-daemon`), and `argv` is the whole worker command for `hc run`: the harness and its `args`,
   or `herdr-loadout exec <id>` when the profile sets `env`, because `hc run` cannot pass
   environment variables.

   Users change profiles between sessions. In briefs, handoff notes, and long-term memory, record
   only the profile id, never its harness, model, or effort. When a note and the profile disagree,
   the profile wins.

4. **Start the worker** in the tab the workflow gives it (see [Tab commands](#tab-commands)).
   Name it in lowercase letters, digits, `-` and `_`, at most 32 characters; both hosts address
   workers by that name. Pass `--cwd` as an absolute path: a relative one resolves against the
   server's directory, not yours. Never add or rewrite harness flags.

   **TUI:** open the pane, then start the agent in it. For every entry in `env`, add one
   `--env KEY=VALUE` argument to the pane command. Pass each pair as one shell-quoted argument;
   OpenCode's inline JSON must remain intact.

   ```bash
   # the worker's tab does not exist yet: create it; its root pane is the worker pane
   herdr tab create --label <tab-name> --cwd "$PWD" --no-focus    # result.root_pane.pane_id
   # the tab exists (herdr tab list): split one of its panes
   herdr pane split <pane_in_that_tab> --direction right|down --cwd "$PWD" --no-focus
   herdr pane rename <pane_id> <worker-name>
   herdr agent start <worker-name> --kind <harness> --pane <pane_id> -- <args...>
   ```

   Pass `args` verbatim after `--`. A `start` right after the pane opens can fail with
   `agent_pane_busy` while the shell is still starting; retry after a few seconds. Give the harness
   a few seconds to come up before the first prompt.

   **App:** one `hc run` starts the worker. Labels put it on screen: `herdr.space` is your own
   space, from `hc get "$HC_TERMINAL_ID" --json` (`labels["herdr.space"]`); add `herdr.tab` when the
   worker's tab already exists (`herdr-app ls`). Pass `argv` verbatim after `--`; it
   already holds the profile's `env`. Then wait until the harness is ready:

   ```bash
   hc run --bg --name <worker-name> --cwd "$PWD" --label herdr.space=<space_id> [--label herdr.tab=<tab_id>] -- <argv...>
   hc wait <worker-name>
   ```

   Without `herdr.tab`, the app opens a new tab for the worker. Name it right away: find the tab
   holding the worker's address in `herdr-app ls`, then
   `herdr-app do tab.rename --id <tab_id> --name <tab-name>`. When you have no `herdr.space` label
   yourself, leave the labels out; the worker then runs without a pane. Workers end when you end.

5. **Prompt the worker** with the task prompt, brief, and report the workflow describes:

   ```bash
   # TUI
   herdr agent prompt <worker-name> "<task prompt>" --wait
   # App
   hc send --wait <worker-name> "<task prompt>"
   ```

   Workers often run for hours. When your harness can run a shell command as a background job
   (Claude Code's `run_in_background`, omp's `async`), run the wait as one, one job per worker,
   with no job deadline, and go back to the user while it runs. The user can then give you new
   instructions mid-task, and the job finishing is your signal to read the worker. Run it in the
   foreground only on a harness without background jobs.

   - **TUI:** do not set a short `--timeout`. To wait again on a worker (after a pane move broke
     the wait, say), use `herdr agent wait <worker-name>`, not another `prompt --wait`. Without
     `--until` it matches `idle`, `done`, or `blocked`. Right after a prompt sent without `--wait`,
     the worker can still show the idle state from before the prompt, which ends the wait at once;
     give it about 30 seconds first. When Herdr reports the worker's state as `unknown`, a wait
     cannot tell when it finishes; check its report file instead.
   - **App:** a wait checks in after 180 seconds with `reason: timeout`. That is not a failure; run
     `hc wait <worker-name>` again until the reason is something else. In a background job, loop
     on it. `hc wait --children any` returns on whichever of your workers stops first. The app also
     types a note into your input when a worker blocks, errors, or exits. A worker that shows
     `status: null` in `hc get` does not report its state; judge it by its screen and report file.

6. **Read the answer, then decide why the worker stopped.** An idle or done state does not mean the
   task finished. Check its report as the workflow says, then read the worker's screen:

   ```bash
   tail -n 1 <report>                  # PowerShell: Get-Content <report> -Tail 1
   herdr agent read <worker-name> --source recent-unwrapped --lines 120   # TUI
   hc read <worker-name> --lines 120                                      # App
   ```

   When the report does not show a finished task, the worker stopped on a question, a permission
   dialog, or a usage limit. See [When a worker stops mid-task](#when-a-worker-stops-mid-task).

7. **Close or compact the worker,** whichever the workflow says.

   - **Close:** TUI: `herdr pane close <pane_id>`; closing hands the space to the neighbouring pane,
     and closing the last pane of a tab closes the tab. App: `hc kill <worker-name>`, then
     `hc rm <worker-name>`; the app closes its pane, and the tab with its last one.
   - **Compact:** use whatever compaction the harness offers (usually a slash command such as
     `/compact`). A slash command must start the line, so send it bare, with no prefix and no
     `--wait`. TUI: `herdr agent prompt <worker-name> "/compact"`. App: `hc send` wraps text in an
     `<hc from=…>` tag, which turns the command into an ordinary message, so type it as keys:
     `hc keys <worker-name> / c o m p a c t enter`. Either host can report the worker `idle` or
     `done` while it compacts. Before the next task prompt, read the worker's screen and send only
     once the compaction has finished.

8. **Report the outcome** with the worker name, the profile that ran it, and the result.

A delegated task is done when the worker's answer is read back to the caller and every worker is
closed or kept as the workflow says — not when the prompt is submitted.

## Tab commands

- **TUI: re-level a tab** by reading it with `herdr pane layout --pane <pane_in_that_tab>` (`rect`,
  and `ratio` under `splits`), resizing, and reading it again. Without `--pane`, `layout` reads the
  user's focused tab, which may be another one.
- **TUI:** `herdr pane resize --pane <id> --direction up|down|left|right --amount <ratio>` takes a ratio
  between 0 and 1 of the split that owns the edge, not a row count; an integer moves the edge
  far. `--direction` names which edge of that pane moves.
- **TUI:** to move a pane into another tab:
  `herdr pane move <pane> --tab <tab> --split right|down --target-pane <pane_in_that_tab> --ratio 0.5 --no-focus`.
  Moving a pane within its own tab reports `changed: false` and does nothing; move it out with
  `--new-tab`, then back. Swap two panes with `herdr pane swap --source-pane <a> --target-pane <b>`.
- **TUI: moving a worker's pane breaks a running wait on it** with `agent_not_running`, although the
  worker is still alive. Start the wait again after a move.
- **App:** the app arranges the panes of a tab itself; there are no resize or move commands for
  agents. The `herdr.tab` label is how you choose a worker's tab. Never use `pane.zoom`.
- `agent prompt`/`agent wait`/`agent read` (TUI) and `hc send`/`hc wait`/`hc read` (App) address
  workers by name, whatever tab they are in. Workers reach each other the same way.
- **App:** a lead worker's members are its children and end when the lead ends.

## When a worker stops mid-task

- **A question or a permission dialog** shows on the worker's screen (`herdr pane read <pane_id>`,
  or `hc read <worker-name>`; the app also reports the worker `blocked`). Answer it if the task brief
  settles it; approve only actions the task needs, such as reads. In the app, `hc send` refuses a
  blocked worker; answer the dialog with `hc keys <worker-name> <keys...>` after reading it.
  Otherwise ask the user. Never relaunch the worker with a permission-skipping flag to get past
  dialogs.
- **A usage limit,** or any other stop the workflow names: handle it as the workflow says.

## When a worker will not start

A start command returning an error, or a worker that dies right after launch, is usually not a
profile problem. Check in this order, and act only on what the evidence supports:

- **TUI: `agent_not_running` on the first prompt** means the pane's process exited. Read the pane; the real cause is on screen. (On a worker that was already running, it can also mean its pane was moved; see [Tab commands](#tab-commands).)
- **TUI: `agent_pane_busy`** right after the pane opened: the shell is still starting. Retry after a few seconds.
- **App: `spawn_failed`** means the program in `argv` could not start; the error's `message` names it. **A worker in state `finished`** (exit code 11 from `hc send`) exited: `hc read <worker-name>` shows why.
- **A harness trust or setup dialog** (a first-run "do you trust this folder", an auth prompt) blocks the worker before any task. It is answered once per directory; report it to the user instead of working around it.
- **TUI: a stale environment.** Panes inherit the environment of the Herdr server, captured when the server started. A `PATH` entry or API key added since then is missing in new panes. Set it in the pane first (`herdr pane run <pane_id> "<command>"`), or have the harness read the value from persistent storage instead of the process environment. App terminals do not inherit your environment either; on Windows they read the user and system environment afresh when they start.
- **TUI: a harness installed under a path with spaces** can fail to launch through `agent start` on Windows. `launch` already prefers a copy on `PATH` without a space; when there is none, a link to the same directory at a path without spaces, placed ahead on `PATH`, works around it. `hc run` starts such a path fine.
- **A wrong model name** for a harness with no catalog (`claude`) shows up as a harness-side error, not an `agent start` failure. `launch --json` cannot catch this; report the model you used.
- **The harness itself failing** (a crash inside the harness) is outside this plugin's control. Report the exact command you ran and the harness output.

Never edit a profile to work around a harness-side failure.

## After Herdr restarts

**TUI:** Herdr restores worker panes after a restart or reboot by resuming each harness session
(`claude --resume <id>`, `omp --resume=<session>`) without the profile's launch arguments.
A resumed worker can run with the harness defaults instead of the profile's settings; Claude Code,
for one, falls back to its default effort. Before giving a resumed worker more work, compare the
running process's command line with `launch --json`, and either restore the setting inside the
harness (Claude Code: `/effort <level>`, then check the status line) or close the worker and launch
a fresh one.

**App:** closing the window does not stop workers; they keep running in herdr-core. A worker whose
program was lost (a crash, a host shutdown) is never rerun; a worker the app keeps comes back as a
plain shell. When `hc get <worker-name>` shows a shell instead of the harness, remove it and launch
a fresh worker.

## Reading `--compact`

```text
builder | normal | implementation/refactor
reviewer | cheap | review
scout | cheap | research
```

Three fields, one line per profile, no header. `cost` is one of `cheap`, `normal`, `expensive`.
Treat the format as stable; parse it as-is and never reflow it.

## Project overrides

A profile's values can differ per project. `list` already applies the override for the current
directory, so route on what you read and do not hunt for a project file.

`list` groups profiles under "Global profiles" and "Project profiles" (those that exist only in this
project). `show` marks an overridden profile with each field and its global value:

```text
Overridden fields: effort (global: medium), extra_args (global: (unset))
```

That means the global profile was adapted for this project — normal, and not something to report
as an inconsistency.

## Profiles with no model catalog

`launch --json` reports `ok: true` for a harness that cannot list models, because the value is
accepted free-form. A worker that then fails to start means the model name is wrong; report the
harness and the model, and prefer a different profile over guessing at a correction.
