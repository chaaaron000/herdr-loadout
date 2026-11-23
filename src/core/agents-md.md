<!-- herdr-loadout:start -->
## Delegation (herdr-loadout)

This project runs in Herdr, where work can be shared with Herdr workers that run on named agent
profiles.

- Before you start work that needs implementation, QA, code review, or repository exploration,
  load the `herdr-loadout` skill and read the workflow it shows. The workflow is the user's: it
  says what you do yourself, what goes to workers, and how. Follow it.
- What the user tells you in the conversation wins over the workflow.
- A prompt starting with `[Worker-<name>]` makes you a worker: do the task yourself and report as
  your brief says. Load the skill only when the brief makes you a lead.
- Outside Herdr (neither `HERDR_ENV=1` nor `HC_TERMINAL_ID` set), ignore this section.
<!-- herdr-loadout:end -->
