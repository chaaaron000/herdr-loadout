---
name: herdr-loadout-edit
description: "Create or change agent profiles in the herdr-loadout registry: add a role, change which harness/model/effort a role uses, set a project-specific override, or import a set of profiles. Also changes the delegation workflow (routing, briefs, tabs, when workers close). Use when the user asks to add, edit, tune, or remove a profile or a workflow rule, or when delegation failed because no suitable profile exists."
---

# Herdr Loadout — edit agent profiles

Profiles live in a TOML registry. Two layers:

| Layer | Path | Purpose |
|---|---|---|
| global | `<HERDR_PLUGIN_CONFIG_DIR>/loadout.toml`; in the app, the same file at its default location (`$LOADOUT path`) | shared across every project |
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
| `harness` | `claude`, `codex`, `opencode`, `omp`, `pi`, `agy` (Antigravity CLI), or `custom` |
| `model` | model id the harness accepts |
| `effort` | reasoning level; for an agy model id ending in a level (`gemini-3.8-flash-medium`) it is set from the id. The editors show such a model once (`gemini-3.8-flash`) with its levels as Effort choices; the stored `model` keeps the full id |
| `when_to_use` | the routing sentence a Director matches against |

Optional: `avoid_when`, `cost` (`cheap`/`normal`/`expensive`), `provider`, `mode`,
`extra_args`, `env`, `tags`, `skills`, `notes`, `sandbox`, `approval_policy`, `permission_mode`, `api`, `auth`.

`api` names a stored API key the harness runs on instead of its own sign-in: a DeepSeek key for
`claude` (DeepSeek's Anthropic-compatible endpoint), a Google AI Studio key for `agy` (the Gemini
API). Codex cannot take either: it speaks only the Responses API. Keys live in `keys.toml` beside
the global config, never in a profile or project file. `herdr-loadout keys list` shows the stored
ids (masked). Set a profile's key with `set <id> --api <key-id>`; an empty value goes back to the
sign-in. With a key, the model must be one the provider lists (`deepseek-v4-pro`,
`deepseek-flash`; agy: the Gemini API's models), and `launch <id>` fails its `API key` check when
the key is missing or its provider cannot drive the harness. Never ask for, read, or write a key
yourself: the user stores it with `keys add` (stdin) or the app editor's API keys page (`k`).

`auth = "api-key"` is agy's older route, with the key from the profile's `env.GEMINI_API_KEY` or the
worker's `GEMINI_API_KEY`. Prefer `api` for new profiles.

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
  (`implementation`, `qa`, `review`, `research`).

**A QA or review profile must not share the implementer's model.** When adding one next to an
implementation profile, read the existing one first and choose a different harness or model. QA is
the default check after implementation; a reviewer is for security-sensitive changes or on request.

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
After changing permissions, check `launch <id> --json`; it reports `args`, and `env` with every
value masked as `***`.

`env` values are often API keys. Set them with `--env KEY=VALUE` or in the editors' Env field,
which shows each value as `***`; leaving `KEY=***` as it is keeps that value. Never echo a key back
to the user or into a note.

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

A change reaches only workers started after it. Workers already running on the profile keep the old
settings and now fail `herdr-loadout worker-check <worker>`; an orchestrator replaces them before
their next prompt. Say so when you report the change.

Report the profile id and the file it landed in.

## Change the workflow

The workflow is the set of choices agents follow when they work in Herdr: what the agent talking to
the user does itself and what it delegates, routing, how prompts, briefs, and reports look, how tabs
are used, when a worker is closed or kept, and how workers coordinate. It is Markdown, in two
layers:

| Layer | Path | Purpose |
|---|---|---|
| global | `<config dir>/workflow.md` (`globalWorkflow` in `$LOADOUT path`); the built-in default until it exists | shared across every project |
| project | `<project>/.herdr/workflow.md` (`projectWorkflow`) | rules for this project only, read after the global ones; they win where the two conflict |

- **A rule for one project:** `$LOADOUT workflow init --project .` creates the project file with a
  short header. Write only what differs from the global workflow.
- **A rule for every project:** `$LOADOUT workflow init` copies the built-in default to the global
  file; edit that copy. From then on it is the user's, and later changes to the built-in default do
  not reach it.

The built-in default shares the work: the agent talking to the user works too and delegates where
that helps. A user who wants that agent to only plan and delegate adds a rule like this one, which
replaces the default's "You work too" (adjust it to what they asked):

```markdown
## Who does what

- **You orchestrate; you do not do the work.** Plan, delegate, read reports, and answer the user.
  Work yourself only to answer a question, read files, or make a few-line edit to one existing
  file (a typo, a value, a sentence). New code, any test change, or a change to more than one
  file goes to a worker, however small it looks. When unsure, delegate.
```

Put the rule where the user said it applies; when they did not say, ask. After a change,
`$LOADOUT workflow` prints exactly what agents will read; report the file you changed.

**Brief and report templates.** `herdr-loadout task new` fills `brief.md` and `report.md` from
`<project>/.herdr/templates/brief.md` and `report.md` when they exist, else from the built-in ones.
To change them for a project, copy the built-in file (`src/core/templates/` in the plugin root,
`pluginRoot` in `$LOADOUT path`) there and edit it. `{{key}}` placeholders are filled in: `task`,
`slug`, `date`, `host`, `host_label`, `orchestrator`, `worker`, `profile`, `dir`, `brief`,
`report`, `prompt`, `notify`. An unknown key is left as written.

## Editing the TOML by hand

The file is meant to be hand-edited: a save changes only the keys and blocks it writes, so comments
and unknown keys survive every save. A layout a save cannot edit as text (profiles written as an
inline array, for example) is refused and the file is left as it was. The interactive editor is for
a person; open it with the command for your host (see "Know your host" in the `herdr-loadout`
skill):

```bash
# TUI: a plugin pane beside you
herdr plugin pane open --plugin herdr-loadout --entrypoint ui
# App: the Agent Profiles window (installed with `npm run install:app-mod` in the checkout)
herdr-app do mod.open --name herdr-loadout
```

In the app, the same command closes the window when it is already open. When `herdr-app status`
shows no `herdr-loadout` overlay afterwards, the mod is not installed; tell the user how to install it.

Prefer the CLI for anything scripted — the editor needs a person at the keyboard.
