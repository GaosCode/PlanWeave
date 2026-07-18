import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  recoverAcpRunByRecord: vi.fn(),
  resolveCliProjectRoot: vi.fn(async () => "/projects/demo")
}));

vi.mock("@planweave-ai/runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@planweave-ai/runtime")>()),
  recoverAcpRunByRecord: mocks.recoverAcpRunByRecord
}));
vi.mock("../projectRoot.js", () => ({ resolveCliProjectRoot: mocks.resolveCliProjectRoot }));

import { registerRecoverAcpRunCommand } from "../commands/recoverAcpRun.js";

afterEach(() => {
  vi.restoreAllMocks();
  mocks.recoverAcpRunByRecord.mockReset();
  process.exitCode = undefined;
});

async function runCommand(...args: string[]): Promise<string> {
  const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
  const program = new Command();
  registerRecoverAcpRunCommand(program);
  await program.parseAsync(args, { from: "user" });
  return log.mock.calls.map(([value]) => String(value)).join("\n");
}

describe("recover-acp-run command", () => {
  it("returns versioned lineage and next actions for an exact source record", async () => {
    mocks.recoverAcpRunByRecord.mockResolvedValue({
      state: {
        runId: "AUTO-RUN-002",
        phase: "running",
        options: {
          tmuxEnabled: true,
          acpRecovery: {
            lineage: {
              version: "planweave.acp-recovery/v1",
              kind: "session_load",
              sourceRecordId: "T-001#B-001::RUN-001",
              sourceRunId: "RUN-001",
              sourceSessionId: "session-1",
              sourceTerminalEventSequence: 9,
              requestedAt: "2026-07-17T00:00:00.000Z",
              requestedBy: "automation"
            }
          }
        }
      },
      nextActions: {
        version: "planweave.runner-next-actions/v1",
        actions: [
          {
            kind: "retry_new_session",
            sourceRecordId: "T-001#B-001::RUN-001",
            sourceRunId: "RUN-001"
          }
        ]
      }
    });

    const stdout = await runCommand(
      "recover-acp-run",
      "--record",
      "T-001#B-001::RUN-001",
      "--source",
      "automation",
      "--reason",
      "transport disconnected",
      "--canvas",
      "default",
      "--json"
    );

    expect(mocks.recoverAcpRunByRecord).toHaveBeenCalledWith(
      {
        projectRoot: "/projects/demo",
        canvasId: "default",
        recordId: "T-001#B-001::RUN-001"
      },
      { source: "automation", reason: "transport disconnected" }
    );
    expect(JSON.parse(stdout)).toMatchObject({
      version: "planweave.recover-acp-run/v1",
      ok: true,
      sourceRecordId: "T-001#B-001::RUN-001",
      sourceRunId: "RUN-001",
      recoveryAutoRunId: "AUTO-RUN-002",
      phase: "running",
      nextActions: {
        version: "planweave.runner-next-actions/v1",
        actions: [
          {
            kind: "retry_new_session",
            sourceRecordId: "T-001#B-001::RUN-001",
            sourceRunId: "RUN-001"
          }
        ]
      }
    });
  });

  it("returns a stable structured JSON error when recovery is unavailable", async () => {
    mocks.recoverAcpRunByRecord.mockRejectedValue(new Error("session/load unavailable"));

    const stdout = await runCommand(
      "recover-acp-run",
      "--record",
      "T-001#B-001::RUN-001",
      "--source",
      "automation",
      "--reason",
      "retry interrupted session",
      "--json"
    );

    expect(JSON.parse(stdout)).toEqual({
      version: "planweave.recover-acp-run/v1",
      ok: false,
      error: { code: "recovery_unavailable", message: "session/load unavailable" }
    });
    expect(process.exitCode).toBe(1);
  });
});
