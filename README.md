# cursor-workflows (`cw`)

Ultracode-style workflow CLI for Cursor. You chat with an orchestrator (`agent`); a JavaScript workflow runs in the background; `agent()` / `pipeline()` / `parallel()` fan work out to local Cursor workers. Intermediate results stay in script variables.

## Setup

```bash
npm install
npm run build
agent login
npx cw --help
```

Default workers are your installed `agent` CLI (plugins, skills, MCP). There is no API key on this path.

```bash
cw                   # interactive orchestrator (TTY)
cw run "audit every route under src/routes for missing auth" --yes
```

`--backend sdk` is optional and requires `CURSOR_API_KEY`. On `--backend cli`, `tools: "write"` and `"full"` both allow shell (`agent -p --force`).

Chat during a run goes to the orchestrator, not into `workflow.js`. Use `cw status`, `cw stop --phase <name>`, `cw resume`, and `cw watch`.

In a `cw` / `cw chat` session, a detached run posts a phase summary when each phase ends and a short heartbeat about every 5 minutes. Headless `cw run --detach` does not print those into chat; inspect with `cw status` or `cw watch`.

## Workflow scripts

```javascript
export const meta = {
  name: "audit-routes",
  description: "Audit route handlers for missing auth checks",
}

const found = await agent("List every .ts file under src/routes/.", {
  schema: {
    type: "object",
    required: ["files"],
    properties: { files: { type: "array", items: { type: "string" } } },
  },
})

const audits = await pipeline(found.files, (file) =>
  agent(`Audit ${file} for missing authentication checks.`, { label: file, tools: "read" }),
)

return audits.filter(Boolean)
```

Host primitives (no `import()` / `require` / filesystem / shell from the script):

- `agent(prompt, opts)` — one Cursor worker; returns parsed result or `null`
- `pipeline(items, ...stages)` — rolling window across items
- `parallel(thunks)` — barrier; throwing thunks become `null`
- `args` — JSON from `--args`

`agent` options: `label`, `phase`, `model`, `schema`, `tools` (`read` | `write` | `full`), `isolation` (`cwd` | `worktree`), `cwd`.

Runs live under `.cursor-workflows/runs/<id>/`. Save reusable scripts to `.cursor/workflows/` (project) or `~/.cursor/workflows/` (user).
