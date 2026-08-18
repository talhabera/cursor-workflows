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
  tools: "read",
  phase: "discover",
})

const audits = await pipeline(found.files, (file) =>
  agent(`Audit ${file} for missing authentication checks.`, {
    label: file,
    tools: "read",
    phase: "audit",
  }),
)

return audits.filter(Boolean)
