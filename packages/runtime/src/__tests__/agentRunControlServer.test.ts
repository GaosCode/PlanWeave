import { once } from "node:events";
import { lstat, mkdtemp, rm } from "node:fs/promises";
import { createConnection, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AGENT_RUN_CONTROL_MAX_FRAME_BYTES,
  AGENT_RUN_CONTROL_PROTOCOL_VERSION,
  agentRunControlLeaseIdSchema,
  agentRunControlResponseSchema,
  type AgentRunControlResponse
} from "../autoRun/agentRunControlContract.js";
import { readAgentRunControlDescriptor } from "../autoRun/agentRunControlEndpoint.js";
import { AgentRunControlServer } from "../autoRun/agentRunControlServer.js";
import type { AgentRunControlTarget } from "../autoRun/agentRunControlTarget.js";

const roots: string[] = [];
const leaseId = agentRunControlLeaseIdSchema.parse("6202e8ad-0634-4f80-ad56-a6a8080b1d65");
const staleLeaseId = agentRunControlLeaseIdSchema.parse("f9a239c5-1ee5-41e5-8caf-a0e59d76dc8e");
const sessionIdentity = {
  scope: "/workspace/planweave",
  executorRunId: "executor-run-1",
  desktopRunId: "desktop-run-1",
  runSessionId: "run-session-1",
  claimRef: "T-001#B-001",
  sessionId: "acp-session-1"
};

async function temporaryRoot(label: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `planweave-control-server-${label}-`));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function requestFrame(value: unknown): Buffer {
  const payload = Buffer.from(JSON.stringify(value), "utf8");
  const frame = Buffer.alloc(4 + payload.byteLength);
  frame.writeUInt32BE(payload.byteLength, 0);
  payload.copy(frame, 4);
  return frame;
}

function responseFrom(socket: Socket): Promise<AgentRunControlResponse> {
  return new Promise((resolve, reject) => {
    let buffered = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      buffered = Buffer.concat([buffered, chunk]);
      if (buffered.byteLength < 4) return;
      const length = buffered.readUInt32BE(0);
      if (buffered.byteLength < 4 + length) return;
      try {
        resolve(
          agentRunControlResponseSchema.parse(
            JSON.parse(buffered.subarray(4, 4 + length).toString("utf8")) as unknown
          )
        );
      } catch (error) {
        reject(error);
      } finally {
        socket.end();
      }
    });
    socket.once("error", reject);
  });
}

async function sendRequest(
  address: string,
  value: unknown,
  splitAt: number | null = null
): Promise<AgentRunControlResponse> {
  const socket = createConnection(address);
  await once(socket, "connect");
  const response = responseFrom(socket);
  const encoded = requestFrame(value);
  if (splitAt === null) {
    socket.write(encoded);
  } else {
    socket.write(encoded.subarray(0, splitAt));
    await new Promise<void>((resolve) => setImmediate(resolve));
    socket.write(encoded.subarray(splitAt));
  }
  return response;
}

function targetFixture(): AgentRunControlTarget {
  return {
    cancel: vi.fn(async () => ({
      status: "delivered",
      deliveredAt: "2026-07-17T07:00:01.000Z"
    })),
    respond: vi.fn(async () => ({
      status: "delivered",
      deliveredAt: "2026-07-17T07:00:01.000Z"
    })),
    followUp: vi.fn(async () => ({ status: "accepted" }))
  };
}

function cancelCommand(commandId: string, commandLease = leaseId) {
  return {
    version: AGENT_RUN_CONTROL_PROTOCOL_VERSION,
    kind: "cancel",
    commandId,
    leaseId: commandLease,
    identity: sessionIdentity
  };
}

