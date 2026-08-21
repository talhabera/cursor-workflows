# Orchestrator phase watch for `cw` chat

When a user starts Cursor Agent via `cw` / `cw chat`, that session is the parent orchestrator: it plans a workflow, detaches the runtime, and maps mid-run chat to `cw status` / `stop` / `resume`. After detach it currently goes idle. It never inspects the run unless the user asks. Phase completions are silent.

This spec adds **event-driven phase summaries** into that chat, with a **5-minute heartbeat** only when a phase is still in flight. The wake-up mechanism is a bundled Cursor `stop` hook. The wait/detect mechanism is a new `cw watch` command. It is not a skill instruction to `sleep 300`.

## Background

The 2026-08-18 ultracode orchestrator spec already split the system into two processes:

```
user ──chat──► orchestrator (`agent` + cw plugin skill)
                    │
                    │  cw run --dry-run / --file --detach
                    │  cw status | stop | resume
                    ▼
              runtime (`cw` child, journal + workers)
```

`plugin/skills/cw-orchestrator/SKILL.md` tells the model to call `cw status` when the user asks what is happening, and to summarize when status is `completed`. That only runs on a user (or model) turn. After “run started, id is …”, the agent loop ends. Cursor does not spin the model again until the next user message.

Workflows already emit `events.ndjson` (`agent_start`, `agent_end`, `status`, `warning`, `result`) and persist a journal. There is no `phase_end` event and no waiter. Phases are labels on `agent()` calls, not explicit script barriers.

Cursor Agent hooks can auto-submit a `followup_message` from a `stop` hook when the agent loop ends. Plugins can ship hooks. `cw chat` already passes `--plugin-dir` at the bundled plugin.

## Goals

1. In a `cw` / `cw chat` session, after a workflow is detached, the orchestrator writes a **phase summary to the user when a phase finishes**, without the user having to ask.
2. If a phase is still running, the orchestrator checks in about **every 5 minutes** with a short in-progress snapshot (heartbeat).
3. Wake-up is **event-driven**. The 5-minute interval is a wait timeout, not a busy poll and not an LLM `sleep`.
4. The user can still chat mid-run (stop a phase, change scope, ask a question). Watch must not require the model to hold a 5-minute tool call open as the only way to notice progress.
5. Headless `cw run` (foreground or `--detach` without `cw chat`) stays unchanged: no hook, no extra process, no chat.

## Non-goals

- MCP server. The control plane stays the `cw` CLI. `cw watch` is the tool; the hook is the idle wake-up. Revisit MCP only if CLI+hook cannot load in `agent`.
- Injecting into an in-flight worker (`agent -p`) chat.
- Per-agent live transcripts in the orchestrator. Summaries stay at **phase** granularity (plus a compact heartbeat).
- Desktop notifications, toasts, or a second TTY pane.
- Changing planner output, sandbox primitives, or approval (`--dry-run` then Yes).
- Making `cw status` itself block or auto-print into chat.
- Multi-orchestrator coordination (two `cw chat` sessions on the same run). Duplicate summaries are acceptable.

## Approaches considered

### A. Skill-only “check every 5 minutes”

Tell `cw-orchestrator` to `sleep 300` then `cw status` in a loop.

Rejected. After the model replies, the agent loop **stops**. Skill text is not a timer. If the model keeps a shell `sleep` open, the turn stays busy, the user cannot talk cleanly, and phase ends wait until the sleep finishes. This is the failure mode we have today, plus token waste.

### B. Blocking MCP / `cw watch` tool as the only waiter

Add a long-running tool. After detach the model calls `watch` (timeout 300s), summarizes, calls `watch` again.

Weaker as the sole mechanism. It is the right **wait primitive**, but the model can forget to call it again after a user question, and a 5-minute in-turn tool call holds the loop busy. Keep `cw watch` as the primitive; do not rely on the model to remember it.

### C. Plugin `stop` hook + `cw watch` (recommended)

When the orchestrator turn ends, a bundled `stop` hook runs. If this workspace has an unread workflow event (phase completed, run terminal, or wait timeout while still running), the hook blocks in `cw watch` until that happens, then returns `followup_message`. Cursor submits that as the next user message. The skill turns it into a user-visible phase summary or heartbeat. If nothing is running and nothing is unread, the hook prints `{}` and the session stays idle.

This is the only Cursor-supported way to resume an idle agent from an external process event. The wait happens **after** the turn ends, so the user can type during a long phase. `loop_limit` is raised so a long run is not cut off after five auto-follow-ups.

## Architecture

Three pieces, one control plane.

