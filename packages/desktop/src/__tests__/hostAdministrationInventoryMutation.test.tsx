/* @vitest-environment jsdom */

import { act } from "@testing-library/react";
import type {
  OperatorHostPage,
  OperatorHostView
} from "@planweave-ai/agent-host-protocol/operator-control";
import { describe, expect, it, vi } from "vitest";
import {
  bridgeMock,
  controller,
  deferred,
  host,
  ready
} from "./hostAdministrationRegistrationHarness";

type Mutation = "revoke" | "renew";
type ReadMode = "silent" | "refresh" | "continue";

function page(items: OperatorHostView[] = [host("host-a")]): OperatorHostPage {
  return { items, nextCursor: null };
}

async function prepare(mode: ReadMode) {
  vi.useFakeTimers();
  if (mode === "continue") {
    bridgeMock.listOperatorHosts.mockImplementation(async ({ query }) => ({
      items: [host("host-a")],
      nextCursor: query.cursor + 1
    }));
  }
  await ready(true, false);
  expect(controller.hosts).toEqual([host("host-a")]);
  expect(controller.hostsLoading).toBe(false);
  bridgeMock.listOperatorHosts.mockResolvedValue(page());
}

async function read(mode: ReadMode): Promise<{ pending: Promise<void> }> {
  let pending!: Promise<void>;
  await act(async () => {
    if (mode === "silent") {
      await vi.advanceTimersByTimeAsync(5_000);
      pending = Promise.resolve();
    } else {
      pending = mode === "refresh" ? controller.refreshHosts() : controller.loadMoreHosts();
    }
  });
  return { pending };
}

async function mutate(mutation: Mutation) {
  const updated: OperatorHostView = {
    ...host("host-a"),
    ...(mutation === "revoke"
      ? { revokedAt: "2030-01-01T00:01:00.000Z" }
      : { credentialRenewalRequestedAt: "2030-01-01T00:01:00.000Z" })
  };
  const bridge =
    mutation === "revoke" ? bridgeMock.revokeOperatorHost : bridgeMock.renewOperatorHostCredential;
  bridge.mockResolvedValueOnce(updated);
  await act(async () => {
    const result =
      mutation === "revoke"
        ? await controller.revokeHost("host-a")
        : await controller.renewHostCredential("host-a");
    expect(result).toEqual(updated);
  });
  expect(bridge).toHaveBeenCalledTimes(1);
  expect(controller.hosts).toEqual([updated]);
  expect(controller.busy).toBe(false);
  return updated;
}

