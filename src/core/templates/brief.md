# Brief: {{slug}}

- Task: `{{task}}`
- Worker: `{{worker}}` (profile `{{profile}}`)
- Orchestrator: `{{orchestrator}}` ({{host_label}})
- Report: `{{report}}`

## Goal

<!-- What the task is for and why, in a few sentences. -->

## Scope

Do:

- <!-- the changes or findings this task covers -->

Do not:

- <!-- the neighbouring work that belongs to someone else -->

## Inputs

Read these before you start:

- <!-- files, docs, earlier reports -->

## Done when

- <!-- observable results: tests that pass, files that exist, questions answered -->

## Forbidden

- <!-- actions this worker must not take: commits, pushes, deleting files, delegating further -->

## Report

Write `{{report}}`, keeping its sections. Its last line is exactly one of:

- `{{task}}-COMPLETE`: everything under "Done when" holds.
- `{{task}}-PARTIAL`: you stopped with part of it done; say what is left.
- `{{task}}-BLOCKED`: you cannot go on without a decision or access; say what you need.
- `REVIEW-READY <n>`: only when this brief asks you to pause for QA or review round `<n>`.

Then tell the orchestrator with exactly this command, putting the marker you wrote in place of
`<MARKER>`:

```bash
{{notify}}
```

When you need a decision, write the question in the report first, then send the same command with
`QUESTION` in place of the marker. If the command fails, try it twice more about 30 seconds apart,
then stop: the report on disk is what counts.