```
user ──chat──► orchestrator (`agent` + skill + plugin stop hook)
                    │
                    │  cw run --file --detach
                    │  cw watch / status / stop / resume
                    ▼
              runtime (events.ndjson + journal + run.json)
```

- **Runtime** (existing): keeps writing events and journal. This spec adds a derived **phase-end** signal inside `cw watch`, not a new runtime event type in v1 (watch reconstructs phases from the existing stream). Optional later: emit `phase_end` from the runtime for cheaper waiters. Not required if watch is correct.
- **`cw watch`**: blocking CLI. Tails one run until the next notify-worthy event or `--timeout` (default 300s). Prints a structured snapshot. Persists a consume cursor so the same phase is not announced twice.
- **Stop hook** (bundled plugin): on orchestrator `stop`, fail-open. If there is work to announce, it execs `cw watch` and returns `followup_message`. `loop_limit` is 80 (heartbeats every 5 minutes for several hours, plus phase follow-ups).
- **Skill**: on a `[cw-watch]` follow-up, write the phase/heartbeat/final summary to the user. Do not `sleep`. Do not start new fan-out work unless the user asked.

## Phase completion (definition)

Phases are labels, not AST blocks. A sequential pair of `await agent(..., { phase: "audit" })` goes to **zero in-flight audit agents** between calls. Treating “running count hit 0” as phase end would fire a false summary between them.

**A phase P completes when all of these are true:**

1. At least one `agent_start` with phase P has been seen.
2. Zero agents with phase P are currently running (`agent_start` without a matching `agent_end` / cancel).
3. A **later** event is either:
   - `agent_start` with phase Q where Q ≠ P, or
   - run status `completed` | `failed` | `stopped`.

Unlabeled calls (`phase` omitted) use the synthetic name `(unlabeled)` so they still group.

Phase reuse (audit → verify → audit) is two completions of `audit`, which is correct.

Watch does not guess future phases from `workflow.js`. “Next phase” in a summary is only known once the next `agent_start` exists.

## Components

### 1. `cw watch`

```text
cw watch [--run <id>] [--timeout 300] [--output text|json]
```

Default run is the same as `cw status` (latest). `--timeout` is seconds; `0` means wait until phase-end or terminal with no heartbeat. Default `300`.

Exit 0 on every successful wait, including timeout and terminal. Exit 1 only for CLI errors (no runs, bad flags).

JSON shape:

```json
{
  "reason": "phase_end" | "heartbeat" | "terminal" | "stale",
  "run": { "...RunRecord..." },
  "phase": "audit",
  "summary": {
    "phase": "audit",
    "ok": 10,
    "failed": 2,
    "cancelled": 0,
    "tokens": 12345,
    "labels": ["src/a.ts", "src/b.ts"],
    "inFlight": [{ "phase": "verify", "label": "src/c.ts" }]
  },
  "resultPreview": null
}
```

| `reason` | When |
| --- | --- |
| `phase_end` | Definition above; cursor advances past that completion. |
| `heartbeat` | Timeout elapsed, run still `pending`/`running`, no new phase_end. Cursor does **not** skip unread phase_ends. |
| `terminal` | Run `completed` / `failed` / `stopped`. Include `resultPreview` from `result.json` when present (truncated). Cursor advances so a later watch is idle. |
| `stale` | `run.json` says `running`/`pending` but `pid` is missing or `kill(pid, 0)` fails. Treat like a failed terminal for notify purposes. |

Text mode is a short human block (reason, phase counts, in-flight labels). Hook and skill prefer JSON.

Implementation: read `events.ndjson` from offset 0 into the phase machine each wait (runs are small). After the current file is parsed, if anything is unconsumed, return **immediately** in this order: next unconsumed `phase_end`, then `stale`, then `terminal`. One reason per `cw watch` invocation so each chat turn covers one event. If the last phase completes in the same tick as the run, the first watch returns that `phase_end` and the next watch (hook’s next `stop`) returns `terminal` without waiting.

Otherwise `fs.watch` / poll the events file and `run.json` until timeout (poll interval 200ms, same order as execute’s cancel poll).

**Consume cursor** lives at `.cursor-workflows/runs/<id>/watch-cursor.json`:

```json
{ "phaseEnds": ["audit"], "terminal": false }
```

`phaseEnds` is the ordered list of completed phase names already announced (repeat names allowed, counted in order). A new `phase_end` for `verify` appends `"verify"`. Heartbeat does not write this file and does not skip unread phase ends.

`cw status` never reads or writes this file.

