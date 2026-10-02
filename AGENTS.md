<!-- graft:start -->
## Graft — repo context graph

This repo is indexed in `graft/`: small linked markdown nodes that explain each
system and carry exact file:line spans, kept in sync with the code through git.

For ANY task here — understanding how something works, finding where code lives,
or scoping a change — get context from the graph before grepping or opening
source files. Re-ask freely (it's cheap) and reuse literal identifiers you
already have (symbol, error string, file name) as the query. New to this repo?
Run `graft map` first — a token-budgeted orientation (dir clusters, hubs,
hotspots), no LLM, no key.

- Run `graft ask "<your question>" --source` → ranked nodes with the relevant
  code spans inlined (each hit's ≤8-line crux by default; `--full` for whole
  definitions when the crux isn't enough). Match the tool to the task shape:
  for understanding or editing, the top node IS the answer — cite its
  `covers:` file:line spans and edit straight from `--source`. For
  exhaustive tasks ("every occurrence / every caller of this pattern"), ranked
  results are top-N, not complete — run `graft grep "<literal>"` instead
  (exhaustive over indexed files, grouped by enclosing symbol), falling back
  to raw `grep -rn` only for unindexed files.
- `graft skeleton <file>` → every definition's signature + span, ~10× cheaper
  than reading the file; use it to skim an API surface.
- `graft callers <symbol>` gives precomputed, exact edges — who calls this.
  Add `--direction out` for what it calls, or `--depth N` to walk
  transitively for the full blast radius. For structural questions, skip
  ranking and use this directly.
- Or browse: `graft/INDEX.md` lists every node; follow the links.
- Monorepos and folders of multiple repos rank fairly across sub-projects —
  hits carry `[scope/]` labels naming which one they're from. Narrow with
  `graft ask "<task>" --in <scope>/` once you know where you're working.

If a returned span is truncated ("+N more lines"), open the file at that exact
range before finalizing. Only open source files when a node genuinely lacks a
needed detail, and then at the exact file:line the node points to — never
re-read whole files.

After big code changes, refresh the graph with `graft build` (deterministic,
no API key, $0).
<!-- graft:end -->

## Testing in Herdr

- **Never test with Herdr zoom mode.** Do not run `herdr pane zoom`, and do not open a plugin pane
  with `--placement zoomed`. Zoom hides the other panes and changes the pane size, so it disturbs
  the user's layout and can leave the workspace zoomed after a failed run.
- Open test panes with `--placement split` (the default for `herdr pane split`) or `overlay`, read
  them with `herdr pane read <pane_id> --source visible`, and always `herdr pane close <pane_id>`
  afterwards.
- Close any worker pane you start (`herdr pane close`) once its result has been read.

## Privacy: nothing personal or machine-specific leaves this repo

This plugin is meant to be published, so no commit or push may carry the author's
identity or their machine's layout.

- Before every commit and every push, run `npm run check:privacy`. It scans for
  user-home paths, absolute drive paths, e-mail addresses, secrets, and the OS
  user name, home directory, checkout path and host name of the machine it runs on.
- The git hooks in `.githooks/` run the same check automatically. Enable them once
  per clone with `npm run setup:hooks`. Never bypass them with `--no-verify`.
- Write `C:\Users\<user>\...` or `~/...` in docs and examples, never a real path.
  Test fixtures under `test/` may use throwaway paths; a source line that truly
  needs a fake absolute path takes a `privacy-allow` marker.
- Do not add personal identifiers to any tracked file, including the guard itself.
  Extra terms to block (a real name, a handle) go in `.git/privacy-denylist`,
  which stays local.
- Do not repeat an unmasked user name, home path or e-mail address in commit
  messages, PR text or chat. Refer to them by role.
- Agent and editor tooling (`.claude/`, `.mcp.json`, `opencode.json`, ...) is gitignored
  on purpose. Do not `git add -f` it.
