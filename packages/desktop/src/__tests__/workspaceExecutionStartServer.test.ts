import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { captureAuthorizedCanvasContent } from "@planweave-ai/runtime";
import { exampleHumanIdentityToken } from "@planweave-ai/collaboration-protocol/fixtures/collaboration";
import { HostEnrollmentService } from "../../../server/src/hostEnrollment.js";
import { OperatorSessionStore } from "../../../server/src/identity/operatorSessionStore.js";
import { WorkspaceIdentityRepository } from "../../../server/src/identity/workspaceRepository.js";
import { hashOperatorToken, OperatorTokenRegistry } from "../../../server/src/operatorAuth.js";
import { RemoteControlService } from "../../../server/src/remoteControlService.js";
import { setupFleetUnboundHost } from "../../../server/src/__tests__/support/remoteBlockCoordinatorFixture.js";
import { TEST_REMOTE_AGENT_OWNER_ID } from "../../../server/src/__tests__/support/remoteAgentOwnerFixture.js";
import { CollaborationService } from "../main/collaboration/collaborationService.js";
import { OperatorControlClient } from "../main/operatorControl/OperatorControlClient.js";
import type { OperatorControlService } from "../main/operatorControl/operatorControlService.js";
import { WorkspaceExecutionDesktopService } from "../main/workspaceExecutionDesktopService.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});

async function setup() {
  const f = await setupFleetUnboundHost();
  const token = `pw_operator_${"T".repeat(43)}`;
  new OperatorSessionStore(f.server.database).create({
    workspaceId: f.locator.workspaceId,
    operatorId: "operator-start-stop",
    credentialSha256: hashOperatorToken(token),
    issuedAt: "2026-08-01T00:00:00.000Z",
    expiresAt: "2030-01-01T00:00:00.000Z"
  });
  const authorization = new OperatorTokenRegistry(f.server.database, [
    {
      operatorId: "operator-start-stop",
      tokenSha256: hashOperatorToken(token),
      projectIds: [],
      serverAdmin: true
    }
  ]);
  const authenticated = authorization.authenticate(`Bearer ${token}`);
  if (!authenticated) throw new Error("operator_principal_required");
  const principal = { ...authenticated, humanPrincipalId: TEST_REMOTE_AGENT_OWNER_ID };
  const control = new RemoteControlService({
    authorization,
    enrollments: new HostEnrollmentService(f.server.database),
    hosts: f.hosts,
    agentEndpoints: f.agentEndpoints,
    remoteAgentAccess: f.remoteAgentAccess,
    remoteAgentRepository: f.remoteAgents,
    operations: f.operations,
    dispatches: f.dispatches,
    coordinator: f.coordinator,
    events: f.acpEvents,
    interactions: f.interactions,
    artifactContent: { readReport: async (ref) => f.artifacts.read(ref) },
    disconnectHost: () => {},
    workspaceIdentity: new WorkspaceIdentityRepository(f.server.database),
    authorizeProjectScope: () => {},
    resolveOwnerRuntimeScope: () => f.locator
  });
  const endpoint = control.listAgentEndpoints(principal, {
    humanPrincipalId: principal.humanPrincipalId,
    projectId: f.locator.projectId,
    canvasId: f.locator.canvasId
  }).items[0];
  if (!endpoint) throw new Error("endpoint_required");
  const content = await captureAuthorizedCanvasContent({
    projectRoot: f.workspace.root,
    canvasId: f.locator.canvasId,
    expectedPackageDir: f.workspace.init.workspace.packageDir,
    authorityProjectId: f.locator.projectId
  });
  let launches = 0;
  let catalog: (() => Promise<void>) | undefined;
  const client = new OperatorControlClient({
    profile: {
      profileId: "profile-server",
      displayName: "Server",
      serverBaseUrl: "https://operator.test/",
      allowInsecureTransport: false
    },
    credential: {
      getOperatorToken: () => token,
      getHumanIdentityToken: () => exampleHumanIdentityToken
    },
    request: async (input, init) => {
      const url = new URL(String(input));
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      if (url.pathname === "/api/v1/agent-endpoints") {
        if (catalog) await catalog();
        return Response.json(
          control.listAgentEndpoints(principal, Object.fromEntries(url.searchParams))
        );
      }
      if (url.pathname === "/api/v1/owner-canvas-materializations/head")
        return Response.json({
          schemaVersion: "owner-canvas-materialization/v1",
          scope: {
            ownerHumanPrincipalId: principal.humanPrincipalId,
            projectId: f.locator.projectId,
            canvasId: f.locator.canvasId
          },
          head: {
            kind: "present",
            revision: 1,
            content: {
              versionId: `version-${content.content.canonicalDigest}`,
              canonicalDigest: content.content.canonicalDigest,
              verification: "complete"
            }
          }
        });
      if (url.pathname === "/api/v1/remote-operations") {
        if (init?.method === "POST") {
          await control.dispatch(principal, body, "public-runtime-v1");
          launches += 1;
          throw new Error("accepted_response_lost");
        }
        return Response.json(
          await control.lookupOperation(
            principal,
            Object.fromEntries(url.searchParams),
            "public-runtime-v1"
          )
        );
      }
      const match = /^\/api\/v1\/remote-operations\/([^/]+)(.*)$/.exec(url.pathname);
      if (!match) throw new Error(`unexpected_route:${url.pathname}`);
      const [, operationId, suffix] = match;
      if (suffix === "/actions")
        return Response.json(await control.executeAction(principal, operationId, body), {
          status: 202
        });
      if (suffix === "/events")
        return Response.json(
          control.replayEvents(principal, operationId, url.searchParams.get("afterCursor"))
        );
      if (suffix === "/interactions")
        return Response.json(
          control.listPendingInteractions(
            principal,
            operationId,
            Object.fromEntries(url.searchParams)
          )
        );
      return Response.json(
        await control.observeOperation(principal, operationId, "public-runtime-v1")
      );
    }
  });
  const operatorControl: Pick<OperatorControlService, "withExecutionProfile"> = {
    withExecutionProfile: async (_profile, operation) => operation(client)
  };
  const root = await mkdtemp(join(tmpdir(), "planweave-start-stop-server-"));
  directories.push(root);
  const collaboration = new CollaborationService({
    profileStorePaths: { profilesPath: join(root, "profiles.json") },
    workspaceProfileStorePaths: { profilesPath: join(root, "workspace-profiles.json") },
    credentialsPath: join(root, "credentials.json"),
    invitationsPath: join(root, "invitations.json")
  });
  const input = {
    locator: {
      kind: "owner_canvas" as const,
      operatorProfileId: "profile-server",
      humanPrincipalId: principal.humanPrincipalId,
      projectRoot: f.workspace.root,
      projectId: f.locator.projectId,
      canvasId: f.locator.canvasId
    },
    blockRef: "T-001#B-001",
    agentEndpointId: endpoint.endpointId,
    effectiveExecutor: { name: "codex-acp", agentId: "codex" },
    startRequestId: "start-real-server"
  };
  const stop = {
    input,
    startRequestId: input.startRequestId,
    actionId: "stop-real-server",
    reason: "Desktop Auto Run stop requested."
  };
  return {
    f,
    input,
    stop,
    create: () => new WorkspaceExecutionDesktopService(collaboration, operatorControl, root),
    launches: () => launches,
    catalog: (value: () => Promise<void>) => {
      catalog = value;
    }
  };
}

