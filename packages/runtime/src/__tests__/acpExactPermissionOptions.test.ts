import { describe, expect, it, vi } from "vitest";
import type { RequestPermissionRequest, RequestPermissionResponse } from "@agentclientprotocol/sdk";
import { createAcpExecutionInteractionHandlers } from "../autoRun/acpExecutionInteractions.js";
import { createLocalAcpInteractionBroker } from "../autoRun/acpLocalInteractionBroker.js";

function setup() {
  const permissionHandler = vi.fn(
    async (): Promise<RequestPermissionResponse> => ({
      outcome: { outcome: "selected", optionId: "once 选项" }
    })
  );
  const broker = createLocalAcpInteractionBroker({
    permissionHandler,
    eventStore: null,
    setOperationDeadline: vi.fn(),
    addPending: vi.fn(),
    releasePending: vi.fn()
  });
  const handlers = createAcpExecutionInteractionHandlers({
    broker,
    clock: { now: () => new Date(), sleep: () => new Promise<void>(() => {}) },
    timeoutMs: 1_000,
    signal: new AbortController().signal,
    emit: vi.fn(async () => {})
  });
  const request: RequestPermissionRequest = {
    sessionId: "session",
    toolCall: { toolCallId: "tool", title: "Permission" },
    options: [
      { optionId: "always", name: "Always allow", kind: "allow_always" },
      { optionId: "reject-always", name: "Always reject", kind: "reject_always" },
      { optionId: "other-once", name: "Other once", kind: "allow_once" },
      { optionId: "once 选项", name: "Allow once", kind: "allow_once" },
      { optionId: "reject", name: "Reject once", kind: "reject_once" }
    ]
  };
  return { permissionHandler, handlers, request };
}

describe("ACP exact permission option adapter", () => {
  it("preserves every option kind and opaque ID through engine and local broker", async () => {
    const { handlers, permissionHandler, request } = setup();
    await expect(handlers.onPermissionRequest(request)).resolves.toEqual({
      outcome: { outcome: "selected", optionId: "once 选项" }
    });
    expect(permissionHandler).toHaveBeenCalledWith(request, "permission:1", expect.any(String));
  });

  it("rejects duplicate original IDs before invoking the local broker", async () => {
    const { handlers, permissionHandler, request } = setup();
    await expect(
      handlers.onPermissionRequest({
        ...request,
        options: [request.options[0]!, request.options[0]!]
      })
    ).rejects.toThrow("ACP permission broker failed");
    expect(permissionHandler).not.toHaveBeenCalled();
  });
});
