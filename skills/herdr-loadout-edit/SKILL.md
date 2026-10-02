---
name: herdr-loadout-edit
description: "Create or change agent profiles in the herdr-loadout registry: add a role, change which harness/model/effort a role uses, set a project-specific override, or import a set of profiles. Use when the user asks to add, edit, tune, or remove a profile, or when delegation failed because no suitable profile exists."
---

# Herdr Loadout — edit agent profiles

Profiles live in a TOML registry. Two layers:

| Layer | Path | Purpose |
|---|---|---|
| global | `<HERDR_PLUGIN_CONFIG_DIR>/loadout.toml` | shared across every project |
| project | `<project>/.herdr/loadout.toml` | only the fields that differ, for this project |

`$LOADOUT` is the CLI resolved in the `herdr-loadout` skill ("Resolve the CLI once"). Resolve the paths instead of guessing:

```bash
$LOADOUT path
```

## Required fields

Every profile needs all six. Writes fail without them.

| Field | Meaning |
|---|---|
| `id` | lowercase identifier, unique; `[a-z0-9][a-z0-9._-]*` |
| `name` | display name |
| `harness` | `claude`, `codex`, `opencode`, `omp`, `pi`, or `custom` |
| `model` | model id the harness accepts |
| `effort` | reasoning level |
| `when_to_use` | the routing sentence a Director matches against |

Optional: `avoid_when`, `cost` (`cheap`/`normal`/`expensive`), `provider`, `mode`,
`extra_args`, `env`, `tags`, `skills`, `notes`, `sandbox`, `approval_policy`, `permission_mode`.

`when_to_use` and `avoid_when` are load-bearing: they are what a Director reads when choosing.
Write them as routing instructions, not documentation.

## Before writing: what does this machine actually have

Never invent a model id or an effort level. Ask:

```bash
$LOADOUT detect
```

The listing is per-harness: `✓ detected` or `✗ not found`, plus a model count when the harness
exposes a catalog. Use **only** ids from that output — a plausible-looking model name is the most
common cause of a worker that starts and then dies.

Two caveats the output encodes:

- **A harness with no catalog** (typically `claude`) accepts a free-form model name. Confirm the
  value with the user rather than guessing.
- **`model list unavailable`** means that harness's own command failed — read the message and treat
  the model as unverified for that harness.

Whether a harness can apply `effort` at launch is reported per profile by `launch <id> --json`. A
harness whose effort cannot be set still launches; the level is simply ignored, and the check says so.

## Add a profile

```bash
$LOADOUT add \
  --id unity-builder \
  --name "Unity Builder" \
  --harness claude --model deepseek-v4.1 --effort high --cost normal \
  --when "Unity and FishNet implementation, asmdef-aware refactors." \
  --avoid "Pure research, or independent review." \
  --tag unity --tag implementation \
  -- --add-dir Assets
```

Conventions that keep the roster usable:

- `--when` is one sentence naming the task shape this role is for. Name the *situation*, not the agent.
- `--avoid` names the neighbouring situation that belongs to another profile — this is what prevents
  two profiles from competing for the same task.
- `--cost` reflects how expensive the model is, not how good it is: `cheap` for scouting and review,
  `normal` for implementation, `expensive` for hard design work.
- `--tag` values feed the `--compact` routing line, so keep them short and task-shaped
  (`implementation`, `review`, `research`).

**A reviewer must not share the implementer's model.** When adding a review profile next to an
implementation profile, read the existing one first and choose a different harness or model.

Arguments after `--` become `extra_args` verbatim. Flags whose values start with a dash need
`--flag=value`.

## Update in place

`set` changes only the fields you name and leaves the rest:

```bash
$LOADOUT set builder --effort high
$LOADOUT set builder --from tuning.json
```

Permissions are harness-specific. Use `--sandbox` and `--approval-policy` for Codex;
use `--permission-mode` for Claude, OMP, or OpenCode. `$LOADOUT --help` lists the
supported values; the TUI picker offers only values for the selected harness.
An empty string explicitly inherits the harness setting, including in a project override.
The new Claude/Codex fields replace their legacy `mode` value when present.
After changing permissions, check `launch <id> --json`; its `args` and `env` are both
required when starting the worker.

Read the profile before editing it, so you preserve fields you are not changing:

```bash
$LOADOUT show builder
```

## Project-specific overrides

There are two places a profile can live: the global config (shared) and the project file
(`<project>/.herdr/loadout.toml`). Without `--project` every write goes to global; with it, to the
project file.

Write to the project layer when a value should differ only for one repository:

```bash
$LOADOUT set builder --effort high --project .
```

This stores just the changed fields:

```toml
[[profiles]]
id = "builder"
effort = "high"
```

Everything unlisted keeps following the global profile, so a later global change still applies.
Prefer an override over duplicating a whole profile.

Setting every field back to the global values removes the override. To drop it outright:

```bash
$LOADOUT reset builder                  # follow the global profile again
```

`set` without `--project` edits the global profile itself and never copies a project override into
it; it says so when this project still overrides a field you just changed.

A profile that exists only in the project layer is fine — `list` shows it under "Project profiles".
Use it for roles that only make sense in that repository. It has no global original, so it has no
override: change it with `set <id> --project .`, which stores the whole profile. `add --project .`
creates one, and refuses an id that already exists in global (use `set --project` to override that).

## Remove

```bash
$LOADOUT remove <id>                    # global profile, plus this project's override of it
$LOADOUT remove <id> --project .        # the project entry (an override or a project-only profile)
```

To undo an override without touching the global profile, use `reset`, not `remove`.

## Bulk changes

```bash
cat profiles.toml | $LOADOUT add --from -
$LOADOUT add --from profile.json
$LOADOUT import ./team-profiles.toml
```

`import` merges every profile in a file. An entry that fails validation is reported and skipped
while the rest are applied — read the `failed` array, and do not report success while it is non-empty.

## Verify every change

```bash
$LOADOUT validate                # schema, duplicate ids
$LOADOUT launch <id> --json      # executable, model, and effort actually resolve
$LOADOUT list --compact          # the roster a Director will read
```

`launch --json` is the only check that proves a profile can start on this machine. `validate` passing
does not mean the model name is real.

Report the profile id and the file it landed in.

## Editing the TOML by hand

The file is meant to be hand-edited; unknown keys survive every save. The interactive editor is:

```bash
herdr plugin pane open --plugin herdr-loadout --entrypoint ui
```

Prefer the CLI for anything scripted — the TUI needs a person at the keyboard.
