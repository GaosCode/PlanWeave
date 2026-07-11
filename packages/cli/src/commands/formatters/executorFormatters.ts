import type { ExecutorPreflightResult, ExecutorProfileSummary } from "@planweave-ai/runtime";

export function formatExecutorTestJson(result: ExecutorPreflightResult): string {
  return JSON.stringify(result, null, 2);
}

export function formatExecutorTestHuman(result: ExecutorPreflightResult): string {
  const failedCheck = result.checks.find((check) => check.status === "failed");
  return `${result.ok ? "ok" : "failed"} ${result.name} agent=${result.agentId ?? "none"} runner=${result.runnerKind ?? "none"}: ${failedCheck?.message ?? result.message}`;
}

export function formatExecutorProfilesHuman(result: ExecutorProfileSummary[]): string {
  return result
    .map(
      (profile) =>
        `${profile.name}\t${profile.adapter}\t${profile.agentId ?? "none"}\t${profile.runnerKind ?? "none"}\t${profile.source}`
    )
    .join("\n");
}
