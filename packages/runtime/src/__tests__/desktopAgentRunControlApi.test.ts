import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AGENT_RUN_CONTROL_PROTOCOL_VERSION,
  agentRunControlLeaseIdSchema,
  type AgentRunControlAction
} from "../autoRun/agentRunControlContract.js";
import { executeDesktopAgentRunControl } from "../desktop/agentRunControlApi.js";
import { desktopAgentRunControlResponseSchema } from "../desktop/types/agentRunControlTypes.js";
import { createTestWorkspace } from "./promptTestHelpers.js";

const roots: string[] = [];
const originalHome = process.env.PLANWEAVE_HOME;
const originalSettings = process.env.PLANWEAVE_DESKTOP_SETTINGS_FILE;
const leaseId = agentRunControlLeaseIdSchema.parse("6202e8ad-0634-4f80-ad56-a6a8080b1d65");
const commandId = "405542d4-f89a-4e95-aaaf-104e44188626";

async function applicationFixture() {
  const { root, home, init } = await createTestWorkspace();
  roots.push(root, home);
  const runDir = join(init.workspace.resultsDir, "T-001", "blocks", "B-001", "runs", "RUN-001");
  await mkdir(runDir, { recursive: true });
  const identity = {
    scope: runDir,
    executorRunId: "RUN-001",
    desktopRunId: "DESKTOP-RUN-001",
    runSessionId: "RUN-SESSION-001",
    claimRef: "T-001#B-001",
    sessionId: "acp-session-1"
  };
  return { root, runDir, identity };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  if (originalHome === undefined) delete process.env.PLANWEAVE_HOME;
  else process.env.PLANWEAVE_HOME = originalHome;
  if (originalSettings === undefined) delete process.env.PLANWEAVE_DESKTOP_SETTINGS_FILE;
  else process.env.PLANWEAVE_DESKTOP_SETTINGS_FILE = originalSettings;
});

describe("desktop agent run control application API", () => {
  it.each([
    { kind: "cancel" as const },
    { kind: "follow_up" as const, prompt: "Continue with the verification." },
    { kind: "respond" as const, requestId: "permission-1", outcome: "allow" }
  ])("resolves and executes the canonical $kind command", async (actionCase) => {
    const fixture = await applicationFixture();
    const action: AgentRunControlAction =
      actionCase.kind === "respond"
        ? {
            kind: "respond",
            identity: { ...fixture.identity, requestId: actionCase.requestId },
            outcome: actionCase.outcome
          }
        : actionCase.kind === "follow_up"
          ? { kind: "follow_up", identity: fixture.identity, prompt: actionCase.prompt }
          : { kind: "cancel", identity: fixture.identity };
    const execute = vi.fn(async () => ({
      version: AGENT_RUN_CONTROL_PROTOCOL_VERSION,
      ok: true as const,
      commandId,
      acceptedAt: "2026-07-17T07:00:00.000Z",
      ownerPid: 9876,
      leaseId,
      result: { status: "delivered" as const, deliveredAt: "2026-07-17T07:00:01.000Z" }
    }));

    const response = await executeDesktopAgentRunControl(
      {
        ref: { projectRoot: fixture.root, canvasId: "default" },
        recordId: "T-001#B-001::RUN-001",
        action
      },
      { locator: { execute } }
    );

    expect(execute).toHaveBeenCalledWith(fixture.runDir, action);
    expect(response).toEqual({
      ok: true,
      commandId,
      acceptedAt: "2026-07-17T07:00:00.000Z",
      result: { status: "delivered", deliveredAt: "2026-07-17T07:00:01.000Z" }
    });
    expect(JSON.stringify(response)).not.toMatch(/address|descriptor|leaseId|ownerPid/);
    expect(
      desktopAgentRunControlResponseSchema.safeParse({
        ...response,
        ownerPid: 9876,
        leaseId,
        address: "/private/control.sock"
      }).success
    ).toBe(false);
  });

  it("rejects identity and path mismatches before locator routing", async () => {
    const fixture = await applicationFixture();
    const execute = vi.fn();
    const response = await executeDesktopAgentRunControl(
      {
        ref: { projectRoot: fixture.root, canvasId: "default" },
        recordId: "T-001#B-001::RUN-001",
        action: {
          kind: "cancel",
          identity: { ...fixture.identity, scope: `${fixture.runDir}-other` }
        }
      },
      { locator: { execute } }
    );
    expect(response).toMatchObject({ ok: false, code: "invalid_identity", commandId: null });
    expect(execute).not.toHaveBeenCalled();

    const escaped = await executeDesktopAgentRunControl(
      {
        ref: { projectRoot: fixture.root, canvasId: "default" },
        recordId: "T-001#B-001::../RUN-001",
        action: { kind: "cancel", identity: fixture.identity }
      },
      { locator: { execute } }
    );
    expect(escaped).toMatchObject({ ok: false, code: "invalid_identity" });
    expect(execute).not.toHaveBeenCalled();
  });
});
