/* @vitest-environment jsdom */

import { act, fireEvent, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createTranslator } from "../renderer/i18n";
import {
  bridgeMock,
  controller,
  deferred,
  host,
  inventory,
  profile,
  ready,
  status,
  statusListener
} from "./hostAdministrationRegistrationHarness";

function managedHost() {
  return {
    ...host("host-a"),
    credentialPolicy: { lifetimeDays: 180 as const, renewal: "automatic" as const },
    credentialExpiresAt: "2030-06-30T00:00:00.000Z"
  };
}
function handoff() {
  return {
    state: "ready" as const,
    workspaceId: "workspace-a",
    expiresAt: "2030-01-01T00:15:00.000Z",
    credentialExpiresAt: "2030-06-30T00:00:00.000Z",
    credentialPolicy: { lifetimeDays: 180 as const, renewal: "automatic" as const },
    copiedAt: "2030-01-01T00:00:00.000Z",
    commandPreview: "planweave agent-host enroll <handoff>"
  };
}
async function registrationTimeout() {
  bridgeMock.registerOperatorLocalAgentHost.mockRejectedValueOnce(
    new Error("agent_host_enrollment_timeout")
  );
  fireEvent.click(screen.getByTestId("host-admin-local-agent-codex-acp"));
  fireEvent.click(screen.getByTestId("host-admin-register-local"));
  await act(async () => {});
  expect(controller.error).toBe("agent_host_enrollment_timeout");
  expect(controller.busy).toBe(false);
}
async function clickAction(action: "grant" | "renew" | "revoke") {
  const user = userEvent.setup();
  if (action === "grant") await user.click(screen.getByTestId("host-admin-create-grant"));
  else {
    await user.click(
      screen.getByRole("button", {
        name: `${createTranslator("zh-CN")("managementActions")}: host-a`
      })
    );
    await user.click(screen.getByTestId(`host-admin-${action}-host-a`));
  }
}
function expectResult(error: string | null) {
  expect(controller.error).toBe(error);
  if (error) expect(screen.getByTestId("host-admin-error").textContent).not.toContain("超时");
  else expect(screen.queryByTestId("host-admin-error")).toBeNull();
}

const pointerDescriptors = new Map<string, PropertyDescriptor | undefined>();
beforeEach(() => {
  bridgeMock.listOperatorHosts.mockResolvedValue({ items: [managedHost()], nextCursor: null });
  vi.spyOn(window, "confirm").mockReturnValue(true);
  for (const key of [
    "hasPointerCapture",
    "setPointerCapture",
    "releasePointerCapture",
    "scrollIntoView"
  ]) {
    pointerDescriptors.set(key, Object.getOwnPropertyDescriptor(window.HTMLElement.prototype, key));
    Object.defineProperty(window.HTMLElement.prototype, key, {
      configurable: true,
      value: vi.fn()
    });
  }
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const [key, descriptor] of pointerDescriptors) {
    if (descriptor) Object.defineProperty(window.HTMLElement.prototype, key, descriptor);
    else Reflect.deleteProperty(window.HTMLElement.prototype, key);
  }
});

it.each([
  ["grant", "failure"],
  ["renew", "failure"],
  ["revoke", "failure"],
  ["grant", "success"],
  ["renew", "success"],
  ["revoke", "success"]
] as const)("replaces a registration timeout at the actual %s button boundary with its %s result", async (action, outcome) => {
  await ready(true, false);
  await registrationTimeout();
  const operation = deferred<ReturnType<typeof handoff> | ReturnType<typeof managedHost>>();
  const bridge =
    action === "grant"
      ? bridgeMock.copyOperatorHostBootstrapHandoff
      : action === "renew"
        ? bridgeMock.renewOperatorHostCredential
        : bridgeMock.revokeOperatorHost;
  bridge.mockReturnValueOnce(operation.promise);
  await clickAction(action);
  expect(bridge).toHaveBeenCalledTimes(1);
  expect(controller.busy).toBe(true);
  expect.soft(controller.error).toBeNull();
  expect.soft(screen.queryByTestId("host-admin-error")).toBeNull();
  await act(async () => {
    if (outcome === "failure") operation.reject(new Error("operator_credential_missing"));
    else
      operation.resolve(
        action === "grant"
          ? handoff()
          : {
              ...managedHost(),
              ...(action === "revoke"
                ? { revokedAt: "2030-01-01T00:01:00.000Z" }
                : { credentialRenewalRequestedAt: "2030-01-01T00:01:00.000Z" })
            }
      );
  });
  expect(controller.busy).toBe(false);
  expectResult(outcome === "failure" ? "operator_credential_missing" : null);
});

