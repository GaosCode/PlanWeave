import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { rm } from "node:fs/promises";
import { connect } from "node:net";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { WebSocket } from "ws";
import { createTestWorkspace } from "../../../../runtime/src/__tests__/promptTestHelpers.js";

export function bounded<T>(work: Promise<T>, description: string, timeoutMs = 5_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    work,
    new Promise<T>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out: ${description}`)), timeoutMs);
    })
  ]).finally(() => clearTimeout(timer));
}

const eventSchema = z.discriminatedUnion("event", [
  z.object({ event: z.literal("ready"), origin: z.string().url() }),
  z.object({ event: z.enum(["handler-pending", "checkpoint"]) })
]);
type ChildEvent = z.infer<typeof eventSchema>;

export async function setupUpgradeBoundary() {
  const workspace = await createTestWorkspace();
  const projectId = workspace.init.workspace.id;
  const child = spawn(
    process.execPath,
    [
      "--unhandled-rejections=strict",
      "--import",
      "tsx",
      fileURLToPath(new URL("./webSocketUpgradeBoundaryChild.ts", import.meta.url)),
      JSON.stringify({ root: workspace.root, projectId })
    ],
    { stdio: ["ignore", "pipe", "pipe", "ipc"] }
  );
  assert(child.stdout && child.stderr, "child_output_pipes_required");
  let output = "";
  child.stdout.on("data", (data: Buffer) => {
    output += data.toString();
  });
  child.stderr.on("data", (data: Buffer) => {
    output += data.toString();
  });
  const queued: ChildEvent[] = [];
  const waiting = new Map<string, (event: ChildEvent) => void>();
  child.on("message", (message: unknown) => {
    const event = eventSchema.parse(message);
    const resolve = waiting.get(event.event);
    if (resolve) {
      waiting.delete(event.event);
      resolve(event);
    } else queued.push(event);
  });
  const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  const waitEvent = (name: ChildEvent["event"]) =>
    bounded(
      Promise.race([
        new Promise<ChildEvent>((resolve) => {
          const index = queued.findIndex((event) => event.event === name);
          if (index >= 0) resolve(queued.splice(index, 1)[0]!);
          else waiting.set(name, resolve);
        }),
        exited.then(({ code, signal }) => {
          throw new Error(`Server child exited (${code}, ${signal}): ${output}`);
        })
      ]),
      `child ${name}`
    );
  const sockets = new Set<{ destroy(): void }>();
  const webSockets = new Set<WebSocket>();
  const dispose = async () => {
    for (const socket of sockets) socket.destroy();
    for (const socket of webSockets) socket.terminate();
    if (child.exitCode === null && child.signalCode === null && child.connected)
      child.send({ command: "stop" }, (error) => {
        if (error) output += `\nchild_stop_delivery_failed:${error.name}`;
      });
    try {
      return await bounded(exited, "server shutdown", 2_000);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await bounded(exited, "forced child shutdown", 2_000);
      await Promise.all(
        [workspace.root, workspace.home].map((path) => rm(path, { recursive: true, force: true }))
      );
    }
  };
  try {
    const ready = await waitEvent("ready");
    assert(ready.event === "ready", "child_ready_required");
    const origin = ready.origin;
    const bootstrap = await fetch(`${origin}/api/v1/projects/${projectId}/human/bootstrap`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ displayName: "Upgrade Owner", humanPrincipalId: "upgrade-owner" }),
      signal: AbortSignal.timeout(2_000)
    });
    assert.equal(bootstrap.status, 201, await bootstrap.clone().text());
    const { deviceToken } = z.object({ deviceToken: z.string() }).parse(await bootstrap.json());
    return {
      child,
      origin,
      projectId,
      deviceToken,
      root: workspace.root,
      dispose,
      output: () => output,
      waitPending: () => waitEvent("handler-pending"),
      release: () => child.send({ command: "reject" }),
      async checkpoint() {
        child.send({ command: "checkpoint" });
        await waitEvent("checkpoint");
      },
      raw(path: string, token = deviceToken, firstFrame = Buffer.alloc(0)) {
        const socket = connect({ host: "127.0.0.1", port: Number(new URL(origin).port) });
        sockets.add(socket);
        let response = "";
        socket.on("data", (data: Buffer) => {
          response += data.toString();
        });
        const errors: string[] = [];
        socket.on("error", (error: NodeJS.ErrnoException) => {
          errors.push(error.code ?? error.name);
        });
        socket.once("connect", () =>
          socket.write(
            Buffer.concat([
              Buffer.from(
                [
                  `GET ${path} HTTP/1.1`,
                  `Host: ${new URL(origin).host}`,
                  "Connection: Upgrade",
                  "Upgrade: websocket",
                  "Sec-WebSocket-Version: 13",
                  "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
                  `Authorization: Bearer ${token}`,
                  "",
                  ""
                ].join("\r\n")
              ),
              firstFrame
            ])
          )
        );
        return bounded(
          new Promise<{ response: string; errors: string[] }>((resolve) =>
            socket.once("close", () => {
              sockets.delete(socket);
              resolve({ response, errors });
            })
          ),
          "raw upgrade close"
        );
      },
      async observer() {
        const socket = new WebSocket(
          `${origin.replace("http:", "ws:")}/api/v1/projects/${projectId}/human/observe`,
          { headers: { Authorization: `Bearer ${deviceToken}` } }
        );
        webSockets.add(socket);
        socket.once("close", () => webSockets.delete(socket));
        const welcome = new Promise<unknown>((resolve) =>
          socket.once("message", (data) => resolve(JSON.parse(data.toString())))
        );
        await bounded(
          new Promise<void>((resolve, reject) => {
            socket.once("open", resolve);
            socket.once("error", reject);
          }),
          "observer open"
        );
        socket.send(
          JSON.stringify({
            type: "human.observer.hello",
            protocolVersion: 1,
            projectId,
            lastCursor: 0
          })
        );
        assert.equal(
          z.object({ type: z.string() }).parse(await bounded(welcome, "observer welcome")).type,
          "human.observer.welcome"
        );
        return socket;
      },
      async healthyPresence() {
        const path = `/api/v1/projects/${projectId}/canvases/default/human/presence`;
        const socket = new WebSocket(`${origin.replace("http:", "ws:")}${path}`, {
          headers: { Authorization: `Bearer ${deviceToken}` }
        });
        webSockets.add(socket);
        const closed = new Promise<number>((resolve) => socket.once("close", resolve));
        const message = new Promise<unknown>((resolve) =>
          socket.once("message", (data) => resolve(JSON.parse(data.toString())))
        );
        await bounded(
          new Promise<void>((resolve, reject) => {
            socket.once("open", resolve);
            socket.once("error", reject);
          }),
          "presence open"
        );
        socket.send(
          JSON.stringify({
            type: "canvas.presence.hello",
            protocolVersion: 1,
            projectId,
            canvasId: "default"
          })
        );
        const snapshot = await bounded(message, "presence snapshot");
        socket.close(1000);
        assert.equal(await bounded(closed, "presence close"), 1000);
        webSockets.delete(socket);
        return snapshot;
      }
    };
  } catch (error) {
    await dispose();
    throw error;
  }
}
