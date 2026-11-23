---
name: herdr-loadout
description: "Orchestrate work in a Herdr session through Herdr workers that run on named agent profiles. Use whenever you work inside Herdr (HERDR_ENV=1 with the `herdr` CLI in the TUI, or HC_TERMINAL_ID set with the `hc` CLI in the Herdr app) and a task needs implementation, QA, code review, or repository exploration: load it before doing that work yourself or handing it to your harness's built-in subagents. Also covers choosing a worker's role, harness, model, or effort, and adding the delegation block to the project's AGENTS.md. A worker given a `[Worker-...]` prompt needs it only when its brief makes it a lead."
---

# Herdr Loadout — orchestrate work with agent profiles

A **profile** names a role and pins the harness, model, and effort a worker runs with.
The registry is the policy layer; the host's CLI is the execution layer.

```text
herdr-loadout list --compact   →  who is available
herdr-loadout show <id>        →  exactly how they run
herdr-loadout command <id>     →  the exact command that starts the worker
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

## Project setup

Once per session, after the host and `$LOADOUT` are resolved, check whether this project's
instructions file carries the delegation block. Skip this section entirely when you are a worker
(your prompt starts with `[Worker-`).

```bash
$LOADOUT agents-md            # state: current | missing | outdated | declined
```

- `declined`: nothing to do. A decline is the user's answer for this project; never ask again.
- `current`: nothing to do, unless the last case below applies.
- `missing` or `outdated`: ask the user once whether to add the block. The message that asks must
  itself contain the exact block, copied in full from `$LOADOUT agents-md print`, and the files that
  will change: `AGENTS.md`, plus any file the status says `needs @AGENTS.md`, such as a `CLAUDE.md`
  that Claude Code reads instead of `AGENTS.md`. Never a summary, and never "printed above": the
  user may not see tool output. On yes, run `$LOADOUT agents-md install`; on no, run
  `$LOADOUT agents-md decline`. Never write the block or the import yourself, and never without
  asking.
- `current`, yet the `## Delegation (herdr-loadout)` section is not among the instructions you
  started this session with (and nobody installed it during the session): your harness reads
  another file here. For Claude Code (an older version, or Project instructions set to
  `claude-md`), offer `$LOADOUT agents-md install --claude-md`, which adds a `CLAUDE.md` importing
  `AGENTS.md`.

`install` writes only between the `<!-- herdr-loadout:start -->` and `<!-- herdr-loadout:end -->`
lines, so the rest of each file stays as the user wrote it. A `note:` line names what it cannot fix,
such as an `AGENTS.override.md` that codex and pi read instead; pass it on to the user. The block
takes effect from the next session; harnesses read these files at startup.

## Read the workflow

The workflow holds the choices this skill leaves open: what you do yourself and what goes to a
worker, which profile class takes which work, how a prompt, brief, and report look, how tabs are
used, when a worker is closed or kept, and how workers coordinate. It is the global workflow
followed by this project's rules, which win where the two conflict. What the user says in the
conversation wins over both. Read it once per session, before you decide what to do yourself:

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

3. **Create the task folder.** Every task gets a fresh worker and its own folder; the workflow says
   when a kept worker may take a next step instead. Pick the worker's name now. One command makes
   the brief and report the workflow describes, with your address and the worker's report command
   already filled in:

   ```bash
   $LOADOUT task new <slug> --worker <worker-name> --profile <id>
   ```

   It creates `.herdr/runs/<YYYY-MM-DD>-<slug>/brief.md` and `report.md` under the project root
   (`--project`, else the nearest `.herdr` up from here), and prints the task prompt as its last
   line (`--json` for all of it). Your address is `$HC_TERMINAL_ID` in the app and `$HERDR_PANE_ID`
   in the TUI; pass `--to <address>` to name another (a lead's members report to the lead, which
   is the default when the lead runs `task new`). It refuses a folder that already exists. Fill in
   the brief's sections before the prompt.

4. **Print the start command** right before every launch, and run what it prints. Never write a
   harness, model, effort, or flag yourself, not even one you used earlier in the session: the
   user may have changed the profile since.

   ```bash
   # TUI
   $LOADOUT command <id> --host herdr --name <worker-name> --task <task-folder> [--pane <pane_id>]
   # App
   $LOADOUT command <id> --host hc --name <worker-name> --task <task-folder> --space <space_id> [--tab <tab_id>]
   ```

   `--task` records the worker's profile and a fingerprint of its launch (harness, arguments, env
   names; never env values) in the folder's `workers.json`. In the app, the printed `hc run` line
   also labels the worker with both. `worker-check` compares against that record later.

   It reads the profile at that moment and prints the host's start line, quoted for your shell
   (`--shell powershell` in PowerShell; the default suits bash, Git Bash and zsh). Lines starting
   with `#` are notes. A value you did not pass prints as `<placeholder>`; replace only those, never
   the rest of the line. `--cwd` defaults to the directory you run it in. When the profile is not
   launchable, it exits non-zero and names the failing checks; do not start the worker.

   For the raw pieces, `$LOADOUT launch <id> --json --host $LOADOUT_HOST` returns `harness`,
   `args`, `env`, `argv`, and `ok`. `env` lists the variable names with every value shown as `***`:
   values can be API keys, so no command prints them. `argv` is the whole worker command for
   `hc run`: the harness and its `args`, or `herdr-loadout exec <id>` when the profile sets `env`
   (which `hc run` cannot pass) or an argument holds a double quote (which Windows PowerShell 5.1
   strips).

   In briefs, handoff notes, and long-term memory, record only the profile id, never its harness,
   model, or effort. When a note and the profile disagree, the profile wins.

