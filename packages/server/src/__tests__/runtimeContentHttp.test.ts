import {
  CANVAS_RUNTIME_CAPABILITY,
  agentHostProtocolVersion,
  type CanvasRuntimeRequestCommand
} from "@planweave-ai/agent-host-protocol";
import {
  canonicalContentVersionDigestPayload,
  type CompleteContentVersion
} from "@planweave-ai/collaboration-protocol/content/version";
import { createHash, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { ContentVersionRepository } from "../canvas/contentVersionRepository.js";
import { handleCanvasRuntimeContentRequest } from "../canvas/runtimeContentHttp.js";
import { CanvasRuntimeRpcBroker } from "../canvas/runtimeRpcBroker.js";
import { AgentHostRepository } from "../hosts.js";
import { DurableMailbox } from "../mailbox.js";
import { applyMigrations } from "../migrations.js";
import { openServerDatabase, type SqliteDatabase } from "../sqlite.js";
import { loopbackHttpTransportAdmission } from "./support/transportAdmission.js";

const databases: SqliteDatabase[] = [];
const servers: Server[] = [];
const scope = {
  workspaceId: "workspace-runtime",
  projectId: "project-runtime",
  canvasId: "default"
};
const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

function content(): CompleteContentVersion {
  const members = [
    {
      kind: "desktop_layout" as const,
      path: "desktop/layout.json",
      content: JSON.stringify({
        version: "desktop-layout/v1",
        projectId: "p",
        nodes: [],
        updatedAt: "2026-01-01T00:00:00.000Z"
      })
    },
    {
      kind: "manifest" as const,
      path: "manifest.json",
      content: JSON.stringify({
        version: "plan-package/v1",
        project: { title: "Plan", description: "" },
        execution: { parallel: { enabled: false, maxConcurrent: 1 } },
        review: { maxFeedbackCycles: 1, completionPolicy: "strict" },
        executors: {},
        nodes: [
          {
            id: "T-001",
            type: "task",
            title: "Task",
            prompt: "nodes/T-001/prompt.md",
            acceptance: ["done"],
            blocks: [
              {
                id: "B-001",
                type: "implementation",
                title: "Block",
                prompt: "nodes/T-001/blocks/B-001.prompt.md"
              }
            ]
          }
        ],
        edges: []
      })
    },
    { kind: "task_prompt" as const, path: "nodes/T-001/prompt.md", content: "# Task\n" },
    {
      kind: "block_prompt" as const,
      path: "nodes/T-001/blocks/B-001.prompt.md",
      content: "# Block\n"
    }
  ]
    .map((member) => ({
      ...member,
      digestSha256: sha256(member.content),
      sizeBytes: Buffer.byteLength(member.content)
    }))
    .sort((left, right) => left.path.localeCompare(right.path));
  const totalBytes = members.reduce((sum, member) => sum + member.sizeBytes, 0);
  return {
    members,
    totalBytes,
    canonicalDigest: sha256(
      canonicalContentVersionDigestPayload({ members, totalBytes, canonicalDigest: "0".repeat(64) })
    )
  };
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve())))
  );
  for (const database of databases.splice(0)) database.close();
});

function runtimeContentUrl(
  baseUrl: string,
  hostId: string,
  target: { versionId: string; canonicalDigest: string },
  inputScope = scope
): string {
  return `${baseUrl}/agent-hosts/${hostId}/canvas-runtime/content/${inputScope.projectId}/${inputScope.canvasId}/${target.versionId}?workspaceId=${inputScope.workspaceId}&canonicalDigest=${target.canonicalDigest}`;
}

function requestCommand(mailbox: DurableMailbox, hostId: string): CanvasRuntimeRequestCommand {
  const message = mailbox.listAfter(hostId, 0).at(-1);
  if (message?.command.type !== "canvas_runtime.request") {
    throw new Error("test_canvas_runtime_request_expected");
  }
  return message.command;
}

