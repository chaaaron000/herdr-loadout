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

3. **Get the launch arguments.** Never transcribe model names or effort levels by hand:

   ```bash
   $LOADOUT launch <id> --json
   ```

   The response carries `harness`, `args`, `env`, and `ok`. Continue only when `ok` is true.
   `args` includes the profile's permission flags. `env` includes its environment overrides
   and, for OpenCode, generated runtime permissions.

4. **Open the worker pane** in the *worker column*: your pane keeps the left half and workers
   stack on the right.

   ```bash
   # first worker: split your own pane to the right
   herdr pane split --current --direction right --cwd "$PWD" --no-focus
   # each further worker: split the tallest worker pane down
   herdr pane split <tallest_worker_pane> --direction down --cwd "$PWD" --no-focus
   ```

   Splitting the tallest worker keeps the column even; splitting the newest one halves it every
   time. Find heights with `herdr pane layout --pane <your_pane_id>` (`rect.height`); without
   `--pane` it reads the user's focused tab, which may be another one. Keep every worker at least
   12 rows tall: when the column has no room for another, finish and close a worker first.
   For every entry in `env`, add one `--env KEY=VALUE` argument to `herdr pane split`.
   Pass each pair as one shell-quoted argument; OpenCode's inline JSON must remain intact.

5. **Start the worker** with the Herdr skill's naming rules:

   ```bash
   herdr agent start <worker-name> --kind <harness> --pane <pane_id> -- <args...>
   ```

   Pass the profile's `args` verbatim after `--`. Do not add or rewrite harness flags.

6. **Prompt with the worker tag.** Every task prompt to a worker, follow-ups included, starts with
   `[Worker-<worker-name>]`, so the worker and the user can both see which worker a prompt is for:

   ```bash
   herdr agent prompt <worker-name> "[Worker-<worker-name>] <task>" --wait --timeout 1800000
   ```

   When your harness can run a shell command as a background job (Claude Code's
   `run_in_background`, omp's `async`), run this exact command as one, one job per worker, and
   go back to the user while it runs. The user can then give you new instructions mid-task, and
   the job finishing is your signal to read the worker. Run it in the foreground only on a
   harness without background jobs.

7. **Read the answer, then close or compact the worker.**

   ```bash
   herdr agent read <worker-name> --source recent-unwrapped --lines 120
   ```

   - **No follow-up planned:** close it now with `herdr pane close <pane_id>`. Closing hands the
     space to the neighbouring pane, and closing the last worker gives your pane its full width
     back, so the layout needs no resizing.
   - **Follow-up planned** (a review-and-fix loop, for example): compact its context now with
     whatever compaction the harness offers (usually a slash command such as `/compact`), so the
     next task starts small. Send it bare, without the worker tag or `--wait`: a slash command
     must start the line, and Herdr can report the worker `idle` while it compacts. Before the
     next task prompt, `herdr agent read` the worker and send only once the compaction has
     finished.

8. **Report the outcome** with the worker name, the profile that ran it, and the result.

A delegated task is done when the worker's answer is read back to the caller and every worker is
either closed or compacted for its planned follow-up — not when the prompt is submitted.

## Routing rules

- **Implementation** goes to a builder-class profile. **Research** goes to a scout-class profile; it must not edit files.
- **Independent review** uses a reviewer-class profile, and the reviewer must differ from the implementer in harness or model. A review by the same profile that wrote the code is not a review.
- **Difficult problems** — design work, bugs that resisted a first attempt — justify an expensive profile. Routine edits and lookups do not.
- **Trivial work stays local.** Delegation costs a pane, a startup wait, and context to read back; spend it where a second agent actually helps.

## When a worker will not start

`agent start` returning an error, or a worker that dies right after launch, is usually not a profile
problem. Check in this order, and act only on what the evidence supports:

- **`agent_not_running` on the first prompt** means the pane's process exited. Read the pane; the real cause is on screen.
- **A harness trust or setup dialog** (a first-run "do you trust this folder", an auth prompt) blocks the worker before any task. It is answered once per directory; report it to the user instead of working around it.
- **A wrong model name** for a harness with no catalog (`claude`) shows up as a harness-side error, not an `agent start` failure. `launch --json` cannot catch this; report the model you used.
- **The harness itself failing** (a crash inside the harness) is outside this plugin's control. Report the exact command you ran and the harness output.

Never edit a profile to work around a harness-side failure.

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
