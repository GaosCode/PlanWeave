import type { Command } from "commander";
import { appendRunSessionEvent, createRunSession, resetRuntimeState, updateRunSession, type ResetRuntimeStateResult, type RunSessionState } from "@planweave-ai/runtime";
import { addCanvasOption, resolveCliPackageWorkspace, type CanvasCommandOptions } from "../cliWorkspace.js";

type ResetCommandOptions = {
  force?: boolean;
  reason?: string;
  json?: boolean;
} & CanvasCommandOptions;

type ResetCommandResult = ResetRuntimeStateResult & {
  session: RunSessionState;
};

export function registerResetCommand(program: Command): void {
  addCanvasOption(program
    .command("reset")
    .description("Reset PlanWeave runtime state for the selected canvas")
    .option("--force", "allow reset while active work exists")
    .option("--reason <text>", "record why the reset is being performed")
    .option("--json", "print JSON output"))
    .action(async (options: ResetCommandOptions) => {
      const projectRoot = await resolveCliPackageWorkspace(options);
      const session = await createRunSession({ projectRoot, kind: "reset", phase: "resetting" });
      try {
        await appendRunSessionEvent(projectRoot, session.sessionId, "reset_started", {
          phase: "resetting",
          force: options.force === true,
          reason: options.reason ?? null
        });
        const reset = await resetRuntimeState({
          projectRoot,
          force: options.force,
          session
        });
        const finishedAt = new Date().toISOString();
        const completedSession = await updateRunSession(projectRoot, session.sessionId, {
          phase: "completed",
          finishedAt
        });
        await appendRunSessionEvent(projectRoot, session.sessionId, "session_completed", {
          phase: "completed",
          finishedAt
        });
        const result: ResetCommandResult = { ...reset, session: completedSession };
        if (options.json) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }
        console.log(formatResetResult(result));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const finishedAt = new Date().toISOString();
        await updateRunSession(projectRoot, session.sessionId, {
          phase: "failed",
          finishedAt,
          error: message
        });
        await appendRunSessionEvent(projectRoot, session.sessionId, "session_failed", {
          phase: "failed",
          finishedAt,
          error: message
        });
        throw error;
      }
    });
}

function formatResetResult(result: ResetCommandResult): string {
  return [
    `session: ${result.session.sessionId}`,
    `state path: ${result.statePath}`,
    `forced: ${result.forced ? "yes" : "no"}`,
    `previous current refs: ${result.previousCurrentRefs.join(", ") || "none"}`,
    `previous in-progress refs: ${result.previousInProgressRefs.join(", ") || "none"}`
  ].join("\n");
}
