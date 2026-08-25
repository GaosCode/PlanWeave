/**
 * Real multi-process adversarial authorization matrix (RV-002#B-003 / FIX-RV-002).
 *
 * Exercises public operator HTTP APIs and Host artifact routes against a live
 * Server + Host topology. Complements artifactAdversarialBoundary (in-process)
 * by proving process-level cross-host/project, lease, revoke, envelope, and
 * oversize fences with sensitivity checks (safe vs unsafe variants).
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { join, relative } from "node:path";
import { claimDispatchedBlock, submitBlockResult } from "@planweave-ai/runtime";
import { afterEach, describe, expect, it } from "vitest";
import { writeReport } from "../../../runtime/src/__tests__/promptTestHelpers.js";
import {
  RealProcessAcpHarness,
  type RealProcessAcpHarnessOptions
} from "./support/realProcessAcpHarness.js";
import { remoteAcpManifestWithDependency } from "./support/realProcessAcpManifests.js";
import { RealProcessLifecycleClient } from "./support/realProcessLifecycleClient.js";
import { TEST_REMOTE_AGENT_OWNER_ID } from "./support/remoteAgentOwnerFixture.js";

const harnesses: RealProcessAcpHarness[] = [];

afterEach(async () => {
  await Promise.all(
    harnesses.splice(0).map(async (harness) => {
      await harness.dispose();
    })
  );
});

async function createHarness(
  options: RealProcessAcpHarnessOptions = {}
): Promise<{ harness: RealProcessAcpHarness; client: RealProcessLifecycleClient }> {
  const harness = await RealProcessAcpHarness.create({
    acpScenario: "success",
    readinessTimeoutMs: 20_000,
    ...options
  });
  harnesses.push(harness);
  return { harness, client: new RealProcessLifecycleClient(harness, 90_000) };
}

type MatrixCase = {
  name: string;
  run: (ctx: {
    harness: RealProcessAcpHarness;
    client: RealProcessLifecycleClient;
    operationId: string;
    dispatchId: string;
    executionAttemptId: string;
    leaseId: string;
    stateVersion: number;
  }) => Promise<void>;
};

/** Fail-closed HTTP statuses for adversarial operator probes (includes unmapped 500). */
function assertDenied(
  response: { status: number; body: unknown },
  allowed: readonly number[] = [400, 401, 403, 404, 409, 413, 422, 500]
): void {
  expect(response.status, JSON.stringify(response.body)).toBeGreaterThanOrEqual(400);
  expect(allowed, JSON.stringify(response.body)).toContain(response.status);
  // Never accept a success-shaped body for a denial probe.
  expect(response.status).not.toBe(202);
  expect(response.status).not.toBe(200);
}

function assertActionNotEffected(
  client: RealProcessLifecycleClient,
  actionId: string,
  dispatchId: string
): void {
  const settled = client.countServerRows(
    "remote_execution_actions",
    "action_id=? AND state IN ('delivered','acknowledged','settled')",
    [actionId]
  );
  expect(settled).toBe(0);
  expect(client.readServerDispatch(dispatchId).status).not.toBe("cancelled");
  expect(client.readServerDispatch(dispatchId).status).not.toBe("completed");
}

function artifactFileSystemSnapshot(root: string): Array<{
  path: string;
  sizeBytes: number;
  sha256: string;
}> {
  if (!existsSync(root)) return [];
  const files: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) files.push(path);
    }
  };
  visit(root);
  return files.sort().map((path) => {
    const bytes = readFileSync(path);
    return {
      path: relative(root, path),
      sizeBytes: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex")
    };
  });
}

