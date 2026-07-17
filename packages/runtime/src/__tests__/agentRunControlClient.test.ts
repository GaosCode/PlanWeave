import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentRunControlClient } from "../autoRun/agentRunControlClient.js";
import {
  AGENT_RUN_CONTROL_MAX_FRAME_BYTES,
  AGENT_RUN_CONTROL_PROTOCOL_VERSION,
  agentRunControlCommandSchema,
  agentRunControlEndpointDescriptorSchema,
  agentRunControlLeaseIdSchema,
  agentRunControlSuccessReceiptSchema,
  type AgentRunControlResponse
} from "../autoRun/agentRunControlContract.js";
import { AgentRunControlServer } from "../autoRun/agentRunControlServer.js";
import type { AgentRunControlTarget } from "../autoRun/agentRunControlTarget.js";

const roots: string[] = [];
const leaseId = agentRunControlLeaseIdSchema.parse("6202e8ad-0634-4f80-ad56-a6a8080b1d65");
const commandId = "405542d4-f89a-4e95-aaaf-104e44188626";
const identity = {
  scope: "/workspace/planweave",
  executorRunId: "executor-run-1",
  desktopRunId: "desktop-run-1",
  runSessionId: "run-session-1",
  claimRef: "T-001#B-001",
  sessionId: "acp-session-1"
};

function command() {
  return agentRunControlCommandSchema.parse({
    version: AGENT_RUN_CONTROL_PROTOCOL_VERSION,
    kind: "cancel",
    commandId,
    leaseId,
    identity
  });
}

function frame(response: AgentRunControlResponse): Buffer {
  const payload = Buffer.from(JSON.stringify(response), "utf8");
  const result = Buffer.alloc(4 + payload.byteLength);
  result.writeUInt32BE(payload.byteLength, 0);
  payload.copy(result, 4);
  return result;
}

async function rawEndpoint(label: string, respond: (socket: import("node:net").Socket) => void) {
  const root = await mkdtemp(join(tmpdir(), `pw-control-client-${label}-`));
  roots.push(root);
  const address = join(root, "control.sock");
  const server = createServer((socket) => {
    socket.once("data", () => respond(socket));
  });
  server.listen(address);
  await once(server, "listening");
  const descriptor = agentRunControlEndpointDescriptorSchema.parse({
    version: AGENT_RUN_CONTROL_PROTOCOL_VERSION,
    transport: "unix",
    address,
    leaseId,
    ownerPid: process.pid,
    publishedAt: "2026-07-17T07:00:00.000Z"
  });
  return { descriptor, server };
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("agent run control client", () => {
  it("executes a framed command against the real node:net control server", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "pw-control-client-server-"));
    roots.push(runDir);
    const cancel = vi.fn(async () => ({
      status: "delivered" as const,
      deliveredAt: "2026-07-17T07:00:01.000Z"
    }));
    const target: AgentRunControlTarget = {
      cancel,
      respond: vi.fn(async () => ({ status: "accepted" as const })),
      followUp: vi.fn(async () => ({ status: "accepted" as const }))
    };
    const server = new AgentRunControlServer({
      runDir,
      leaseId,
      target,
      now: () => new Date("2026-07-17T07:00:00.000Z")
    });
    const descriptor = await server.start();
    try {
      await expect(new AgentRunControlClient(descriptor).execute(command())).resolves.toEqual({
        version: AGENT_RUN_CONTROL_PROTOCOL_VERSION,
        ok: true,
        commandId,
        acceptedAt: "2026-07-17T07:00:00.000Z",
        ownerPid: process.pid,
        leaseId,
        result: { status: "delivered", deliveredAt: "2026-07-17T07:00:01.000Z" }
      });
      expect(cancel).toHaveBeenCalledWith(identity);
    } finally {
      await server.stop();
    }
  });

  it("reassembles a split response frame and preserves accepted receipts", async () => {
    const response = agentRunControlSuccessReceiptSchema.parse({
      version: AGENT_RUN_CONTROL_PROTOCOL_VERSION,
      ok: true,
      commandId,
      acceptedAt: "2026-07-17T07:00:00.000Z",
      ownerPid: process.pid,
      leaseId,
      result: { status: "accepted" }
    });
    const endpoint = await rawEndpoint("split", (socket) => {
      const encoded = frame(response);
      socket.write(encoded.subarray(0, 2));
      setImmediate(() => socket.end(encoded.subarray(2)));
    });
    try {
      await expect(
        new AgentRunControlClient(endpoint.descriptor).execute(command())
      ).resolves.toEqual(response);
    } finally {
      await close(endpoint.server);
    }
  });

  it("maps malformed, oversized, timed-out, and unavailable responses to typed errors", async () => {
    const oversized = await rawEndpoint("oversized", (socket) => {
      const header = Buffer.alloc(4);
      header.writeUInt32BE(AGENT_RUN_CONTROL_MAX_FRAME_BYTES + 1, 0);
      socket.end(header);
    });
    try {
      await expect(
        new AgentRunControlClient(oversized.descriptor).execute(command())
      ).resolves.toMatchObject({
        ok: false,
        code: "protocol_mismatch",
        commandId
      });
    } finally {
      await close(oversized.server);
    }

    const timedOut = await rawEndpoint("timeout", () => undefined);
    try {
      await expect(
        new AgentRunControlClient(timedOut.descriptor, { timeoutMs: 20 }).execute(command())
      ).resolves.toMatchObject({ ok: false, code: "delivery_failed", commandId });
    } finally {
      await close(timedOut.server);
    }

    const missingRoot = await mkdtemp(join(tmpdir(), "pw-control-missing-"));
    roots.push(missingRoot);
    const unavailable = { ...timedOut.descriptor, address: join(missingRoot, "missing.sock") };
    await expect(new AgentRunControlClient(unavailable).execute(command())).resolves.toMatchObject({
      ok: false,
      code: "delivery_failed",
      commandId
    });
  });
});