Idempotency: two overlapping `cw watch` processes on the same run may race the cursor. Accept last-write-wins. The hook is the normal single waiter.

### 2. Bundled `stop` hook

Ship with the existing plugin:

```
plugin/
  .cursor-plugin/plugin.json    # hooks: ./hooks/hooks.json
  hooks/hooks.json
  hooks/orchestrator-stop.js
  skills/cw-orchestrator/SKILL.md
```

`hooks.json`:

```json
{
  "version": 1,
  "hooks": {
    "stop": [
      {
        "command": "node ./hooks/orchestrator-stop.js",
        "timeout": 330,
        "loop_limit": 80
      }
    ]
  }
}
```

Hook script rules:

1. Read stdin JSON. If `status` is `aborted`, print `{}` (user interrupted; do not fight them).
2. Resolve workspace: first `workspace_roots[0]`, else `cwd`.
3. Find the watch target: latest run that is `pending`/`planning`/`running`, **or** a run with an unconsumed `phase_end`/`terminal`/`stale`. If none, print `{}`.
4. Exec `cw watch --run <id> --timeout 300 --output json` using the same Node entry as this package (`dist/cli.js` next to the plugin, not whatever `cw` is on PATH). Inherit no TTY. On hook/watch failure, print `{}` (fail open).
5. Print one JSON object to stdout:

```json
{
  "followup_message": "[cw-watch] reason=phase_end run=cw_k1_ab12\n<json snapshot>\nSummarize this to the user. Do not start new fan-out work unless they asked. Do not sleep."
}
```

The `[cw-watch]` prefix is the skill matcher. The snapshot is the watch JSON so the model does not need a second `cw status` unless it wants more detail.

Do not follow up when watch would have been a no-op (no run). After `terminal`/`stale` is consumed, the next `stop` prints `{}`.

Cursor enforces `loop_limit: 80`. When stdin `loop_count` is 79 and a run is still active, the follow-up includes that this is the last automatic check and the user can say “keep watching”. Do not depend on a 81st call.

### 3. Skill (`cw-orchestrator`)

Add a **Watch** section. Keep plan-then-run and mid-run command mapping.

Must teach:

1. After `--detach`, expect automatic `[cw-watch]` messages. Do not `sleep`, do not busy-loop `cw status`, do not hold a 5-minute shell wait.
2. On `[cw-watch]`:
   - `phase_end` → a short **phase summary** in the assistant reply (what the phase did, ok/fail counts, notable labels, whether the run continues).
   - `heartbeat` → 1–3 lines: still running, current phase `done/started`, in-flight labels. No essay.
   - `terminal` / `stale` → read `result.json` / error as needed and close out the run in this session.
3. User messages still win. “stop verify”, “what’s happening”, “continue” map to existing commands. A user question does not cancel the next stop-hook wait.
4. Never paste full worker transcripts. Journal results in the snapshot are enough; truncate aggressively.
5. Headless users still have `cw run --yes` with no hook.

### 4. Phase summary content

Assistant phase summary (target: 3–8 lines):

- Phase name and outcome (finished / still running / run ended).
- Counts: succeeded, failed/null, cancelled.
- A few labels (cap at 8, then “and N more”).
- Token count for that phase if non-zero.
- One sentence on what happens next only if `inFlight` or terminal result is known.

Do not dump the raw `[cw-watch]` JSON in the assistant reply.

### 5. `cw chat` / plugin load

No new `agent` flags if `--plugin-dir` already loads plugin hooks in the CLI (verify in implementation). If CLI ignores plugin hooks, `chatCommand` writes a session-scoped project file **only as a fallback**, and the spec should be updated then. Do not silently write `~/.cursor/hooks.json` (global, not scoped to cw).

Preferred fallback if needed: `cw chat` sets `CURSOR_PLUGIN_PATH` / documented CLI equivalent, or copies `plugin/hooks` into a temp dir passed however the CLI supports. Decision at implementation with a failing test or a recorded `agent` probe — not by assuming Desktop-only hooks.

## Data flow

1. User runs `cw` → `agent --plugin-dir <bundled>`.
2. User describes work. Orchestrator dry-runs, user says yes, `cw run --file … --detach`.
3. Orchestrator tells the user the run id and stops the turn.
4. `stop` hook sees `running`, calls `cw watch --timeout 300`.
5. Workers emit `agent_start`/`agent_end`. When `verify` starts and `audit` is idle, watch returns `phase_end` / `audit`.
6. Cursor injects `[cw-watch] …`. Orchestrator writes the audit summary into the chat.
7. Turn ends. Hook waits again.
8. If audit-like work lasts >5 minutes with no phase transition, watch returns `heartbeat`; orchestrator posts 1–3 lines.
9. Run completes → `terminal` follow-up → final answer. Next `stop` → `{}`.

