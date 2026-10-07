import { gzipSync } from "node:zlib";
import { COMMENT_ATTACHMENT_MAX_BYTES } from "@planweave-ai/collaboration-protocol/core/limits";
import { CollaborationHttpTransport } from "../main/collaboration/collaborationHttpTransport.js";
import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { exampleHumanDeviceToken } from "@planweave-ai/collaboration-protocol/fixtures/collaboration";
import { CollaborationClient } from "../main/collaboration/CollaborationClient.js";

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const close of cleanup.reverse()) await close();
  cleanup.length = 0;
});
const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
const digest = createHash("sha256").update(bytes).digest("hex");
const uploaded = {
  pendingUploadId: "pending-1",
  status: "uploaded",
  mediaType: "image/png",
  sizeBytes: bytes.length
};

async function fixture(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
  timeout = 50,
  requestImpl?: typeof fetch
) {
  const server = createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing TCP address");
  const origin = `http://127.0.0.1:${address.port}/`;
  cleanup.push(
    () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      })
  );
  const client = new CollaborationClient({
    profile: {
      profileId: "attachment-test",
      displayName: "Test",
      serverBaseUrl: origin,
      projectId: "project-demo-001",
      allowInsecureTransport: true,
      endpoint: {
        topology: "loopback_http",
        serverOrigin: origin,
        allowedClientOrigins: [origin],
        tlsTrust: "not_applicable"
      }
    },
    request: requestImpl,
    credential: { getDeviceToken: () => exampleHumanDeviceToken },
    limits: { requestTimeoutMs: timeout, jsonBodyMaxBytes: 512 }
  });
  cleanup.push(() => client.dispose());
  return client;
}
function request(client: CollaborationClient, method: "PUT" | "GET", signal?: AbortSignal) {
  return method === "PUT"
    ? client.uploadPendingAttachment(
        "pending-1",
        { body: bytes, mediaType: "image/png", digestSha256: digest },
        signal
      )
    : client.readCommentAttachment("comment-1", digest, signal);
}