describe("agent run control server", () => {
  it("routes a partial length-prefixed frame through the narrow target", async () => {
    const runDir = await temporaryRoot("partial");
    const target = targetFixture();
    const server = new AgentRunControlServer({
      runDir,
      leaseId,
      target,
      now: () => new Date("2026-07-17T07:00:00.000Z")
    });
    const descriptor = await server.start();
    try {
      const command = cancelCommand("405542d4-f89a-4e95-aaaf-104e44188626");
      const response = await sendRequest(descriptor.address, command, 2);

      expect(response).toEqual({
        version: AGENT_RUN_CONTROL_PROTOCOL_VERSION,
        ok: true,
        commandId: command.commandId,
        acceptedAt: "2026-07-17T07:00:00.000Z",
        ownerPid: process.pid,
        leaseId,
        result: { status: "delivered", deliveredAt: "2026-07-17T07:00:01.000Z" }
      });
      expect(target.cancel).toHaveBeenCalledWith(sessionIdentity);
      expect(await readAgentRunControlDescriptor(runDir)).toEqual(descriptor);
    } finally {
      await server.stop();
    }
  });

  it("returns typed failures for stale lease, invalid identity, and oversized framing", async () => {
    const runDir = await temporaryRoot("errors");
    const target = targetFixture();
    const server = new AgentRunControlServer({ runDir, leaseId, target });
    const descriptor = await server.start();
    try {
      const stale = await sendRequest(
        descriptor.address,
        cancelCommand("d256ca8b-e5f8-455f-b090-dfbd848af57b", staleLeaseId)
      );
      expect(stale).toMatchObject({ ok: false, code: "stale_lease" });

      const invalid = await sendRequest(descriptor.address, {
        ...cancelCommand("33309d9e-cc59-47f2-a9d3-d12e005dbab7"),
        identity: { ...sessionIdentity, sessionId: undefined }
      });
      expect(invalid).toMatchObject({ ok: false, code: "invalid_identity" });

      const socket = createConnection(descriptor.address);
      await once(socket, "connect");
      const response = responseFrom(socket);
      const header = Buffer.alloc(4);
      header.writeUInt32BE(AGENT_RUN_CONTROL_MAX_FRAME_BYTES + 1, 0);
      socket.write(header);
      await expect(response).resolves.toMatchObject({ ok: false, code: "protocol_mismatch" });
      expect(target.cancel).not.toHaveBeenCalled();
    } finally {
      await server.stop();
    }
  });

  it("bounds concurrency and reuses a cached receipt only for the same command", async () => {
    const runDir = await temporaryRoot("idempotency");
    let release!: (result: { status: "delivered"; deliveredAt: string }) => void;
    const delivery = new Promise<{ status: "delivered"; deliveredAt: string }>((resolve) => {
      release = resolve;
    });
    const target = targetFixture();
    target.cancel = vi.fn(() => delivery);
    const server = new AgentRunControlServer({
      runDir,
      leaseId,
      target,
      maxConcurrentRequests: 1,
      commandCacheSize: 2
    });
    const descriptor = await server.start();
    try {
      const firstCommand = cancelCommand("15aa246e-72a7-4e9f-b19a-ac742d5303f7");
      const first = sendRequest(descriptor.address, firstCommand);
      await vi.waitFor(() => expect(target.cancel).toHaveBeenCalledTimes(1));
      const duplicate = sendRequest(descriptor.address, firstCommand);
      const overCapacity = await sendRequest(
        descriptor.address,
        cancelCommand("7417435a-6748-4a49-875c-560ec2b70e8f")
      );
      expect(overCapacity).toMatchObject({ ok: false, code: "delivery_failed" });

      release({ status: "delivered", deliveredAt: new Date().toISOString() });
      const [firstResponse, duplicateResponse] = await Promise.all([first, duplicate]);
      expect(duplicateResponse).toEqual(firstResponse);
      expect(target.cancel).toHaveBeenCalledTimes(1);

      const reused = await sendRequest(descriptor.address, {
        ...firstCommand,
        kind: "follow_up",
        prompt: "Different command with the same id."
      });
      expect(reused).toMatchObject({ ok: false, code: "protocol_mismatch" });
      expect(target.followUp).not.toHaveBeenCalled();
    } finally {
      await server.stop();
    }
  });

  it("closes idle connections and removes descriptor and Unix socket on idempotent stop", async () => {
    const runDir = await temporaryRoot("teardown");
    const server = new AgentRunControlServer({
      runDir,
      leaseId,
      target: targetFixture(),
      idleTimeoutMs: 25
    });
    const descriptor = await server.start();
    const socket = createConnection(descriptor.address);
    await once(socket, "connect");
    await once(socket, "close");
    expect(socket.destroyed).toBe(true);

    await server.stop();
    await server.stop();
    expect(await readAgentRunControlDescriptor(runDir)).toBeNull();
    if (descriptor.transport === "unix") {
      await expect(lstat(descriptor.address)).rejects.toMatchObject({ code: "ENOENT" });
    }
  });
});
