---
name: herdr-loadout
description: "Delegate work to Herdr workers using named agent profiles. Use when a task should be handed to another agent in a Herdr pane — parallel implementation, independent review, or repository exploration — and the role, harness, model, or effort level matters. Requires HERDR_ENV=1 and the herdr-loadout plugin."
---

# Herdr Loadout — orchestrate work with agent profiles

A **profile** names a role and pins the harness, model, and effort a worker runs with.
The registry is the policy layer; Herdr skill commands are the execution layer.

```text
herdr-loadout list --compact   →  who is available
herdr-loadout show <id>        →  exactly how they run
herdr agent start …            →  how the worker launches
```

## Resolve the CLI once

`herdr-loadout` answers from any working directory. Pick the first form that works and reuse it as
`$LOADOUT` for the rest of the session. `HERDR_PLUGIN_ROOT` is only set for commands the plugin
itself runs, never in an agent's shell, so do not rely on it.

```bash
# 1. on PATH
herdr-loadout list --compact

# 2. the launcher in the plugin config dir; needs no PATH (POSIX sh / Git Bash)
LOADOUT="$(herdr plugin config-dir herdr-loadout)/herdr-loadout"
"$LOADOUT" list --compact
```

```powershell
# 2. same thing in PowerShell
$LOADOUT = Join-Path (herdr plugin config-dir herdr-loadout) 'herdr-loadout.cmd'
& $LOADOUT list --compact
```

On Windows, `bash` may resolve to WSL, which sees neither `herdr` nor the Windows `node`. When the
POSIX form fails that way, use the PowerShell form.

If form 2 says the file does not exist, create the launchers once and retry:

```bash
herdr plugin action invoke herdr-loadout.install-shim
```

If the launcher reports that the plugin is missing from its install path, run the same command again;
the plugin was reinstalled somewhere else.

An empty roster is a real answer: no profiles exist yet. Point the user at the `herdr-loadout-edit`
skill rather than inventing a profile.

## Delegate

1. **Read the roster.** One call, cheap and always current:

   ```bash
   $LOADOUT list --compact
   ```

   Each line is `id | cost | purpose`. The purpose is the routing signal; cost is the tiebreaker.

2. **Pick by description, not by name.** Read the full description of the candidates that plausibly fit:

   ```bash
   $LOADOUT show <id>
   ```

   Match the task against `When to use`, and reject a candidate whose `Avoid when` describes your task.
   When several profiles fit equally, take the cheapest.

3. **Get the launch arguments** right before every launch. Never transcribe model names or effort
   levels by hand:

   ```bash
   $LOADOUT launch <id> --json
   ```

   The response carries `harness`, `args`, `env`, and `ok`. Continue only when `ok` is true.
   `args` includes the profile's permission flags. `env` includes its environment overrides
   and, for OpenCode, generated runtime permissions.

   Users change profiles between sessions. In briefs, handoff notes, and long-term memory, record
   only the profile id, never its harness, model, or effort. When a note and the profile disagree,
   the profile wins.