it("retains a real accepted launch Stop through delivered cancellation and restart until Host terminal acknowledgement", async () => {
  const h = await setup();
  const first = h.create();
  await expect(first.start(h.input)).rejects.toMatchObject({ code: "operator_request_failed" });
  const operation = h.f.operations.findByIdempotencyKeyInScope({
    ...h.f.locator,
    blockRef: h.input.blockRef,
    idempotencyKey: `workspace-execution-${h.input.startRequestId}`
  });
  if (!operation) throw new Error("real_accepted_operation_required");
  const dispatch = h.f.dispatches.getRequired(operation.dispatchId);
  h.f.dispatches.accept(
    h.f.host.id,
    "host-started",
    dispatch.id,
    dispatch.leaseId,
    dispatch.executionAttemptId
  );
  expect(await first.cancelStart(h.stop)).toMatchObject({ confirmed: false });
  expect(h.f.operations.getRequired(operation.id).state).not.toBe("cancelled");
  const restarted = h.create();
  expect((await restarted.recoverCancellations({ locator: h.input.locator })).starts).toEqual([
    h.stop
  ]);
  expect(await restarted.cancelStart(h.stop)).toMatchObject({ confirmed: false });
  expect(
    h.f.mailbox
      .listAfter(h.f.host.id, 0)
      .filter((entry) => entry.command.type === "cancel_execution")
  ).toHaveLength(1);
  await h.f.dispatches.fail(
    h.f.host.id,
    "host-cancelled",
    dispatch.id,
    dispatch.leaseId,
    dispatch.executionAttemptId,
    { code: "execution_cancelled", message: "Cancelled by Host", retryable: false }
  );
  expect(await restarted.cancelStart(h.stop)).toMatchObject({ confirmed: true });
  expect((await restarted.recoverCancellations({ locator: h.input.locator })).starts).toEqual([]);
  await expect(restarted.start(h.input)).rejects.toThrow();
  expect(h.launches()).toBe(1);
});

it("prevents duplicate start admission before session persistence and preserves a settled Stop tombstone", async () => {
  const h = await setup();
  let release!: () => void;
  let reached!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const entered = new Promise<void>((resolve) => {
    reached = resolve;
  });
  h.catalog(async () => {
    reached();
    await gate;
    throw new Error("catalog_unavailable");
  });
  const first = h.create();
  const starting = first.start(h.input);
  const failure = expect(starting).rejects.toThrow();
  await entered;
  const duplicate = first.start(h.input);
  // Attach before releasing the catalog gate so duplicate admission cannot create an unhandled rejection.
  const duplicateFailure = expect(duplicate).rejects.toThrow();
  expect(await first.cancelStart(h.stop)).toMatchObject({ confirmed: false });
  release();
  await Promise.all([failure, duplicateFailure]);
  expect(await first.cancelStart(h.stop)).toMatchObject({ confirmed: true });
  const restarted = h.create();
  await expect(restarted.start(h.input)).rejects.toThrow();
  expect(h.launches()).toBe(0);
});

it("does not reopen a failed pre-session request while retrying the same start identity", async () => {
  const h = await setup();
  h.catalog(async () => {
    throw new Error("catalog_unavailable");
  });
  const first = h.create();
  await expect(first.start(h.input)).rejects.toThrow();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  h.catalog(() => gate);
  const retry = first.start(h.input);
  const retried = expect(retry).rejects.toThrow();
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(await first.cancelStart(h.stop)).toMatchObject({ confirmed: true });
  release();
  await retried;
  expect(h.launches()).toBe(0);
});