describe("Canvas Runtime content HTTP authorization", () => {
  it("serves only the exact pending Host content target and fails closed after it settles", async () => {
    const database = await openServerDatabase(":memory:", 5_000);
    databases.push(database);
    applyMigrations(database);
    const hosts = new AgentHostRepository(database);
    const mailbox = new DurableMailbox(database);
    const active = new Set<string>();
    const broker = new CanvasRuntimeRpcBroker(database, hosts, mailbox, {
      requestTimeoutMs: 5_000
    });
    broker.attachSessionLookup({ isActive: (hostId) => active.has(hostId) });
    const registration = hosts.register("Runtime Host");
    hosts.reportOnline(registration.host.id, [CANVAS_RUNTIME_CAPABILITY], 1);
    active.add(registration.host.id);
    const other = hosts.register("Other Runtime Host");
    hosts.reportOnline(other.host.id, [CANVAS_RUNTIME_CAPABILITY], 1);
    active.add(other.host.id);

    const contentVersions = new ContentVersionRepository(database);
    const published = contentVersions.publishInitial({
      scope,
      content: content(),
      createdBy: { kind: "system", id: "test" }
    });
    const target = {
      revision: published.head.revision,
      content: published.head.content,
      graphFingerprint: `pkg-${"a".repeat(64)}`
    };
    const server = createServer((request, response) => {
      void handleCanvasRuntimeContentRequest(request, response, {
        hosts,
        authorization: broker,
        contentVersions,
        transportAdmission: loopbackHttpTransportAdmission
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test_http_address_missing");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const pending = broker.request(registration.host.id, scope, {
      operation: "availability",
      contentTarget: target
    });
    const headers = { authorization: `Bearer ${registration.token}` };

    const exact = await fetch(runtimeContentUrl(baseUrl, registration.host.id, target.content), {
      headers
    });
    expect(exact.status).toBe(200);
    expect(await exact.text()).toContain('"type":"complete"');

    const wrongHost = await fetch(runtimeContentUrl(baseUrl, other.host.id, target.content), {
      headers: { authorization: `Bearer ${other.token}` }
    });
    expect(wrongHost.status).toBe(403);
    const wrongScope = await fetch(
      runtimeContentUrl(baseUrl, registration.host.id, target.content, {
        ...scope,
        canvasId: "other-canvas"
      }),
      { headers }
    );
    expect(wrongScope.status).toBe(403);
    const wrongContent = {
      versionId: `version-${"d".repeat(64)}`,
      canonicalDigest: "d".repeat(64),
      verification: "complete" as const
    };
    const wrongDigest = await fetch(
      runtimeContentUrl(baseUrl, registration.host.id, wrongContent),
      { headers }
    );
    expect(wrongDigest.status).toBe(403);

    const command = requestCommand(mailbox, registration.host.id);
    broker.handleResponse(registration.host.id, {
      type: "canvas_runtime.response",
      protocolVersion: agentHostProtocolVersion,
      messageId: randomUUID(),
      requestId: command.requestId,
      response: {
        outcome: "success",
        operation: "availability",
        result: { kind: "unavailable", reason: "host_offline" }
      }
    });
    await pending;
    const settled = await fetch(runtimeContentUrl(baseUrl, registration.host.id, target.content), {
      headers
    });
    expect(settled.status).toBe(403);

    const stalePending = broker.request(registration.host.id, scope, {
      operation: "availability",
      contentTarget: { ...target, revision: target.revision + 1, content: wrongContent }
    });
    const stale = await fetch(runtimeContentUrl(baseUrl, registration.host.id, wrongContent), {
      headers
    });
    expect(stale.status).toBe(409);
    const staleAssertion = expect(stalePending).rejects.toMatchObject({
      code: "canvas_runtime_host_disconnected"
    });
    broker.detachHost(registration.host.id, "disconnected");
    await staleAssertion;
  });
});
