import type { Command } from "commander";
import { recoverAcpRunByRecord } from "@planweave-ai/runtime";
import { addCanvasOption, resolveCliCanvasId, type CanvasCommandOptions } from "../cliWorkspace.js";
import { resolveCliProjectRoot } from "../projectRoot.js";

type RecoverAcpRunOptions = CanvasCommandOptions & {
  record: string;
  source: string;
  reason: string;
  json?: boolean;
};

export function registerRecoverAcpRunCommand(program: Command): void {
  addCanvasOption(
    program
      .command("recover-acp-run")
      .description("Recover an interrupted ACP Block run as a new session/load attempt")
      .requiredOption("--record <recordId>", "exact source Block run record id")
      .requiredOption("--source <clientLabel>", "stable audit label for the requesting client")
      .requiredOption("--reason <text>", "non-empty audit reason for recovery")
      .option("--json", "print versioned JSON output")
  ).action(async (options: RecoverAcpRunOptions) => {
    try {
      const recoveryResult = await recoverAcpRunByRecord(
        {
          projectRoot: await resolveCliProjectRoot(),
          canvasId: resolveCliCanvasId(options),
          recordId: options.record
        },
        { source: options.source, reason: options.reason }
      );
      const { state, nextActions } = recoveryResult;
      const recovery = state.options.acpRecovery;
      if (!recovery) throw new Error("Runtime recovery state is missing its lineage contract.");
      const result = {
        version: "planweave.recover-acp-run/v1" as const,
        ok: true as const,
        sourceRecordId: recovery.lineage.sourceRecordId,
        sourceRunId: recovery.lineage.sourceRunId,
        recoveryAutoRunId: state.runId,
        phase: state.phase,
        lineage: recovery.lineage,
        nextActions
      };
      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(
          `Started ACP recovery Auto Run '${state.runId}' from '${recovery.lineage.sourceRecordId}'.`
        );
      }
    } catch (error) {
      if (!options.json) throw error;
      const message = error instanceof Error ? error.message : String(error);
      console.log(
        JSON.stringify(
          {
            version: "planweave.recover-acp-run/v1",
            ok: false,
            error: { code: "recovery_unavailable", message }
          },
          null,
          2
        )
      );
      process.exitCode = 1;
    }
  });
}
