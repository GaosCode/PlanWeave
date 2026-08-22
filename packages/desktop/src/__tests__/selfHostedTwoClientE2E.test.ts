import { describe, expect, it } from "vitest";
import {
  adminToken,
  configureWorkspaceAccess,
  deviceToken,
  discoverContentHead,
  expectRouteUnavailable,
  issueDeviceSetupCode,
  nextPresenceMessage,
  openPresence,
  postJson,
  redeemDesktop,
  sendPresenceHello,
  setupSelfHostedTwoClientFixture
} from "./support/selfHostedTwoClientE2E.js";

describe("self-hosted two-Desktop collaboration flow (OSS-006 B-002)", () => {
  it("redeems one-time setup codes through the Desktop Workspace connection and reaches one Workspace", async () => {
    const fixture = await setupSelfHostedTwoClientFixture();
    const ownerCode = await issueDeviceSetupCode(fixture.origin, fixture.workspaceId);
    const owner = await redeemDesktop({
      home: fixture.home,
      name: "Desktop Owner",
      origin: fixture.origin,
      setupCode: ownerCode.setupCode
    });
    const memberCode = await issueDeviceSetupCode(fixture.origin, fixture.workspaceId);
    const member = await redeemDesktop({
      home: fixture.home,
      name: "Desktop Member",
      origin: fixture.origin,
      setupCode: memberCode.setupCode
    });

    expect(owner.view).toMatchObject({
      status: "connected",
      workspaceId: fixture.workspaceId,
      profile: { workspaceId: fixture.workspaceId }
    });
    expect(member.view).toMatchObject({
      status: "connected",
      workspaceId: fixture.workspaceId,
      profile: { workspaceId: fixture.workspaceId }
    });
    await expect(owner.connection.buildPickerPage()).resolves.toMatchObject({
      items: [expect.objectContaining({ workspaceId: fixture.workspaceId, membershipActive: true })]
    });
    await expect(
      owner.connection.redeemDeviceSetupCode({
        serverBaseUrl: fixture.origin,
        allowInsecureTransport: true,
        setupCode: ownerCode.setupCode,
        displayName: "Replay must fail"
      })
    ).rejects.toMatchObject({ code: "setup_code_redeemed" });

    const revocable = await issueDeviceSetupCode(fixture.origin, fixture.workspaceId);
    const revoke = await fetch(
      `${fixture.origin}/api/v1/workspaces/${encodeURIComponent(fixture.workspaceId)}/setup-codes/${encodeURIComponent(revocable.grant.setupCodeId)}/revoke`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${adminToken}`, "content-type": "application/json" },
        body: JSON.stringify({ reason: "two-client e2e revocation" })
      }
    );
    expect(revoke.status).toBe(200);
    await expect(
      redeemDesktop({
        home: fixture.home,
        name: "Revoked Desktop",
        origin: fixture.origin,
        setupCode: revocable.setupCode
      })
    ).rejects.toMatchObject({ code: "setup_code_revoked" });

    const malformed = await fetch(`${fixture.origin}/api/v1/setup-codes/redeem`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}"
    });
    expect(malformed.status).toBe(400);
    await expect(malformed.json()).resolves.toEqual({ error: "setup_code_malformed" });

    for (const [path, expected] of [
      ["/api/v1/registry/directories", { error: "registry_resource_not_found" }],
      [
        "/api/v1/files/watch",
        {
          error: "not_found",
          feature: "/api/v1/files/watch",
          detail: "canvas_feature_not_supported"
        }
      ],
      [
        "/api/v1/files/upload",
        {
          error: "not_found",
          feature: "/api/v1/files/upload",
          detail: "canvas_feature_not_supported"
        }
      ],
      [
        "/api/v1/files/download",
        {
          error: "not_found",
          feature: "/api/v1/files/download",
          detail: "canvas_feature_not_supported"
        }
      ],
      [
        "/api/v1/sync/bidirectional",
        {
          error: "not_found",
          feature: "/api/v1/sync/bidirectional",
          detail: "canvas_feature_not_supported"
        }
      ],
      [
        "/api/v1/billing/subscription",
        {
          error: "not_found",
          feature: "/api/v1/billing/subscription",
          detail: "canvas_feature_not_supported"
        }
      ],
      ["/api/v1/licenses/entitlements", { error: "route_not_found" }],
      [
        "/api/v1/ssh/vps",
        {
          error: "not_found",
          feature: "/api/v1/ssh/vps",
          detail: "canvas_feature_not_supported"
        }
      ],
      ["/api/v1/crdt/v1", { error: "route_not_found" }]
    ] as const) {
      await expectRouteUnavailable(fixture.origin, path, expected);
    }
  });

  it("uses workspace sessions for private/shared Canvas authority, exact-Block Hosts, ordered commands, reconnect, and presence", async () => {
    const fixture = await setupSelfHostedTwoClientFixture();
    const owner = await redeemDesktop({
      home: fixture.home,
      name: "E2E Owner",
      origin: fixture.origin,
      setupCode: (await issueDeviceSetupCode(fixture.origin, fixture.workspaceId)).setupCode
    });
    const member = await redeemDesktop({
      home: fixture.home,
      name: "E2E Member",
      origin: fixture.origin,
      setupCode: (await issueDeviceSetupCode(fixture.origin, fixture.workspaceId)).setupCode
    });
    const ownerToken = await deviceToken(owner);
    const memberToken = await deviceToken(member);
    const ownerId = owner.view.profile?.profileId;
    const memberId = member.view.profile?.profileId;
    const ownerCredential = await owner.vault.getMetadata(ownerId ?? "");
    const memberCredential = await member.vault.getMetadata(memberId ?? "");
    if (!ownerCredential?.humanPrincipalId || !memberCredential?.humanPrincipalId) {
      throw new Error("workspace_principal_missing");
    }
    const configured = await configureWorkspaceAccess({
      databasePath: fixture.databasePath,
      workspaceId: fixture.workspaceId,
      projectId: fixture.projectId,
      ownerId: ownerCredential.humanPrincipalId,
      memberId: memberCredential.humanPrincipalId
    });
    try {
      // Server composition bootstraps trusted canvas content at startup (publishInitial).
      // HTTP initial-publish is not a second bootstrap; it must see an existing head.
      const bootstrapped = await discoverContentHead(
        fixture.origin,
        fixture.projectId,
        "default",
        ownerToken
      );
      expect(bootstrapped.status).toBe(200);
      expect(bootstrapped.body).toMatchObject({
        revision: 1,
        content: { canonicalDigest: fixture.initialContent.canonicalDigest }
      });

      const memberCanvases = await fetch(
        `${fixture.origin}/api/v1/registry/projects/${encodeURIComponent(fixture.projectId)}/canvases`,
        { headers: { authorization: `Bearer ${memberToken}` } }
      );
      expect(memberCanvases.status).toBe(200);
      const memberCanvasPage = (await memberCanvases.json()) as {
        items: Array<{ registry: { canvasId: string } }>;
      };
      expect(memberCanvasPage.items).toContainEqual(
        expect.objectContaining({
          registry: expect.objectContaining({ canvasId: "default" }),
          visibility: "shared"
        })
      );
      const memberCanvasIds = memberCanvasPage.items.map((canvas) => canvas.registry.canvasId);
      expect(memberCanvasIds).not.toContain("private");

      const taskScope = {
        kind: "task",
        workspaceId: fixture.workspaceId,
        projectId: fixture.projectId,
        canvasId: "default",
        taskId: "T-001"
      } as const;
      const blockScope = {
        kind: "block",
        workspaceId: fixture.workspaceId,
        projectId: fixture.projectId,
        canvasId: "default",
        blockRef: "T-001#B-001"
      } as const;
      const assignmentPath = `/api/v1/projects/${encodeURIComponent(fixture.projectId)}/assignments`;

      for (const [path, body] of [
        [
          "/responsibility",
          {
            schemaVersion: "responsibility/v1",
            scope: taskScope,
            principal: { kind: "human", humanPrincipalId: memberCredential.humanPrincipalId },
            expectedRevision: 0
          }
        ],
        [
          "/reviewer",
          {
            schemaVersion: "review-assignment/v1",
            scope: taskScope,
            principal: { kind: "human", humanPrincipalId: ownerCredential.humanPrincipalId },
            expectedRevision: 0
          }
        ],
        [
          "/responsibility",
          {
            schemaVersion: "responsibility/v1",
            scope: blockScope,
            principal: { kind: "human", humanPrincipalId: ownerCredential.humanPrincipalId },
            expectedRevision: 0
          }
        ],
        [
          "/reviewer",
          {
            schemaVersion: "review-assignment/v1",
            scope: blockScope,
            principal: { kind: "human", humanPrincipalId: memberCredential.humanPrincipalId },
            expectedRevision: 0
          }
        ]
      ] as const) {
        const response = await postJson(
          fixture.origin,
          `${assignmentPath}${path}`,
          ownerToken,
          body
        );
        expect(response.status).toBe(200);
      }

      const endpointResponse = await fetch(
        `${fixture.origin}/api/v1/projects/${encodeURIComponent(fixture.projectId)}/agent-endpoints`,
        { headers: { authorization: `Bearer ${ownerToken}` } }
      );
      expect(endpointResponse.status).toBe(200);
      const endpointPage = (await endpointResponse.json()) as {
        items: Array<{ endpointId: string; status: string }>;
      };
      const agentEndpointId = endpointPage.items.find(
        (endpoint) => endpoint.status === "available"
      )?.endpointId;
      expect(agentEndpointId).toBeTruthy();

      const dispatched = await postJson(
        fixture.origin,
        `/api/v1/projects/${encodeURIComponent(fixture.projectId)}/remote-operations`,
        ownerToken,
        {
          schemaVersion: "remote-run/v3",
          projectId: fixture.projectId,
          canvasId: "default",
          blockRef: "T-001#B-001",
          agentEndpointId,
          idempotencyKey: "two-client-exact-block-dispatch",
          expectedResponsibilityRevision: 1,
          expectedReviewerRevision: 1
        }
      );
      const dispatchedBody = await dispatched.json();
      expect(dispatched.status, JSON.stringify(dispatchedBody)).toBe(202);
      expect(dispatchedBody).toMatchObject({
        blockRef: "T-001#B-001",
        agentEndpoint: { endpointId: agentEndpointId }
      });
      expect(dispatchedBody.attempt?.hostId).toBeUndefined();
      if (typeof dispatchedBody.operationId !== "string") {
        throw new Error("remote_operation_id_missing");
      }
      const observed = await fetch(
        `${fixture.origin}/api/v1/projects/${encodeURIComponent(fixture.projectId)}/remote-operations/${encodeURIComponent(dispatchedBody.operationId)}`,
        { headers: { authorization: `Bearer ${ownerToken}` } }
      );
      expect(observed.status).toBe(200);
      await expect(observed.json()).resolves.toMatchObject({
        operationId: dispatchedBody.operationId,
        blockRef: "T-001#B-001",
        agentEndpoint: { endpointId: agentEndpointId }
      });
      const retry = await postJson(
        fixture.origin,
        `/api/v1/projects/${encodeURIComponent(fixture.projectId)}/remote-operations`,
        ownerToken,
        {
          schemaVersion: "remote-run/v3",
          projectId: fixture.projectId,
          canvasId: "default",
          blockRef: "T-001#B-001",
          agentEndpointId,
          idempotencyKey: "two-client-exact-block-dispatch",
          expectedResponsibilityRevision: 1,
          expectedReviewerRevision: 1
        }
      );
      expect(retry.status).toBe(202);
      await expect(retry.json()).resolves.toMatchObject({
        operationId: dispatchedBody.operationId,
        dispatchId: dispatchedBody.dispatchId,
        agentEndpoint: { endpointId: agentEndpointId }
      });

      for (const [request, status] of [
        [{ projectId: "untrusted-project" }, 403],
        [{ canvasId: "private" }, 404],
        [{ blockRef: "T-001" }, 400]
      ] as const) {
        const response = await postJson(
          fixture.origin,
          `/api/v1/projects/${encodeURIComponent(fixture.projectId)}/remote-operations`,
          ownerToken,
          {
            schemaVersion: "remote-run/v3",
            projectId: fixture.projectId,
            canvasId: "default",
            blockRef: "T-001#B-001",
            agentEndpointId,
            idempotencyKey: `two-client-rejected-${status}`,
            expectedResponsibilityRevision: 1,
            expectedReviewerRevision: 1,
            ...request
          }
        );
        const body = await response.json();
        expect(response.status, JSON.stringify(body)).toBe(status);
      }

      for (const invalidScope of [
        taskScope,
        { workspaceId: fixture.workspaceId, projectId: fixture.projectId, canvasId: "default" },
        { workspaceId: fixture.workspaceId, projectId: fixture.projectId }
      ]) {
        const response = await postJson(
          fixture.origin,
          `${assignmentPath}/execution-target`,
          ownerToken,
          {
            schemaVersion: "execution-target/v1",
            scope: invalidScope,
            target: { kind: "exact_host", hostId: configured.hostId },
            expectedRevision: 0
          }
        );
        expect(response.status).toBe(400);
      }

      const stale = await postJson(fixture.origin, `${assignmentPath}/responsibility`, ownerToken, {
        schemaVersion: "responsibility/v1",
        scope: taskScope,
        principal: { kind: "human", humanPrincipalId: ownerCredential.humanPrincipalId },
        expectedRevision: 0
      });
      expect(stale.status).toBe(409);
      await expect(stale.json()).resolves.toEqual({ error: "authority_revision_conflict" });

      const privateRead = await fetch(
        `${fixture.origin}${assignmentPath}/authority?scope=${encodeURIComponent(
          JSON.stringify({ ...taskScope, canvasId: "private" })
        )}`,
        { headers: { authorization: `Bearer ${memberToken}` } }
      );
      expect(privateRead.status).toBe(403);

      const firstCommand = await postJson(
        fixture.origin,
        `/api/v1/projects/${encodeURIComponent(fixture.projectId)}/canvases/default/commands`,
        ownerToken,
        {
          operationId: "two-client-command-1",
          expectedRevision: 0,
          intent: {
            kind: "update_task_prompt",
            taskId: "T-001",
            promptMarkdown: "# owner mutation"
          }
        }
      );
      expect(firstCommand.status).toBe(200);
      await expect(firstCommand.json()).resolves.toMatchObject({
        type: "canvas.command.accepted",
        revision: 1
      });
      const secondCommand = await postJson(
        fixture.origin,
        `/api/v1/projects/${encodeURIComponent(fixture.projectId)}/canvases/default/commands`,
        memberToken,
        {
          operationId: "two-client-command-2",
          expectedRevision: 1,
          intent: {
            kind: "update_task_prompt",
            taskId: "T-001",
            promptMarkdown: "# member mutation"
          }
        }
      );
      expect(secondCommand.status).toBe(200);
      await expect(secondCommand.json()).resolves.toMatchObject({
        type: "canvas.command.accepted",
        revision: 2
      });

      const reconnect = await postJson(
        fixture.origin,
        `/api/v1/projects/${encodeURIComponent(fixture.projectId)}/canvases/default/reconnect`,
        memberToken,
        { afterRevision: 1 }
      );
      expect(reconnect.status).toBe(200);
      await expect(reconnect.json()).resolves.toMatchObject({
        type: "canvas.reconnect.delta",
        entries: [expect.objectContaining({ revision: 2 })]
      });
      const snapshot = await postJson(
        fixture.origin,
        `/api/v1/projects/${encodeURIComponent(fixture.projectId)}/canvases/default/reconnect`,
        memberToken,
        { afterRevision: 1, afterContentDigest: "0".repeat(64) }
      );
      expect(snapshot.status).toBe(200);
      await expect(snapshot.json()).resolves.toMatchObject({
        type: "canvas.reconnect.snapshot",
        reason: "digest_mismatch"
      });

      const ownerPresence = await openPresence(
        fixture.origin,
        fixture.projectId,
        "default",
        ownerToken
      );
      const memberPresence = await openPresence(
        fixture.origin,
        fixture.projectId,
        "default",
        memberToken
      );
      try {
        const snapshots = Promise.all([
          nextPresenceMessage(ownerPresence, "canvas.presence.snapshot"),
          nextPresenceMessage(memberPresence, "canvas.presence.snapshot")
        ]);
        sendPresenceHello(ownerPresence, fixture.projectId, "default");
        sendPresenceHello(memberPresence, fixture.projectId, "default");
        const [ownerSnapshot, memberSnapshot] = await snapshots;
        expect(ownerSnapshot.sessions).toEqual(expect.any(Array));
        expect(memberSnapshot.sessions).toEqual(expect.any(Array));
        const update = nextPresenceMessage(memberPresence, "canvas.presence.update");
        ownerPresence.send(
          JSON.stringify({
            type: "canvas.presence.update",
            protocolVersion: 1,
            projectId: fixture.projectId,
            canvasId: "default",
            pointer: { x: 10, y: 20 },
            selectionIds: ["T-001"]
          })
        );
        await expect(update).resolves.toMatchObject({
          session: {
            identity: { humanPrincipalId: ownerCredential.humanPrincipalId },
            pointer: { x: 10, y: 20 }
          }
        });
        const leave = nextPresenceMessage(memberPresence, "canvas.presence.leave");
        ownerPresence.close(1000, "done");
        await expect(leave).resolves.toMatchObject({ sessionId: expect.any(String) });
      } finally {
        ownerPresence.terminate();
        memberPresence.terminate();
      }

      const revokedAt = new Date().toISOString();
      configured.database
        .prepare(
          "UPDATE workspace_memberships SET revoked_at=?, updated_at=?, revision=revision+1 WHERE workspace_id=? AND human_principal_id=?"
        )
        .run(revokedAt, revokedAt, fixture.workspaceId, memberCredential.humanPrincipalId);
      configured.database
        .prepare(
          "UPDATE workspace_device_sessions SET revoked_at=? WHERE workspace_id=? AND human_principal_id=?"
        )
        .run(revokedAt, fixture.workspaceId, memberCredential.humanPrincipalId);
      const revokedRegistry = await fetch(
        `${fixture.origin}/api/v1/registry/projects/${encodeURIComponent(fixture.projectId)}/canvases`,
        { headers: { authorization: `Bearer ${memberToken}` } }
      );
      expect(revokedRegistry.status).toBe(401);
      await expect(revokedRegistry.json()).resolves.toEqual({ error: "registry_unauthorized" });

      const revokedAssignment = await postJson(
        fixture.origin,
        `${assignmentPath}/responsibility`,
        memberToken,
        {
          schemaVersion: "responsibility/v1",
          scope: blockScope,
          principal: { kind: "human", humanPrincipalId: ownerCredential.humanPrincipalId },
          expectedRevision: 1
        }
      );
      expect(revokedAssignment.status).toBe(401);

      const revokedCommand = await postJson(
        fixture.origin,
        `/api/v1/projects/${encodeURIComponent(fixture.projectId)}/canvases/default/commands`,
        memberToken,
        {
          operationId: "two-client-revoked-command",
          expectedRevision: 2,
          intent: {
            kind: "update_task_prompt",
            taskId: "T-001",
            promptMarkdown: "# revoked mutation"
          }
        }
      );
      expect(revokedCommand.status).toBe(401);
    } finally {
      configured.database.close();
    }
  });
});
