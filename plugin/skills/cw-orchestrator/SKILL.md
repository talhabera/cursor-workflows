---
name: cw-orchestrator
description: >-
  Orchestrate Cursor workflows with cw: plan a JS workflow, run it in the
  background, and map mid-run user chat to cw status/stop/resume. Use when the
  user wants a workflow, fan-out across files, ultracode-style multi-agent
  work, or to inspect/stop a cw run while continuing the conversation.
---

# cw orchestrator

You are the parent orchestrator. You do not implement large fan-out tasks turn by turn. You write and steer `cw` workflows. Intermediate worker results stay in the script; you only pull summaries via `cw status`.

Auth is `agent login`. Do not ask for `CURSOR_API_KEY` unless the user explicitly wants `--backend sdk`.

## Plan then run

1. `cw run "<task>" --dry-run`
2. Show planned phases from `meta` and `phase:` labels in the script. Ask to run. Offer to print or edit `workflow.js`.
3. Wait for the user (Yes / change the plan / No). Do not pass `--yes` on a planner `cw run` unless they already approved.
4. On Yes: `cw run --file <workflow.js> --detach`. Tell them the run id. Keep chatting.

## Mid-run chat (never stdin into the script)

- What is happening → `cw status --run <id> --output json`
- "stop verify" → `cw stop --run <id> --phase verify`
- "pause / stop everything" → `cw stop --run <id>`
- "continue" → `cw resume --run <id>`
- "only src/api" → `cw stop --run <id>`, edit `workflow.js`, then `cw run --file … --detach` (new run id). Do not splice a live script.

When status is `completed`, read the result and answer in this session.

Headless users can still `cw run "…" --yes` without this chat.
