import { appendFile, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { AcpSessionController, type AcpSessionRun } from "../autoRun/acpSessionController.js";
import { ActiveAgentRunRegistry } from "../autoRun/activeAgentRunRegistry.js";
import { AcpEventReadModelRegistry } from "../autoRun/acpEventReadModel.js";
import { AcpEventStore } from "../autoRun/acpEventStore.js";
import { createAcpElicitationSettlement } from "../autoRun/acpElicitationSettlement.js";
import type { LivePendingRequestHandle } from "../autoRun/liveControl.js";
import { ACP_MOCK_OPERATION_TIMEOUT_MS } from "./support/acpMockHarness.js";

const acpFixture = fileURLToPath(new URL("./support/acpMockAgent.mjs", import.meta.url));

function controllerRun(root: string, prompt: string): AcpSessionRun {
  return {
    kind: "implementation",
    identity: {
      scope: root,
      desktopRunId: "AUTO-RUN-001",
      runSessionId: "SESSION-001",
      executorRunId: "RUN-001",
      claimRef: "T-001#B-001"
    },
    runDir: root,
    metadataPath: join(root, "metadata.json"),
    prompt,
    cwd: root,
    launch: { command: process.execPath, args: [acpFixture, "elicitation-validation"] },
    executorName: "mock-acp",
    agentId: "codex",
    taskId: "T-001",
    metadataIdentity: { blockId: "B-001" },
    projectId: "project-1",
    canvasId: "default"
  };
}

function permissionRun(
  root: string,
  scenario: "permission-deny" | "permission-secret"
): AcpSessionRun {
  return {
    ...controllerRun(root, scenario),
    launch: { command: process.execPath, args: [acpFixture, scenario] }
  };
}

describe("ACP Preview elicitation settlement", () => {
  it("allows retry after a transient publication failure without acknowledging the first attempt", async () => {
    const complete = vi.fn();
    const publishResult = vi.fn()
      .mockRejectedValueOnce(new Error("transient durable failure"))
      .mockResolvedValueOnce(undefined);
    const settlement = createAcpElicitationSettlement({
      requestId: "elicitation-1",
      requestedSchema: {
        type: "object",
        properties: { value: { type: "string" } },
        required: ["value"]
      },
      publishResult,
      complete
    });
    const response = { action: "accept", content: { value: "valid" } } as const;
    await expect(settlement.respond(response)).rejects.toThrow("transient durable failure");
    expect(complete).not.toHaveBeenCalled();
    await expect(settlement.respond(response)).resolves.toBeUndefined();
    expect(complete).toHaveBeenCalledTimes(1);
    await expect(settlement.respond(response)).rejects.toThrow("already answered");
    expect(publishResult).toHaveBeenCalledTimes(2);
  });

  it("settles valid accept and cancel responses through the real ACP controller", async () => {
    for (const [decision, act] of [
      ["accept", async (request: LivePendingRequestHandle) => request.respond({
        action: "accept",
        content: { value: "accepted" }
      })],
      ["cancel", async (request: LivePendingRequestHandle) => request.reject("cancelled by test")]
    ] as const) {
      const root = await mkdtemp(join(tmpdir(), `planweave-acp-elicitation-${decision}-`));
      const controller = new AcpSessionController(new ActiveAgentRunRegistry());
      await expect(controller.execute(controllerRun(root, "required"), {
        timeoutMs: ACP_MOCK_OPERATION_TIMEOUT_MS,
        interactionBroker: {
          mode: "interactive",
          requestAvailable: async (request) => {
            expect(request.kind).toBe("elicitation");
            await act(request);
          }
        }
      })).resolves.toMatchObject({ kind: "block", exitCode: 0 });
      const events = await readFile(join(root, "events.ndjson"), "utf8");
      expect(events).toContain('"kind":"interaction_result"');
      expect(events).toContain(`"outcome":"${decision === "accept" ? "submitted" : "cancelled"}"`);
      const protocol = await readFile(join(root, "protocol.ndjson"), "utf8");
      expect(protocol).toContain(`"action":"${decision}"`);
    }
  });

  it("settles once and rejects a duplicate after durable publication", async () => {
    const root = await mkdtemp(join(tmpdir(), "planweave-acp-elicitation-one-shot-"));
    const controller = new AcpSessionController(new ActiveAgentRunRegistry());
    await expect(controller.execute(controllerRun(root, "required"), {
      timeoutMs: ACP_MOCK_OPERATION_TIMEOUT_MS,
      interactionBroker: {
        mode: "interactive",
        requestAvailable: async (request) => {
          const response = { action: "accept", content: { value: "accepted" } } as const;
          await request.respond(response);
          await expect(request.respond(response)).rejects.toThrow("already answered");
        }
      }
    })).resolves.toMatchObject({ kind: "block", exitCode: 0 });
    const events = await readFile(join(root, "events.ndjson"), "utf8");
    expect(events.match(/"kind":"interaction_result"/g)).toHaveLength(1);
  });

  it.each([
    ["required", "required", { action: "accept", content: {} }],
    ["primitive type", "required", { action: "accept", content: { value: 42 } }],
    ["string format/pattern/length", "string", { action: "accept", content: { value: "invalid" } }],
    ["enum", "enum", { action: "accept", content: { value: "gamma" } }],
    ["oneOf", "oneOf", { action: "accept", content: { value: "gamma" } }],
    ["number range", "range", { action: "accept", content: { value: 6 } }],
    ["integer type", "integer", { action: "accept", content: { value: 1.5 } }],
    ["multi-select minItems", "multi", { action: "accept", content: { value: [] } }],
    ["multi-select maxItems", "multi", { action: "accept", content: { value: ["alpha", "beta", "gamma"] } }],
    ["multi-select enum", "multi", { action: "accept", content: { value: ["unknown"] } }],
    ["titled multi-select", "multi-titled", { action: "accept", content: { value: ["unknown"] } }],
    ["SDK wire content", "required", { action: "accept", content: { value: { nested: true } } }],
    ["SDK custom action", "required", { action: "future-action" }]
  ] as const)("keeps Preview %s mismatch pending until explicit cancel", async (_case, schema, response) => {
    const root = await mkdtemp(join(tmpdir(), `planweave-acp-elicitation-invalid-${schema}-`));
    const registry = new ActiveAgentRunRegistry();
    const controller = new AcpSessionController(registry);
    await expect(controller.execute(controllerRun(root, schema), {
      timeoutMs: ACP_MOCK_OPERATION_TIMEOUT_MS,
      interactionBroker: {
        mode: "interactive",
        requestAvailable: async (request) => {
          expect(request.kind).toBe("elicitation");
          await expect(request.respond(response)).rejects.toThrow(/Preview elicitation response/);
          expect(registry.lookupDesktopRun("AUTO-RUN-001")?.control.pendingRequests.has(request.requestId))
            .toBe(true);
          expect(await readFile(join(root, "events.ndjson"), "utf8"))
            .not.toContain('"kind":"interaction_result"');
          await request.reject("cancel invalid response");
        }
      }
    })).resolves.toMatchObject({ kind: "block", exitCode: 0 });
    const events = await readFile(join(root, "events.ndjson"), "utf8");
    expect(events).not.toContain('"outcome":"submitted"');
    expect(events).toContain('"outcome":"cancelled"');
    expect(await readFile(join(root, "protocol.ndjson"), "utf8")).toContain('"action":"cancel"');
  });

  it("fails closed before broker exposure for an unsupported schema variant", async () => {
    const root = await mkdtemp(join(tmpdir(), "planweave-acp-elicitation-unsupported-schema-"));
    const available = vi.fn();
    const controller = new AcpSessionController(new ActiveAgentRunRegistry());
    await expect(controller.execute(controllerRun(root, "unsupported"), {
      timeoutMs: ACP_MOCK_OPERATION_TIMEOUT_MS,
      interactionBroker: { mode: "interactive", requestAvailable: available }
    })).rejects.toThrow(/unsupported property type|Invalid params/i);
    expect(available).not.toHaveBeenCalled();
    expect(await readFile(join(root, "events.ndjson"), "utf8"))
      .not.toContain('"kind":"interaction_result"');
  });

  it("does not acknowledge or release input when durable result append fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "planweave-acp-elicitation-event-failure-"));
    const registry = new ActiveAgentRunRegistry();
    const eventModels = new AcpEventReadModelRegistry((options) => new AcpEventStore({
      ...options,
      appendText: async (...args) => {
        if (String(args[1]).includes('"kind":"interaction_result"')) {
          throw new Error("scripted interaction result append failure");
        }
        return appendFile(...args);
      }
    }));
    const abort = new AbortController();
    let observedPending = false;
    const controller = new AcpSessionController(registry, undefined, eventModels);
    await expect(controller.execute(controllerRun(root, "required"), {
      signal: abort.signal,
      timeoutMs: ACP_MOCK_OPERATION_TIMEOUT_MS,
      interactionBroker: {
        mode: "interactive",
        requestAvailable: async (request) => {
          await expect(request.respond({ action: "accept", content: { value: "valid" } }))
            .rejects.toThrow("scripted interaction result append failure");
          observedPending =
            registry.lookupDesktopRun("AUTO-RUN-001")?.control.pendingRequests.has(request.requestId) === true;
          abort.abort(new Error("stop after append failure assertion"));
        }
      }
    })).rejects.toThrow();
    expect(observedPending).toBe(true);
    expect(await readFile(join(root, "events.ndjson"), "utf8"))
      .not.toContain('"kind":"interaction_result"');
    expect(await readFile(join(root, "protocol.ndjson"), "utf8"))
      .not.toContain('"action":"accept"');
  });
});

