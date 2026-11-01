import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { acpConversationOrderedPageSchema } from "@planweave-ai/agent-host-protocol";
import { COLLABORATION_JSON_RESPONSE_MAX_BYTES } from "@planweave-ai/collaboration-protocol/core/limits";
import { OperatorControlClient } from "../main/operatorControl/OperatorControlClient.js";
import { CollaborationHttpTransport } from "../main/collaboration/collaborationHttpTransport.js";
import { CollaborationRemoteOperationsClient } from "../main/collaboration/CollaborationRemoteOperationsClient.js";

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.reverse()) await close();
  cleanup.length = 0;
});
async function fixture(handler: (req: IncomingMessage, res: ServerResponse) => void) {
  const server = createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing TCP address");
  cleanup.push(
    () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      })
  );
  const serverBaseUrl = `http://127.0.0.1:${address.port}/`;
  const owner = new OperatorControlClient({
    profile: {
      profileId: "conversation-test",
      displayName: "Test",
      serverBaseUrl,
      allowInsecureTransport: true
    },
    credential: {
      getOperatorToken: () => "operator_test_abcdefghijklmnopqrstuvwxyz_1234",
      getHumanIdentityToken: () => `pw_hid_${"a".repeat(43)}`
    },
    requestTimeoutMs: 3000
  });
  const transport = new CollaborationHttpTransport({
    serverBaseUrl,
    credential: { getDeviceToken: () => "device-test" }
  });
  cleanup.push(
    () => owner.dispose(),
    () => transport.dispose()
  );
  return { owner, workspace: new CollaborationRemoteOperationsClient("project-test", transport) };
}
const identity = { executionAttemptId: "attempt-test", sessionId: "session-test" };
const page = acpConversationOrderedPageSchema.parse({
  available: true,
  reason: null,
  ...identity,
  turns: Array.from({ length: 3 }, (_, i) => ({
    ...identity,
    turnId: `turn-${i}`,
    turnOrder: i + 1,
    status: "failed",
    createdAt: "2030-01-01T00:00:00.000Z",
    error: "Readable failure detail. ".repeat(1500)
  })),
  events: [],
  cursor: 0,
  hasMore: false
});
const action = { kind: "prompt", ...identity, turnId: "turn-next", text: "Continue" } as const;

describe("Owner ACP conversation HTTP budget", () => {
  it.each([
    ["owner", 1],
    ["owner", 2],
    ["workspace", 1],
    ["workspace", 2]
  ] as const)("rejects a %s v%i-shaped success on the v3 endpoint", async (surface, version) => {
    const unsequenced = {
      ...page,
      turns: page.turns.map(({ turnOrder: _order, ...turn }) => turn)
    };
    const { turnCursor: _cursor, hasMoreTurns: _more, ...legacy } = unsequenced;
    const { owner, workspace } = await fixture((req, res) => {
      req.resume();
      res.end(JSON.stringify(version === 1 ? legacy : unsequenced));
    });
    const read =
      surface === "owner"
        ? owner.acpConversation("operation-test", 0, "human-test")
        : workspace.acpConversation("operation-test", 0);
    await expect(read).rejects.toMatchObject({
      kind: "protocol",
      code: surface === "owner" ? "operator_response_invalid" : "collaboration_response_invalid"
    });
  });
  it.each([
    "GET",
    "POST"
  ] as const)("reads a schema-valid large %s page identically to Workspace defaults", async (method) => {
    const bytes = Buffer.from(JSON.stringify(page));
    expect(bytes.length).toBeGreaterThan(64 * 1024);
    expect(bytes.length).toBeLessThan(COLLABORATION_JSON_RESPONSE_MAX_BYTES);
    const calls: { method: string | undefined; path: string | undefined }[] = [];
    const { owner, workspace } = await fixture((req, res) => {
      calls.push({ method: req.method, path: req.url });
      req.resume();
      res.writeHead(200, { "content-type": "application/json", "content-length": bytes.length });
      res.end(bytes);
    });
    const input = method === "POST" ? action : undefined;
    await expect(workspace.acpConversation("operation-test", 0, input, "turn-0")).resolves.toEqual(
      page
    );
    await expect(
      owner.acpConversation("operation-test", 0, "human-test", input, "turn-0")
    ).resolves.toEqual(page);
    expect(calls).toEqual([
      {
        method,
        path: `/api/v1/projects/project-test/remote-operations/operation-test/conversation/v3${method === "GET" ? "?afterCursor=0&afterTurnId=turn-0" : ""}`
      },
      {
        method,
        path: `/api/v1/remote-operations/operation-test/conversation/v3${method === "GET" ? "?afterCursor=0&afterTurnId=turn-0" : ""}`
      }
    ]);
  });

  it.each([
    "owner",
    "workspace"
  ] as const)("rejects oversized declared, chunked, and decoded gzip bodies on %s and remains usable", async (surface) => {
    for (const mode of ["declared", "chunked", "gzip"] as const) {
      let calls = 0;
      const { owner, workspace } = await fixture((req, res) => {
        req.resume();
        if (++calls > 1) {
          res.end(JSON.stringify(page));
          return;
        }
        const bytes = Buffer.alloc(COLLABORATION_JSON_RESPONSE_MAX_BYTES + 1, 0x61);
        if (mode === "declared") {
          res.writeHead(200, { "content-length": bytes.length });
          res.flushHeaders();
        } else if (mode === "gzip") {
          const compressed = gzipSync(bytes);
          res.writeHead(200, { "content-encoding": "gzip", "content-length": compressed.length });
          res.end(compressed);
        } else {
          res.write(bytes);
        }
      });
      const read = (input?: typeof action) =>
        surface === "owner"
          ? owner.acpConversation("operation-test", 0, "human-test", input)
          : workspace.acpConversation("operation-test", 0, input);
      await expect(read(action)).rejects.toMatchObject({
        kind: "payload_too_large",
        code:
          surface === "owner" ? "operator_response_too_large" : "collaboration_response_too_large"
      });
      await expect(read()).resolves.toEqual(page);
      expect(calls).toBe(2);
    }
  });

  it("retains the general 64 KiB bound for conversation error responses", async () => {
    const { owner } = await fixture((req, res) => {
      req.resume();
      res.writeHead(403, { "content-length": 64 * 1024 + 1 });
      res.flushHeaders();
    });
    await expect(owner.acpConversation("operation-test", 0, "human-test")).rejects.toMatchObject({
      kind: "payload_too_large",
      code: "operator_response_too_large"
    });
  });
});
