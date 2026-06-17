import type { ExecutorProfile } from "../types.js";

export type ExecutorPreflightCheckName =
  | "profile_exists"
  | "adapter_supported"
  | "cwd_resolved"
  | "command_started"
  | "command_version";

export type ExecutorPreflightCheckStatus = "passed" | "failed" | "skipped";

export type ExecutorPreflightCheck = {
  check: ExecutorPreflightCheckName;
  status: ExecutorPreflightCheckStatus;
  message: string;
  command?: string;
  cwd?: string;
  output?: string;
  exitCode?: number;
  timedOut?: boolean;
};

export type ExecutorPreflightResult = {
  name: string;
  adapter: ExecutorProfile["adapter"] | null;
  ok: boolean;
  message: string;
  checks: ExecutorPreflightCheck[];
};
