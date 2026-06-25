import type { Command } from "commander";
import { getRunSession, listRunSessions, type ListRunSessionsResult, type RunSessionDetail, type RunSessionState } from "@planweave-ai/runtime";
import { addCanvasOption, resolveCliPackageWorkspace, type CanvasCommandOptions } from "../cliWorkspace.js";

type JsonCommandOptions = {
  json?: boolean;
} & CanvasCommandOptions;

export function registerRunSessionsCommands(program: Command): void {
  addCanvasOption(program
    .command("run-sessions")
    .description("List PlanWeave run/reset sessions")
    .option("--json", "print JSON output"))
    .action(async (options: JsonCommandOptions) => {
      const result = await listRunSessions(await resolveCliPackageWorkspace(options));
      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      console.log(formatRunSessions(result));
    });

  addCanvasOption(program
    .command("run-session")
    .argument("<session-id>")
    .description("Show one PlanWeave run/reset session")
    .option("--json", "print JSON output"))
    .action(async (sessionId: string, options: JsonCommandOptions) => {
      const result = await getRunSession(await resolveCliPackageWorkspace(options), sessionId);
      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      console.log(formatRunSessionDetail(result));
    });
}

export function formatRunSessions(result: ListRunSessionsResult): string {
  const lines = result.sessions.length === 0 ? ["run sessions: none"] : ["run sessions:", ...result.sessions.map(formatRunSessionSummary)];
  if (result.diagnostics.length > 0) {
    lines.push("diagnostics:");
    lines.push(...result.diagnostics.map((diagnostic) => `- ${diagnostic.sessionId} ${diagnostic.code}: ${diagnostic.message}`));
  }
  return lines.join("\n");
}

function formatRunSessionSummary(session: RunSessionState): string {
  return `- ${session.sessionId} ${session.kind} ${session.phase} steps=${session.autoRun?.stepCount ?? 0} stop=${session.autoRun?.stopReason ?? "none"} started=${session.startedAt} latest=${session.latestRecordId ?? "none"}`;
}

function formatRunSessionDetail(detail: RunSessionDetail): string {
  const lines = [
    `session: ${detail.session.sessionId}`,
    `kind: ${detail.session.kind}`,
    `phase: ${detail.session.phase}`,
    `canvas: ${detail.session.canvasId}`,
    `started: ${detail.session.startedAt}`,
    `finished: ${detail.session.finishedAt ?? "none"}`,
    `stop reason: ${detail.session.autoRun?.stopReason ?? "none"}`,
    `latest record: ${detail.session.latestRecordId ?? "none"}${detail.session.latestRecordPath ? ` (${detail.session.latestRecordPath})` : ""}`,
    `error: ${detail.session.error ?? "none"}`,
    "events:"
  ];
  lines.push(...detail.events.map((event) => `- ${event.timestamp} ${event.type} ${event.phase}`));
  if (detail.diagnostics.length > 0) {
    lines.push("diagnostics:");
    lines.push(...detail.diagnostics.map((diagnostic) => `- ${diagnostic.code}: ${diagnostic.message}`));
  }
  return lines.join("\n");
}
