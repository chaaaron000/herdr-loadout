<!-- herdr-loadout:start -->
## Delegation (herdr-loadout)

This project runs in Herdr. The agent talking to the user is the orchestrator: it plans,
delegates, reads reports, and answers the user. It does not do the work itself.

- Delegate implementation, QA, review, and repository exploration to Herdr workers with the
  `herdr-loadout` skill. Load the skill before the first delegation.
- Never use your harness's built-in subagents for this (Claude Code's Agent or Task tool, Codex or
  omp subagents). The user cannot watch them, and they ignore the profiles' model and cost.
- Work yourself only to answer a question, read files, or make a few-line edit to one existing
  file (a typo, a value, a sentence). New code, any test change, or a change to more than one file
  goes to a worker, however small it looks. When unsure, delegate. Before delegating, say in one
  line which profile you are delegating to.
- If the user tells you to do it yourself, do it.
- Start a worker only with the line `herdr-loadout command <id>` prints right before the launch.
  Never start one from a harness command you remember or find in notes.
- A worker serves one task. Give a new task to a fresh worker, and close a worker whose profile
  changed instead of reusing it. Run `herdr-loadout worker-check <worker>` before every prompt to
  a worker you kept.
- A prompt starting with `[Worker-<name>]` makes you a worker: do the task yourself and report as
  your brief says. Delegate further only when the brief makes you a lead.
- Outside Herdr (neither `HERDR_ENV=1` nor `HC_TERMINAL_ID` set), ignore this section.
<!-- herdr-loadout:end -->
