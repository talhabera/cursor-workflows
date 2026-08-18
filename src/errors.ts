export class CliError extends Error {
  readonly exitCode: number;
  readonly example: string | undefined;

  constructor(message: string, options?: { exitCode?: number; example?: string }) {
    super(message);
    this.name = "CliError";
    this.exitCode = options?.exitCode ?? 1;
    this.example = options?.example;
  }
}

export class WorkflowLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkflowLimitError";
  }
}

export class WorkflowSandboxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkflowSandboxError";
  }
}

export function formatCliError(error: CliError): string {
  if (error.example) {
    return `Error: ${error.message}\n  ${error.example}`;
  }
  return `Error: ${error.message}`;
}
