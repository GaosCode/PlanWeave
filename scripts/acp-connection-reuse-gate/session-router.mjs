import { AcpGateProtocolClient } from "./protocol-client.mjs";

export class SessionRouter {
  constructor(client, sessionCwd) {
    this.client = client;
    this.sessionCwd = sessionCwd;
    this.owners = new Map();
    this.earlyUpdates = new Map();
    this.openingOwner = null;
    this.diagnostics = [];
    this.interactionRequestIds = new Set();
  }

  owner(ownerId) {
    return { ownerId, sessionId: null, events: [], interactions: [], lost: 0 };
  }

  async open(owner) {
    if (this.openingOwner) throw new Error("Only one opening owner is allowed per connection.");
    this.openingOwner = owner;
    try {
      const response = await this.client.request("session/new", {
        cwd: this.sessionCwd,
        mcpServers: []
      });
      if (typeof response?.sessionId !== "string") throw new Error("Agent returned no sessionId.");
      owner.sessionId = response.sessionId;
      this.owners.set(response.sessionId, owner);
      owner.events.push(...(this.earlyUpdates.get(response.sessionId) ?? []));
      this.earlyUpdates.delete(response.sessionId);
      return response.sessionId;
    } finally {
      this.openingOwner = null;
    }
  }

  prompt(owner, text) {
    if (!owner.sessionId) throw new Error("Cannot prompt an unbound owner.");
    return this.client.request("session/prompt", {
      sessionId: owner.sessionId,
      prompt: [{ type: "text", text }]
    });
  }

  cancel(owner) {
    if (!owner.sessionId) throw new Error("Cannot cancel an unbound owner.");
    this.client.notify("session/cancel", { sessionId: owner.sessionId });
  }

  async close(owner) {
    if (!owner.sessionId) throw new Error("Cannot close an unbound owner.");
    await this.client.request("session/close", { sessionId: owner.sessionId });
    this.owners.delete(owner.sessionId);
  }

  connectionLost() {
    for (const owner of this.owners.values()) owner.lost += 1;
  }

  handle(message) {
    if (message.method === "session/update") {
      const sessionId = message.params?.sessionId;
      const owner = this.owners.get(sessionId);
      if (owner) owner.events.push(message.params.update);
      else if (this.openingOwner && typeof sessionId === "string") {
        const updates = this.earlyUpdates.get(sessionId) ?? [];
        updates.push(message.params.update);
        this.earlyUpdates.set(sessionId, updates);
      } else {
        this.diagnostics.push(`unowned-update:${String(sessionId)}`);
      }
      return;
    }

    if (message.id === undefined) return;
    if (this.interactionRequestIds.has(message.id)) {
      this.diagnostics.push(`duplicate-request-id:${String(message.id)}`);
      this.client.respondError(message.id, -32600, "Duplicate request id");
      return;
    }
    this.interactionRequestIds.add(message.id);

    if (message.method === "session/request_permission") {
      const sessionId = message.params?.sessionId;
      const owner = this.owners.get(sessionId);
      if (!owner) {
        this.diagnostics.push(`unowned-permission:${String(sessionId)}`);
        this.client.respond(message.id, { outcome: { outcome: "cancelled" } });
        return;
      }
      owner.interactions.push({ kind: "permission", requestId: message.id, sessionId });
      this.client.respond(message.id, {
        outcome: { outcome: "selected", optionId: `allow:${sessionId}` }
      });
      return;
    }

    if (message.method === "elicitation/create") {
      const sessionId = message.params?.sessionId;
      const owner = sessionId == null ? this.openingOwner : this.owners.get(sessionId);
      if (!owner) {
        this.diagnostics.push(`unowned-elicitation:${String(sessionId)}`);
        this.client.respond(message.id, { action: "cancel" });
        return;
      }
      owner.interactions.push({ kind: "elicitation", requestId: message.id, sessionId });
      this.client.respond(message.id, {
        action: "accept",
        content: { owner: owner.sessionId ?? owner.ownerId }
      });
      return;
    }

    this.diagnostics.push(`unsupported-client-request:${String(message.method)}`);
    this.client.respondError(message.id, -32601, "Method not found");
  }
}

export function createClient({
  launch,
  env,
  cwd,
  deadlineAt = null,
  timeoutMs = 10_000,
  requestAudit = null
}) {
  let router;
  const client = new AcpGateProtocolClient({
    ...launch,
    cwd,
    env,
    timeoutMs,
    deadlineAt,
    onMessage: (message) => router.handle(message),
    onTerminal: () => router?.connectionLost(),
    onOutgoingRequest: (method) => {
      if (requestAudit) requestAudit.set(method, (requestAudit.get(method) ?? 0) + 1);
    }
  });
  router = new SessionRouter(client, cwd);
  return { client, router };
}