describe("Collaboration attachment HTTP body ownership", () => {
  it.each([
    "PUT",
    "GET"
  ] as const)("keeps %s deadline after headers and closes stalled socket without replay", async (method) => {
    let calls = 0;
    let closed!: () => void;
    const socketClosed = new Promise<void>((resolve) => {
      closed = resolve;
    });
    const client = await fixture((req, res) => {
      calls++;
      req.resume();
      res.on("close", closed);
      res.writeHead(200, { "content-type": method === "PUT" ? "application/json" : "image/png" });
      res.write(method === "PUT" ? "{" : bytes.subarray(0, 1));
    });
    await expect(request(client, method)).rejects.toMatchObject({
      kind: "timeout",
      code: "collaboration_timeout"
    });
    await socketClosed;
    expect(calls).toBe(1);
  }, 600);

  it.each(["PUT", "GET"] as const)("bounds stalled %s HTTP error body", async (method) => {
    const client = await fixture((req, res) => {
      req.resume();
      res.writeHead(403, { "content-type": "application/json" });
      res.write('{"error":');
    });
    await expect(request(client, method)).rejects.toMatchObject({ kind: "timeout" });
  }, 600);

  it.each([
    "declared",
    "single chunk",
    "cumulative",
    "compressed length"
  ])("rejects upload response budget: %s", async (mode) => {
    let closed!: () => void;
    const socketClosed = new Promise<void>((resolve) => {
      closed = resolve;
    });
    const client = await fixture((req, res) => {
      req.resume();
      res.on("close", closed);
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (mode === "declared") headers["content-length"] = "513";
      if (mode === "compressed length") {
        const compressed = gzipSync(Buffer.from("x".repeat(513)));
        headers["content-length"] = String(compressed.length);
        headers["content-encoding"] = "gzip";
        res.writeHead(200, headers);
        res.end(compressed);
        return;
      }
      res.writeHead(200, headers);
      if (mode === "declared") res.flushHeaders();
      else if (mode === "single chunk") res.write("x".repeat(513));
      else {
        res.write("x".repeat(300));
        res.write("x".repeat(213));
      }
    }, 500);
    await expect(request(client, "PUT")).rejects.toMatchObject({
      kind: "payload_too_large",
      code: "collaboration_response_too_large"
    });
    await socketClosed;
  });

  it.each(["PUT", "GET"] as const)("bounds oversized %s HTTP error body", async (method) => {
    const client = await fixture((req, res) => {
      req.resume();
      res.writeHead(403, { "content-type": "application/json" });
      res.write("x".repeat(513));
    }, 500);
    await expect(request(client, method)).rejects.toMatchObject({
      kind: "payload_too_large",
      httpStatus: 403
    });
  });

  it.each(["declared", "stream"])("rejects binary attachment over budget: %s", async (mode) => {
    const client = await fixture((req, res) => {
      req.resume();
      res.writeHead(200, {
        "content-type": "image/png",
        ...(mode === "declared"
          ? { "content-length": String(COMMENT_ATTACHMENT_MAX_BYTES + 1) }
          : {})
      });
      if (mode === "declared") res.flushHeaders();
      else res.write(Buffer.alloc(COMMENT_ATTACHMENT_MAX_BYTES + 1));
    }, 2_000);
    await expect(request(client, "GET")).rejects.toMatchObject({ kind: "payload_too_large" });
  });

  it.each([
    { body: Buffer.from("{"), code: "collaboration_malformed_json" },
    { body: Buffer.from("{}"), code: "collaboration_response_invalid" },
    {
      body: Buffer.concat([
        Buffer.from('{"pendingUploadId":"pending-'),
        Buffer.from([0xff]),
        Buffer.from('","status":"uploaded","mediaType":"image/png"}')
      ]),
      code: "collaboration_malformed_json"
    }
  ])("validates upload JSON and UTF-8 ($code)", async ({ body, code }) => {
    const client = await fixture((req, res) => {
      req.resume();
      res.end(body);
    }, 500);
    await expect(request(client, "PUT")).rejects.toMatchObject({ kind: "protocol", code });
  });

  it.each([
    { method: "PUT", status: 401, kind: "auth" },
    { method: "GET", status: 401, kind: "auth" },
    { method: "PUT", status: 403, kind: "forbidden" },
    { method: "GET", status: 403, kind: "forbidden" }
  ] as const)("preserves $method HTTP $status for a non-UTF-8 error body", async ({
    method,
    status,
    kind
  }) => {
    const client = await fixture((req, res) => {
      req.resume();
      res.writeHead(status, { "retry-after": "2" });
      res.end(Buffer.from([0xff]));
    }, 500);
    await expect(request(client, method)).rejects.toMatchObject({
      kind,
      httpStatus: status,
      code: `http_${status}`,
      retryAfterMs: 2_000
    });
  });

  it("preserves HTTP error mapping and retry-after", async () => {
    const client = await fixture((req, res) => {
      req.resume();
      res.writeHead(429, { "retry-after": "2" });
      res.end(JSON.stringify({ error: "rate_limit_exceeded" }));
    }, 500);
    await expect(request(client, "PUT")).rejects.toMatchObject({
      httpStatus: 429,
      retryAfterMs: 2_000,
      code: "rate_limit_exceeded"
    });
  });

  it.each(["abort", "dispose"] as const)("attributes %s during body reading", async (cause) => {
    let headersReady!: () => void;
    const ready = new Promise<void>((resolve) => {
      headersReady = resolve;
    });
    const requestImpl: typeof fetch = async (url, init) => {
      const response = await fetch(url, init);
      headersReady();
      return response;
    };
    const client = await fixture(
      (req, res) => {
        req.resume();
        res.writeHead(200, { "content-type": "image/png" });
        res.write(bytes.subarray(0, 1));
      },
      500,
      requestImpl
    );
    const controller = new AbortController();
    const result = expect(request(client, "GET", controller.signal)).rejects.toMatchObject({
      kind: "aborted",
      code: "collaboration_aborted",
      retryable: false
    });
    await ready;
    if (cause === "abort") controller.abort(new Error("caller cancelled"));
    else client.dispose();
    await result;
  });

  it.each(["abort", "dispose"] as const)("attributes %s before response headers", async (cause) => {
    let requested!: () => void;
    const ready = new Promise<void>((resolve) => {
      requested = resolve;
    });
    const client = await fixture((req) => {
      req.resume();
      requested();
    }, 500);
    const controller = new AbortController();
    const result = expect(request(client, "PUT", controller.signal)).rejects.toMatchObject({
      kind: "aborted",
      retryable: false
    });
    await ready;
    if (cause === "abort") controller.abort("caller cancelled");
    else client.dispose();
    await result;
  });

  it("isolates concurrent cancellation and allows another successful request", async () => {
    let headersReady!: () => void;
    const ready = new Promise<void>((resolve) => {
      headersReady = resolve;
    });
    let count = 0;
    const client = await fixture(
      (req, res) => {
        req.resume();
        res.writeHead(200, { "content-type": "image/png" });
        if (++count === 1) res.write(bytes.subarray(0, 1));
        else res.end(bytes);
      },
      500,
      async (url, init) => {
        const response = await fetch(url, init);
        headersReady();
        return response;
      }
    );
    const controller = new AbortController();
    const cancelled = expect(request(client, "GET", controller.signal)).rejects.toMatchObject({
      kind: "aborted"
    });
    await ready;
    const successful = request(client, "GET");
    controller.abort();
    await cancelled;
    await expect(successful).resolves.toMatchObject({
      digestSha256: digest,
      sizeBytes: bytes.length
    });
    await expect(request(client, "GET")).resolves.toMatchObject({
      bodyBase64: bytes.toString("base64")
    });
  });

  it("accepts exact JSON and binary budgets with authentication and digest intact", async () => {
    const binary = Buffer.alloc(COMMENT_ATTACHMENT_MAX_BYTES, 1);
    const sha = createHash("sha256").update(binary).digest("hex");
    const json = JSON.stringify(uploaded).padEnd(512, " ");
    let authenticated = 0;
    const client = await fixture((req, res) => {
      if (req.headers.authorization === `Bearer ${exampleHumanDeviceToken}`) authenticated++;
      req.resume();
      if (req.method === "PUT") {
        res.writeHead(200, { "content-length": "512" });
        res.end(json);
      } else {
        res.writeHead(200, {
          "content-type": "image/png",
          "content-length": String(binary.length)
        });
        res.end(binary);
      }
    }, 2_000);
    await expect(request(client, "PUT")).resolves.toMatchObject({
      pendingUploadId: "pending-1",
      status: "uploaded",
      expectedSizeBytes: bytes.length
    });
    await expect(client.readCommentAttachment("comment-1", sha)).resolves.toMatchObject({
      digestSha256: sha,
      sizeBytes: binary.length
    });
    expect(authenticated).toBe(2);
  });

  it("rejects immediately without waiting for a never-settling cancellation", async () => {
    let cancelled = 0;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(513));
      },
      cancel() {
        cancelled++;
        return new Promise<void>(() => {});
      }
    });
    const transport = new CollaborationHttpTransport({
      serverBaseUrl: "http://127.0.0.1:1/",
      credential: { getDeviceToken: () => exampleHumanDeviceToken },
      limits: { jsonBodyMaxBytes: 512 },
      request: async () => new Response(body)
    });
    cleanup.push(() => transport.dispose());
    await expect(
      transport.consumeResponse("/api/v1/test", { method: "GET", headers: {} }, (response) =>
        transport.readBytesLimited(response, 512)
      )
    ).rejects.toMatchObject({ kind: "payload_too_large" });
    expect(cancelled).toBe(1);
    expect(body.locked).toBe(false);
  }, 600);
});
