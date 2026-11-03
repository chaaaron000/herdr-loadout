# Delegation workflow

How work is handed to workers, watched, and wound down. The `herdr-loadout` skill carries the
commands; this file carries the choices. A project adds its own rules after these in
`.herdr/workflow.md`.

## Routing

- **Implementation** goes to a builder-class profile. **Research** goes to a scout-class profile;
  it must not edit files.
- **Independent review** uses a reviewer-class profile, and the reviewer must differ from the
  implementer in harness or model. A review by the same profile that wrote the code is not a review.
- **Difficult problems** — design work, bugs that resisted a first attempt — justify an expensive
  profile. Routine edits and lookups do not.
- **Trivial work stays local.** Delegation costs a pane, a startup wait, and context to read back;
  spend it where a second agent actually helps.
- When several profiles fit equally, take the cheapest.
- **Check a scout's key claims yourself.** Cheap research workers sometimes stop after a few
  minutes with a shallow answer.

## Briefs, prompts, and reports

- Put each task in a brief file and point the worker at it, so the worker can reread it after a
  compaction or restart.
- Every task prompt to a worker, follow-ups included, starts with `[Worker-<worker-name>]`, so the
  worker and the user can both see which worker a prompt is for:
  `[Worker-<worker-name>] Read <brief> and do it. Report in <report>.`
- The brief names a report file whose last line is a fixed marker: `<TASK>-COMPLETE`,
  `<TASK>-PARTIAL`, `<TASK>-BLOCKED`, or `REVIEW-READY <n>` for a worker that pauses for review.
- The task finished when the report was written after your prompt (its modification time is newer)
  and its last line is a completion marker. Anything else is a stop mid-task.

## Tabs

Give each kind of work its own tab instead of stacking every worker beside you.

- **Your tab holds only you.** The orchestrator keeps the full width of its tab; never open a
  worker there.
- **One tab per kind of work.** Name it with a short lowercase word (`backend`, `docs`, `sound`).
  The implementer, its reviewers, scouts, and advisors on the same work share that tab.
- **Idle workers stay in their own tab.** Do not keep a separate parking tab; a worker waiting for
  its next task stays where its work is, and a worker with nothing left is closed.
- **Helper panes go with their worker.** A pane a worker opens for itself (a progress monitor, a
  log tail) belongs in that worker's tab.
- **Workers that lead other workers** open and close panes only inside their own tab.
- **Inside a tab,** put workers on the same context side by side in one row rather than stacking
  them all vertically. Keep row heights equal, and widths equal within a row, and every pane at
  least 12 rows tall. Re-level the tab in the same turn you open or close a pane in it.

## Closing and keeping workers

- **No follow-up planned:** close the worker as soon as its answer is read.
- **Follow-up planned** (a review-and-fix loop, for example): compact its context right after
  reading its answer, so the next task starts small.
- A worker that stops at `REVIEW-READY <n>` is always kept: compact it as soon as you have read its
  report, before anything else.
- Do not replace or stop a worker only because its context is filling up; the harness compacts on
  its own.
- **A usage limit** usually shows a reset time in the harness's status line. Tell the user, wait
  until that time (as a background job), then prompt the same worker to continue. Do not start a
  fresh worker for it.
- **A profile swapped temporarily** (another model while one provider is out of quota, say): record
  the exact command that restores it next to the change, and restore it when the limit lifts.

## Coordinating workers

- **Peers on one task** agree on a contract file they both follow. When one needs a change, it
  edits the contract and tells the other with a short tagged prompt. For a structured discussion,
  keep the transcript in one file, append one turn at a time, and pass the turn with a prompt; cap
  the number of turns.
- **A lead worker with members** starts them as Herdr workers in its own tab rather than as its
  harness's built-in subagents, so the user can watch them. Keep it to a few members at once,
  write each member's brief to a file, and forbid members from delegating further.
- **Reviewers start fresh for every review**, re-reviews included. Give a re-reviewer only the
  previous review file and the implementer's account of the fixes, not the earlier conversation.
  Close a reviewer as soon as its review is read.
