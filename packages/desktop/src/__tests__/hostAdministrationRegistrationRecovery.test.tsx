/* @vitest-environment jsdom */

import { act, fireEvent, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import {
  bridgeMock,
  checked,
  controller,
  deferred,
  disabled,
  host,
  inventory,
  profile,
  ready,
  status,
  statusListener
} from "./hostAdministrationRegistrationHarness";

it.each([
  "register",
  "enroll"
] as const)("keeps the actual %s checkbox choice through timeout, null recovery, polling and a second click", async (method) => {
  vi.useFakeTimers();
  await ready(method === "register");
  const buttonId = `host-admin-${method}-local`;
  fireEvent.click(screen.getByTestId("host-admin-local-agent-codex-acp"));
  if (method === "enroll")
    fireEvent.change(screen.getByTestId("host-admin-local-handoff"), {
      target: { value: "same-handoff" }
    });
  const action =
    method === "register"
      ? bridgeMock.registerOperatorLocalAgentHost
      : bridgeMock.enrollOperatorLocalAgentHost;
  const pending = deferred<never>();
  const recovery = deferred<ReturnType<typeof inventory>>();
  action
    .mockReturnValueOnce(pending.promise)
    .mockResolvedValueOnce({ ...inventory(true), state: "ready" });
  bridgeMock.getOperatorLocalAgentHostStatus.mockReturnValueOnce(recovery.promise);
  fireEvent.click(screen.getByTestId(buttonId));
  expect(controller.busy).toBe(true);
  await act(async () => pending.reject(new Error("agent_host_enrollment_timeout")));
  expect(controller.localAgentHost).toBeNull();
  expect(screen.getByTestId("host-admin-error").textContent).toContain("超时");
  await act(async () => recovery.resolve(inventory()));
  expect(controller.busy).toBe(false);
  expect.soft(checked()).toBe(true);
  expect.soft(disabled(buttonId)).toBe(false);

  await act(async () => vi.advanceTimersByTimeAsync(5_000));
  expect.soft(checked()).toBe(true);
  expect.soft(screen.queryByTestId("host-admin-error")?.textContent).toContain("超时");
  fireEvent.click(screen.getByTestId(buttonId));
  await act(async () => {});
  expect(action).toHaveBeenCalledTimes(2);
  expect(action.mock.calls[1]?.[0]).toMatchObject(
    method === "enroll"
      ? { handoff: "same-handoff", exposedProfileIds: ["codex-acp"] }
      : { profileId: "profile-a", exposedProfileIds: ["codex-acp"] }
  );
  expect(controller.error).toBeNull();
});

it("preserves a registration error through deferred inventory completion and replaces it at the next action boundary", async () => {
  await ready();
  fireEvent.click(screen.getByTestId("host-admin-local-agent-codex-acp"));
  const inventoryRequest = deferred<{ items: ReturnType<typeof host>[]; nextCursor: null }>();
  bridgeMock.listOperatorHosts.mockReturnValueOnce(inventoryRequest.promise);
  let inventoryOperation!: Promise<void>;
  act(() => {
    inventoryOperation = controller.refreshHosts();
  });
  bridgeMock.registerOperatorLocalAgentHost.mockRejectedValueOnce(
    new Error("agent_host_enrollment_timeout")
  );
  fireEvent.click(screen.getByTestId("host-admin-register-local"));
  await act(async () => {});
  expect(screen.getByTestId("host-admin-error").textContent).toContain("超时");
  await act(async () => {
    inventoryRequest.resolve({ items: [host("host-a")], nextCursor: null });
    await inventoryOperation;
  });
  expect.soft(controller.error).toBe("agent_host_enrollment_timeout");
  expect.soft(screen.queryByTestId("host-admin-error")?.textContent).toContain("超时");
  const retry = deferred<never>();
  bridgeMock.registerOperatorLocalAgentHost.mockReturnValueOnce(retry.promise);
  act(() => {
    void controller.registerLocalAgentHost(["codex-acp"]);
  });
  expect(controller.busy).toBe(true);
  expect.soft(screen.queryByTestId("host-admin-error")).toBeNull();
  await act(async () => retry.reject(new Error("agent_host_enrollment_rejected")));
  expect(controller.error).toBe("agent_host_enrollment_rejected");
  bridgeMock.listOperatorHosts.mockRejectedValueOnce(new Error("operator_timeout"));
  await act(async () => controller.refreshHosts());
  expect.soft(controller.error).toBe("agent_host_enrollment_rejected");
  await act(async () => controller.refreshHosts());
  expect.soft(controller.error).toBe("agent_host_enrollment_rejected");
});

it("honors explicit deselection, discards removed choices, and initializes a new profile or Server from its inventory", async () => {
  vi.useFakeTimers();
  await ready();
  fireEvent.click(screen.getByTestId("host-admin-local-agent-codex-acp"));
  fireEvent.click(screen.getByTestId("host-admin-local-agent-codex-acp"));
  bridgeMock.getOperatorLocalAgentHostStatus.mockResolvedValue(inventory(true));
  await act(async () => vi.advanceTimersByTimeAsync(5_000));
  expect.soft(checked()).toBe(false);
  expect.soft(disabled("host-admin-register-local")).toBe(true);
  fireEvent.click(screen.getByTestId("host-admin-local-agent-codex-acp"));
  bridgeMock.getOperatorLocalAgentHostStatus.mockResolvedValue({ ...inventory(), agents: [] });
  await act(async () => vi.advanceTimersByTimeAsync(5_000));
  expect(screen.queryByTestId("host-admin-local-agent-codex-acp")).toBeNull();
  bridgeMock.getOperatorLocalAgentHostStatus.mockResolvedValue(inventory());
  await act(async () => vi.advanceTimersByTimeAsync(5_000));
  expect(checked()).toBe(false);
  fireEvent.click(screen.getByTestId("host-admin-local-agent-codex-acp"));
  await act(async () => statusListener?.(status("profile-b")));
  expect(checked()).toBe(false);
  fireEvent.click(screen.getByTestId("host-admin-local-agent-codex-acp"));
  await act(async () =>
    statusListener?.(
      status(
        "profile-b",
        profile("profile-b", {
          serverBaseUrl: "https://other.example/",
          updatedAt: "2030-01-02T00:00:00.000Z"
        })
      )
    )
  );
  expect(checked()).toBe(false);
});

it("initializes a changed registration target from its exposed inventory", async () => {
  vi.useFakeTimers();
  await ready();
  fireEvent.click(screen.getByTestId("host-admin-local-agent-codex-acp"));
  fireEvent.click(screen.getByTestId("host-admin-local-agent-codex-acp"));
  bridgeMock.getOperatorLocalAgentHostStatus.mockResolvedValue({
    ...inventory(true),
    workspaceId: "new-target"
  });
  await act(async () => vi.advanceTimersByTimeAsync(5_000));
  expect(checked()).toBe(true);
  expect(disabled("host-admin-register-local")).toBe(false);
});

it("clears an inventory failure only when that inventory recovers", async () => {
  await ready();
  bridgeMock.listOperatorHosts.mockRejectedValueOnce(new Error("operator_timeout"));
  await act(async () => controller.refreshHosts());
  expect(controller.error).toBe("operator_timeout");
  expect(screen.getByTestId("host-admin-error").textContent).toContain("重试");
  await act(async () => controller.refreshHosts());
  expect(controller.error).toBeNull();
  expect(screen.queryByTestId("host-admin-error")).toBeNull();
});

it.each([
  "success",
  "failure"
] as const)("keeps the latest registration %s when an older other action completes, rejects concurrent registration and clears on a new authority", async (outcome) => {
  await ready();
  const oldAction = deferred<never>();
  bridgeMock.copyOperatorHostBootstrapHandoff.mockReturnValueOnce(oldAction.promise);
  let oldOperation!: ReturnType<typeof controller.copyBootstrapHandoff>;
  act(() => {
    oldOperation = controller.copyBootstrapHandoff();
  });
  const registration = deferred<ReturnType<typeof inventory>>();
  bridgeMock.registerOperatorLocalAgentHost.mockReturnValueOnce(registration.promise);
  let currentOperation!: ReturnType<typeof controller.registerLocalAgentHost>;
  act(() => {
    currentOperation = controller.registerLocalAgentHost(["codex-acp"]);
  });
  await act(async () => controller.enrollLocalAgentHost("another-handoff", ["codex-acp"]));
  expect(bridgeMock.enrollOperatorLocalAgentHost).not.toHaveBeenCalled();
  expect(controller.busy).toBe(true);
  await act(async () => {
    if (outcome === "failure") registration.reject(new Error("agent_host_enrollment_rejected"));
    else registration.resolve(inventory(true));
    await currentOperation;
  });
  await act(async () => {
    oldAction.reject(new Error("operator_timeout"));
    await oldOperation;
  });
  expect(controller.error).toBe(outcome === "failure" ? "agent_host_enrollment_rejected" : null);
  if (outcome === "failure")
    expect(screen.getByTestId("host-admin-error").textContent).not.toContain("超时");
  else expect(screen.queryByTestId("host-admin-error")).toBeNull();
  const staleRetry = deferred<never>();
  bridgeMock.registerOperatorLocalAgentHost.mockReturnValueOnce(staleRetry.promise);
  let staleOperation!: ReturnType<typeof controller.registerLocalAgentHost>;
  act(() => {
    staleOperation = controller.registerLocalAgentHost(["codex-acp"]);
  });
  await act(async () => statusListener?.(status("profile-b")));
  expect(controller.busy).toBe(false);
  expect(controller.error).toBeNull();
  await act(async () => {
    staleRetry.reject(new Error("agent_host_enrollment_timeout"));
    await staleOperation;
  });
  expect(controller.error).toBeNull();
  expect(screen.queryByTestId("host-admin-error")).toBeNull();
});

it("ignores an inventory failure begun before registration while surfacing a new inventory failure afterward", async () => {
  await ready();
  fireEvent.click(screen.getByTestId("host-admin-local-agent-codex-acp"));
  const oldInventory = deferred<never>();
  bridgeMock.listOperatorHosts.mockReturnValueOnce(oldInventory.promise);
  let oldOperation!: Promise<void>;
  act(() => {
    oldOperation = controller.refreshHosts();
  });
  bridgeMock.registerOperatorLocalAgentHost.mockResolvedValueOnce(inventory(true));
  fireEvent.click(screen.getByTestId("host-admin-register-local"));
  await act(async () => {});
  await act(async () => {
    oldInventory.reject(new Error("operator_timeout"));
    await oldOperation;
  });
  expect(controller.busy).toBe(false);
  expect.soft(controller.error).toBeNull();
  bridgeMock.listOperatorHosts.mockRejectedValueOnce(new Error("operator_timeout"));
  await act(async () => controller.refreshHosts());
  expect(controller.error).toBe("operator_timeout");
  expect(screen.getByTestId("host-admin-error").textContent).toContain("重试");
});
