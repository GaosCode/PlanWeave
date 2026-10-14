import { setupCommentReadComposition } from "./support/commentReadAccessCompositionFixture.js";
import { hashHumanToken } from "../identity/index.js";
import { ActivityRepository, buildCommentActivity } from "../comments/index.js";
import { openServerDatabase } from "../sqlite.js";
import { ProjectAccessRepository } from "../projectAccessRepository.js";
import { inviteAndJoin } from "./support/commentAttachmentHttpFixture.js";
import { createHash } from "node:crypto";
import { createServer, type Server as HttpServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  initWorkspace,
  resolveProjectCanvasWorkspace,
  writeProjectGraph,
  type InitWorkspaceResult,
  type PlanPackageManifest
} from "@planweave-ai/runtime";
import { afterEach, describe, expect, it } from "vitest";
import {
  basicManifest,
  createTestWorkspace,
  writePromptFiles
} from "../../../runtime/src/__tests__/promptTestHelpers.js";
import { parseServerConfig } from "../config.js";
import { hashOperatorToken } from "../operatorAuth.js";
import { seedOperatorSessions } from "./support/operatorAuthFixture.js";
import {
  createDistributedServerComposition,
  type DistributedServerComposition
} from "../serverComposition.js";
import { resetCommentActivityHttpRateLimits } from "../comments/index.js";
import { resetWorkAssignmentHttpRateLimits } from "../work/index.js";

const servers: HttpServer[] = [];
const compositions: DistributedServerComposition[] = [];
const directories: string[] = [];
const operatorToken = `pw_operator_${"H".repeat(43)}`;
const projectAWorkspaceId = "workspace-comment-activity-a";
const projectBWorkspaceId = "workspace-comment-activity-b";

afterEach(async () => {
  resetCommentActivityHttpRateLimits();
  resetWorkAssignmentHttpRateLimits();
  for (const composition of compositions.splice(0)) await composition.close();
  await Promise.all(
    servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve())))
  );
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

