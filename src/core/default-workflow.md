# Delegation workflow

How work is handed to workers, watched, and wound down. The `herdr-loadout` skill carries the
commands; this file carries the choices. A project adds its own rules after these in
`.herdr/workflow.md`.

## Routing

- **Implementation** goes to a builder-class profile. **Research** goes to a scout-class profile;
  it must not edit files.
- **After substantial implementation, the next step is independent QA** by a qa-class profile that
  differs from the implementer in harness or model. QA by the profile that wrote the code is not
  QA. The QA worker:
  - writes its scenarios from the brief, the intent, before it reads the code;
  - runs them against the real CLI and the real host: in the TUI, an isolated
    `herdr --session <name> server`, never the user's session; in the app, temporary hc workers it
    closes afterwards;
  - turns every bug it finds into a regression test;
  - may add tests but does not change source: source fixes go back to the implementer;
  - **never stops or kills a process it did not start itself.** Host processes are off limits:
    `herdr-core` and its holder processes, `hc server`, and the user's `herdr` server. One holder
    carries every terminal in the app, so stopping it ends every agent the user has open. Host
    failures (a lost program, a restart) are reproduced with fixtures, or inside an isolated
    `herdr --session <name>` the QA worker created, and nowhere else.
- **Skills and workflow text are part of what QA covers.** Check them by having an agent follow
  them and watching what it does, not only by reading them.
- **Code review** by a reviewer-class profile is optional: use it for security-sensitive changes
  (shell quoting, secrets, permissions) or when the user asks. The reviewer, too, must differ from
  the implementer in harness or model.
- **Difficult problems** — design work, bugs that resisted a first attempt — justify an expensive
  profile. Routine edits and lookups do not.
- **Only trivial work stays local:** answering a question, reading files, or a few-line edit to one
  existing file (a typo, a value, a sentence). New code, any test change, or a change to more than
  one file goes to a worker, however small it looks. When unsure, delegate.
- When several profiles fit equally, take the cheapest.
- **Check a scout's key claims yourself.** Cheap research workers sometimes stop after a few
  minutes with a shallow answer.

## Task folders, prompts, and reports

- **One folder per task.** `herdr-loadout task new <slug> --worker <worker-name> --profile <id>`
  creates `.herdr/runs/<YYYY-MM-DD>-<slug>/` with `brief.md` and `report.md`, your address, and
  the command the worker reports with. Fill in the brief, then point the worker at it, so the
  worker can reread it after a compaction or restart. Everything else about the task (QA and
  review rounds, a contract, notes) goes in the same folder. `runs/` ignores itself in git.
- The task id is the slug in upper case (`api-auth` → `API-AUTH`). The report's last line is a
  fixed marker: `<TASK>-COMPLETE`, `<TASK>-PARTIAL`, `<TASK>-BLOCKED`, or `REVIEW-READY <n>` for a
  worker that pauses for QA or review round `<n>`.
- Start each worker with `command <id> --name <worker-name> --task <task folder>`, which records
  the worker's profile and launch in `workers.json` there; `worker-check` compares against it.
- Every task prompt to a worker, follow-ups included, starts with `[Worker-<worker-name>]`, so the
  worker and the user can both see which worker a prompt is for:
  `[Worker-<worker-name>] Read <brief> and do it. Report in <report>.` `task new` prints it.

## Knowing when a worker is done

- **The worker reports in.** After writing its report, the worker sends you one line with the
  command its brief gives: `[Report-<worker-name>] <MARKER> <report>`. It sends the same line for
  `PARTIAL` and `BLOCKED`, and with `QUESTION` in place of the marker when it needs a decision,
  after writing the question in the report.
- **Do not wait on a worker for completion, in any form.** Idle or done states do not mean the
  task finished, and a loop that sleeps and rereads the report file is a wait too. After the
  prompts and the failure watch are started, end your turn: go back to the user, or, as a lead
  worker with no user, just end it, never blocking on your harness's own wait for background
  jobs. The report line, or a return of the failure watch below, starts your next turn.
- **Watch only for a worker that stops without reporting.** In the app, keep one background
  `hc wait --children any` for all your workers: it returns when one of them ends a turn, blocks,
  errors, or exits, or when a message reaches you. Read its `reason` first: a `message` return
  lists no workers, so it never means they are gone; only a `children` return with no
  workers listed does, and then the watch stops. On every other return, start the watch again
  first, then check the reports. In the TUI, run one background
  `herdr agent wait <worker-name> --until blocked` per worker, which also ends with an error when
  the worker dies.
