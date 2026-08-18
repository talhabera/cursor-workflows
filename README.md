# cursor-workflows (`cw`)

Ultracode-style workflow CLI for Cursor. One planner agent writes a JavaScript workflow; a local runtime executes `agent()` / `pipeline()` / `parallel()` against Cursor workers. Intermediate results stay in script variables, not in the planner's context.

## Setup

```bash
npm install
npm run build
npx cw --help
```

Auth uses the same key as the Cursor SDK and CLI:

```bash
export CURSOR_API_KEY="cursor_..."
```

Create a user key at [Cursor Dashboard → Integrations](https://cursor.com/dashboard/integrations). Team service-account keys also work.

Default worker backend is the local `@cursor/sdk`. Pass `--backend cli` to spawn `agent -p` instead.

## Examples

```bash
cw run "audit every route under src/routes for missing auth" --yes
cw run --file .cursor/workflows/audit-routes.js
cw run --workflow audit-routes --args '{"dir":"src/routes"}'
cw run --file examples/audit-routes.js --backend fake --yes
cw run "migrate styled-components to Tailwind" --dry-run
cw workflows list
cw status --run <id>
cw stop --run <id>
cw resume --run <id>
```

Without `--yes`, a planner-generated script is printed and execution is refused (non-interactive). `--file` / `--workflow` / `resume` skip that gate.

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
