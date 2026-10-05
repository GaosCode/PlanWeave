import { CANVAS_RUNTIME_CAPABILITY } from "@planweave-ai/agent-host-protocol";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { serverEventSchema, type ServerEvent } from "../protocol.js";

function bounded<T>(work: Promise<T>, description: string, timeoutMs = 5_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    work,
    new Promise<T>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out: ${description}`)), timeoutMs);
    })
  ]).finally(() => clearTimeout(timer));
}

class Events<T> {
  private queued: T[] = [];
  private waiting: Array<{ predicate: (value: T) => boolean; resolve: (value: T) => void }> = [];
  push(value: T): void {
    const index = this.waiting.findIndex(({ predicate }) => predicate(value));
    if (index === -1) this.queued.push(value);
    else this.waiting.splice(index, 1)[0]!.resolve(value);
  }
  next(predicate: (value: T) => boolean): Promise<T> {
    const index = this.queued.findIndex(predicate);
    if (index !== -1) return Promise.resolve(this.queued.splice(index, 1)[0]!);
    return new Promise((resolve) => this.waiting.push({ predicate, resolve }));
  }
}

const childEventSchema = z.discriminatedUnion("event", [
  z.object({
    event: z.literal("ready"),
    origin: z.string().url(),
    hosts: z.array(z.object({ hostId: z.string(), token: z.string() })).length(2)
  }),
  z.object({
    event: z.literal("rpc"),
    id: z.string(),
    outcome: z.enum(["success", "error"]),
    code: z.string().optional(),
    result: z.unknown().optional()
  })
]);
type ChildEvent = z.infer<typeof childEventSchema>;
const socketDiagnosticSchema = z.object({
  scope: z.literal("agent-host-ws"),
  event: z.literal("socket_error"),
  hostId: z.string(),
  code: z.string()
});

async function setup(heartbeatIntervalMs = 30_000) {
  const directory = await mkdtemp(join(tmpdir(), "planweave-ws-error-isolation-"));
  const child = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      fileURLToPath(new URL("./support/wsServerErrorIsolationChild.ts", import.meta.url)),
      JSON.stringify({ directory, heartbeatIntervalMs })
    ],
    { stdio: ["ignore", "pipe", "pipe", "ipc"] }
  );
  assert(child.stdout, "test_child_stdout_pipe_required");
  assert(child.stderr, "test_child_stderr_pipe_required");
  let output = "";
  child.stdout.on("data", (data: Buffer) => {
    output += data.toString();
  });
  child.stderr.on("data", (data: Buffer) => {
    output += data.toString();
  });
  const events = new Events<ChildEvent>();
  child.on("message", (message: unknown) => events.push(childEventSchema.parse(message)));
  const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  const sockets: WebSocket[] = [];
  async function waitEvent(predicate: (event: ChildEvent) => boolean): Promise<ChildEvent> {
    return bounded(
      Promise.race([
        events.next(predicate),
        exited.then(({ code, signal }) => {
          throw new Error(`Server child exited (${code}, ${signal}): ${output}`);
        })
      ]),
      "child event"
    );
  }
  const dispose = async () => {
    for (const socket of sockets) socket.terminate();
    if (child.exitCode === null && child.signalCode === null && child.connected)
      child.send({ command: "stop" });
    try {
      return await bounded(exited, "natural server shutdown", 2_000);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await exited;
      await rm(directory, { recursive: true, force: true });
    }
  };
  try {
    const ready = await waitEvent((event) => event.event === "ready");
    if (ready.event !== "ready") throw new Error("test_ready_expected");
    const { origin, hosts } = ready;
    async function connect(index: number, autoPong = true) {
      const host = hosts[index];
      if (!host) throw new Error("test_host_missing");
      const socket = new WebSocket(
        `${origin.replace("http:", "ws:")}/agent-hosts/${host.hostId}/connect`,
        { headers: { Authorization: `Bearer ${host.token}` }, autoPong }
      );
      sockets.push(socket);
      const stream = new Events<ServerEvent>();
      socket.on("message", (data) =>
        stream.push(serverEventSchema.parse(JSON.parse(data.toString())))
      );
      const closed = new Promise<number>((resolve) =>
        socket.once("close", (code) => resolve(code))
      );
      await bounded(
        new Promise<void>((resolve, reject) => {
          socket.once("open", resolve);
          socket.once("error", reject);
        }),
        "socket open"
      );
      socket.send(
        JSON.stringify({
          type: "host.hello",
          protocolVersion: 1,
          supportedExecutionEnvelopeVersions: [1, 2],
          lastAcknowledgedSequence: 0,
          capabilities: [CANVAS_RUNTIME_CAPABILITY],
          capacity: 1,
          readiness: { workspaceMappings: [], acpProfiles: [], runtimeProjects: [] }
        })
      );
      const next = (type: ServerEvent["type"]) =>
        bounded(
          stream.next((event) => event.type === type),
          `socket ${type}`
        );
      await next("host.welcome");
      return { socket, closed, next, hostId: host.hostId };
    }
    const rpc = (id: string, hostId: string) => {
      child.send({ command: "rpc", id, hostId });
    };
    const rpcOutcome = (id: string) =>
      waitEvent((event) => event.event === "rpc" && event.id === id);
    const health = async () => {
      const response = await fetch(`${ready.origin}/health`, {
        signal: AbortSignal.timeout(2_000)
      });
      expect(response.status).toBe(200);
      return z
        .object({ active: z.array(z.boolean()), pending: z.number() })
        .parse(await response.json());
    };
    return {
      child,
      connect,
      rpc,
      rpcOutcome,
      health,
      dispose,
      output: () => output,
      diagnostics: () =>
        output
          .split("\n")
          .filter((line) => line.includes('"event":"socket_error"'))
          .map((line) => socketDiagnosticSchema.parse(JSON.parse(line)))
    };
  } catch (error) {
    await dispose();
    throw error;
  }
}

async function respond(client: {
  socket: WebSocket;
  next(type: ServerEvent["type"]): Promise<ServerEvent>;
}) {
  const event = await client.next("mailbox.message");
  if (event.type !== "mailbox.message" || event.command.type !== "canvas_runtime.request")
    throw new Error("test_runtime_request_expected");
  client.socket.send(
    JSON.stringify({
      type: "canvas_runtime.response",
      protocolVersion: 1,
      messageId: `response-${event.command.requestId}`,
      requestId: event.command.requestId,
      response: {
        outcome: "success",
        operation: "availability",
        result: { kind: "unavailable", reason: "runtime_not_attached" }
      }
    })
  );
  await client.next("host.event_ack");
}

describe("Agent Host WebSocket transport error isolation", () => {
  it.each([
    {
      name: "unmasked frame",
      code: "WS_ERR_EXPECTED_MASK",
      payload: "token=frame-secret",
      mask: false
    },
    {
      name: "oversized frame",
      code: "WS_ERR_UNSUPPORTED_MESSAGE_LENGTH",
      payload: "token=frame-secret".repeat(100),
      mask: true
    }
  ])("keeps the Server, HTTP and healthy Host RPC alive after $name", async ({
    code,
    payload,
    mask
  }) => {
    const fixture = await setup();
    try {
      const bad = await fixture.connect(0);
      const healthy = await fixture.connect(1);
      fixture.rpc("bad-pending", bad.hostId);
      await bad.next("mailbox.message");
      bad.socket.send(payload, { mask });
      await bounded(bad.closed, "bad socket close");
      await expect(fixture.rpcOutcome("bad-pending")).resolves.toMatchObject({
        outcome: "error",
        code: "canvas_runtime_host_disconnected"
      });
      expect(await fixture.health()).toEqual({ active: [false, true], pending: 0 });
      healthy.socket.send(
        JSON.stringify({
          type: "host.heartbeat",
          protocolVersion: 1,
          messageId: "healthy-heartbeat",
          activeLeases: []
        })
      );
      await expect(healthy.next("host.event_ack")).resolves.toMatchObject({
        messageId: "healthy-heartbeat"
      });
      fixture.rpc("healthy-rpc", healthy.hostId);
      await respond(healthy);
      await expect(fixture.rpcOutcome("healthy-rpc")).resolves.toMatchObject({
        outcome: "success",
        result: { operation: "availability", result: { reason: "runtime_not_attached" } }
      });
      expect(fixture.diagnostics()).toEqual([
        { scope: "agent-host-ws", event: "socket_error", hostId: bad.hostId, code }
      ]);
      expect(fixture.output()).not.toContain("frame-secret");
      expect(fixture.child.exitCode).toBeNull();
    } finally {
      expect(await fixture.dispose(), fixture.output()).toEqual({ code: 0, signal: null });
    }
  });

  it("preserves the replacement session and its pending RPC when the old socket errors during close", async () => {
    const fixture = await setup();
    try {
      const old = await fixture.connect(0);
      old.socket.pause();
      const replacement = await fixture.connect(0);
      fixture.rpc("replacement-rpc", replacement.hostId);
      const request = await replacement.next("mailbox.message");
      old.socket.send("token=old-frame-secret", { mask: false });
      old.socket.resume();
      await bounded(old.closed, "superseded socket close");
      if (request.type !== "mailbox.message" || request.command.type !== "canvas_runtime.request")
        throw new Error("test_runtime_request_expected");
      replacement.socket.send(
        JSON.stringify({
          type: "canvas_runtime.response",
          protocolVersion: 1,
          messageId: "replacement-response",
          requestId: request.command.requestId,
          response: {
            outcome: "success",
            operation: "availability",
            result: { kind: "unavailable", reason: "runtime_not_attached" }
          }
        })
      );
      await replacement.next("host.event_ack");
      await expect(fixture.rpcOutcome("replacement-rpc")).resolves.toMatchObject({
        outcome: "success"
      });
      expect(await fixture.health()).toEqual({ active: [true, false], pending: 0 });
      expect(fixture.diagnostics()).toEqual([
        {
          scope: "agent-host-ws",
          event: "socket_error",
          hostId: old.hostId,
          code: "WS_ERR_EXPECTED_MASK"
        }
      ]);
      expect(fixture.output()).not.toContain("old-frame-secret");
      replacement.socket.close();
      await bounded(replacement.closed, "normal replacement close");
      await expect.poll(async () => (await fixture.health()).active[0]).toBe(false);
    } finally {
      expect(await fixture.dispose(), fixture.output()).toEqual({ code: 0, signal: null });
    }
  });

  it("releases a heartbeat timeout session and pending RPC while another Host remains usable", async () => {
    const fixture = await setup(100);
    try {
      const bad = await fixture.connect(0, false);
      const healthy = await fixture.connect(1);
      fixture.rpc("timeout-pending", bad.hostId);
      await bad.next("mailbox.message");
      await bounded(bad.closed, "heartbeat timeout");
      await expect(fixture.rpcOutcome("timeout-pending")).resolves.toMatchObject({
        outcome: "error",
        code: "canvas_runtime_host_disconnected"
      });
      fixture.rpc("healthy-after-timeout", healthy.hostId);
      await respond(healthy);
      await expect(fixture.rpcOutcome("healthy-after-timeout")).resolves.toMatchObject({
        outcome: "success"
      });
      expect(await fixture.health()).toEqual({ active: [false, true], pending: 0 });
    } finally {
      expect(await fixture.dispose(), fixture.output()).toEqual({ code: 0, signal: null });
    }
  });
});