describe("real-process adversarial authorization matrix", () => {
  it("operator and action identity fence matrix (wrong principal/scope/lease/version/schema/cursor)", async () => {
    const projectOperatorToken = `pw_operator_${"J".repeat(43)}`;
    const { harness, client } = await createHarness({ projectOperatorToken });
    await harness.startAll();
    await harness.acpControl.pause(["session/prompt"]);

    const dispatched = await client.dispatch({
      blockRef: "T-001#B-001",
      idempotencyKey: "auth-matrix-1"
    });
    await client.waitForDispatchStatus(dispatched.operationId, ["leased", "running"]);
    // ACP barrier is session/prompt, so session/new is durable before probes begin.
    await harness.acpControl.waitUntilLifecycleContains("paused session/prompt", 30_000);
    const view = await client.observe(dispatched.operationId);
    const leaseId = view.attempt.leaseId;
    expect(leaseId).toEqual(expect.any(String));

    const ctx = {
      harness,
      client,
      operationId: view.operationId,
      dispatchId: view.dispatchId,
      executionAttemptId: view.executionAttemptId,
      leaseId: leaseId!,
      stateVersion: view.attempt.stateVersion
    };

    const cases: MatrixCase[] = [
      {
        name: "missing Authorization",
        run: async ({ client: c, operationId }) => {
          const denied = await c.rawRequest({
            method: "GET",
            path: `/api/v1/remote-operations/${encodeURIComponent(operationId)}`,
            authorization: null
          });
          expect(denied.status).toBe(401);
          // Sensitivity: authenticated observation must succeed.
          const allowed = await c.rawRequest({
            method: "GET",
            path: `/api/v1/remote-operations/${encodeURIComponent(operationId)}`
          });
          expect(allowed.status).toBe(200);
        }
      },
      {
        name: "wrong operator token",
        run: async ({ client: c, operationId }) => {
          const denied = await c.rawRequest({
            method: "GET",
            path: `/api/v1/remote-operations/${encodeURIComponent(operationId)}`,
            authorization: "definitely-not-the-harness-token"
          });
          expect(denied.status).toBe(401);
          const allowed = await c.rawRequest({
            method: "GET",
            path: `/api/v1/remote-operations/${encodeURIComponent(operationId)}`
          });
          expect(allowed.status).toBe(200);
        }
      },
      {
        name: "wrong projectId on create",
        run: async ({ client: c, operationId, dispatchId }) => {
          // Positive control: the Owner Fleet operator reaches the real project/runtime seam.
          const agentEndpointId = await c.availableAgentEndpointId();
          const trusted = await c.rawRequest({
            method: "POST",
            path: "/api/v1/remote-operations",
            body: {
              schemaVersion: "remote-run/v3",
              projectId: c.harness.projectId,
              canvasId: "default",
              blockRef: "T-001#B-001",
              agentEndpointId,
              idempotencyKey: "auth-matrix-1",
              expectedResponsibilityRevision: 0,
              expectedReviewerRevision: 0,
              humanPrincipalId: TEST_REMOTE_AGENT_OWNER_ID
            }
          });
          expect(trusted).toMatchObject({
            status: 202,
            body: { operationId, dispatchId }
          });

          const collaborationOperatorDenied = await c.rawRequest({
            method: "POST",
            path: "/api/v1/remote-operations",
            authorization: projectOperatorToken,
            body: {
              schemaVersion: "remote-run/v3",
              projectId: c.harness.projectId,
              canvasId: "default",
              blockRef: "T-001#B-001",
              agentEndpointId,
              idempotencyKey: "auth-matrix-project-operator",
              expectedResponsibilityRevision: 0,
              expectedReviewerRevision: 0,
              humanPrincipalId: TEST_REMOTE_AGENT_OWNER_ID
            }
          });
          expect(collaborationOperatorDenied).toMatchObject({
            status: 403,
            body: { error: "operator_admin_required" }
          });

          const durableBaseline = async () => ({
            operation: await c.observe(operationId),
            dispatch: c.readServerDispatch(dispatchId),
            operationCount: c.countServerRows("remote_operations"),
            dispatchCount: c.countServerRows("dispatches"),
            attemptCount: c.countServerRows("remote_execution_attempts"),
            grantCount: c.countServerRows("artifact_grants"),
            linkCount: c.countServerRows("dispatch_artifact_links"),
            blobCount: c.countServerRows("artifact_blobs"),
            links: c.readServerArtifactLinks(dispatchId),
            envelope: c.readServerEnvelopeCanonical(dispatchId),
            artifactFiles: artifactFileSystemSnapshot(join(c.harness.paths.serverData, "artifacts"))
          });
          const before = await durableBaseline();
          const denied = await c.rawRequest({
            method: "POST",
            path: "/api/v1/remote-operations",
            authorization: projectOperatorToken,
            body: {
              schemaVersion: "remote-run/v3",
              projectId: "foreign-project-id",
              canvasId: "default",
              blockRef: "T-001#B-001",
              agentEndpointId,
              idempotencyKey: "auth-wrong-project",
              expectedResponsibilityRevision: 0,
              expectedReviewerRevision: 0,
              humanPrincipalId: TEST_REMOTE_AGENT_OWNER_ID
            }
          });
          expect({ status: denied.status, body: denied.body }).toEqual({
            status: 403,
            body: { error: "operator_scope_forbidden" }
          });
          expect(await durableBaseline()).toEqual(before);
        }
      },
      {
        name: "unknown operation observe",
        run: async ({ client: c }) => {
          const denied = await c.rawRequest({
            method: "GET",
            path: `/api/v1/remote-operations/${encodeURIComponent("operation-does-not-exist")}`
          });
          assertDenied(denied, [404, 403]);
        }
      },
      {
        name: "action with wrong leaseId",
        run: async ({ client: c, operationId, dispatchId, executionAttemptId, stateVersion }) => {
          const denied = await c.rawRequest({
            method: "POST",
            path: `/api/v1/remote-operations/${encodeURIComponent(operationId)}/actions`,
            body: {
              actionId: "auth-wrong-lease",
              operationId,
              dispatchId,
              executionAttemptId,
              expectedAttemptVersion: stateVersion,
              kind: "cancel",
              leaseId: "lease-foreign",
              reason: "wrong lease attack"
            }
          });
          // Action rows may be recorded before validation; they must not deliver or cancel.
          assertDenied(denied, [400, 409, 422, 500]);
          assertActionNotEffected(c, "auth-wrong-lease", dispatchId);
        }
      },
      {
        name: "action with wrong dispatchId",
        run: async ({
          client: c,
          operationId,
          dispatchId,
          executionAttemptId,
          leaseId,
          stateVersion
        }) => {
          const denied = await c.rawRequest({
            method: "POST",
            path: `/api/v1/remote-operations/${encodeURIComponent(operationId)}/actions`,
            body: {
              actionId: "auth-wrong-dispatch",
              operationId,
              dispatchId: "dispatch-foreign",
              executionAttemptId,
              expectedAttemptVersion: stateVersion,
              kind: "cancel",
              leaseId,
              reason: "wrong dispatch attack"
            }
          });
          assertDenied(denied, [400, 409, 422, 500]);
          assertActionNotEffected(c, "auth-wrong-dispatch", dispatchId);
        }
      },
      {
        name: "action with wrong executionAttemptId",
        run: async ({ client: c, operationId, dispatchId, leaseId, stateVersion }) => {
          const denied = await c.rawRequest({
            method: "POST",
            path: `/api/v1/remote-operations/${encodeURIComponent(operationId)}/actions`,
            body: {
              actionId: "auth-wrong-attempt",
              operationId,
              dispatchId,
              executionAttemptId: "attempt-foreign",
              expectedAttemptVersion: stateVersion,
              kind: "cancel",
              leaseId,
              reason: "wrong attempt attack"
            }
          });
          assertDenied(denied, [400, 409, 422, 500]);
          assertActionNotEffected(c, "auth-wrong-attempt", dispatchId);
        }
      },
      {
        name: "action with stale expectedAttemptVersion",
        run: async ({
          client: c,
          operationId,
          dispatchId,
          executionAttemptId,
          leaseId,
          stateVersion
        }) => {
          const denied = await c.rawRequest({
            method: "POST",
            path: `/api/v1/remote-operations/${encodeURIComponent(operationId)}/actions`,
            body: {
              actionId: "auth-stale-version",
              operationId,
              dispatchId,
              executionAttemptId,
              // Always diverge from the live attempt version (0 is a valid version).
              expectedAttemptVersion: stateVersion === 0 ? 1 : stateVersion - 1,
              kind: "cancel",
              leaseId,
              reason: "stale version attack"
            }
          });
          assertDenied(denied, [409, 400, 422, 500]);
          assertActionNotEffected(c, "auth-stale-version", dispatchId);
        }
      },
      {
        name: "invalid schema / missing required action fields",
        run: async ({ client: c, operationId }) => {
          const denied = await c.rawRequest({
            method: "POST",
            path: `/api/v1/remote-operations/${encodeURIComponent(operationId)}/actions`,
            body: { kind: "cancel" }
          });
          assertDenied(denied, [400, 409, 422]);
        }
      },
      {
        name: "malformed JSON body",
        run: async ({ client: c, operationId }) => {
          const denied = await c.rawRequest({
            method: "POST",
            path: `/api/v1/remote-operations/${encodeURIComponent(operationId)}/actions`,
            body: "{not-json",
            headers: { "content-type": "application/json" }
          });
          expect(denied.status).toBe(400);
        }
      },
      {
        name: "out-of-order / invalid event cursor",
        run: async ({ client: c, operationId }) => {
          const negative = await c.rawRequest({
            method: "GET",
            path: `/api/v1/remote-operations/${encodeURIComponent(operationId)}/events?afterCursor=-1`
          });
          // Zod rejects negative; missing stream can surface 404 before validation differences matter.
          assertDenied(negative, [400, 404, 422]);

          const huge = await c.rawRequest({
            method: "GET",
            path: `/api/v1/remote-operations/${encodeURIComponent(operationId)}/events?afterCursor=999999`
          });
          // Cursor beyond high-watermark fails closed (404/400/409) or empty-safe 200.
          if (huge.status === 200) {
            const body = huge.body as { events?: unknown[] };
            expect(body.events ?? []).toEqual([]);
          } else {
            assertDenied(huge, [400, 404, 422, 409]);
          }

          // At the ACP barrier the event stream may not exist yet (404). When present, cursor 0 is valid.
          const zero = await c.rawRequest({
            method: "GET",
            path: `/api/v1/remote-operations/${encodeURIComponent(operationId)}/events?afterCursor=0`
          });
          expect([200, 404]).toContain(zero.status);
          if (zero.status === 200) {
            // Sensitivity: invalid negative stays denied even when zero works.
            expect(negative.status).not.toBe(200);
          }
        }
      },
      {
        name: "invalid hosts pagination",
        run: async ({ client: c }) => {
          const denied = await c.rawRequest({
            method: "GET",
            path: "/api/v1/hosts?limit=1&limit=2"
          });
          expect(denied.status).toBe(400);
          const allowed = await c.rawRequest({
            method: "GET",
            path: "/api/v1/hosts?cursor=0&limit=50"
          });
          expect(allowed.status).toBe(200);
        }
      },
      {
        name: "interaction respond with wrong dispatch identity",
        run: async ({ client: c, operationId, leaseId, executionAttemptId }) => {
          const denied = await c.rawRequest({
            method: "POST",
            path: `/api/v1/remote-operations/${encodeURIComponent(operationId)}/interactions/respond`,
            body: {
              type: "interaction.permission_response",
              actionId: "permission:fabricated",
              dispatchId: "dispatch-foreign",
              leaseId,
              executionAttemptId,
              acpSessionId: "session-fabricated",
              decision: "allow_once"
            }
          });
          assertDenied(denied, [400, 403, 404, 409, 422, 500]);
        }
      }
    ];

    const results: Array<{ name: string; ok: boolean; error?: string }> = [];
    for (const entry of cases) {
      try {
        await entry.run(ctx);
        results.push({ name: entry.name, ok: true });
      } catch (error) {
        results.push({
          name: entry.name,
          ok: false,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }
    const failed = results.filter((result) => !result.ok);
    expect(failed, JSON.stringify(failed, null, 2)).toEqual([]);

    // Operation must remain non-terminal success after adversarial probes (still at barrier).
    const stillLive = await client.observe(dispatched.operationId);
    expect(stillLive.state).not.toBe("completed");
    expect(client.countLifecycleFragment("session/new")).toBe(1);

    await harness.acpControl.resume();
    const terminal = await client.waitForTerminal(dispatched.operationId);
    expect(terminal.state).toBe("completed");

    // Post-terminal sensitivity: legitimate cursor 0 succeeds; negative and ahead fail closed.
    const zeroAfter = await client.rawRequest({
      method: "GET",
      path: `/api/v1/remote-operations/${encodeURIComponent(dispatched.operationId)}/events?afterCursor=0`
    });
    expect(zeroAfter.status).toBe(200);
    const negativeAfter = await client.rawRequest({
      method: "GET",
      path: `/api/v1/remote-operations/${encodeURIComponent(dispatched.operationId)}/events?afterCursor=-1`
    });
    assertDenied(negativeAfter, [400, 422]);
    const body = zeroAfter.body as { highWatermark?: number };
    const ahead = (body.highWatermark ?? 0) + 10;
    const aheadAfter = await client.rawRequest({
      method: "GET",
      path: `/api/v1/remote-operations/${encodeURIComponent(dispatched.operationId)}/events?afterCursor=${ahead}`
    });
    // cursor_ahead is fail-closed; HTTP mapping may still be unmapped 500.
    assertDenied(aheadAfter, [400, 404, 409, 422, 500]);
  }, 180_000);

  it("action after terminal rejects further cancel without rewriting success", async () => {
    const { harness, client } = await createHarness();
    await harness.startAll();
    const dispatched = await client.dispatch({
      blockRef: "T-001#B-001",
      idempotencyKey: "auth-after-deadline-1"
    });
    const terminal = await client.waitForTerminal(dispatched.operationId);
    expect(terminal.state).toBe("completed");
    const leaseId = terminal.attempt.leaseId;
    expect(leaseId).toEqual(expect.any(String));

    const denied = await client.rawRequest({
      method: "POST",
      path: `/api/v1/remote-operations/${encodeURIComponent(terminal.operationId)}/actions`,
      body: {
        actionId: "auth-after-terminal-cancel",
        operationId: terminal.operationId,
        dispatchId: terminal.dispatchId,
        executionAttemptId: terminal.executionAttemptId,
        expectedAttemptVersion: terminal.attempt.stateVersion,
        kind: "cancel",
        leaseId,
        reason: "after terminal"
      }
    });
    assertDenied(denied, [400, 409, 422, 500]);

    const still = await client.observe(terminal.operationId);
    expect(still.state).toBe("completed");
    expect(still.runtime.terminalReceipt?.outcome).toBe("completed");
    expect(client.readServerDispatch(terminal.dispatchId).status).toBe("completed");
  }, 120_000);

  it("foreign block ownership: second idempotency key cannot hijack active claim", async () => {
    const { harness, client } = await createHarness({ hostCapacity: 1 });
    await harness.startAll();
    await harness.acpControl.pause(["session/prompt"]);

    const owner = await client.dispatch({
      blockRef: "T-001#B-001",
      idempotencyKey: "auth-owner-a"
    });
    await client.waitForDispatchStatus(owner.operationId, ["leased", "running"]);

    const hijack = await client.rawRequest({
      method: "POST",
      path: "/api/v1/remote-operations",
      body: {
        projectId: harness.projectId,
        canvasId: "default",
        blockRef: "T-001#B-001",
        idempotencyKey: "auth-owner-b"
      }
    });
    // Either hard reject (4xx/500 fail-closed) or non-hijacking 202 of the same operation.
    if (hijack.status === 202) {
      const body = hijack.body as { operationId?: string };
      expect(body.operationId).toBe(owner.operationId);
    } else {
      assertDenied(hijack, [400, 403, 409, 422, 500]);
    }
    expect(client.countServerRows("remote_execution_attempts")).toBe(1);

    await harness.acpControl.resume();
    const terminal = await client.waitForTerminal(owner.operationId);
    expect(terminal.state).toBe("completed");
  }, 120_000);

  it("process artifact auth matrix proves positive seams before exact denials", async () => {
    const { harness, client } = await createHarness({
      hostCapacity: 2,
      manifest: remoteAcpManifestWithDependency()
    });
    const inputContent = "authorization matrix upstream input\n";
    const previousPlanWeaveHome = process.env.PLANWEAVE_HOME;
    try {
      process.env.PLANWEAVE_HOME = harness.paths.projectHome;
      await claimDispatchedBlock({
        projectRoot: harness.paths.projectRoot,
        ref: "T-001#B-001"
      });
      const reportPath = await writeReport(
        harness.paths.projectRoot,
        "authorization-input.md",
        inputContent
      );
      await submitBlockResult({
        projectRoot: harness.paths.projectRoot,
        ref: "T-001#B-001",
        reportPath
      });
    } finally {
      if (previousPlanWeaveHome === undefined) delete process.env.PLANWEAVE_HOME;
      else process.env.PLANWEAVE_HOME = previousPlanWeaveHome;
    }

    await harness.startAll();
    await harness.acpControl.pause(["session/prompt"]);
    const ownerHost = await harness.waitForHostOnline();
    const ownerCredential = client.readHostCredential();
    expect(ownerCredential.hostId).toBe(ownerHost.id);

    const secondary = await harness.startSecondaryHost({
      key: "foreign",
      displayName: "Foreign Auth Host",
      capabilities: ["other.capability"],
      capacity: 1,
      acpScenario: "success"
    });
    const foreignCredential = client.readHostCredential(secondary.handle.dataDir);
    expect(foreignCredential.hostId).toBe(secondary.id);
    expect(foreignCredential.hostId).not.toBe(ownerCredential.hostId);

    const ownerEndpoint = await client.availableAgentEndpointForHostDisplayName(
      ownerHost.displayName
    );
    const dispatched = await client.dispatch({
      blockRef: "T-001#B-002",
      idempotencyKey: "auth-matrix-process-scope-1",
      agentEndpointId: ownerEndpoint.endpointId
    });
    await client.waitForDispatchStatus(dispatched.operationId, ["leased", "running"]);
    await harness.acpControl.waitUntilLifecycleContains("paused session/prompt", 30_000);
    const view = await client.observe(dispatched.operationId);
    const leaseId = view.attempt.leaseId;
    expect(leaseId).toEqual(expect.any(String));
    expect(view.agentEndpoint).toMatchObject({
      endpointId: ownerEndpoint.endpointId,
      hostDisplayName: ownerHost.displayName
    });
    expect(view.attempt.hostId).toBeUndefined();
    expect(client.readServerDispatch(view.dispatchId).host_id).toBe(ownerHost.id);

    const envelopeBefore = client.readServerEnvelopeCanonical(view.dispatchId);
    const envelope = client.readServerEnvelope(view.dispatchId);
    expect(envelope).toMatchObject({
      projectId: harness.projectId,
      blockRef: "T-001#B-002",
      execution: {
        dispatchId: view.dispatchId,
        attemptId: view.executionAttemptId
      }
    });
    const inputArtifacts = envelope.inputArtifacts as Array<{
      artifactRef: string;
      logicalName: string;
    }>;
    expect(inputArtifacts).toHaveLength(1);
    const inputArtifact = inputArtifacts[0];
    const inputSha = inputArtifact.artifactRef.slice("artifact:sha256:".length);
    expect(client.readServerArtifactBytes(inputArtifact.artifactRef)).toEqual(
      Buffer.from(inputContent)
    );

    const artifactFixture = (label: string) => {
      const bytes = Buffer.from(`auth-matrix-${label}\n`, "utf8");
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      return { bytes, sha256, ref: `artifact:sha256:${sha256}` };
    };
    const artifactUrl = (
      sha256: string,
      overrides?: { hostId?: string; leaseId?: string; executionAttemptId?: string }
    ) =>
      client.artifactUrl({
        hostId: overrides?.hostId ?? ownerCredential.hostId,
        dispatchId: view.dispatchId,
        leaseId: overrides?.leaseId ?? leaseId!,
        executionAttemptId: overrides?.executionAttemptId ?? view.executionAttemptId,
        sha256
      });
    const parseBody = (text: string): unknown => {
      if (text.length === 0) return null;
      try {
        return JSON.parse(text);
      } catch {
        return text;
      }
    };
    const putArtifact = async (
      url: string,
      token: string,
      artifact: ReturnType<typeof artifactFixture>
    ): Promise<{ status: number; body: unknown }> => {
      const response = await fetch(url, {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${token}`,
          "content-type": "text/plain",
          "content-length": String(artifact.bytes.byteLength),
          "x-planweave-artifact-operation-id": `auth-probe-${artifact.sha256.slice(0, 12)}`,
          "x-planweave-artifact-purpose": "report"
        },
        body: artifact.bytes
      });
      return { status: response.status, body: parseBody(await response.text()) };
    };
    const getArtifact = async (
      url: string,
      token: string
    ): Promise<{ status: number; body: unknown; etag: string | null }> => {
      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` }
      });
      return {
        status: response.status,
        body: parseBody(await response.text()),
        etag: response.headers.get("etag")
      };
    };
    const persistenceBaseline = async () => ({
      operation: await client.observe(view.operationId),
      dispatch: client.readServerDispatch(view.dispatchId),
      attemptCount: client.countServerRows("remote_execution_attempts", "operation_id=?", [
        view.operationId
      ]),
      grantCount: client.countServerRows("artifact_grants", "dispatch_id=?", [view.dispatchId]),
      blobCount: client.countServerRows("artifact_blobs"),
      links: client.readServerArtifactLinks(view.dispatchId),
      envelope: client.readServerEnvelopeCanonical(view.dispatchId)
    });
    const expectDeniedWithoutMutation = async (
      probe: () => Promise<{ status: number; body: unknown }>,
      expected: { status: 401 | 403; error: string },
      absentArtifactRef?: string
    ) => {
      const before = await persistenceBaseline();
      if (absentArtifactRef) expect(client.serverArtifactBlobExists(absentArtifactRef)).toBe(false);
      const response = await probe();
      expect(response).toEqual({ status: expected.status, body: { error: expected.error } });
      expect(await persistenceBaseline()).toEqual(before);
      if (absentArtifactRef) expect(client.serverArtifactBlobExists(absentArtifactRef)).toBe(false);
    };

    // Positive PUT proves owner credential + bound lease/attempt reaches persistence.
    const ownerReport = artifactFixture("owner-positive-report");
    const ownerReportUrl = artifactUrl(ownerReport.sha256);
    const ownerPut = await putArtifact(
      ownerReportUrl,
      ownerCredential.credentialToken,
      ownerReport
    );
    expect(ownerPut).toEqual({
      status: 201,
      body: expect.objectContaining({
        ref: ownerReport.ref,
        sha256: ownerReport.sha256,
        sizeBytes: ownerReport.bytes.byteLength,
        mediaType: "text/plain"
      })
    });
    expect(client.readServerArtifactBytes(ownerReport.ref)).toEqual(ownerReport.bytes);
    expect(client.readServerArtifactLinks(view.dispatchId)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          project_id: harness.projectId,
          host_id: ownerHost.id,
          dispatch_id: view.dispatchId,
          lease_id: leaseId,
          execution_attempt_id: view.executionAttemptId,
          artifact_ref: ownerReport.ref,
          purpose: "report",
          permission: "report_write",
          grant_id: `auth-probe-${ownerReport.sha256.slice(0, 12)}`,
          produced_by_host_id: ownerHost.id
        })
      ])
    );

    // Positive GET proves the production-created input grant and exact bytes.
    const ownerGet = await getArtifact(artifactUrl(inputSha), ownerCredential.credentialToken);
    expect(ownerGet).toEqual({
      status: 200,
      body: inputContent,
      etag: `"sha256:${inputSha}"`
    });
    expect(client.readServerArtifactLinks(view.dispatchId)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          project_id: harness.projectId,
          host_id: ownerHost.id,
          dispatch_id: view.dispatchId,
          lease_id: leaseId,
          execution_attempt_id: view.executionAttemptId,
          artifact_ref: inputArtifact.artifactRef,
          purpose: "input",
          permission: "input_read",
          logical_name: inputArtifact.logicalName,
          produced_by_host_id: null
        })
      ])
    );

    const crossHostPutArtifact = artifactFixture("cross-host-put");
    await expectDeniedWithoutMutation(
      () =>
        putArtifact(
          artifactUrl(crossHostPutArtifact.sha256, { hostId: foreignCredential.hostId }),
          foreignCredential.credentialToken,
          crossHostPutArtifact
        ),
      { status: 403, error: "artifact_scope_forbidden" },
      crossHostPutArtifact.ref
    );
    await expectDeniedWithoutMutation(
      async () => {
        const { etag: _etag, ...response } = await getArtifact(
          artifactUrl(inputSha, { hostId: foreignCredential.hostId }),
          foreignCredential.credentialToken
        );
        return response;
      },
      { status: 403, error: "artifact_scope_forbidden" }
    );

    const wrongLeaseArtifact = artifactFixture("wrong-lease");
    await expectDeniedWithoutMutation(
      () =>
        putArtifact(
          artifactUrl(wrongLeaseArtifact.sha256, { leaseId: "lease-foreign-not-bound" }),
          ownerCredential.credentialToken,
          wrongLeaseArtifact
        ),
      { status: 403, error: "artifact_scope_forbidden" },
      wrongLeaseArtifact.ref
    );
    const wrongAttemptArtifact = artifactFixture("wrong-attempt");
    await expectDeniedWithoutMutation(
      () =>
        putArtifact(
          artifactUrl(wrongAttemptArtifact.sha256, {
            executionAttemptId: "attempt-foreign-not-bound"
          }),
          ownerCredential.credentialToken,
          wrongAttemptArtifact
        ),
      { status: 403, error: "artifact_scope_forbidden" },
      wrongAttemptArtifact.ref
    );

    const invalidTokenArtifact = artifactFixture("invalid-host-token");
    await expectDeniedWithoutMutation(
      () =>
        putArtifact(
          artifactUrl(invalidTokenArtifact.sha256),
          "not-a-host-token",
          invalidTokenArtifact
        ),
      { status: 401, error: "Unauthorized" },
      invalidTokenArtifact.ref
    );
    const operatorTokenArtifact = artifactFixture("operator-as-host");
    await expectDeniedWithoutMutation(
      () =>
        putArtifact(
          artifactUrl(operatorTokenArtifact.sha256),
          harness.operatorToken,
          operatorTokenArtifact
        ),
      { status: 401, error: "Unauthorized" },
      operatorTokenArtifact.ref
    );

    const oversizedBody = "x".repeat(300 * 1024);
    const oversizeOperatorBaseline = await persistenceBaseline();
    const oversizeOperator = await client.rawRequest({
      method: "POST",
      path: "/api/v1/remote-operations",
      body: oversizedBody,
      headers: { "content-type": "application/json" }
    });
    expect(oversizeOperator).toMatchObject({
      status: 413,
      body: { error: "operator_body_too_large" }
    });
    expect(await persistenceBaseline()).toEqual(oversizeOperatorBaseline);

    const oversizedArtifact = artifactFixture("oversized-artifact");
    const oversizeUrl = new URL(artifactUrl(oversizedArtifact.sha256));
    const oversizeBaseline = await persistenceBaseline();
    expect(client.serverArtifactBlobExists(oversizedArtifact.ref)).toBe(false);
    const oversizeResponse = await new Promise<{ status: number; body: unknown }>(
      (resolve, reject) => {
        const req = httpRequest(
          {
            protocol: oversizeUrl.protocol,
            hostname: oversizeUrl.hostname,
            port: oversizeUrl.port,
            path: oversizeUrl.pathname,
            method: "PUT",
            headers: {
              Authorization: `Bearer ${ownerCredential.credentialToken}`,
              "content-type": "text/plain",
              "content-length": String(200 * 1024 * 1024),
              "x-planweave-artifact-operation-id": "auth-oversize-artifact",
              "x-planweave-artifact-purpose": "report"
            }
          },
          (response) => {
            const chunks: Buffer[] = [];
            response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
            response.on("end", () =>
              resolve({
                status: response.statusCode ?? 0,
                body: parseBody(Buffer.concat(chunks).toString("utf8"))
              })
            );
          }
        );
        req.on("error", reject);
        req.end();
      }
    );
    expect(oversizeResponse).toEqual({ status: 413, body: { error: "artifact_too_large" } });
    expect(await persistenceBaseline()).toEqual(oversizeBaseline);
    expect(client.serverArtifactBlobExists(oversizedArtifact.ref)).toBe(false);

    // Revoke seam positive controls: the exact same owner PUT/GET still succeeds immediately before revoke.
    expect(
      await putArtifact(ownerReportUrl, ownerCredential.credentialToken, ownerReport)
    ).toMatchObject({ status: 201, body: { ref: ownerReport.ref } });
    expect(await getArtifact(artifactUrl(inputSha), ownerCredential.credentialToken)).toEqual({
      status: 200,
      body: inputContent,
      etag: `"sha256:${inputSha}"`
    });
    const revoke = await client.rawRequest({
      method: "POST",
      path: `/api/v1/hosts/${encodeURIComponent(ownerHost.id)}/revoke`
    });
    expect(revoke).toMatchObject({
      status: 200,
      body: { id: ownerHost.id, revokedAt: expect.any(String) }
    });

    const revokedPutArtifact = artifactFixture("revoked-put");
    await expectDeniedWithoutMutation(
      () =>
        putArtifact(
          artifactUrl(revokedPutArtifact.sha256),
          ownerCredential.credentialToken,
          revokedPutArtifact
        ),
      { status: 401, error: "Unauthorized" },
      revokedPutArtifact.ref
    );
    await expectDeniedWithoutMutation(
      async () => {
        const { etag: _etag, ...response } = await getArtifact(
          artifactUrl(inputSha),
          ownerCredential.credentialToken
        );
        return response;
      },
      { status: 401, error: "Unauthorized" }
    );

    const stillLive = await client.observe(dispatched.operationId);
    expect(stillLive.state).not.toBe("completed");
    expect(stillLive.runtime.terminalReceipt?.outcome).not.toBe("completed");
    expect(client.readServerEnvelopeCanonical(view.dispatchId)).toBe(envelopeBefore);
    expect(
      client.countServerRows("remote_execution_attempts", "operation_id=?", [view.operationId])
    ).toBe(1);
    expect(
      client.countServerRows("dispatch_artifact_links", "dispatch_id=? AND purpose='report'", [
        view.dispatchId
      ])
    ).toBe(1);
  }, 180_000);
});