async function setup(manifest: PlanPackageManifest = basicManifest()) {
  const projectA = await createTestWorkspace(manifest);
  const projectBRoot = await mkdtemp(join(tmpdir(), "planweave-project-b-"));
  const projectBInit: InitWorkspaceResult = await initWorkspace({ projectRoot: projectBRoot });
  await writeFile(projectBInit.workspace.manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
  await writePromptFiles(projectBInit.workspace.packageDir, manifest);
  await writeProjectGraph(projectBInit.workspace, {
    version: "plan-project/v1",
    canvases: [
      {
        id: "default",
        type: "canvas",
        title: manifest.project.title,
        packageDir: "canvases/default/package",
        stateFile: "canvases/default/state.json",
        resultsDir: "canvases/default/results"
      }
    ],
    edges: [],
    crossTaskEdges: []
  });
  const projectB = { root: projectBRoot, init: projectBInit };
  const projectACanvas = await resolveProjectCanvasWorkspace(projectA.root, "default");
  directories.push(projectA.home, projectA.root, projectB.root);
  const httpServer = createServer();
  servers.push(httpServer);
  const config = parseServerConfig({
    version: "server-config/v1",
    bind: { host: "127.0.0.1", port: 7_443 },
    publicUrl: "http://127.0.0.1:7443",
    allowInsecureDevelopment: true,
    dataDirectory: join(projectA.root, "server-data"),
    trustedProjects: [
      {
        workspaceId: projectAWorkspaceId,
        projectId: projectA.init.workspace.id,
        canvasId: "default",
        projectRoot: projectA.root
      },
      {
        workspaceId: projectBWorkspaceId,
        projectId: projectB.init.workspace.id,
        canvasId: "default",
        projectRoot: projectB.root
      }
    ],
    operatorCredentials: [
      {
        operatorId: "admin",
        tokenSha256: hashOperatorToken(operatorToken),
        projectIds: [],
        serverAdmin: true
      }
    ]
  });
  let composition = await createDistributedServerComposition({
    httpServer,
    config
  });
  compositions.push(composition);
  await seedOperatorSessions(config.databasePath, config.operatorCredentials);
  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const address = httpServer.address();
  if (!address || typeof address === "string") throw new Error("Expected HTTP address");
  const restart = async () => {
    const index = compositions.indexOf(composition);
    if (index >= 0) compositions.splice(index, 1);
    await composition.close();
    composition = await createDistributedServerComposition({ httpServer, config });
    compositions.push(composition);
  };
  return {
    origin: `http://127.0.0.1:${address.port}`,
    projectA,
    projectB,
    projectACanvas,
    restart,
    manifest,
    config
  };
}

function jsonHeaders(token?: string): Record<string, string> {
  return {
    "content-type": "application/json",
    ...(token ? { Authorization: `Bearer ${token}` } : {})
  };
}

async function bootstrap(origin: string, projectId: string, principalId: string): Promise<string> {
  const response = await fetch(`${origin}/api/v1/projects/${projectId}/human/bootstrap`, {
    method: "POST",
    headers: jsonHeaders(),
    body: JSON.stringify({ displayName: principalId, humanPrincipalId: principalId })
  });
  const payload = (await response.json()) as { deviceToken?: string };
  expect(response.status).toBe(201);
  if (!payload.deviceToken) throw new Error("Expected bootstrap device token");
  return payload.deviceToken;
}

describe("comment and activity production HTTP", () => {
  it("does not let unauthenticated proxy peers exhaust comment or assignment buckets", async () => {
    const fixture = await setup();
    const projectId = fixture.projectA.init.workspace.id;
    const ownerToken = await bootstrap(fixture.origin, projectId, "rate-limit-owner");
    const workItem = encodeURIComponent(
      JSON.stringify({ kind: "task", canvasId: "default", taskId: "T-001" })
    );
    const urls = [
      `${fixture.origin}/api/v1/projects/${projectId}/comments?workItem=${workItem}`,
      `${fixture.origin}/api/v1/projects/${projectId}/assignments/list?cursor=0&limit=50`
    ];

    for (const url of urls) {
      for (let request = 0; request <= 120; request += 1) {
        expect((await fetch(url)).status).toBe(401);
      }
      expect(
        (await fetch(url, { headers: { Authorization: `Bearer ${ownerToken}` } })).status
      ).toBe(200);
      for (let request = 1; request < 120; request += 1) {
        expect(
          (await fetch(url, { headers: { Authorization: `Bearer ${ownerToken}` } })).status
        ).toBe(200);
      }
      const limited = await fetch(url, {
        headers: { Authorization: `Bearer ${ownerToken}` }
      });
      expect(limited.status).toBe(429);
      expect(limited.headers.get("retry-after")).toBe("60");
    }
  });

  it("wires create/list/edit/tombstone/activity with project, CAS, package, and attachment bounds", async () => {
    const fixture = await setup();
    const projectId = fixture.projectA.init.workspace.id;
    const otherProjectId = fixture.projectB.init.workspace.id;
    const token = await bootstrap(fixture.origin, projectId, "comment-owner-a");
    const otherToken = await bootstrap(fixture.origin, otherProjectId, "comment-owner-b");
    const workItem = { kind: "block", canvasId: "default", blockRef: "T-001#B-001" };

    const bytes = Buffer.from("comment attachment");
    const digestSha256 = createHash("sha256").update(bytes).digest("hex");
    const staged = await fetch(
      `${fixture.origin}/api/v1/projects/${projectId}/attachments/pending`,
      {
        method: "POST",
        headers: jsonHeaders(token),
        body: JSON.stringify({
          expectedSizeBytes: bytes.byteLength,
          mediaType: "text/plain",
          expectedDigestSha256: digestSha256,
          fileName: "evidence.txt"
        })
      }
    );
    const stagedBody = (await staged.json()) as { pendingUploadId: string };
    expect(staged.status).toBe(201);
    const uploaded = await fetch(
      `${fixture.origin}/api/v1/projects/${projectId}/attachments/pending/${stagedBody.pendingUploadId}`,
      {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${token}`,
          "content-type": "text/plain",
          "content-length": String(bytes.byteLength),
          "x-planweave-content-sha256": digestSha256
        },
        body: bytes
      }
    );
    expect(uploaded.status).toBe(201);

    const create = await fetch(`${fixture.origin}/api/v1/projects/${projectId}/comments`, {
      method: "POST",
      headers: jsonHeaders(token),
      body: JSON.stringify({
        workItem,
        body: "Initial comment",
        attachments: [
          {
            pendingUploadId: stagedBody.pendingUploadId,
            digestSha256,
            sizeBytes: bytes.byteLength,
            mediaType: "text/plain",
            fileName: "evidence.txt"
          }
        ]
      })
    });
    const created = (await create.json()) as {
      commentId: string;
      revision: number;
      body: string | null;
      attachments: Array<{ digestSha256: string }>;
    };
    expect(create.status).toBe(201);
    expect(created).toMatchObject({ revision: 1, body: "Initial comment" });
    expect(created.attachments).toEqual([expect.objectContaining({ digestSha256 })]);

    const attachment = await fetch(
      `${fixture.origin}/api/v1/projects/${projectId}/attachments/comments/${created.commentId}/${digestSha256}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    expect(attachment.status).toBe(200);
    expect(Buffer.from(await attachment.arrayBuffer())).toEqual(bytes);

    const edit = await fetch(
      `${fixture.origin}/api/v1/projects/${projectId}/comments/${created.commentId}`,
      {
        method: "PATCH",
        headers: jsonHeaders(token),
        body: JSON.stringify({ body: "Edited comment", expectedRevision: 1 })
      }
    );
    expect(edit.status).toBe(200);
    await expect(edit.json()).resolves.toMatchObject({ body: "Edited comment", revision: 2 });

    const staleEdit = await fetch(
      `${fixture.origin}/api/v1/projects/${projectId}/comments/${created.commentId}`,
      {
        method: "PATCH",
        headers: jsonHeaders(token),
        body: JSON.stringify({ body: "Stale edit", expectedRevision: 1 })
      }
    );
    expect(staleEdit.status).toBe(409);
    await expect(staleEdit.json()).resolves.toEqual({ error: "comment_revision_conflict" });

    const missingManifest: PlanPackageManifest = { ...fixture.manifest, nodes: [], edges: [] };
    await writeFile(
      fixture.projectACanvas.manifestFile,
      `${JSON.stringify(missingManifest, null, 2)}\n`,
      "utf8"
    );
    await fixture.restart();
    const listParams = new URLSearchParams({
      workItem: JSON.stringify(workItem),
      limit: "20",
      includeTombstoned: "false"
    });
    const list = await fetch(
      `${fixture.origin}/api/v1/projects/${projectId}/comments?${listParams}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    expect(list.status).toBe(200);
    await expect(list.json()).resolves.toMatchObject({
      items: [{ commentId: created.commentId, workItemPresence: "present", body: "Edited comment" }]
    });

    const tombstone = await fetch(
      `${fixture.origin}/api/v1/projects/${projectId}/comments/${created.commentId}/tombstone`,
      {
        method: "POST",
        headers: jsonHeaders(token),
        body: JSON.stringify({ expectedRevision: 2, reason: "Cleanup" })
      }
    );
    expect(tombstone.status).toBe(200);
    await expect(tombstone.json()).resolves.toMatchObject({
      commentId: created.commentId,
      revision: 3,
      tombstoned: true,
      body: null
    });

    const activity = await fetch(
      `${fixture.origin}/api/v1/projects/${projectId}/activity?limit=20`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    expect(activity.status).toBe(200);
    const activityBody = (await activity.json()) as { items: Array<{ type: string }> };
    expect(activityBody.items.map((item) => item.type)).toEqual([
      "comment_tombstoned",
      "comment_edited",
      "comment_created",
      "member_joined"
    ]);

    const crossProject = await fetch(
      `${fixture.origin}/api/v1/projects/${projectId}/activity?limit=20`,
      { headers: { Authorization: `Bearer ${otherToken}` } }
    );
    expect(crossProject.status).toBe(403);

    const unknown = await fetch(
      `${fixture.origin}/api/v1/projects/unknown-project/comments?${listParams}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    expect(unknown.status).toBe(403);
    await expect(unknown.json()).resolves.toEqual({ error: "comment_cross_project_forbidden" });

    for (const invalidToken of ["pw_host_not_human", operatorToken]) {
      const denied = await fetch(
        `${fixture.origin}/api/v1/projects/${projectId}/activity?limit=20`,
        { headers: { Authorization: `Bearer ${invalidToken}` } }
      );
      expect(denied.status).toBe(401);
    }
  });

  it("projects membership and assignment transitions from production mutations", async () => {
    const fixture = await setup();
    const projectId = fixture.projectA.init.workspace.id;
    const otherProjectId = fixture.projectB.init.workspace.id;
    const ownerToken = await bootstrap(fixture.origin, projectId, "activity-owner-a");
    const otherToken = await bootstrap(fixture.origin, otherProjectId, "activity-owner-b");

    const invitation = await fetch(
      `${fixture.origin}/api/v1/projects/${projectId}/human/invitations`,
      { method: "POST", headers: jsonHeaders(ownerToken), body: JSON.stringify({}) }
    );
    const invitationBody = (await invitation.json()) as { invitationToken: string };
    expect(invitation.status).toBe(201);
    const joined = await fetch(
      `${fixture.origin}/api/v1/projects/${projectId}/human/invitations/consume`,
      {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({
          invitationToken: invitationBody.invitationToken,
          displayName: "Activity Member"
        })
      }
    );
    const joinedBody = (await joined.json()) as {
      principal: { humanPrincipalId: string };
      deviceToken: string;
    };
    expect(joined.status).toBe(201);

    const privateWorkItem = encodeURIComponent(
      JSON.stringify({ kind: "task", canvasId: "default", taskId: "T-001" })
    );
    for (const endpoint of [
      `comments?workItem=${privateWorkItem}`,
      `activity?workItem=${privateWorkItem}`
    ]) {
      const denied = await fetch(`${fixture.origin}/api/v1/projects/${projectId}/${endpoint}`, {
        headers: jsonHeaders(joinedBody.deviceToken)
      });
      expect(denied.status).toBe(403);
      expect(await denied.json()).toMatchObject({ error: "comment_auth_forbidden" });
    }

    const shared = await fetch(
      `${fixture.origin}/api/v1/projects/${projectId}/canvases/default/access`,
      {
        method: "POST",
        headers: jsonHeaders(ownerToken),
        body: JSON.stringify({
          operation: "visibility",
          scope: {
            scopeKind: "project",
            workspaceId: projectAWorkspaceId,
            projectId,
            canvasId: null
          },
          expectedAclRevision: 0,
          visibility: "shared"
        })
      }
    );
    expect(shared.status).toBe(200);
    const memberAccess = await fetch(
      `${fixture.origin}/api/v1/projects/${projectId}/canvases/default/access`,
      {
        method: "POST",
        headers: jsonHeaders(ownerToken),
        body: JSON.stringify({
          operation: "grant",
          scope: {
            scopeKind: "canvas",
            workspaceId: projectAWorkspaceId,
            projectId,
            canvasId: "default"
          },
          expectedAclRevision: 0,
          humanPrincipalId: joinedBody.principal.humanPrincipalId,
          role: "viewer"
        })
      }
    );
    expect(memberAccess.status).toBe(200);

    const workItem = { kind: "task", canvasId: "default", taskId: "T-001" };
    const assignment = await fetch(`${fixture.origin}/api/v1/projects/${projectId}/assignments`, {
      method: "POST",
      headers: jsonHeaders(ownerToken),
      body: JSON.stringify({
        workItem,
        target: { kind: "human", humanPrincipalId: joinedBody.principal.humanPrincipalId },
        expectedRevision: 0,
        reason: "Coordinate task ownership"
      })
    });
    expect(assignment.status).toBe(200);
    await expect(assignment.json()).resolves.toMatchObject({
      revision: 1,
      target: { kind: "human" }
    });

    const staleAssignment = await fetch(
      `${fixture.origin}/api/v1/projects/${projectId}/assignments`,
      {
        method: "POST",
        headers: jsonHeaders(ownerToken),
        body: JSON.stringify({ workItem, target: { kind: "unassigned" }, expectedRevision: 0 })
      }
    );
    expect(staleAssignment.status).toBe(409);

    const workItemParameter = encodeURIComponent(JSON.stringify(workItem));
    const getAssignment = await fetch(
      `${fixture.origin}/api/v1/projects/${projectId}/assignments?workItem=${workItemParameter}`,
      { headers: { Authorization: `Bearer ${ownerToken}` } }
    );
    expect(getAssignment.status).toBe(200);
    await expect(getAssignment.json()).resolves.toMatchObject({ revision: 1 });
    const listAssignments = await fetch(
      `${fixture.origin}/api/v1/projects/${projectId}/assignments/list?cursor=0&limit=50`,
      { headers: { Authorization: `Bearer ${ownerToken}` } }
    );
    expect(listAssignments.status).toBe(200);
    await expect(listAssignments.json()).resolves.toMatchObject({ items: [{ revision: 1 }] });
    const eligible = await fetch(
      `${fixture.origin}/api/v1/projects/${projectId}/assignments/eligible-assignees?workItem=${workItemParameter}`,
      { headers: { Authorization: `Bearer ${ownerToken}` } }
    );
    expect(eligible.status).toBe(200);
    await expect(eligible.json()).resolves.toMatchObject({
      humans: expect.arrayContaining([
        expect.objectContaining({ humanPrincipalId: joinedBody.principal.humanPrincipalId })
      ])
    });
    const blockWorkItem = { kind: "block", canvasId: "default", blockRef: "T-001#B-001" };
    const eligibleBatch = await fetch(
      `${fixture.origin}/api/v1/projects/${projectId}/assignments/eligible-hosts/batch`,
      {
        method: "POST",
        headers: jsonHeaders(ownerToken),
        body: JSON.stringify({ workItems: [blockWorkItem] })
      }
    );
    expect(eligibleBatch.status).toBe(200);
    await expect(eligibleBatch.json()).resolves.toMatchObject({
      items: [{ index: 0, workItem: blockWorkItem }],
      hosts: expect.any(Array)
    });
    const unauthenticatedBatch = await fetch(
      `${fixture.origin}/api/v1/projects/${projectId}/assignments/eligible-hosts/batch`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workItems: [blockWorkItem] })
      }
    );
    expect(unauthenticatedBatch.status).toBe(401);

    for (const action of ["promote", "promote", "demote", "remove"] as const) {
      const response = await fetch(
        `${fixture.origin}/api/v1/projects/${projectId}/human/members/${joinedBody.principal.humanPrincipalId}/${action}`,
        { method: "POST", headers: { Authorization: `Bearer ${ownerToken}` } }
      );
      expect(response.status).toBe(200);
    }

    const feed = await fetch(`${fixture.origin}/api/v1/projects/${projectId}/activity?limit=20`, {
      headers: { Authorization: `Bearer ${ownerToken}` }
    });
    const feedBody = (await feed.json()) as {
      items: Array<{ type: string; source: { kind: string; sourceId: string } }>;
    };
    expect(feed.status).toBe(200);
    expect(feedBody.items.map((item) => item.type)).toEqual(
      expect.arrayContaining([
        "member_joined",
        "assignment_updated",
        "owner_promoted",
        "owner_demoted",
        "member_removed"
      ])
    );
    expect(feedBody.items.filter((item) => item.type === "owner_promoted")).toHaveLength(1);
    const memberSources = feedBody.items
      .filter((item) => item.source.kind === "membership")
      .map((item) => item.source.sourceId);
    expect(new Set(memberSources).size).toBe(memberSources.length);

    const unknown = await fetch(
      `${fixture.origin}/api/v1/projects/unknown-project/assignments?workItem=${workItemParameter}`,
      { headers: { Authorization: `Bearer ${ownerToken}` } }
    );
    expect(unknown.status).toBe(403);
    const crossProject = await fetch(
      `${fixture.origin}/api/v1/projects/${projectId}/assignments?workItem=${workItemParameter}`,
      { headers: { Authorization: `Bearer ${otherToken}` } }
    );
    expect(crossProject.status).toBe(403);
  });

  it("commits boundary work-item assignments with distinct bounded activity source keys", async () => {
    const manifest = basicManifest();
    const maximalTaskId = "M".repeat(128);
    manifest.nodes.push(
      {
        id: "A",
        type: "task",
        title: "Collision prefix task",
        prompt: "nodes/A/prompt.md",
        acceptance: ["Assignment succeeds."],
        blocks: [
          {
            id: "B--C",
            type: "implementation",
            title: "First collision block",
            prompt: "nodes/A/blocks/B--C.prompt.md",
            depends_on: []
          }
        ]
      },
      {
        id: "A--B",
        type: "task",
        title: "Collision suffix task",
        prompt: "nodes/A--B/prompt.md",
        acceptance: ["Assignment succeeds."],
        blocks: [
          {
            id: "C",
            type: "implementation",
            title: "Second collision block",
            prompt: "nodes/A--B/blocks/C.prompt.md",
            depends_on: []
          }
        ]
      },
      {
        id: maximalTaskId,
        type: "task",
        title: "Maximum identifier task",
        prompt: `nodes/${maximalTaskId}/prompt.md`,
        acceptance: ["Assignment succeeds."],
        blocks: [
          {
            id: "B-001",
            type: "implementation",
            title: "Maximum identifier block",
            prompt: `nodes/${maximalTaskId}/blocks/B-001.prompt.md`,
            depends_on: []
          }
        ]
      }
    );
    const fixture = await setup(manifest);
    const projectId = fixture.projectA.init.workspace.id;
    const ownerToken = await bootstrap(fixture.origin, projectId, "collision-owner");
    const workItems = [
      { kind: "block" as const, canvasId: "default", blockRef: "A#B--C" },
      { kind: "block" as const, canvasId: "default", blockRef: "A--B#C" },
      { kind: "task" as const, canvasId: "default", taskId: maximalTaskId }
    ];

    for (const workItem of workItems) {
      const response = await fetch(`${fixture.origin}/api/v1/projects/${projectId}/assignments`, {
        method: "POST",
        headers: jsonHeaders(ownerToken),
        body: JSON.stringify({
          workItem,
          target: { kind: "unassigned" },
          expectedRevision: 0
        })
      });
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({ workItem, revision: 1 });

      const workItemParameter = encodeURIComponent(JSON.stringify(workItem));
      const persisted = await fetch(
        `${fixture.origin}/api/v1/projects/${projectId}/assignments?workItem=${workItemParameter}`,
        { headers: { Authorization: `Bearer ${ownerToken}` } }
      );
      expect(persisted.status).toBe(200);
      await expect(persisted.json()).resolves.toMatchObject({ workItem, revision: 1 });
    }

    const feed = await fetch(`${fixture.origin}/api/v1/projects/${projectId}/activity?limit=20`, {
      headers: { Authorization: `Bearer ${ownerToken}` }
    });
    expect(feed.status).toBe(200);
    const body = (await feed.json()) as {
      items: Array<{ type: string; source: { kind: string; sourceId: string } }>;
    };
    const assignmentSources = body.items
      .filter((item) => item.type === "assignment_updated")
      .map((item) => item.source.sourceId);
    expect(assignmentSources).toHaveLength(workItems.length);
    expect(new Set(assignmentSources).size).toBe(workItems.length);
  });
});

describe("authorized Activity pagination", () => {
  it("advances across a full hidden scan budget without leaking or skipping visible events", async () => {
    const fixture = await setup();
    const projectId = fixture.projectA.init.workspace.id;
    const owner = await bootstrap(fixture.origin, projectId, "pagination-owner");
    const member = await inviteAndJoin(fixture.origin, owner, projectId, "Activity reader");
    const database = await openServerDatabase(fixture.config.databasePath, 5000);
    try {
      const access = new ProjectAccessRepository(database);
      access.registerCanvasInternal({
        workspaceId: projectAWorkspaceId,
        projectId,
        canvasId: "hidden",
        packageDir: join(fixture.projectA.root, "hidden"),
        ownerHumanPrincipalId: "pagination-owner"
      });
      database
        .prepare(
          "UPDATE project_registry SET visibility='shared' WHERE workspace_id=? AND project_id=?"
        )
        .run(projectAWorkspaceId, projectId);
      database
        .prepare(
          "UPDATE canvas_registry SET visibility='shared' WHERE workspace_id=? AND project_id=? AND canvas_id='default'"
        )
        .run(projectAWorkspaceId, projectId);
      const repository = new ActivityRepository(database, { workspaceId: projectAWorkspaceId });
      const expected: string[] = [];
      const baseOccurredAt = Date.now() + 10000;
      for (let index = 0; index < 1006; index += 1) {
        const visible = index >= 1001 && index % 2 === 1;
        const record = buildCommentActivity({
          activityId: repository.allocateActivityId(),
          projectId,
          type: "comment_created",
          commentId: `page-comment-${index}`,
          workItem: { kind: "task", canvasId: visible ? "default" : "hidden", taskId: "T-001" },
          authorHumanPrincipalId: "pagination-owner",
          authorDisplayName: "Owner",
          revision: 1,
          occurredAt: new Date(baseOccurredAt - index).toISOString()
        });
        repository.insertIdempotent(record);
        if (visible) expected.push(record.activityId);
      }
      const actual: string[] = [];
      let cursor: object | null = null;
      for (let page = 0; page < 10; page += 1) {
        const url = `${fixture.origin}/api/v1/projects/${projectId}/activity?limit=2${cursor ? `&cursor=${encodeURIComponent(JSON.stringify(cursor))}` : ""}`;
        const response = await fetch(url, { headers: jsonHeaders(member) });
        expect(response.status).toBe(200);
        const body = (await response.json()) as {
          items: Array<{ activityId: string; workItem?: { canvasId: string } }>;
          nextCursor: object | null;
        };
        expect(JSON.stringify(body.items)).not.toContain('"hidden"');
        if (page === 0) {
          expect(body.items).toEqual([]);
          expect(body.nextCursor).not.toBeNull();
        }
        actual.push(...body.items.filter((item) => item.workItem).map((item) => item.activityId));
        cursor = body.nextCursor;
        if (!cursor) break;
      }
      expect(cursor).toBeNull();
      expect(actual).toEqual(expected);
    } finally {
      database.close();
    }
  });
});

describe("composed live comment read grants", () => {
  it("revokes cached-client reads and isolates identical project/canvas IDs between workspaces", async () => {
    const fixture = await setupCommentReadComposition();
    const owner = fixture.owner;
    const member = await inviteAndJoin(
      fixture.origin,
      owner!.token,
      fixture.projectId,
      "Read member"
    );
    const otherOwner = fixture.createOtherWorkspace();
    const memberId = fixture.database
      .prepare("SELECT human_principal_id FROM workspace_device_sessions WHERE credential_sha256=?")
      .get(hashHumanToken(member)) as { human_principal_id: string };
    const comment = await fixture.createComment(owner!.token, "default", "private-comment-secret");
    const otherComment = await fixture.createComment(
      otherOwner!.token,
      "default",
      "other-workspace-secret"
    );
    const query = `workItem=${encodeURIComponent(JSON.stringify({ kind: "task", canvasId: "default", taskId: "T-001" }))}`;
    const read = (path: string, token = member) =>
      fetch(`${fixture.base}/${path}`, { headers: jsonHeaders(token) });
    for (const path of [`comments?${query}`, `activity?${query}`, "activity"]) {
      const denied = await read(path);
      expect(denied.status).toBe(403);
      expect(await denied.json()).toEqual({ error: "comment_auth_forbidden" });
    }
    await fixture.mutateAccess(owner!.token, owner!.workspaceId, "default", {
      operation: "grant",
      expectedAclRevision: 0,
      humanPrincipalId: memberId.human_principal_id,
      role: "viewer"
    });
    const allowed = await read(`comments?${query}`);
    expect(allowed.status).toBe(200);
    const allowedBody = await allowed.json();
    expect(allowedBody).toMatchObject({
      items: [{ commentId: comment.commentId, body: "private-comment-secret" }]
    });
    expect(JSON.stringify(allowedBody)).not.toContain(otherComment.commentId);
    const activity = await read("activity");
    expect(activity.status).toBe(200);
    const page = (await activity.json()) as { items: Array<{ type: string; workItem?: object }> };
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({
      type: "comment_created",
      workItem: { canvasId: "default" }
    });
    // A read-only grant cannot create comments and cannot expose project-only membership events.
    const write = await fetch(`${fixture.base}/comments`, {
      method: "POST",
      headers: jsonHeaders(member),
      body: JSON.stringify({
        workItem: { kind: "task", canvasId: "default", taskId: "T-001" },
        body: "viewer write"
      })
    });
    expect(write.status).toBe(403);
    const grant = fixture.access.listActiveCanvasPersonGrants({
      workspaceId: owner!.workspaceId,
      projectId: fixture.projectId,
      canvasId: "default",
      humanPrincipalId: memberId.human_principal_id
    })[0]!;
    await fixture.mutateAccess(owner!.token, owner!.workspaceId, "default", {
      operation: "revoke",
      expectedAclRevision: 1,
      grantId: grant.grantId
    });
    for (const path of [`comments?${query}`, `activity?${query}`, "activity"]) {
      const denied = await read(path);
      expect(denied.status).toBe(403);
      expect(await denied.json()).toEqual({ error: "comment_auth_forbidden" });
    }
    const otherList = await read(`comments?${query}`, otherOwner!.token);
    expect(otherList.status).toBe(200);
    expect(await otherList.json()).toMatchObject({
      items: [{ commentId: otherComment.commentId, body: "other-workspace-secret" }]
    });
    await fixture.mutateAccess(owner!.token, owner!.workspaceId, null, {
      operation: "visibility",
      expectedAclRevision: 0,
      visibility: "shared"
    });
    const projectFeed = await read("activity");
    expect(projectFeed.status).toBe(200);
    const sharedBody = (await projectFeed.json()) as { items: Array<{ type: string }> };
    expect(sharedBody.items.some((item) => item.type === "member_joined")).toBe(true);
    expect(JSON.stringify(sharedBody)).not.toContain(comment.commentId);
    const privateCanvas = await read(`comments?${query}`);
    expect(privateCanvas.status).toBe(403);
  });
});
