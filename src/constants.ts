export const DEFAULT_MODEL = "composer-2.5";
export const DEFAULT_CONCURRENCY = 4;
export const MAX_CONCURRENCY = 16;
export const DEFAULT_MAX_AGENTS = 100;
export const HARD_MAX_AGENTS = 1000;
export const LARGE_RUN_AGENT_WARNING = 25;

export const RUN_DIR_NAME = ".cursor-workflows";
export const PROJECT_WORKFLOWS_DIR = ".cursor/workflows";
export const USER_WORKFLOWS_DIR_SEGMENTS = [".cursor", "workflows"] as const;

export const UNLABELED_PHASE = "(unlabeled)";
export const DEFAULT_WATCH_TIMEOUT_SEC = 300;
export const WATCH_POLL_MS = 200;
