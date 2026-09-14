import { describe, expect, it } from "vitest";
import { exactPermissionRequestSchema } from "@planweave-ai/agent-host-protocol";
import { interactionResponse } from "../workspaceExecution/session.js";

const request = exactPermissionRequestSchema.parse({
  type: "interaction.permission_requested",
  dispatchId: "dispatch",
  leaseId: "lease",
  executionAttemptId: "attempt",
  acpSessionId: "session",
  actionId: "permission",
  expiresAt: "2030-01-01T00:00:00.000Z",
  title: "Permission",
  description: "Choose an option",
  options: [
    { optionId: "always", label: "Always allow", kind: "allow_always" },
    { optionId: "once-a", label: "Allow once", kind: "allow_once" },
    { optionId: "once-b", label: "Allow with audit", kind: "allow_once" },
    { optionId: "reject-forever", label: "Reject always", kind: "reject_always" }
  ]
});

describe("Workspace CLI exact permission responses", () => {
  it.each([
    "once-a",
    "once-b",
    "always",
    "reject-forever"
  ])("returns the advertised ID %s", (option) => {
    expect(interactionResponse({ request, option })).toMatchObject({
      decision: "select_option",
      optionId: option
    });
  });
  it("cancels without selecting a permanent rejection option", () => {
    const response = interactionResponse({ request, cancel: true });
    expect(response).toMatchObject({ decision: "deny" });
    expect(response).not.toHaveProperty("optionId");
  });
  it("rejects unadvertised IDs and legacy requests rather than guessing a scope", () => {
    expect(() => interactionResponse({ request, option: "allow_once" })).toThrow(
      "interaction_permission_option_unknown"
    );
    expect(() => interactionResponse({ request })).toThrow("workspace_execution_usage_invalid");
    const { options: _options, ...legacy } = request;
    expect(() => interactionResponse({ request: legacy, cancel: true })).toThrow(
      "legacy_permission_request_requires_execution_cancel"
    );
  });
});
