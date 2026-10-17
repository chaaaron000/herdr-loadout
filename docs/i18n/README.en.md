# herdr-loadout

**Language:** [한국어](../../README.md) · [English](./README.en.md) · [日本語](./README.ja.md) · [简体中文](./README.zh-CN.md)

A lightweight agent profile registry plugin for Herdr.

It lets a Director (or a human) define **which harness / model / effort belongs to which role**,
so the orchestrator can look up a profile at minimal context cost and launch a worker
through the Herdr skill.

```text
Profile Registry (this plugin)
      "who should do it?"
           ↓
       Director
           ↓
      Herdr Skill          "how do we launch it?"
           ↓
      Herdr Runtime
```

This plugin is not an orchestrator. Pane creation, agent lifecycle, worktrees, messaging,
task DAGs, and scheduling stay with Herdr and the Herdr skill.

## Requirements

- **Node.js ≥ 22** (plugin commands and the CLI run on Node)
- Herdr ≥ 0.7.0
- `npm` (a GitHub install runs `npm ci --omit=dev` as its build step)

## Install

From GitHub (recommended):

```bash
herdr plugin install chaaaron000/herdr-loadout
```

Pin a version with `--ref <tag>`. When developing from a source checkout, link it instead:

```bash
# From a source checkout
npm install

# Register the plugin with Herdr (local link)
herdr plugin link "$(pwd -W 2>/dev/null || pwd)"     # on Git Bash, -W gives the native path
herdr plugin list
```

`herdr plugin link` requires an **absolute path**. Virtual paths such as `/tmp/...` from Git Bash
fail with `Working directory does not exist`, so use `pwd -W` or a `D:\...` style path.

