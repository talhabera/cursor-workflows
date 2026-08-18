import { WorkflowSandboxError } from "../errors.js";
import type { WorkflowMeta } from "../types.js";

const BANNED_PATTERNS: Array<{ pattern: RegExp; message: string }> = [
  { pattern: /\bimport\s*\(/, message: "import() is not allowed in workflow scripts" },
  { pattern: /\bimport\s+["']/, message: "import is not allowed in workflow scripts" },
  { pattern: /\bimport\s*\{/, message: "import is not allowed in workflow scripts" },
  { pattern: /\bimport\s+\w+/, message: "import is not allowed in workflow scripts" },
  { pattern: /\brequire\s*\(/, message: "require() is not allowed in workflow scripts" },
  { pattern: /\bprocess\b/, message: "process is not allowed in workflow scripts" },
  { pattern: /\bBuffer\b/, message: "Buffer is not allowed in workflow scripts" },
  { pattern: /\b__dirname\b/, message: "__dirname is not allowed in workflow scripts" },
  { pattern: /\b__filename\b/, message: "__filename is not allowed in workflow scripts" },
  { pattern: /\beval\s*\(/, message: "eval() is not allowed in workflow scripts" },
  { pattern: /\bFunction\s*\(/, message: "Function() is not allowed in workflow scripts" },
  {
    pattern: /\bfs\s*\.\s*(read|write|open|unlink|mkdir)/,
    message: "filesystem access is not allowed from the workflow script",
  },
];

export function assertScriptAllowed(source: string): void {
  for (const { pattern, message } of BANNED_PATTERNS) {
    if (pattern.test(source)) {
      throw new WorkflowSandboxError(message);
    }
  }
}

export function extractMeta(source: string): WorkflowMeta {
  const nameMatch = source.match(/\bname\s*:\s*['"]([^'"]+)['"]/);
  const descriptionMatch = source.match(/\bdescription\s*:\s*['"]([^'"]+)['"]/);
  return {
    name: nameMatch?.[1],
    description: descriptionMatch?.[1],
  };
}

export function transformWorkflowSource(source: string): string {
  assertScriptAllowed(source);
  const stripped = source.replace(/export\s+const\s+meta\s*=/, "const meta =");
  return `"use strict";
__resolve((async function (agent, pipeline, parallel, args) {
${stripped}
})(agent, pipeline, parallel, args));
`;
}

export function createSandboxGlobals(): {
  Math: Math;
  Date: DateConstructor;
} {
  const randomThrow = (): never => {
    throw new WorkflowSandboxError(
      "Math.random() is disabled in workflows; vary prompts by index or pass seeds via args",
    );
  };
  const nowThrow = (): never => {
    throw new WorkflowSandboxError(
      "Date.now() is disabled in workflows; pass timestamps via args",
    );
  };

  const math = Object.create(Math) as Math;
  Object.defineProperty(math, "random", { value: randomThrow, writable: false });

  const DateCtor = function Date(...dateArgs: unknown[]): Date {
    if (dateArgs.length === 0) {
      throw new WorkflowSandboxError(
        "new Date() without arguments is disabled; pass a timestamp via args",
      );
    }
    return Reflect.construct(globalThis.Date, dateArgs) as Date;
  } as unknown as DateConstructor;
  DateCtor.now = nowThrow;
  DateCtor.parse = globalThis.Date.parse;
  DateCtor.UTC = globalThis.Date.UTC;

  return { Math: math, Date: DateCtor };
}
