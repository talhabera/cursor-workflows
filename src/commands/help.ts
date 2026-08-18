export const ROOT_HELP = `cw — ultracode-style workflow CLI for Cursor

Usage:
  cw <command> [options]

Commands:
  chat        Start an interactive Cursor agent session
  run         Generate and/or execute a workflow
  workflows   List or save reusable workflow scripts
  status      Show a run
  stop        Request stop for a running workflow
  resume      Resume a stopped or incomplete run
  help        Show help for a command

Examples:
  cw
  cw chat
  cw run "audit every route under src/routes for missing auth" --yes
  cw run --file .cursor/workflows/audit-routes.js
  cw workflows list
  cw status --run cw_k1_ab12
`;

export const CHAT_HELP = `cw chat — start an interactive Cursor agent session

Usage:
  cw chat [agent-options...]

Options:
  -h, --help              Show this help

Examples:
  cw
  cw chat
  cw chat --model composer-2.5
`;

export const RUN_HELP = `cw run — generate and execute a workflow

Usage:
  cw run [prompt...] [options]

Options:
  --file <path>           Execute an existing workflow.js (skips the planner)
  --workflow <name>       Load .cursor/workflows/<name>.js (project wins over user)
  --args <json>           Structured input exposed as \`args\` in the script
  --dry-run               Write/print the script and exit without executing
  --detach                Start the runtime in the background (cw resume --run <id>)
  --yes                   Execute a planner-generated script without a second confirmation
  --save                  After a successful run, copy the script to .cursor/workflows/
  --backend <sdk|cli|fake>
                          Worker backend (default: cli)
  --cwd <path>            Workspace root (default: current directory)
  --model <id>            Default model for planner and workers
  --size <small|medium|large|unrestricted>
                          Planner sizing advice (default: medium)
  --concurrency <n>       Concurrent workers (default: 4, max: 16)
  --max-agents <n>        Total agent() calls (default: 100, max: 1000)
  --output <text|json>    stdout format (default: text)
  -h, --help              Show this help

Examples:
  agent login && cw run --file workflow.js --detach
  cw run "audit every route under src/routes for missing auth" --yes
  cw run --file examples/audit-routes.js --backend fake --yes
  cw run --workflow audit-routes --args '{"dir":"src/routes"}'
  cw run "migrate styled-components to Tailwind" --dry-run
  cw run --file .cursor/workflows/audit-routes.js --detach
`;

export const WORKFLOWS_HELP = `cw workflows — saved workflow scripts

Usage:
  cw workflows list
  cw workflows save --run <id> [--name <name>] [--user]

Examples:
  cw workflows list
  cw workflows save --run cw_k1_ab12 --name audit-routes
`;

export const STATUS_HELP = `cw status — inspect a run

Usage:
  cw status [--run <id>] [--output text|json]

Examples:
  cw status
  cw status --run cw_k1_ab12 --output json
`;

export const STOP_HELP = `cw stop — request stop for a running workflow

Usage:
  cw stop [--run <id>] [--phase <name>] [--label <label>]

Examples:
  cw stop --run cw_k1_ab12
  cw stop --run cw_k1_ab12 --phase verify
  cw stop --run cw_k1_ab12 --label src/routes/a.ts
`;

export const RESUME_HELP = `cw resume — replay completed agent() calls and continue the rest

Usage:
  cw resume [--run <id>] [--yes] [--output text|json]

Examples:
  cw resume --run cw_k1_ab12
`;