> **Windows note:** Herdr passes the executable path to a shell without quoting it when it runs
> `herdr agent start`. If a harness (`codex`, `opencode`, ...) lives under a path containing a space
> (for example nvm's `Author Software`), the worker fails to start. Put a space-free path
> (for example a junction) at the front of PATH. The `launchable path` check in
> `herdr-loadout launch <id>` reports such paths. See
> [`docs/herdr-verified-facts.md`](../herdr-verified-facts.md) §5.

## Usage

### 1. Edit profiles in the GUI/TUI

```bash
herdr plugin pane open --plugin herdr-loadout --entrypoint ui
```

Or through an action (callable from a Director or a user keybinding):

```bash
herdr plugin action invoke herdr-loadout.open-ui
herdr plugin action invoke herdr-loadout.open-ui-popup
```

If you registered a keybinding, you can open it with that key as well.

### Registering a keybinding (optional)

Herdr does not let a plugin register its own keybindings, so add them to `config.toml`:

```toml
# herdr-loadout: open the agent profile registry
[[keys.command]]
key = "prefix+a"
type = "plugin_action"
command = "herdr-loadout.open-ui"
description = "agent profiles"

[[keys.command]]
key = "prefix+shift+a"
type = "plugin_action"
command = "herdr-loadout.open-ui-popup"
description = "agent profiles (popup)"
```

`prefix+a` opens the default overlay; `prefix+shift+a` opens the session-modal popup.
Keys such as `prefix+l`, `prefix+g`, and `prefix+p` are already taken by Herdr. Apply with
`herdr server reload-config`; no restart needed.

TUI controls:

| Key | Action |
|---|---|
| `↑` `↓` | Move between profiles |
| `Enter` / `e` | Edit the selected profile |
| `a` | New profile |
| `c` | Duplicate |
| `d` | Delete (a global profile takes its project override with it) |
| `r` | Reset the project override — follow the global profile again (only on a row that has one) |
| `j` | Detection view (installed harnesses + model catalogs) |
| `q` | Quit (the pane closes too) |

The list has two sections.

- **Global profiles**: the shared profiles. A row this project overrides shows what differs from global, for example `≠ model, effort`.
- **Project profiles · (path)**: profiles that exist only in this project. They have no global original, so there is no override: edit them directly.

The editor keeps its **modes separate**, so the same key never means two things.

| Mode | Keys | Action |
|---|---|---|
| Moving | `↑` `↓` | between profile fields |
| | `Enter` | open the field (option list, or typing when it has none) |
| | `g` `p` `t` | save to global / save to project / Test Launch |
| | `r` | put the focused field back to the global value (only on a field that differs) |
| | `Esc` | back to the list |
| Picking | `↑` `↓` | move through options |
| | `Enter` | apply and return to the fields |
| | `/` | find (filters as you type) |
| | `o` | cycle order (catalog → name → provider → context) |
| | `Esc` | clear the filter, then leave the picker |
| Typing | any key | enter the value |
| | `Enter` | confirm |
| | `Esc` | cancel |

Search matches the id, provider, or name, and multiple words narrow with AND
(`ollama flash`). The header shows the remaining count as `24 of 55` so a filtered list is
never mistaken for a short one. The key-hint line at the bottom follows the live mode.

Long option lists (model catalogs can hold hundreds of ids) scroll to keep the cursor visible,
with the remaining count shown as `↑27 ↓45 (41/86)`.

Each save target has its own key, so there is no mode to switch. The top of the editor says what the profile is and what each key does.

| Key | Writes to | Behaviour |
|---|---|---|
| `g` | `<HERDR_PLUGIN_CONFIG_DIR>/loadout.toml` | edits the global profile; only the fields changed in this session are applied, so a project override never leaks into global |
| `p` | `<project>/.herdr/loadout.toml` | stores **only the fields that differ**; the rest follows global. A project-only profile stores its whole body |

- A project-only profile uses `p` only (`g` is refused).
- A new or copied profile is saved with `g` (global) or `p` (project-only). An id that already exists is refused, never overwritten.
- A field that differs from global is marked `≠` and the global value is shown at the bottom. `r` on it restores the global value; once everything is restored, `p` removes the override.
- In the list, `r` on a row with an override asks for confirmation, then deletes the whole override so the profile follows global again.

Saving to the project records just the delta, so changing a global model or tag later
still applies to that project.

The popup (`prefix+shift+a`) opens at 90%x80% of the screen. The TUI adapts its layout to the
terminal and, in a small window, trims the field list so the model picker keeps its rows.

### 2. Query from the CLI (the Director path)

```bash
herdr-loadout list                  # human-readable list
herdr-loadout list --compact        # Director format: id | cost | purpose
herdr-loadout show builder          # details for one profile
herdr-loadout path                  # show config and state paths
herdr-loadout validate              # validate the config
herdr-loadout detect                # harness availability + model catalogs
herdr-loadout catalog               # inspect/refresh the models.dev snapshot (225 providers)
herdr-loadout launch builder        # Test Launch (dry-run)
herdr-loadout ui                    # opens a pane and exits when there is no TTY
```

Install the launchers (this never edits PATH):

```bash
herdr plugin action invoke herdr-loadout.install-shim
```

How agents call it without PATH:

```bash
"$(herdr plugin config-dir herdr-loadout)/herdr-loadout" list --compact
```

To call `herdr-loadout` from any shell, install into a folder that is **already on PATH**:

```bash
node scripts/setup-shim.mjs --dir ~/.local/bin
```

Launchers you installed once are refreshed on Herdr startup, so they keep working if a reinstall moves the plugin.

It always works without the shim:

```bash
node bin/herdr-loadout.mjs list --compact
```

`list --compact` is a fixed format with no header, colour, or decoration.
Orchestrator parsers depend on it.

```text
builder | normal | implementation/refactor
reviewer | cheap | review
scout | cheap | research
heavy | expensive | design
```

### 3. Config files

| File | Purpose |
|---|---|
| `<HERDR_PLUGIN_CONFIG_DIR>/loadout.toml` | Global profiles |
| `<project>/.herdr/loadout.toml` | Project overrides (only the listed fields are replaced) |

Run `herdr-loadout path` to see the real locations. You can also edit the files by hand;
unknown keys survive every save.

```toml
version = 1

[[profiles]]
id = "builder"
name = "Builder"
harness = "claude"
model = "deepseek-v4.1"
effort = "medium"
cost = "normal"
when_to_use = "General implementation, refactoring, and bug fixes."
avoid_when = "Pure research, trivial edits, or independent review."
```

Example project override (changes only effort and extra args):

```toml
[[profiles]]
id = "builder"
effort = "high"
extra_args = ["--add-dir", "Assets"]
```

### 4. AGENTS.md snippet for the Director

```md
## Delegation

Use Herdr workers when delegation is beneficial.

Before delegating:
1. Query available agent profiles: `herdr-loadout list --compact`
2. Choose the profile whose usage description best matches the task: `herdr-loadout show <id>`
3. Prefer the cheaper suitable profile when multiple profiles are appropriate.
4. Use an independent reviewer for substantial code changes.
5. Do not delegate trivial work.

Use the Herdr skill for spawning, messaging, waiting, and reading worker results.
Launch workers with the profile's harness/model/effort via `herdr agent start`.
```

Swapping models or harnesses only touches profiles. AGENTS.md stays unchanged.

### 5. Let an agent create profiles (non-interactive)

The TUI is for humans, so agents use the CLI write commands.

```bash
# Directly with flags
herdr-loadout add --id builder-unity --name "Unity Builder" \
  --harness claude --model deepseek-v4.1 --effort high --cost normal \
  --when "Unity/FishNet implementation with asmdef awareness." \
  --avoid "Pure research." --tag unity --tag implementation \
  -- --add-dir Assets

# From a JSON/TOML payload file
herdr-loadout add --from profile.json
cat profile.toml | herdr-loadout add --from -

# Update an existing profile (only the given fields change)
herdr-loadout set builder --effort high

# Different for this project only (stores just what differs)
herdr-loadout set builder --effort high --project .

# Drop the project override; follow the global profile again
herdr-loadout reset builder

# Delete (a global profile takes this project's override with it)
herdr-loadout remove builder-unity

# Merge a whole config file
herdr-loadout import ./team-profiles.toml
```

`--project <PATH>` writes the project file (`.herdr/loadout.toml`) instead of the global one. The rules match the TUI.

| Command | Global (default) | `--project` |
|---|---|---|
| `set` | edits the global profile itself; a project override is never copied in (it tells you when this project still overrides a field you changed) | stores only what differs from global; a project-only profile stores its whole body; going back to the global values removes the override |
| `reset` | n/a | removes the project override (the current directory's project when `--project` is omitted); not valid for a project-only profile |
| `remove` | deletes the global profile and this project's override of it | deletes the project entry (an override or a project-only profile) |
| `add` | refuses an existing id | also refuses an id that exists in global (use `set --project` to override it) |
| `import` | merges as-is | an id that exists in global is stored as a delta, and skipped when identical |

`list` splits the output into **Global profiles** and **Project profiles** like the TUI, and an overridden profile shows `Overridden: effort (global: medium)`. `differs` in `list --json` carries the same information. `list --compact` is unchanged.
`--json` prints a machine-readable result (`{ok, id, scope, path, created}`).
Exit codes: `0` success, `1` runtime error, `2` usage or validation error.

`add` fails when the id already exists (use `--force` to overwrite, or `set` to update).

Actions cannot take arguments, so write a payload file first:

```bash
# after the agent writes profile.json
herdr plugin action invoke herdr-loadout.add-profile
```

## Agent skills

`skills/` holds two skills that agents read.

| Skill | Purpose |
|---|---|
| `herdr-loadout` | Delegate work to a worker through a profile (look up → `launch --json` → `herdr agent start`) |
| `herdr-loadout-edit` | Add, change, remove, or import profiles |

`launch <id> --json` returns `ok`, `harness`, and `args`. Append `args` unchanged after
`herdr agent start <name> --kind <harness> --`. Skill files are copied into a skills library,
so their line endings are pinned to LF (`.gitattributes`).

## Profile fields

Required: `id`, `name`, `harness`, `model`, `effort`, `when_to_use`
Optional: `avoid_when`, `cost` (cheap|normal|expensive), `provider`, `mode`, `extra_args`, `env`, `tags`, `skills`, `notes`

`harness` is one of `claude`, `codex`, `opencode`, `omp`, `pi`, `agy` (Antigravity CLI), or `custom`.
Any other value is rejected by validation unless it is `custom`.

## Harness argument mapping

| harness | model | effort | Notes |
|---|---|---|---|
| `claude` | `--model` | `--effort` | No listing command, so its rows are **derived from omp's Anthropic catalog**; falls back to the aliases (opus/sonnet/haiku/fable) without omp |
| `codex` | `-m` | `-c model_reasoning_effort=<lvl>` | Catalog from `codex debug models` |
| `opencode` | `-m` | `--variant` | Catalog from `opencode models` |
| `omp` | `--model=` | `--thinking=` | Catalog from `omp models --json` (includes thinking levels) |
| `agy` | `--model` | `--effort` | Antigravity CLI. Catalog from `agy models`; same id as Herdr's `--kind agy` |
| `custom` | `--model` | `--effort` | Free-form input |

## Verification

```bash
node --test          # unit tests
```

Manual verification (requires Herdr):

```bash
herdr plugin pane open --plugin herdr-loadout --entrypoint ui
herdr pane read <pane_id> --source visible     # check rendering
herdr pane send-keys <pane_id> down            # check key input
herdr pane close <pane_id>
herdr plugin unlink herdr-loadout              # clean up
```

A plugin pane closes automatically when the process inside it exits (measured).

## Design notes

- Herdr cannot add CLI subcommands to plugins, so `herdr-loadout` is a separate executable.
- Plugin pane commands run in the **pane's cwd**, so every manifest command goes through
  `bootstrap.mjs` (which resolves modules from the plugin root), and the project path is read
  from `HERDR_PLUGIN_CONTEXT_JSON` instead of the pane cwd.
- `herdr plugin action invoke` accepts no arguments and returns no stdout (asynchronous
  fire-and-forget). The query path is therefore the CLI, and actions only open the UI.
- Profile and model discovery failing never blocks profile creation. Catalogs are cached
  with a 5-minute TTL.
- `claude` has no listing command, so its rows are derived from **models.dev** (the public
  catalog omp reads). Order: models.dev snapshot (24h TTL) → omp → curated aliases; all work offline.
- Refresh the snapshot with `herdr-loadout catalog --refresh`.

Measured evidence lives in [`docs/herdr-verified-facts.md`](../herdr-verified-facts.md),
and the plan is in [`docs/implementation-plan.md`](../implementation-plan.md).
