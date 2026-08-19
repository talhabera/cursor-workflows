export type WorkerBackendName = "sdk" | "cli" | "fake";
export type ToolPreset = "read" | "write" | "full";
export type IsolationMode = "cwd" | "worktree";
export type WorkflowSize = "small" | "medium" | "large" | "unrestricted";
export type OutputFormat = "text" | "json";
export type RunStatus =
  | "pending"
  | "planning"
  | "awaiting_approval"
  | "running"
  | "completed"
  | "failed"
  | "stopped";

export interface AgentCallOptions {
  label?: string;
  phase?: string;
  model?: string;
  schema?: Record<string, unknown>;
  tools?: ToolPreset;
  isolation?: IsolationMode;
  cwd?: string;
}

export interface WorkflowMeta {
  name?: string;
  description?: string;
}

export interface WorkerRequest {
  prompt: string;
  cwd: string;
  model: string;
  tools: ToolPreset;
  schema: Record<string, unknown> | undefined;
  label: string | undefined;
  phase: string | undefined;
  isolation: IsolationMode;
  signal: AbortSignal;
  cliMode?: "ask" | "plan";
}

export interface WorkerResult {
  id: string;
  result: unknown;
  tokens: number;
  transcriptPath: string | undefined;
  status: "finished" | "error" | "cancelled";
}

export interface WorkerBackend {
  readonly name: WorkerBackendName;
  start(request: WorkerRequest): Promise<WorkerResult>;
}

export interface JournalEntry {
  callIndex: number;
  key: string;
  prompt: string;
  label: string | undefined;
  phase: string | undefined;
  status: "running" | "completed";
  result: unknown;
  tokens: number;
  workerId: string | undefined;
}

export interface RunRecord {
  id: string;
  status: RunStatus;
  cwd: string;
  backend: WorkerBackendName;
  model: string;
  createdAt: string;
  updatedAt: string;
  pid: number | undefined;
  stopRequested: boolean;
  cancelPhases: string[];
  cancelLabels: string[];
  workflowPath: string;
  prompt: string | undefined;
  args: unknown;
  size: WorkflowSize;
  concurrency: number;
  maxAgents: number;
  error: string | undefined;
  agentCount: number;
  tokens: number;
}

export type WatchReason = "phase_end" | "heartbeat" | "terminal" | "stale";

export interface WatchCursor {
  phaseEnds: string[];
  terminal: boolean;
}

export type RunEvent =
  | {
      type: "agent_start";
      at: string;
      callIndex: number;
      key: string;
      label?: string;
      phase?: string;
    }
  | {
      type: "agent_end";
      at: string;
      callIndex: number;
      key: string;
      ok: boolean;
      cancelled?: boolean;
      tokens: number;
      phase?: string;
    }
  | { type: "warning"; at: string; message: string }
  | { type: "status"; at: string; status: RunStatus }
  | { type: "result"; at: string; result: unknown };

export function isWorkerBackendName(value: string): value is WorkerBackendName {
  return value === "sdk" || value === "cli" || value === "fake";
}

export function isToolPreset(value: string): value is ToolPreset {
  return value === "read" || value === "write" || value === "full";
}

export function isIsolationMode(value: string): value is IsolationMode {
  return value === "cwd" || value === "worktree";
}

export function isWorkflowSize(value: string): value is WorkflowSize {
  return (
    value === "small" ||
    value === "medium" ||
    value === "large" ||
    value === "unrestricted"
  );
}

export function isOutputFormat(value: string): value is OutputFormat {
  return value === "text" || value === "json";
}
