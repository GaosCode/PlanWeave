#!/usr/bin/env node
import { createInterface } from "node:readline";

const sessions = new Map();
const pendingClientRequests = new Map();
const heldPrompts = new Map();
let nextSession = 1;
let nextRequestId = 10_000;
let peakRssKiB = Math.ceil(process.memoryUsage.rss() / 1024);
const rssSampler = setInterval(() => {
  peakRssKiB = Math.max(peakRssKiB, Math.ceil(process.memoryUsage.rss() / 1024));
}, 5);
rssSampler.unref();

function send(message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
}

function clientRequest(method, params) {
  const id = nextRequestId++;
  send({ id, method, params });
  return new Promise((resolve, reject) => pendingClientRequests.set(id, { resolve, reject }));
}

function update(sessionId, marker) {
  send({
    method: "session/update",
    params: {
      sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        messageId: marker,
        content: { type: "text", text: marker }
      }
    }
  });
}

async function handleRequest(message) {
  if (message.method === "initialize") {
    await new Promise((resolve) => setTimeout(resolve, 25));
    send({
      id: message.id,
      result: {
        protocolVersion: 1,
        agentCapabilities: { sessionCapabilities: { close: {} } },
        agentInfo: { name: "planweave-connection-reuse-gate-mock", version: "1.0.0" },
        authMethods: []
      }
    });
    return;
  }

  if (message.method === "gate/metrics") {
    peakRssKiB = Math.max(peakRssKiB, Math.ceil(process.memoryUsage.rss() / 1024));
    send({
      id: message.id,
      result: { pid: process.pid, parentPid: process.ppid, rssKiB: peakRssKiB }
    });
    return;
  }

  if (message.method === "session/new") {
    const sessionId = `gate-session-${nextSession++}`;
    sessions.set(sessionId, { cancelled: false });
    update(sessionId, `early:${sessionId}`);
    await clientRequest("elicitation/create", {
      mode: "form",
      sessionId: null,
      message: `opening:${sessionId}`,
      requestedSchema: { type: "object", properties: {} }
    });
    send({ id: message.id, result: { sessionId } });
    return;
  }

  const sessionId = message.params?.sessionId;
  const session = sessions.get(sessionId);
  if (message.method === "session/prompt") {
    if (!session) {
      send({ id: message.id, error: { code: -32602, message: "Unknown session" } });
      return;
    }
    const text = message.params?.prompt?.find((part) => part.type === "text")?.text ?? "";
    update(sessionId, `prompt:${sessionId}:${text}`);
    const [permission, elicitation] = await Promise.all([
      clientRequest("session/request_permission", {
        sessionId,
        toolCall: {
          toolCallId: `tool:${sessionId}:${text}`,
          title: `permission:${sessionId}:${text}`,
          kind: "execute"
        },
        options: [
          { optionId: `allow:${sessionId}`, name: "Allow", kind: "allow_once" },
          { optionId: `deny:${sessionId}`, name: "Deny", kind: "reject_once" }
        ]
      }),
      clientRequest("elicitation/create", {
        mode: "form",
        sessionId,
        message: `elicitation:${sessionId}:${text}`,
        requestedSchema: { type: "object", properties: {} }
      })
    ]);
    if (
      permission?.outcome?.optionId !== `allow:${sessionId}` ||
      elicitation?.content?.owner !== sessionId
    ) {
      send({ id: message.id, error: { code: -32603, message: "Cross-session response" } });
      return;
    }
    if (text === "hold") {
      heldPrompts.set(sessionId, message.id);
      return;
    }
    send({
      id: message.id,
      result: { stopReason: session.cancelled ? "cancelled" : "end_turn" }
    });
    return;
  }

  if (message.method === "session/close") {
    if (!sessions.delete(sessionId)) {
      send({ id: message.id, error: { code: -32602, message: "Unknown session" } });
      return;
    }
    send({ id: message.id, result: {} });
    return;
  }

  send({ id: message.id, error: { code: -32601, message: "Method not found" } });
}

function handleNotification(message) {
  if (message.method !== "session/cancel") return;
  const sessionId = message.params?.sessionId;
  const session = sessions.get(sessionId);
  if (!session) return;
  session.cancelled = true;
  const promptId = heldPrompts.get(sessionId);
  if (promptId !== undefined) {
    heldPrompts.delete(sessionId);
    send({ id: promptId, result: { stopReason: "cancelled" } });
  }
}

const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  if (!line.trim()) return;
  const message = JSON.parse(line);
  if (message.id !== undefined && message.method === undefined) {
    const pending = pendingClientRequests.get(message.id);
    if (!pending) return;
    pendingClientRequests.delete(message.id);
    if (message.error) pending.reject(new Error(String(message.error.message)));
    else pending.resolve(message.result);
    return;
  }
  if (message.id === undefined) {
    handleNotification(message);
    return;
  }
  handleRequest(message).catch((error) => {
    send({ id: message.id, error: { code: -32603, message: String(error?.message ?? error) } });
  });
});