User types “stop verify” in the middle of a wait: the current turn (if any) handles `cw stop --phase verify`. If the hook is still blocked in `watch`, it returns on the resulting `agent_end` / status change or at timeout. Fail-open if the hook is killed.

## Error handling

- Hook crash, timeout, or invalid JSON: Cursor fail-open; session stays usable. Hook itself prints `{}` on errors.
- `cw watch` with no runs: exit 1, hook prints `{}`.
- Missing `agent` / logged-out: unchanged existing errors; watch is local filesystem, no `agent` needed.
- Zombie runtime (`stale`): announce once, consume cursor, do not heartbeat forever.
- `loop_limit` exhausted: one last message, then idle. User can say “keep watching” (skill: call `cw watch` once or ask them to send any message to retrigger `stop`).
- `--timeout 0` with a hung phase: wait until phase_end/terminal/stale. Hook always uses 300, not 0.

Exit codes: watch 0 on wait complete, 1 on CLI/config. Do not reuse 2/130.

## Testing

No live `agent` and no API key.

- Phase machine: sequential same-phase does not complete until the next distinct phase or terminal; pipeline concurrent audit then verify emits one `audit` completion; last phase completes on terminal; unlabeled groups as `(unlabeled)`; reused phase name appends a second completion.
- `cw watch`: fake events file + `run.json`; immediate `phase_end` when unconsumed; one event per invocation when both last `phase_end` and `terminal` are pending; heartbeat after fake clock/timeout with no new events; `terminal` reads `result.json`; `stale` when pid is dead; cursor file prevents duplicate `phase_end`.
- Flags: `--timeout` default 300; reject negative; `--output json`.
- Hook unit: stdin `aborted` → stdout `{}`; watch `phase_end` → stdout contains `followup_message` and `[cw-watch]`; watch throw → `{}`.
- Skill/manifest: plugin.json points at hooks; skill forbids `sleep 300` / “only status when asked”; skill mentions `[cw-watch]` and phase summaries.
- Existing: `cw run --file examples/audit-routes.js --backend fake --yes` still passes.

## Docs

README: while a detached run is in a `cw` chat session, phase summaries and 5-minute heartbeats appear automatically. `cw watch` is documented for humans and as the hook’s backend. Headless `cw run --detach` still requires `cw status` to inspect.

`--help` for `watch` with examples:

```text
cw watch --run cw_k1_ab12
cw watch --run cw_k1_ab12 --timeout 300 --output json
```

## File map (implementation)

| Path | Change |
| --- | --- |
| `src/runtime/phase-machine.ts` | Pure reducer over `RunEvent[]` + run status → completions / in-flight. |
| `src/commands/watch.ts` | New command. |
| `src/cli.ts` / `src/commands/help.ts` / `src/cli/flags.ts` | Dispatch, help, `--timeout`. |
| `src/store/watch-cursor.ts` | Read/write `watch-cursor.json`. |
| `plugin/.cursor-plugin/plugin.json` | `hooks: "./hooks/hooks.json"`. |
| `plugin/hooks/hooks.json` | `stop` hook. |
| `plugin/hooks/orchestrator-stop.js` | Fail-open wrapper around `cw watch`. |
| `plugin/skills/cw-orchestrator/SKILL.md` | Watch protocol. |
| `src/plugin-manifest.test.ts` | Assert hooks + skill phrases. |
| `README.md` | Auto summaries in `cw` chat. |

## Success criteria

- After `cw` chat detaches a run, a phase summary appears in that chat when the phase completes, with no user message.
- A phase that runs longer than 5 minutes produces a short heartbeat in that chat without the user asking.
- Sequential `agent()` calls that share a phase do not emit a summary between them.
- User can still stop a phase or ask a question mid-run.
- `cw run --file … --backend fake --yes` without chat is unaffected.
- Hook failures never block the orchestrator from answering the user.

## Assumptions

- Cursor CLI `agent --plugin-dir` loads plugin `stop` hooks the same way Desktop does. If implementation proves it does not, the fallback is `cw chat` installing a workspace-scoped hook for that session, not a global user hook.
- Stop-hook `timeout` is honored in seconds and may exceed 5 minutes (set 330s so watch can return first).
- Common hook stdin includes `workspace_roots` even for `stop` (documented on the shared envelope). If missing, hook uses `process.cwd()`.
- One interesting run per workspace is the latest active (or unconsumed) run.
