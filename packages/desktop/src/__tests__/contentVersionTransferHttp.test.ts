import { createServer } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { contentVersionTransferMediaType } from "@planweave-ai/collaboration-protocol/content/transfer";
import { CollaborationHttpTransport } from "../main/collaboration/collaborationHttpTransport.js";
import { fetchContentVersionTransfer } from "../main/collaboration/contentVersionTransfer.js";

const scope = {
  workspaceId: "workspace-demo-001",
  projectId: "project-demo-001",
  canvasId: "canvas-demo-001"
};
const digest = "a".repeat(64);
const content = {
  versionId: `version-${digest}`,
  canonicalDigest: digest,
  verification: "complete" as const
};
const invalidHeader = `${JSON.stringify({
  type: "header",
  schemaVersion: "content-version/v1",
  scope: { ...scope, canvasId: "other-canvas" },
  completed: content,
  canonicalDigest: digest,
  totalBytes: 4,
  memberCount: 2,
  createdAt: "2026-08-01T00:00:00.000Z",
  createdBy: { kind: "human", id: "owner" }
})}\n`;
const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

describe("Content transfer HTTP reader ownership", () => {
  it("closes a stalled body on consumer authority rejection and permits the next request", async () => {
    let closed!: () => void;
    const socketClosed = new Promise<void>((resolve) => {
      closed = resolve;
    });
    const server = createServer((req, res) => {
      req.resume();
      if (req.url === "/next") {
        res.end("{}");
        return;
      }
      res.once("close", closed);
      res.writeHead(200, { "content-type": contentVersionTransferMediaType });
      res.write(invalidHeader);
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    cleanup.push(
      () =>
        new Promise<void>((resolve, reject) => {
          server.closeAllConnections();
          server.close((error) => (error ? reject(error) : resolve()));
        })
    );
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing TCP address");
    let body: ReadableStream<Uint8Array> | null = null;
    const transport = new CollaborationHttpTransport({
      serverBaseUrl: `http://127.0.0.1:${address.port}/`,
      credential: { getDeviceToken: () => "test-only" },
      limits: { requestTimeoutMs: 500 },
      request: async (url, init) => {
        const response = await fetch(url, init);
        body = response.body;
        return response;
      }
    });
    cleanup.push(() => transport.dispose());
    await expect(fetchContentVersionTransfer({ transport, scope, content })).rejects.toMatchObject({
      kind: "protocol",
      code: "content_transfer_authority_mismatch"
    });
    // Observe closure before disposal; the domain failure already released the deadline.
    await socketClosed;
    expect(body?.locked).toBe(false);
    await expect(transport.jsonEmpty("GET", "/next", {})).resolves.toBeUndefined();
  }, 1500);

  it("preserves the consumer error and releases lock and timer when cancellation never settles", async () => {
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(invalidHeader));
      },
      cancel
    });
    const clearTimeout = vi.fn();
    const transport = new CollaborationHttpTransport({
      serverBaseUrl: "http://127.0.0.1:1/",
      credential: { getDeviceToken: () => "test-only" },
      request: async () =>
        new Response(body, { headers: { "content-type": contentVersionTransferMediaType } }),
      clock: { now: () => new Date(), setTimeout: () => 1, clearTimeout }
    });
    cleanup.push(() => transport.dispose());
    await expect(fetchContentVersionTransfer({ transport, scope, content })).rejects.toMatchObject({
      kind: "protocol",
      code: "content_transfer_authority_mismatch"
    });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(body.locked).toBe(false);
    expect(clearTimeout).toHaveBeenCalledTimes(1);
  }, 600);
});