5. **Start the worker** in the tab the workflow gives it (see [Tab commands](#tab-commands)).
   Name it in lowercase letters, digits, `-` and `_`, at most 32 characters; both hosts address
   workers by that name. Pass `--cwd` as an absolute path: a relative one resolves against the
   server's directory, not yours. Never add or rewrite harness flags.

   **TUI:** open the pane, then run the printed `herdr agent start` line in it. When the profile
   sets `env`, `command` prints the pane's `--env` flags as a note. Each one reads its value when the
   shell runs it (`"KEY=$(… env-value <id> KEY)"`), so copy the flag as printed; never look the
   value up and paste it in.

   ```bash
   # the worker's tab does not exist yet: create it; its root pane is the worker pane
   herdr tab create --label <tab-name> --cwd "$PWD" --no-focus [--env KEY=VALUE...]   # result.root_pane.pane_id
   # the tab exists (herdr tab list): split one of its panes
   herdr pane split <pane_in_that_tab> --direction right|down --cwd "$PWD" --no-focus [--env KEY=VALUE...]
   herdr pane rename <pane_id> <worker-name>
   $LOADOUT command <id> --host herdr --name <worker-name> --task <task-folder> --pane <pane_id>   # run the line it prints
   ```

   A `start` right after the pane opens can fail with `agent_pane_busy` while the shell is still
   starting; retry after a few seconds. Give the harness a few seconds to come up before the first
   prompt.

   **App:** one `hc run` starts the worker. Labels put it on screen: `herdr.space` is your own
   space, from `hc get "$HC_TERMINAL_ID" --json` (`labels["herdr.space"]`); add `herdr.tab` when the
   worker's tab already exists (`herdr-app ls`). Run the printed `hc run` line; it already carries
   the profile's `env`. Then wait until the harness is ready:

   ```bash
   $LOADOUT command <id> --host hc --name <worker-name> --task <task-folder> --space <space_id> [--tab <tab_id>]   # run the line it prints
   hc wait <worker-name>
   ```

   `hc run --bg` and `hc wait` both exit 0 even when the harness died at startup. Read the wait's
   JSON: `"reason": "exit"` means the worker is gone (`exit_code` says how), while a ready worker
   shows `"reason": "status"`. `"reason": "message"` means a message arrived for you (another
   worker's report line, say), not that this worker is ready: handle the message, then run
   `hc wait <worker-name>` again. On `exit` the start failed; go to
   [When a worker will not start](#when-a-worker-will-not-start) before any prompt.

   Without `herdr.tab`, the app opens a new tab for the worker. Name it right away: find the tab
   holding the worker's address in `herdr-app ls`, then
   `herdr-app do tab.rename --id <tab_id> --name <tab-name>`. When you have no `herdr.space` label
   yourself, drop the printed `--label herdr.space=<space_id>` pair; the worker then runs without a
   pane. Workers end when you end.

   **A lead worker keeps its members in its own tab,** never in new tabs. App: pass `--tab self`
   to `command`; it finds the tab that shows you in `herdr-app ls` (the app gives a worker it
   placed in a new tab no `herdr.tab` label) and fills in that tab's space when you give no
   `--space`. TUI: split the lead's own pane,
   `herdr pane split "$HERDR_PANE_ID" --direction right|down --cwd "$PWD" --no-focus`.

6. **Prompt the worker** with the line `task new` printed:

   ```bash
   # TUI
   herdr agent prompt <worker-name> "<task prompt>"
   # App
   hc send <worker-name> "<task prompt>"
   ```

   **App: `hc send` returning `"started": false`** can mean the prompt was pasted into the
   worker's input but not submitted (seen with a codex worker that had just become ready). Read
   its screen with `hc read <worker-name>`; if the prompt sits unsent in its input, press enter
   once with `hc keys <worker-name> enter`. Do not send the prompt again.

   **A worker you kept** (the next step of its own task, as the workflow allows) gets a check
   before every prompt, follow-ups and answers included:

   ```bash
   $LOADOUT worker-check <worker-name>      # exit 0: still matches its profile
   ```

   It reads the record (the app's labels, else the newest `workers.json` entry under
   `.herdr/runs/`; `--task <folder>` picks one) and compares it with the live worker and the
   profile as it is now. It fails when the profile was edited since the launch, the worker runs
   another profile than `--profile <id>` names, the worker has exited or fell back to a shell, the
   TUI worker's command line no longer carries the profile's arguments (a resume after a restart),
   or the worker has no record. On a failure, close the worker and start a fresh one from step 4,
   in the same task folder. Never patch a running worker with `/model`, `/effort`, or similar.
   Never prompt a worker that is still compacting.

   Two failures mean the check could not see the worker, so nothing is known about it:
   `host-unavailable` (`hc` or `herdr` could not be run, its server is not running, or it answered
   with an error other than "no such worker") and `process-unknown` (the TUI pane's command line
   could not be read). Do not treat the worker as gone and do not prompt it. Fix what the message
   names (start the server, say) and check again. If the command line stays unreadable, replace
   the worker.

   Do not wait for completion in any form: no `hc wait <worker-name>` or
   `herdr agent wait --until done` after the prompt, and no loop that sleeps and rereads the report
   file. After the prompts and the failure watch below are started, end your turn: go back to the
   user, or, as a lead worker with no user, just end it. Never block on your harness's own wait
   for its background jobs. The worker reports in when its report is written:
   it sends you `[Report-<worker-name>] <MARKER> <report>` with the command in its brief, and
   `QUESTION` in place of the marker when it needs a decision. That line arrives as a prompt in
   your input and starts your next turn, as does a return of the watch. Watch only for a worker
   that stops without reporting:

   - **App:** one background job for all your workers, started after the first launch, with no job
     deadline. `hc wait --children any` returns when one of your workers ends a turn, blocks, errors,
     or exits, or when a message reaches you; the loop only steps over its check-in timeouts:

     ```bash
     while r=$(hc wait --children any --json --timeout 3600); printf '%s' "$r" | grep -q '"reason":"timeout"'; do :; done; printf '%s\n' "$r"
     ```

     ```powershell
     do { $r = hc wait --children any --json --timeout 3600 } while (($r | ConvertFrom-Json).reason -eq 'timeout'); $r
     ```

     Read `reason` first. `"message"` means a message reached you (often a worker's report line,
     which also arrives in your input); its `children` list is empty and says nothing about
     your workers. Only `"children"` with an empty `children` list means none of your workers is
     left; stop watching then, never on a message. On any other return, start the job again
     first, then handle it: it means only "check the reports" (step 7); a worker that already
     reported ends its turn too, so most returns are repeats to ignore. Do not count on the app
     typing a note into your input when a worker's turn ends. A worker that shows `status: null`
     in `hc get` reports no turns, so the watch sees only its exit; judge it by its screen and
     report file. When your harness has no background jobs, run
     `hc wait --children any --json --timeout 1` yourself when you come back to the work, never
     right after a prompt.
   - **TUI:** one background job per worker, with no job deadline:
     `herdr agent wait <worker-name> --until blocked`. It ends when the worker shows a question or
     dialog, and with an error when the worker dies. Moving the worker's pane breaks it; start it
     again after a move. When your harness has no background jobs, check quiet workers yourself.
   - **TUI, known gap:** a worker stopped by a usage limit sits idle; neither its report line nor
     the blocked wait fires. When a worker has been quiet for long, read its screen.

7. **On any signal, read the report, then the screen.** The report line, a return of the failure
   watch, or a worker you find quiet all lead here. The report file is the truth; the line is only
   a signal:

   ```bash
   tail -n 1 <report>                  # PowerShell: Get-Content <report> -Tail 1
   herdr agent read <worker-name> --source recent-unwrapped --lines 120   # TUI
   hc read <worker-name> --lines 120                                      # App
   ```

   The task finished when the report is newer than your prompt and its last line is a completion
   marker. A line for a report you already handled is a repeat; ignore it. Otherwise the worker
   stopped on a question, a permission dialog, or a usage limit: see
   [When a worker stops mid-task](#when-a-worker-stops-mid-task). A `QUESTION` is answered in a
   follow-up prompt, tagged `[Worker-<worker-name>]` like the first.

8. **Close or compact the worker,** whichever the workflow says.

   - **Close:** TUI: `herdr pane close <pane_id>`; closing hands the space to the neighbouring pane,
     and closing the last pane of a tab closes the tab. App: `hc kill <worker-name>`, then
     `hc rm <worker-name>`; the app closes its pane, and the tab with its last one.
   - **Compact:** use whatever compaction the harness offers (usually a slash command such as
     `/compact`). A slash command must start the line, so send it bare, with no prefix and no
     `--wait`. TUI: `herdr agent prompt <worker-name> "/compact"`. App: `hc send` wraps text in an
     `<hc from=…>` tag, which turns the command into an ordinary message, so type it as keys:
     `hc keys <worker-name> / c o m p a c t enter`. In Git Bash (MSYS), an argument that starts
     with `/` is rewritten as a Windows path, so both lines fail there; prefix the command with
     `MSYS_NO_PATHCONV=1` (`MSYS_NO_PATHCONV=1 hc keys <worker-name> / c o m p a c t enter`), or
     run it from PowerShell. Either host can report the worker `idle` or `done` while it compacts.
     Before the next task prompt, read the worker's screen and send only once the compaction has
     finished.

9. **Report the outcome** with the worker name, the profile that ran it, and the result.

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

- **TUI: `agent start` timing out** (it waits up to 30 s for the agent to become ready) usually means the harness exited at once and the pane is back at its shell prompt. Read the pane for its error.
- **TUI: `agent_not_running` on the first prompt** means the pane's process exited. Read the pane; the real cause is on screen. (On a worker that was already running, it can also mean its pane was moved; see [Tab commands](#tab-commands).)
- **TUI: `agent_pane_busy`** right after the pane opened: the shell is still starting. Retry after a few seconds.
- **App: `spawn_failed`** means the program in `argv` could not start; the error's `message` names it. **A worker in state `finished`** (exit code 11 from `hc send`) exited: `hc read <worker-name>` shows why.
- **A harness trust or setup dialog** (a first-run "do you trust this folder", an auth prompt) blocks the worker before any task. It is answered once per directory; report it to the user instead of working around it.
- **TUI: a stale environment.** Panes inherit the environment of the Herdr server, captured when the server started. A `PATH` entry or API key added since then is missing in new panes. Set it in the pane first (`herdr pane run <pane_id> "<command>"`), or have the harness read the value from persistent storage instead of the process environment. App terminals do not inherit your environment either; on Windows they read the user and system environment afresh when they start.
- **TUI: a harness installed under a path with spaces** can fail to launch through `agent start` on Windows. `launch` already prefers a copy on `PATH` without a space; when there is none, a link to the same directory at a path without spaces, placed ahead on `PATH`, works around it. `hc run` starts such a path fine.
- **A wrong model name** for a harness with no catalog (`claude`) shows up as a harness-side error, not an `agent start` failure. `launch --json` cannot catch this; report the model you used.
- **The harness itself failing** (a crash inside the harness) is outside this plugin's control. Report the exact command you ran and the harness output.

Never edit a profile to work around a harness-side failure.

Every failed start ends in a report to the user, in the same turn: the profile id, the start line
you ran, and the harness's own error from the worker's screen (`hc read <worker-name>`, or
`herdr pane read <pane_id> --source recent`). Close the dead worker after reading it. Switching to
another profile or doing the task yourself is the user's call, made after that report.

## After Herdr restarts

A restart is one more case of the check in step 6: run `$LOADOUT worker-check <worker-name>` before
giving any worker more work, and replace the worker when it fails. Never restore a setting inside
the harness instead.

**TUI:** Herdr restores worker panes after a restart or reboot by resuming each harness session
(`claude --resume <id>`, `omp --resume=<session>`) without the profile's launch arguments, so a
resumed worker runs with the harness defaults. `worker-check` reads the pane's command line
(`herdr pane process-info`) and fails when the profile's arguments are missing from it. A profile
with no launch arguments leaves nothing to compare, so after a restart replace its workers anyway.

**App:** closing the window does not stop workers; they keep running in herdr-core. A worker whose
program was lost (a crash, a host shutdown) is never rerun; a worker the app keeps comes back as a
plain shell, which `worker-check` reports. Remove it (`hc kill`, `hc rm`) and launch a fresh worker.

## Reading `--compact`

```text
builder | expensive | implementation/refactor/design
qa | normal | qa/testing
reviewer | cheap | review/security
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