4. **Open the worker pane** in the tab for its kind of work (see [Tabs and layout](#tabs-and-layout)).
   For every entry in `env`, add one `--env KEY=VALUE` argument. Pass each pair as one
   shell-quoted argument; OpenCode's inline JSON must remain intact. Pass `--cwd` as an absolute
   path: a relative one resolves against the Herdr server's directory, not yours.

   ```bash
   # no tab for this kind of work yet: create it; its root pane is the worker pane
   herdr tab create --label <kind> --cwd "$PWD" --no-focus        # result.root_pane.pane_id
   # the tab exists (herdr tab list): split one of its panes
   herdr pane split <pane_in_that_tab> --direction right|down --cwd "$PWD" --no-focus
   herdr pane rename <pane_id> <worker-name>
   ```

5. **Start the worker** with the Herdr skill's naming rules:

   ```bash
   herdr agent start <worker-name> --kind <harness> --pane <pane_id> -- <args...>
   ```

   Pass the profile's `args` verbatim after `--`. Do not add or rewrite harness flags.
   A `start` right after the pane opens can fail with `agent_pane_busy` while the shell is still
   starting; retry after a few seconds. Give the harness a few seconds to come up before the first
   prompt.

6. **Prompt with the worker tag.** Put the task in a brief file and point the worker at it, so the
   worker can reread it after a compaction or restart. Every task prompt to a worker, follow-ups
   included, starts with `[Worker-<worker-name>]`, so the worker and the user can both see which
   worker a prompt is for. Have the brief name a report file whose last line is a fixed marker
   (`<TASK>-COMPLETE`, `<TASK>-PARTIAL`, `<TASK>-BLOCKED`, or `REVIEW-READY <n>` for a worker that
   pauses for review):

   ```bash
   herdr agent prompt <worker-name> "[Worker-<worker-name>] Read <brief> and do it. Report in <report>." --wait
   ```

   Workers often run for hours, so do not set a short `--timeout`. When your harness can run a
   shell command as a background job (Claude Code's `run_in_background`, omp's `async`), run this
   exact command as one, one job per worker, with no job deadline, and go back to the user while it
   runs. The user can then give you new instructions mid-task, and the job finishing is your signal
   to read the worker. Run it in the foreground only on a harness without background jobs.

   To wait again on a worker (after a pane move broke the wait, say), use `agent wait`, not another
   `prompt --wait`. Without `--until` it matches `idle`, `done`, or `blocked`:

   ```bash
   herdr agent wait <worker-name>
   ```

   Right after a prompt sent without `--wait`, the worker can still show the idle state from before
   the prompt, which ends the wait at once; give it about 30 seconds first. When Herdr reports the
   worker's state as `unknown`, a wait cannot tell when it finishes; check its report file instead.

7. **Read the answer, then decide why the worker stopped.** An idle or done state does not mean the
   task finished. Read the report's last line, then the pane:

   ```bash
   tail -n 1 <report>                  # PowerShell: Get-Content <report> -Tail 1
   herdr agent read <worker-name> --source recent-unwrapped --lines 120
   ```

   - The report was written after your prompt (its modification time is newer) and its last line is
     a completion marker: the task finished; go to step 8.
   - Otherwise the worker stopped on a question, a permission dialog, or a usage limit. See
     [When a worker stops mid-task](#when-a-worker-stops-mid-task).

8. **Close or compact the worker.**

   - **No follow-up planned:** close it now with `herdr pane close <pane_id>`. Closing hands the
     space to the neighbouring pane, and closing the last pane of a tab closes the tab.
   - **Follow-up planned** (a review-and-fix loop, for example): compact its context now with
     whatever compaction the harness offers (usually a slash command such as `/compact`), so the
     next task starts small. Send it bare, without the worker tag or `--wait`: a slash command
     must start the line, and Herdr can report the worker `idle` while it compacts. Before the
     next task prompt, `herdr agent read` the worker and send only once the compaction has
     finished.
   - A worker that stops at `REVIEW-READY <n>` is always kept: compact it as described above as soon
     as you have read its report, before anything else.
   - Do not replace or stop a worker only because its context is filling up; the harness compacts
     on its own.

9. **Report the outcome** with the worker name, the profile that ran it, and the result.

A delegated task is done when the worker's answer is read back to the caller and every worker is
either closed or compacted for its planned follow-up — not when the prompt is submitted.

## Tabs and layout

Give each kind of work its own tab instead of stacking every worker beside you.

- **Your tab holds only you.** The orchestrator pane keeps the full width of its tab; never open a
  worker there.
- **One tab per kind of work.** Name it with a short lowercase word (`backend`, `docs`, `sound`).
  The implementer, its reviewers, scouts, and advisors on the same work share that tab.
- **Idle workers stay in their own tab.** Do not keep a separate parking tab; a worker waiting for
  its next task stays where its work is, and a worker with nothing left is closed.
- **Helper panes go with their worker.** A pane a worker opens for itself (a progress monitor, a log
  tail) belongs in that worker's tab.
- **Workers that lead other workers** open and close panes only inside their own tab.
- **Inside a tab,** put workers on the same context side by side in one row rather than stacking
  them all vertically. Keep row heights equal, and widths equal within a row. Keep every pane at
  least 12 rows tall.
- **Re-level the tab whenever you open or close a pane in it,** in the same turn: read it with
  `herdr pane layout --pane <pane_in_that_tab>` (`rect`, and `ratio` under `splits`), resize, and
  read it again. Without `--pane`, `layout` reads the user's focused tab, which may be another one.
- `herdr pane resize --pane <id> --direction up|down|left|right --amount <ratio>` takes a ratio
  between 0 and 1 of the split that owns the edge, not a row count; an integer moves the edge
  far. `--direction` names which edge of that pane moves.
- To move a pane into another tab:
  `herdr pane move <pane> --tab <tab> --split right|down --target-pane <pane_in_that_tab> --ratio 0.5 --no-focus`.
  Moving a pane within its own tab reports `changed: false` and does nothing; move it out with
  `--new-tab`, then back. Swap two panes with `herdr pane swap --source-pane <a> --target-pane <b>`.
- **Moving a worker's pane breaks a running wait on it** with `agent_not_running`, although the
  worker is still alive. Start the wait again after a move.
- `agent prompt`, `agent wait`, and `agent read` address workers by name, whatever tab they are in.

## Coordinating workers

- **Peers on one task** agree on a contract file they both follow. When one needs a change, it
  edits the contract and tells the other with
  `herdr agent prompt <peer> "[Worker-<peer>] <short note>"`. For a structured discussion, keep the
  transcript in one file, append one turn at a time, and pass the turn with a prompt; cap the
  number of turns.
- **A lead worker with members** starts them as Herdr panes in its own tab rather than as its
  harness's built-in subagents, so the user can watch them. Keep it to a few members at once,
  write each member's brief to a file, and forbid members from delegating further.
- **Reviewers start fresh for every review**, re-reviews included. Give a re-reviewer only the
  previous review file and the implementer's account of the fixes, not the earlier conversation.
  Close a reviewer as soon as its review is read.

## Routing rules

- **Implementation** goes to a builder-class profile. **Research** goes to a scout-class profile; it must not edit files.
- **Independent review** uses a reviewer-class profile, and the reviewer must differ from the implementer in harness or model. A review by the same profile that wrote the code is not a review.
- **Difficult problems** — design work, bugs that resisted a first attempt — justify an expensive profile. Routine edits and lookups do not.
- **Trivial work stays local.** Delegation costs a pane, a startup wait, and context to read back; spend it where a second agent actually helps.
- **Check a scout's key claims yourself.** Cheap research workers sometimes stop after a few minutes with a shallow answer.

## When a worker stops mid-task

- **A question or a permission dialog** shows in the pane (`herdr pane read <pane_id>`). Answer it if
  the task brief settles it; approve only actions the task needs, such as reads. Otherwise ask the
  user. Never relaunch the worker with a permission-skipping flag to get past dialogs.
- **A usage limit** usually shows a reset time in the harness's status line. Tell the user, wait
  until that time (as a background job), then prompt the same worker to continue. Do not start a
  fresh worker for it.
- **A profile swapped temporarily** (another model while one provider is out of quota, say): record
  the exact command that restores it next to the change, and restore it when the limit lifts.

## When a worker will not start

`agent start` returning an error, or a worker that dies right after launch, is usually not a profile
problem. Check in this order, and act only on what the evidence supports:

- **`agent_not_running` on the first prompt** means the pane's process exited. Read the pane; the real cause is on screen. (On a worker that was already running, it can also mean its pane was moved; see [Tabs and layout](#tabs-and-layout).)
- **`agent_pane_busy`** right after the pane opened: the shell is still starting. Retry after a few seconds.
- **A harness trust or setup dialog** (a first-run "do you trust this folder", an auth prompt) blocks the worker before any task. It is answered once per directory; report it to the user instead of working around it.
- **A stale environment.** Panes inherit the environment of the Herdr server, captured when the server started. A `PATH` entry or API key added since then is missing in new panes. Set it in the pane first (`herdr pane run <pane_id> "<command>"`), or have the harness read the value from persistent storage instead of the process environment.
- **A harness installed under a path with spaces** can fail to launch through `agent start` on Windows. `launch` already prefers a copy on `PATH` without a space; when there is none, a link to the same directory at a path without spaces, placed ahead on `PATH`, works around it.
- **A wrong model name** for a harness with no catalog (`claude`) shows up as a harness-side error, not an `agent start` failure. `launch --json` cannot catch this; report the model you used.
- **The harness itself failing** (a crash inside the harness) is outside this plugin's control. Report the exact command you ran and the harness output.

Never edit a profile to work around a harness-side failure.

## After Herdr restarts

Herdr restores worker panes after a restart or reboot by resuming each harness session
(`claude --resume <id>`, `omp --resume=<session>`) without the profile's launch arguments.
A resumed worker can run with the harness defaults instead of the profile's settings; Claude Code,
for one, falls back to its default effort. Before giving a resumed worker more work, compare the
running process's command line with `launch --json`, and either restore the setting inside the
harness (Claude Code: `/effort <level>`, then check the status line) or close the worker and launch
a fresh one.

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
