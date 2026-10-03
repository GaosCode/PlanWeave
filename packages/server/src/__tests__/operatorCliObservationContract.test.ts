import { afterEach, describe, expect, it, vi } from "vitest";
import { createOwnerCanvasRunContext } from "../../../cli/src/workspaceExecution/ownerCanvas.js";
import { writeOperatorExecutionProfiles } from "../../../cli/src/__tests__/support/workspaceExecutionHttpHarness.js";
import { operatorPublicOperationViewSchema } from "../operatorDtos.js";
import { RealProcessAcpHarness } from "./support/realProcessAcpHarness.js";
import { RealProcessLifecycleClient } from "./support/realProcessLifecycleClient.js";
import { TEST_REMOTE_AGENT_OWNER_ID } from "./support/remoteAgentOwnerFixture.js";

const harnesses: RealProcessAcpHarness[] = [];
afterEach(async () => {
  await Promise.all(harnesses.splice(0).map((harness) => harness.dispose()));
  vi.unstubAllEnvs();
});

describe("real Server operator observation consumed by CLI", () => {
  it.each([
    "dispatch",
    "observe"
  ] as const)("preserves the envelope digest and exact identity through %s", async (method) => {
    const harness = await RealProcessAcpHarness.create({
      acpScenario: "load-capable-permission",
      readinessTimeoutMs: 20_000
    });
    harnesses.push(harness);
    vi.stubEnv("PLANWEAVE_HOME", harness.paths.projectHome);
    await harness.startAll();
    await harness.waitForHostOnline();
    await harness.acpControl.pause(["session/prompt"]);
    const client = new RealProcessLifecycleClient(harness, 30_000);
    const endpointId = await client.availableAgentEndpointId();
    vi.stubEnv("PLANWEAVE_OPERATOR_TOKEN", harness.operatorToken);
    vi.stubEnv("PLANWEAVE_HUMAN_PRINCIPAL_ID", TEST_REMOTE_AGENT_OWNER_ID);
    vi.stubEnv(
      "PLANWEAVE_HUMAN_IDENTITY_TOKEN",
      harness
        .remoteAgentOwnerIdentityHeaders()
        ["x-planweave-human-identity"].replace(/^Bearer /, "")
    );
    await writeOperatorExecutionProfiles({
      home: harness.paths.projectHome,
      serverOrigin: harness.origin
    });
    // The raw client establishes a real operation; no operation response is supplied by a mock.
    const raw = await client.rawDispatch({
      blockRef: "T-001#B-001",
      idempotencyKey: `operator-cli-${method}`,
      agentEndpointId: endpointId
    });
    expect(raw.status).toBe(202);
    const produced = operatorPublicOperationViewSchema.parse(raw.body);
    const context = await createOwnerCanvasRunContext({
      projectRoot: harness.paths.projectRoot,
      options: { connectionProfile: "profile-1" },
      scope: { kind: "block", blockRef: "T-001#B-001" },
      target: { policy: "remote", agentEndpointId: endpointId },
      identity: { name: "codex", agentId: "codex" },
      eventFormat: "execution-v1"
    });
    const binding = context.binding;
    if (binding.kind !== "remote") throw new Error("expected remote binding");
    const intent = {
      schemaVersion: "remote-run/v3" as const,
      projectId: harness.projectId,
      canvasId: "default",
      blockRef: "T-001#B-001",
      agentEndpointId: endpointId,
      idempotencyKey: `operator-cli-${method}`,
      expectedResponsibilityRevision: 0,
      expectedReviewerRevision: 0,
      executionTargetRevision: 0,
      contentRevision: binding.contentRevision,
      graphFingerprint: binding.graphFingerprint
    };
    const consumed =
      method === "dispatch"
        ? await context.ports.command.dispatch({ binding, intent })
        : await context.ports.query.observe({ binding, operationId: produced.operationId });
    expect(consumed).toMatchObject({
      operationId: produced.operationId,
      dispatchId: produced.dispatchId,
      executionAttemptId: produced.executionAttemptId,
      envelopeDigest: produced.envelopeDigest,
      agentEndpoint: { endpointId },
      attempt: { leaseId: produced.attempt.leaseId },
      diagnostics: { attemptId: produced.executionAttemptId }
    });
    expect(produced.envelopeDigest).toMatch(/^envelope:sha256:[a-f0-9]{64}$/);
    expect(consumed.attempt.hostId).toBeUndefined();
  }, 90_000);
});