it.each([
  "success",
  "failure"
] as const)("keeps a new grant %s after old inventory, local poll and grant completions", async (outcome) => {
  vi.useFakeTimers();
  await ready(true, false);
  await registrationTimeout();
  const oldInventory = deferred<{ items: ReturnType<typeof host>[]; nextCursor: null }>();
  const oldPoll = deferred<ReturnType<typeof inventory>>();
  bridgeMock.listOperatorHosts.mockReturnValueOnce(oldInventory.promise);
  bridgeMock.getOperatorLocalAgentHostStatus.mockReturnValueOnce(oldPoll.promise);
  await act(async () => vi.advanceTimersByTimeAsync(5_000));
  const oldAction = deferred<ReturnType<typeof handoff>>();
  bridgeMock.copyOperatorHostBootstrapHandoff.mockReturnValueOnce(oldAction.promise);
  let older!: ReturnType<typeof controller.copyBootstrapHandoff>;
  act(() => {
    older = controller.copyBootstrapHandoff();
  });
  const currentAction = deferred<ReturnType<typeof handoff>>();
  bridgeMock.copyOperatorHostBootstrapHandoff.mockReturnValueOnce(currentAction.promise);
  let current!: ReturnType<typeof controller.copyBootstrapHandoff>;
  act(() => {
    current = controller.copyBootstrapHandoff();
  });
  await act(async () => {
    if (outcome === "failure") currentAction.reject(new Error("operator_credential_missing"));
    else currentAction.resolve(handoff());
    await current;
  });
  expectResult(outcome === "failure" ? "operator_credential_missing" : null);
  await act(async () => {
    if (outcome === "success") {
      oldInventory.reject(new Error("operator_timeout"));
      oldPoll.reject(new Error("operator_timeout"));
      oldAction.reject(new Error("operator_timeout"));
    } else {
      oldInventory.resolve({ items: [host("host-a")], nextCursor: null });
      oldPoll.resolve(inventory());
      oldAction.resolve(handoff());
    }
    await older;
  });
  expectResult(outcome === "failure" ? "operator_credential_missing" : null);
  expect(controller.busy).toBe(false);
});

it("does not let an older action release busy or publish a handoff during a newer action", async () => {
  await ready(true, false);
  const stale = deferred<ReturnType<typeof handoff>>();
  bridgeMock.copyOperatorHostBootstrapHandoff.mockReturnValueOnce(stale.promise);
  let old!: ReturnType<typeof controller.copyBootstrapHandoff>;
  act(() => {
    old = controller.copyBootstrapHandoff();
  });
  const current = deferred<never>();
  bridgeMock.renewOperatorHostCredential.mockReturnValueOnce(current.promise);
  let newer!: ReturnType<typeof controller.renewHostCredential>;
  act(() => {
    newer = controller.renewHostCredential("host-a");
  });
  await act(async () => {
    stale.resolve(handoff());
    await old;
  });
  expect(controller.busy).toBe(true);
  expect(controller.handoff).toBeNull();
  await act(async () => {
    current.reject(new Error("operator_credential_missing"));
    await newer;
  });
  expectResult("operator_credential_missing");
});

it("ignores a late action success after the authority changes", async () => {
  await ready(true, false);
  const stale = deferred<ReturnType<typeof handoff>>();
  bridgeMock.copyOperatorHostBootstrapHandoff.mockReturnValueOnce(stale.promise);
  let old!: ReturnType<typeof controller.copyBootstrapHandoff>;
  act(() => {
    old = controller.copyBootstrapHandoff();
  });
  await act(async () => statusListener?.(status("profile-b", profile("profile-b"))));
  await act(async () => {
    stale.resolve(handoff());
    await old;
  });
  expect(controller.handoff).toBeNull();
  expect(controller.busy).toBe(false);
  expectResult(null);
});

it("keeps a pending action owned until its new result arrives after dismissing a prior prompt", async () => {
  await ready(true, false);
  const pending = deferred<never>();
  bridgeMock.copyOperatorHostBootstrapHandoff.mockReturnValueOnce(pending.promise);
  await clickAction("grant");
  act(() => controller.clearError());
  expect(controller.busy).toBe(true);
  await act(async () => pending.reject(new Error("operator_credential_missing")));
  expect(controller.busy).toBe(false);
  expectResult("operator_credential_missing");
});