describe("ACP permission settlement", () => {
  it.each([
    ["approve", "permission-secret", "token=opaque-action-id"],
    ["deny", "permission-deny", "deny"],
    ["cancel", "permission-secret", null]
  ] as const)("retries %s after a pre-commit append failure and settles once", async (
    decision,
    scenario,
    optionId
  ) => {
    const root = await mkdtemp(join(tmpdir(), `planweave-acp-permission-${decision}-`));
    let failInteractionResult = true;
    const eventModels = new AcpEventReadModelRegistry((options) => new AcpEventStore({
      ...options,
      appendText: async (...args) => {
        if (
          failInteractionResult &&
          String(args[1]).includes('"kind":"interaction_result"')
        ) {
          failInteractionResult = false;
          throw new Error("scripted permission append failure");
        }
        return appendFile(...args);
      }
    }));
    const registry = new ActiveAgentRunRegistry();
    const controller = new AcpSessionController(registry, undefined, eventModels);
    await expect(controller.execute(permissionRun(root, scenario), {
      timeoutMs: ACP_MOCK_OPERATION_TIMEOUT_MS,
      interactionBroker: {
        mode: "interactive",
        requestAvailable: async (request) => {
          const act = () => optionId === null
            ? request.reject("cancelled by test")
            : request.respond(optionId);
          await expect(act()).rejects.toThrow("scripted permission append failure");
          expect(registry.lookupDesktopRun("AUTO-RUN-001")?.control.pendingRequests.has(request.requestId))
            .toBe(true);
          expect(await readFile(join(root, "events.ndjson"), "utf8"))
            .not.toContain('"kind":"interaction_result"');
          await expect(act()).resolves.toBeUndefined();
          await expect(act()).rejects.toThrow("already answered");
        }
      }
    })).resolves.toMatchObject({ kind: "block", exitCode: 0 });
    const events = await readFile(join(root, "events.ndjson"), "utf8");
    expect(events.match(/"kind":"interaction_result"/g)).toHaveLength(1);
    expect(events).toContain(
      `"outcome":"${decision === "approve" ? "approved" : decision === "deny" ? "denied" : "cancelled"}"`
    );
  });

  it("treats a post-log projection failure as committed and releases permission", async () => {
    const root = await mkdtemp(join(tmpdir(), "planweave-acp-permission-projection-"));
    let failProjection = true;
    const eventModels = new AcpEventReadModelRegistry((options) => new AcpEventStore({
      ...options,
      writeConversationProjection: async (_runDir, events) => {
        if (failProjection && events.at(-1)?.body.kind === "interaction_result") {
          failProjection = false;
          throw new Error("path=/private/secret projection payload");
        }
      }
    }));
    const registry = new ActiveAgentRunRegistry();
    const controller = new AcpSessionController(registry, undefined, eventModels);
    await expect(controller.execute(permissionRun(root, "permission-secret"), {
      timeoutMs: ACP_MOCK_OPERATION_TIMEOUT_MS,
      interactionBroker: {
        mode: "interactive",
        requestAvailable: async (request) => {
          await expect(request.respond("token=opaque-action-id")).resolves.toBeUndefined();
          expect(registry.lookupDesktopRun("AUTO-RUN-001")?.control.pendingRequests.has(request.requestId))
            .toBe(false);
        }
      }
    })).resolves.toMatchObject({ kind: "block", exitCode: 0 });
    expect(await readFile(join(root, "events.ndjson"), "utf8"))
      .toContain('"outcome":"approved"');
  });
});