- **The report file is the truth; the line is only a signal.** On any signal (the report line or
  a return of the failure watch), read the report: the task finished when the report was written
  after your prompt (its modification time is newer) and its last line is a completion marker. A
  worker that stopped with no new report stopped without reporting; read its screen too. A signal
  for a report you already handled is a repeat; ignore it.
- **A worker whose report line fails** (you sat in a dialog, say) retries twice, then stops; its
  report is on disk, and the failure watch or your next look at the work finds it.
- **Known gap, TUI:** a worker stopped by a usage limit sits idle, and neither its report line nor
  the blocked wait fires. When you come back to the work, look at workers that have been quiet.

## Tabs

Give each kind of work its own tab instead of stacking every worker beside you.

- **The user's orchestrator keeps its tab to itself.** It keeps the full width of its tab; never
  open a worker there. A lead worker is different: its members share its tab (below).
- **One tab per kind of work.** Name it with a short lowercase word (`backend`, `docs`, `sound`).
  The implementer, its QA workers and reviewers, scouts, and advisors on the same work share that
  tab.
- **Idle workers stay in their own tab.** Do not keep a separate parking tab; a worker waiting for
  the next step of its task stays where its work is, and a worker with nothing left is closed.
- **Helper panes go with their worker.** A pane a worker opens for itself (a progress monitor, a
  log tail) belongs in that worker's tab.
- **Workers that lead other workers** keep their members in their own tab and open and close
  panes only there, never in a new tab: in the app they pass `--tab self` to `command`; in the
  TUI they split their own pane.
- **Inside a tab,** put workers on the same context side by side in one row rather than stacking
  them all vertically. Keep row heights equal, and widths equal within a row, and every pane at
  least 12 rows tall. Re-level the tab in the same turn you open or close a pane in it.

## Closing and keeping workers

- **A worker belongs to one task folder.** Reuse it only for that task's next step: fixes after
  its QA or review round, continuing after `REVIEW-READY <n>` or a usage limit, a follow-up to its
  own question. A new task gets a fresh worker, even when an idle one of the right profile is open.
- **The same task moving to another profile** (the implementer's work now goes to QA, a cheap
  profile that failed is escalated) also gets a fresh worker.
- **No next step for this task:** close the worker as soon as its answer is read.
- **A next step planned for the same task** (a QA-and-fix loop, for example): compact its
  context right after reading its answer, so the next step starts small. Never send a prompt
  while it is still compacting.
- A worker that stops at `REVIEW-READY <n>` is always kept: compact it as soon as you have read its
  report, before anything else.
- **Check a kept worker before every prompt.** `herdr-loadout worker-check <worker-name>` compares
  the running worker with its profile as it is now. When it fails (the profile was edited, it runs
  another profile, it lost its launch arguments in a restart, it fell back to a shell), close the
  worker and launch a fresh one from `command`. Never switch a running worker to other settings
  in place (`/model`, `/effort`, and the like). When the check cannot see the worker
  (`host-unavailable`, `process-unknown`), nothing is known about it: do not treat it as gone and
  do not prompt it; fix the cause and check again.
- Do not replace or stop a worker only because its context is filling up; the harness compacts on
  its own.
- **A usage limit** usually shows a reset time in the harness's status line. Tell the user, wait
  until that time (as a background job), then prompt the same worker to continue. Do not start a
  fresh worker for it.
- **A profile swapped temporarily** (another model while one provider is out of quota, say): record
  the exact command that restores it next to the change, and restore it when the limit lifts.
  Workers started before either change fail `worker-check`; replace them.

## Coordinating workers

- **Peers on one task** agree on a contract, `contract.md` in the task folder, that they both
  follow. When one needs a change, it edits the contract and tells the other with a short tagged
  prompt. For a structured discussion, keep the transcript in one file in the task folder, append
  one turn at a time, and pass the turn with a prompt; cap the number of turns.
- **A lead worker with members** starts them as Herdr workers in its own tab rather than as its
  harness's built-in subagents, so the user can watch them. Keep it to a few members at once, give
  each member its own task folder (`task new` run by the lead fills in the lead's own address), and
  forbid members from delegating further. Members report to the lead, not to you.
- **QA workers start fresh for every round,** re-tests included. QA round `<n>` is written to
  `qa-<n>.md` in the task folder: the scenarios, how each ran, the bugs found, and the regression
  tests added. Give the next round only the previous `qa-<n>.md` and the implementer's account of
  the fixes, not the earlier conversation. Close a QA worker as soon as its round is read.
- **Reviewers, when used, follow the same rule:** a fresh reviewer per round, round `<n>` in
  `review-<n>.md`, closed as soon as its review is read.