describe("Host inventory publication after a successful mutation", () => {
  it.each([
    { mode: "silent", mutation: "revoke" },
    { mode: "silent", mutation: "renew" },
    { mode: "refresh", mutation: "revoke" },
    { mode: "refresh", mutation: "renew" },
    { mode: "continue", mutation: "revoke" },
    { mode: "continue", mutation: "renew" }
  ] as const)("keeps $mutation data when an older $mode read succeeds", async ({
    mode,
    mutation
  }) => {
    await prepare(mode);
    const oldRead = deferred<OperatorHostPage>();
    bridgeMock.listOperatorHosts.mockReturnValueOnce(oldRead.promise);
    const { pending } = await read(mode);
    const updated = await mutate(mutation);
    await act(async () => {
      oldRead.resolve(page([host("host-b")]));
      await pending;
    });
    expect(controller.hosts).toEqual([updated]);
    expect(controller.hostInventoryState).toBe("ready");
    expect(controller.hostsLoading).toBe(false);
  });

  it.each([
    { mode: "refresh", queued: "continue", mutation: "revoke" },
    { mode: "continue", queued: "refresh", mutation: "renew" }
  ] as const)("retires a queued $queued read after $mutation", async ({
    mode,
    queued,
    mutation
  }) => {
    await prepare("continue");
    const oldRead = deferred<OperatorHostPage>();
    bridgeMock.listOperatorHosts.mockReturnValueOnce(oldRead.promise);
    const callsBefore = bridgeMock.listOperatorHosts.mock.calls.length;
    const active = await read(mode);
    const queuedRead = await read(queued);
    expect(bridgeMock.listOperatorHosts).toHaveBeenCalledTimes(callsBefore + 1);
    const updated = await mutate(mutation);
    await act(async () => {
      oldRead.resolve(page());
      await Promise.all([active.pending, queuedRead.pending]);
    });
    expect(bridgeMock.listOperatorHosts).toHaveBeenCalledTimes(callsBefore + 1);
    expect(controller.hosts).toEqual([updated]);
    expect(controller.hostInventoryState).toBe("ready");
    expect(controller.hostsLoading).toBe(false);
  });

  it.each([
    { mutation: "revoke", outcome: "resolve" },
    { mutation: "renew", outcome: "reject" }
  ] as const)("starts a fresh lane after $mutation and keeps its loading when the old read $outcome", async ({
    mutation,
    outcome
  }) => {
    await prepare("refresh");
    const oldRead = deferred<OperatorHostPage>();
    const freshRead = deferred<OperatorHostPage>();
    bridgeMock.listOperatorHosts
      .mockReturnValueOnce(oldRead.promise)
      .mockReturnValueOnce(freshRead.promise);
    const old = await read("refresh");
    const updated = await mutate(mutation);
    expect(controller.hostInventoryState).toBe("ready");
    expect(controller.hostsLoading).toBe(false);
    const callsBefore = bridgeMock.listOperatorHosts.mock.calls.length;
    const fresh = await read("refresh");
    expect(bridgeMock.listOperatorHosts).toHaveBeenCalledTimes(callsBefore + 1);
    expect(controller.hostsLoading).toBe(true);
    await act(async () => {
      if (outcome === "resolve") oldRead.resolve(page());
      else oldRead.reject(new Error("operator_offline"));
      await old.pending;
    });
    expect(controller.hosts).toEqual([updated]);
    expect(controller.hostsLoading).toBe(true);
    expect(controller.hostInventoryState).toBe("loading");
    const serverUpdate = { ...host("host-a"), displayName: "Server update" };
    await act(async () => {
      freshRead.resolve(page([serverUpdate]));
      await fresh.pending;
    });
    expect(controller.hosts).toEqual([serverUpdate]);
    expect(controller.hostsLoading).toBe(false);
    expect(controller.hostInventoryState).toBe("ready");
  });

  it("continues from the mutated snapshot while an older continuation remains pending", async () => {
    await prepare("continue");
    const oldRead = deferred<OperatorHostPage>();
    bridgeMock.listOperatorHosts.mockReturnValueOnce(oldRead.promise);
    const old = await read("continue");
    const updated = await mutate("renew");
    bridgeMock.listOperatorHosts.mockResolvedValueOnce(page([host("host-b")]));
    const callsBefore = bridgeMock.listOperatorHosts.mock.calls.length;
    const fresh = await read("continue");
    expect(bridgeMock.listOperatorHosts).toHaveBeenCalledTimes(callsBefore + 1);
    await act(async () => fresh.pending);
    expect(controller.hosts).toEqual([updated, host("host-b")]);
    await act(async () => {
      oldRead.resolve(page());
      await old.pending;
    });
    expect(controller.hosts).toEqual([updated, host("host-b")]);
    expect(controller.hostsHasMore).toBe(false);
  });

  it("ignores an old rejection after a newer inventory error and permits retry", async () => {
    await prepare("refresh");
    const oldRead = deferred<OperatorHostPage>();
    bridgeMock.listOperatorHosts.mockReturnValueOnce(oldRead.promise);
    const old = await read("refresh");
    const updated = await mutate("renew");
    bridgeMock.listOperatorHosts.mockRejectedValueOnce(new Error("operator_timeout"));
    const callsBefore = bridgeMock.listOperatorHosts.mock.calls.length;
    const fresh = await read("refresh");
    expect(bridgeMock.listOperatorHosts).toHaveBeenCalledTimes(callsBefore + 1);
    await act(async () => fresh.pending);
    expect(controller.error).toBe("operator_timeout");
    await act(async () => {
      oldRead.reject(new Error("operator_offline"));
      await old.pending;
    });
    expect(controller.error).toBe("operator_timeout");
    expect(controller.hosts).toEqual([updated]);
    expect(controller.hostsLoading).toBe(false);
    bridgeMock.listOperatorHosts.mockResolvedValueOnce(page([updated]));
    await act(async () => controller.refreshHosts());
    expect(controller.error).toBeNull();
  });

  it.each([
    "revoke",
    "renew",
    "grant",
    "clear-error"
  ] as const)("keeps pending inventory valid after %s without a successful Host mutation", async (action) => {
    await prepare("refresh");
    const oldRead = deferred<OperatorHostPage>();
    bridgeMock.listOperatorHosts.mockReturnValueOnce(oldRead.promise);
    const old = await read("refresh");
    await act(async () => {
      if (action === "revoke") {
        bridgeMock.revokeOperatorHost.mockRejectedValueOnce(new Error("operator_forbidden"));
        await controller.revokeHost("host-a");
      } else if (action === "renew") {
        bridgeMock.renewOperatorHostCredential.mockRejectedValueOnce(
          new Error("operator_forbidden")
        );
        await controller.renewHostCredential("host-a");
      } else if (action === "grant") {
        bridgeMock.copyOperatorHostBootstrapHandoff.mockResolvedValueOnce({
          state: "ready",
          expiresAt: "2030-01-01T00:15:00.000Z",
          credentialExpiresAt: "2030-06-30T00:00:00.000Z",
          credentialPolicy: { lifetimeDays: 180, renewal: "automatic" },
          copiedAt: "2030-01-01T00:00:00.000Z",
          commandPreview: "planweave agent-host enroll <handoff>"
        });
        await controller.copyBootstrapHandoff();
      } else {
        controller.clearError();
      }
    });
    const serverUpdate = { ...host("host-a"), displayName: "Current server data" };
    await act(async () => {
      oldRead.resolve(page([serverUpdate]));
      await old.pending;
    });
    expect(controller.hosts).toEqual([serverUpdate]);
    expect(controller.hostsLoading).toBe(false);
    expect(controller.error).toBe(
      action === "revoke" || action === "renew" ? "operator_forbidden" : null
    );
  });
});
