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
- Herdr ≥ 0.7.0 (TUI). The CLI and skills also work in the Herdr desktop app (herdr-core `hc`) — see [Using it in the Herdr app](#using-it-in-the-herdr-app)
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

In the Herdr app, use the app-only editor (an app mod). Install it once from a source checkout:

```bash
npm run install:app-mod                         # installs to ~/.config/herdr-app/mods/herdr-loadout
npm run install:app-mod -- --key ctrl-shift-a   # also registers a keybinding (refused if the key is already in use)
herdr-app do mod.open --name herdr-loadout      # open without a keybinding
```

- It shows global/project profiles for the project of the focused terminal, with the same keys and actions as the TUI
  (`Enter` edit, `a` add, `c` copy, `d` delete, `r` clear override, `[`/`]` reorder, `j` harness list, `k` API keys, `g`/`p` save while editing, `t` run check, `Esc` back/close). You can also click with the mouse.
- Every read and write goes through `herdr-loadout editor <action>` (the CLI's JSON backend), so the rules are the same as the TUI.
- App mods cannot use Node, so the install script writes the paths to node and the CLI into `cli.js`. Reinstall if you move the checkout.
- The app's command palette (Ctrl+Shift+P) does not accept mod entries, so open it with the keybinding or `mod.open`.

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
| `[` `]` | Move the selected profile up/down within its group (the selection follows it) |
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
herdr-loadout command builder --name w1 --pane 3   # print the worker start command with the profile's current values
herdr-loadout task new api-auth --worker builder-auth --profile builder   # create brief.md and report.md in .herdr/runs/<date>-api-auth/
herdr-loadout worker-check builder-auth   # does a running worker still match its profile? (exit 1 if not)
herdr-loadout agents-md             # the delegation block in this project's AGENTS.md (current | missing | outdated | declined)
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
builder | expensive | implementation/refactor/design
junior | normal | implementation/light
qa | normal | qa/testing
reviewer | cheap | review/security
scout | cheap | research
```

### 3. Config files

| File | Purpose |
|---|---|
| `<HERDR_PLUGIN_CONFIG_DIR>/loadout.toml` | Global profiles |
| `<project>/.herdr/loadout.toml` | Project overrides (only the listed fields are replaced) |

Run `herdr-loadout path` to see the real locations. You can also edit the files by hand. A save
(`set`, `add`, `remove`, `reset`, `import`, the editors) changes only the keys and blocks it was
asked to change, so comments, unknown keys, other tables, blank lines and line endings stay as they
are. A file it cannot edit that way (profiles written as an inline array, for example) is refused
and nothing is written.

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

### 4. The delegation block in the project's AGENTS.md

A skill loads only once an agent has decided to use it. So the pointer "before implementation, QA,
review, or exploration, load the skill and follow the user's workflow" has to live in the file
every harness reads at startup. The block is neutral: what the agent does itself and what it hands
to workers is the workflow's call (see "Workflow" below). The block has one source,
`src/core/agents-md.md`, which the CLI prints and installs as is.

```bash
herdr-loadout agents-md            # state: current | missing | outdated | declined (--json too)
herdr-loadout agents-md print      # the block itself
herdr-loadout agents-md install    # write or update it in AGENTS.md, plus any @AGENTS.md import needed
herdr-loadout agents-md decline    # never ask again in this project
```

- The `herdr-loadout` skill checks the state once per session. On `missing` or `outdated` it shows
  the user the block and asks once: yes runs `install`, no runs `decline`. It never writes without
  asking, and a worker started with a `[Worker-...]` prompt skips the step.
- `install` writes only between the `<!-- herdr-loadout:start -->` and `<!-- herdr-loadout:end -->`
  lines. It creates a missing file, appends the block to a file without markers, and replaces only
  the marked lines otherwise. Running it again changes nothing. With broken markers it fails and
  leaves every file alone.
- A decline is kept outside the repo, in `agents-md-declined.json` in the plugin state dir, keyed by
  project root. `install` drops it.
- The project root is `--project`, else the nearest folder up the tree holding `.git` or `.herdr`.

Each harness reads different files at the project root. Verified against their docs, and for all but
pi by running each harness in a temporary project and asking what its instruction files say (pi:
against its source).

| harness | reads | what `install` does |
|---|---|---|
| claude | `CLAUDE.md`, `.claude/CLAUDE.md`, `CLAUDE.local.md` when any exists, else `AGENTS.md` (v2.1.277 and later) | imports `@AGENTS.md` from that file (`@../AGENTS.md` from `.claude/CLAUDE.md`) |
| omp | one file per folder: `.omp/AGENTS.md` > `.claude/CLAUDE.md` > `.agent(s)/AGENTS.md` > `.gemini/GEMINI.md` > `.github/copilot-instructions.md` > `AGENTS.md` > `CLAUDE.md` | imports from a file that outranks `AGENTS.md` |
| codex | `AGENTS.override.md`, else `AGENTS.md` | only a `note:` for `AGENTS.override.md` (codex expands no imports) |
| opencode | `AGENTS.md` (`CLAUDE.md` only when there is none) | nothing |
| agy | both `AGENTS.md` and `GEMINI.md` | nothing |
| pi | `AGENTS.override.md` > `AGENTS.md` > `CLAUDE.md` | as for codex |

When Claude Code reads only `CLAUDE.md` (an older version, or Project instructions set to
`claude-md`), `install --claude-md` creates a `CLAUDE.md` that imports `AGENTS.md`. With
`claude-md` set in `~/.claude/settings.json` it does so without the flag.

Swapping models or harnesses only touches profiles. The block in AGENTS.md stays unchanged.

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

# Change the list order (within a group: global among global, project among project)
herdr-loadout move scout --up
herdr-loadout move scout --down
herdr-loadout move scout --before builder
herdr-loadout move scout --after builder

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

`move` does not follow the global/`--project` split: a global profile (overridden or not) is reordered in the global file, a project-only profile in the project file, and where an override sits never changes the order. `--project` only names the project; the profile decides which file is written.

`move` moves only the `[[profiles]]` blocks as text, so comments, other tables and line endings stay as they are. A file it cannot reorder that way (profiles written as an inline array, for example) is refused and nothing is written.
`move --json` prints `{ok, id, scope, index, moved, path, order, message}`. `index` is the profile's new place in the list (from 0) and `order` is the group's new order. When nothing changes because the profile is already there, `moved` is `false`, `path` is `null`, and there is no `order`.
Exit codes: `0` also when nothing changes; `1` for an unknown id, a move relative to another group or to itself, or a file that cannot be reordered as blocks (the file is unchanged); `2` when no position flag or more than one is given.

`list` splits the output into **Global profiles** and **Project profiles** like the TUI, and an overridden profile shows `Overridden: effort (global: medium)`. `differs` in `list --json` carries the same information. `list --compact` is unchanged.
`--json` prints a machine-readable result (`{ok, id, scope, path, created}`; `move` uses the shape above).
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
| `herdr-loadout` | Delegate work to a worker through a profile (project setup → read the workflow → look up → run the `herdr agent start` or `hc run` that `command` prints) |
| `herdr-loadout-edit` | Add, change, remove, or import profiles and the workflow |

`command <id>` prints the host command that starts a worker, using the profile's values at that moment, so agents do not
retype an old model or effort from memory. It takes `--host herdr|hc`, `--name`, `--pane` (TUI),
`--space`/`--tab` (app), and `--cwd` (default: current directory); values not given print as placeholders such as `<pane_id>`.
In the app, `--tab self` uses the tab that shows you, found in `herdr-app ls`, and that tab's space when `--space` is not given.
A worker that leads other workers uses it to keep its members in its own tab, since a worker the app put in a new tab has no `herdr.tab` label.
`--shell powershell` quotes for PowerShell; the default quotes for sh (bash, Git Bash, zsh).
Lines starting with `#` are notes. In the TUI, when the profile has `env`, it prints the `--env` flags to pass when opening the pane as a note.

`launch <id> --json` returns the same values as `ok`, `harness`, `args`, `env`, and `argv`.

`env` values may be API keys, so they are masked as `***` in the output of `list`, `show`, `launch`, and `command`, and in both editors (TUI and app).
In the editors' Env field, leaving `KEY=***` as it is keeps the existing value; typing a new value replaces it.
The TUI `--env` flags that `command` prints take the form `"KEY=$(… env-value <id> KEY)"`, so the shell reads the value when it runs them.
The real value only comes out of `herdr-loadout env-value <id> <KEY>`. In the app (`hc`), `exec` sets the value directly.

### Workflow

The skills hold only the commands; the choices made when delegating live in the workflow file: which profile family gets which kind of work,
the prompt, brief, and report file formats, how to use tabs, when to close a worker and when to keep it, and how workers collaborate.
Like profiles, it has two layers.

The default shares the work: the agent talking to the user works too, and hands workers what can run
in parallel, independent QA, research, and tasks another profile suits better. To make that agent an
orchestrator that only plans and delegates, write that rule into the workflow (the
`herdr-loadout-edit` skill has an example). What the user says in the conversation wins over the workflow.

| Layer | File | Purpose |
|---|---|---|
| Global | `<config dir>/workflow.md` (built-in default if absent) | Shared by every project |
| Project | `<project>/.herdr/workflow.md` | Rules for this project only. Appended after the global file; where they conflict, this one wins |

```bash
herdr-loadout workflow                      # workflow that applies to this project (the skill reads it before delegating)
herdr-loadout workflow init --project .     # create the project rules file (write only what differs)
herdr-loadout workflow init                 # copy the built-in default to the global file to edit it
```

Once you create the global file it is your file, so later changes to the built-in default are not picked up.
`globalWorkflow` and `projectWorkflow` in `herdr-loadout path` are the two file locations.

### Task folders and reports

Each delegated task gets one folder, `.herdr/runs/<YYYY-MM-DD>-<slug>/`. `task new` creates `brief.md` and `report.md` in it
and fills in the orchestrator address (app: `$HC_TERMINAL_ID`, TUI: `$HERDR_PANE_ID`, override with `--to`) and the command
the worker reports with. When it creates `runs/`, it also writes `runs/.gitignore` (`*`), so task files stay out of git even
in projects that commit `.herdr/`. It refuses a folder that already exists.

```bash
herdr-loadout task new api-auth --worker builder-auth --profile builder   # the last line is the prompt to send the worker
herdr-loadout command builder --host hc --name builder-auth --task .herdr/runs/2026-11-21-api-auth --space <space_id>
herdr-loadout worker-check builder-auth                                      # before prompting a worker you kept
```

- The task id is the slug in upper case (`api-auth` → `API-AUTH`). The report's last line is one of `API-AUTH-COMPLETE`,
  `API-AUTH-PARTIAL`, `API-AUTH-BLOCKED`, or `REVIEW-READY <n>`.
- The worker sends the completion signal: after writing its report it sends the orchestrator one line,
  `[Report-<worker>] <MARKER> <report>` (app: `hc send`, TUI: `herdr agent prompt`). The report file is the truth; the line
  is only a signal.
- The orchestrator never polls for completion. In the app it keeps one background `hc wait --children any` to notice a
  worker that stopped without reporting; in the TUI, one `herdr agent wait <worker> --until blocked` per worker. The app
  watch reads `reason` first: a `message` return has an empty `children` list that says nothing about the workers, and the
  watch stops only on a `children` return that lists no workers.
- After substantial implementation, the next step is independent QA. A `qa` profile that differs from the implementer in
  harness or model writes scenarios from the brief before reading the code and runs them against the real CLI and host (TUI:
  an isolated `herdr --session <name> server`; app: temporary hc workers it closes). Every bug it finds becomes a regression
  test, and each round is a fresh QA worker writing `qa-<n>.md`. Source fixes go back to the implementer. Code review
  (`review-<n>.md`) is for security-sensitive changes (shell quoting, secrets, permissions) or when the user asks.
- Templates: `<project>/.herdr/templates/brief.md` and `report.md` when present, else the built-in ones
  (`src/core/templates/`). `{{key}}` placeholders such as `{{task}}`, `{{worker}}`, and `{{notify}}` are filled in; an
  unknown key is left as written.
- `command --task <folder>` records the worker's profile and a launch fingerprint (harness, arguments, env names; never
  values) in that folder's `workers.json`. In the app (`--host hc`) it also adds both as `hc run` labels. `worker-check`
  compares that record with the profile as it is now and with the live worker, and exits 1 with the reason when the profile
  was edited, the worker runs another profile, it fell back to a shell, or a TUI worker lost its launch arguments in a restart.
  When it cannot ask the host (CLI missing, server not running) it exits 1 with `host-unavailable`: nothing is known about
  the worker, so check again rather than relaunch.

### Using it in the Herdr app

The skills treat `HERDR_ENV=1` as the TUI (`herdr`) and the presence of `HC_TERMINAL_ID` as the app (`hc`, `herdr-app`),
and use the matching CLI. In the app, use `launch <id> --json --host hc`.

- `argv` is the full worker command: `hc run --bg --name <name> --cwd <dir> --label herdr.space=<space> -- <argv...>`.
- `hc run` cannot pass environment variables, so for a profile with `env` the `argv` goes through
  `herdr-loadout exec <id>`. `exec` applies the env, starts the harness, and returns its exit code unchanged.
  An argument containing a double quote (such as agy's `--settings` JSON) takes the same route, because Windows PowerShell 5.1
  strips double quotes from arguments it passes to native commands.
- Codex needs `--no-daemon` under `hc`, so it is added automatically with `--host hc`.
- The app has no plugin actions. If the launcher is missing, create it from a source checkout with `node scripts/setup-shim.mjs`.

Skill files are copied into a skills library, so their line endings are pinned to LF (`.gitattributes`).

## Profile fields

Required: `id`, `name`, `harness`, `model`, `effort`, `when_to_use`
Optional: `avoid_when`, `cost` (cheap|normal|expensive), `provider`, `mode`, `extra_args`, `env`, `tags`, `skills`, `notes`, `sandbox`, `approval_policy`, `permission_mode`, `api`, `auth`

`api` makes a harness run on a stored API key instead of its own sign-in. The value is a stored key's id;
empty means the harness's own sign-in (subscription). Supported pairs:

| Harness | Provider | Route |
|---|---|---|
| claude | DeepSeek | DeepSeek's Anthropic-compatible endpoint (`https://api.deepseek.com/anthropic`) |
| agy | Google AI Studio | the Gemini API |

Codex accepts only the Responses API (0.170 rejects `wire_api = "chat"`). DeepSeek and Google do not serve the
Responses API, so their keys cannot drive Codex.

Keys live apart from profiles, in `keys.toml` beside the global config. They never go into a project file, so
they cannot be committed with a repository, and every output shows only the last four characters (`sk-…1a2b`).

```bash
herdr-loadout keys add deepseek --provider deepseek   # the key is read from stdin (hidden input at a terminal)
herdr-loadout keys list                               # stored keys (masked) and providers
herdr-loadout keys test deepseek                      # ask the provider whether the key works
herdr-loadout set <id> --api deepseek                 # the profile runs on that key
```

In the app editor, `k` (the API keys page) adds, tests and deletes keys, and a claude or agy profile picks one in
its API field. Picking a key switches the model list to that provider's (DeepSeek `/models`, the Gemini API).

What a launch sets:

- claude + DeepSeek: `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN=<key>`, `ANTHROPIC_MODEL`, `ANTHROPIC_DEFAULT_OPUS_MODEL` and
  `ANTHROPIC_DEFAULT_SONNET_MODEL` = `<model>[1m]`, `ANTHROPIC_DEFAULT_HAIKU_MODEL=deepseek-flash`,
  `CLAUDE_CODE_AUTO_COMPACT_WINDOW`, and an empty `ANTHROPIC_API_KEY` so an inherited one is not sent. `--model` is also
  `<model>[1m]` (the 1M-context marker, which Claude Code strips before the request). These follow DeepSeek's Claude Code guide.
- agy + Google: `GEMINI_API_KEY=<key>` and `--settings <state dir>/agy-api/…/settings.json` (`{"modelProvider":"gemini"}`).
- A name the profile's `env` also sets keeps the profile's value. A missing key, or one that cannot drive the harness, fails
  `launch`'s `API key` check.

agy's `auth = "api-key"` still works; it reads the key from the profile's `env.GEMINI_API_KEY` or the worker's
`GEMINI_API_KEY`. agy's built-in list of API models is fixed when agy is built, so newer models are missing from it.
Each time the list is read, the Gemini API's model list is looked up with a key (the environment's `GEMINI_API_KEY`,
a profile's key, then a stored Google key), and the Gemini models agy lacks are registered as custom models under
`customModelsConfig` in the same settings file. New models then appear in the editors' model list and work with
`--model` right away. A failed lookup keeps the models found last time.

`harness` is one of `claude`, `codex`, `opencode`, `omp`, `pi`, `agy` (Antigravity CLI), or `custom`.
Any other value is rejected by validation unless it is `custom`.

## Harness argument mapping

| harness | model | effort | Notes |
|---|---|---|---|
| `claude` | `--model` | `--effort` | No listing command, so its rows are **derived from omp's Anthropic catalog**; falls back to the aliases (opus/sonnet/haiku/fable) without omp |
| `codex` | `-m` | `-c model_reasoning_effort=<lvl>` | Catalog from `codex debug models` |
| `opencode` | v1: `-m` · v2: config `model` | v2: `#variant` on the config `model` (not carried on v1) | Catalog from `opencode models`. Arguments follow the installed version (`opencode --version`). The v2 TUI has no `-m`, so model, effort and permissions go through `OPENCODE_CONFIG_CONTENT`, with `--standalone` so the worker's own server reads it (the shared background service ignores the worker's env) |
| `omp` | `--model=` | `--thinking=` | Catalog from `omp models --json` (includes thinking levels) |
| `agy` | `--model` | `--effort` | Antigravity CLI. Catalog from `agy models`; same id as Herdr's `--kind agy`. When the id ends in a level (`-low`, `-medium`, `-high`, …, e.g. `gemini-3.8-flash-medium`), the effort is that level and no `--effort` is passed. The editors list such ids as one model (`gemini-3.8-flash`) and take the level from Effort; the profile still stores the full id |
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
