import { expect, it } from "vitest";
import { setupWorkspaceExecutionStartServer as setup } from "./workspaceExecutionStartServerFixture.js";

it("retains a real accepted launch Stop through delivered cancellation and restart until Host terminal acknowledgement", async () => {
  const h = await setup();
  const first = h.create();
  await expect(first.start(h.input)).rejects.toMatchObject({ code: "operator_request_failed" });
  const operation = h.f.operations.findByIdempotencyKeyInScope({
    ...h.f.locator,
    blockRef: h.input.blockRef,
    idempotencyKey: `workspace-execution-${h.input.startRequestId}`
  });
  if (!operation) throw new Error("real_accepted_operation_required");
  const dispatch = h.f.dispatches.getRequired(operation.dispatchId);
  h.f.dispatches.accept(
    h.f.host.id,
    "host-started",
    dispatch.id,
    dispatch.leaseId,
    dispatch.executionAttemptId
  );
  expect(await first.cancelStart(h.stop)).toMatchObject({ confirmed: false });
  expect(h.f.operations.getRequired(operation.id).state).not.toBe("cancelled");
  const restarted = h.create();
  expect((await restarted.recoverCancellations({ locator: h.input.locator })).starts).toEqual([
    h.stop
  ]);
  expect(await restarted.cancelStart(h.stop)).toMatchObject({ confirmed: false });
  expect(
    h.f.mailbox
      .listAfter(h.f.host.id, 0)
      .filter((entry) => entry.command.type === "cancel_execution")
  ).toHaveLength(1);
  await h.f.dispatches.fail(
    h.f.host.id,
    "host-cancelled",
    dispatch.id,
    dispatch.leaseId,
    dispatch.executionAttemptId,
    { code: "execution_cancelled", message: "Cancelled by Host", retryable: false }
  );
  expect(await restarted.cancelStart(h.stop)).toMatchObject({ confirmed: true });
  expect((await restarted.recoverCancellations({ locator: h.input.locator })).starts).toEqual([]);
  await expect(restarted.start(h.input)).rejects.toThrow();
  expect(h.launches()).toBe(1);
});

it("prevents duplicate start admission before session persistence and preserves a settled Stop tombstone", async () => {
  const h = await setup();
  let release!: () => void;
  let reached!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const entered = new Promise<void>((resolve) => {
    reached = resolve;
  });
  h.catalog(async () => {
    reached();
    await gate;
    throw new Error("catalog_unavailable");
  });
  const first = h.create();
  const starting = first.start(h.input);
  const failure = expect(starting).rejects.toThrow();
  await entered;
  const duplicate = first.start(h.input);
  // Attach before releasing the catalog gate so duplicate admission cannot create an unhandled rejection.
  const duplicateFailure = expect(duplicate).rejects.toThrow();
  expect(await h.create().cancelStart(h.stop)).toMatchObject({ confirmed: false });
  release();
  await Promise.all([failure, duplicateFailure]);
  expect(await first.cancelStart(h.stop)).toMatchObject({ confirmed: true });
  const restarted = h.create();
  await expect(restarted.start(h.input)).rejects.toThrow();
  expect(h.launches()).toBe(0);
});

it("does not reopen a failed pre-session request while retrying the same start identity", async () => {
  const h = await setup();
  h.catalog(async () => {
    throw new Error("catalog_unavailable");
  });
  const first = h.create();
  await expect(first.start(h.input)).rejects.toThrow();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  h.catalog(() => gate);
  const retry = first.start(h.input);
  const retried = expect(retry).rejects.toThrow();
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(await first.cancelStart(h.stop)).toMatchObject({ confirmed: true });
  release();
  await retried;
  expect(h.launches()).toBe(0);
});
