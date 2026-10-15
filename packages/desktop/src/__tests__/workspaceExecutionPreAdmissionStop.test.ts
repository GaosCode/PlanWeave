import { unlink } from "node:fs/promises";
import { expect, it, vi } from "vitest";
import { WorkspaceExecutionStartIntents } from "../main/workspaceExecutionStartIntents.js";
import { setupPreAdmissionStop } from "./workspaceExecutionPreAdmissionStopFixture.js";

it("seals a credential failure before admission and preserves the Stop across service reconstruction", async () => {
  const h = await setupPreAdmissionStop();
  const service = h.create();
  const endpoints = await h.collaboration.withWorkspaceExecutionClient(h.input.locator, (client) =>
    client.remoteOperations().listAgentEndpoints(h.input.locator)
  );
  expect(endpoints.items.some((endpoint) => endpoint.endpointId === h.input.agentEndpointId)).toBe(
    true
  );
  await h.clearCredential();
  const requests = h.requests.length;
  await expect(service.start(h.input)).rejects.toMatchObject({
    code: "collaboration_unknown",
    message: "Human device credential is not available for this profile.",
    httpStatus: undefined
  });
  expect(h.requests).toHaveLength(requests);
  expect(await h.diskFiles()).toEqual([]);
  expect(h.server.countOperations()).toBe(0);
  await h.restoreCredential();
  expect(await service.cancelStart(h.stop)).toMatchObject({ confirmed: true });
  expect((await service.recoverCancellations({ locator: h.input.locator })).starts).toEqual([]);
  const restarted = h.create();
  expect(await restarted.cancelStart(h.stop)).toMatchObject({ confirmed: true });
  expect((await restarted.recoverCancellations({ locator: h.input.locator })).starts).toEqual([]);
  await expect(restarted.start(h.input)).rejects.toThrow("workspace_execution_cancel_unconfirmed");
  const fresh = await restarted.start({ ...h.input, startRequestId: "fresh-start" });
  expect(fresh.handle.target).toBe("remote");
  expect(h.server.countOperations()).toBe(1);
  expect(
    h.requests.filter(
      (request) => request.path.endsWith("/remote-operations") && request.method === "POST"
    )
  ).toHaveLength(1);
  expect((await h.journals()).map((journal) => journal.value)).toContainEqual(
    expect.objectContaining({
      input: h.input,
      settled: true,
      cancellationConfirmed: true,
      cancellation: h.stop
    })
  );
});

it("lets Stop seal before a delayed start reaches admission in the same service", async () => {
  const h = await setupPreAdmissionStop();
  const service = h.create();
  let enter!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const readCredential = h.vault.getDeviceToken.bind(h.vault);
  vi.spyOn(h.vault, "getDeviceToken").mockImplementationOnce(async (profileId) => {
    enter();
    await gate;
    return readCredential(profileId);
  });
  const starting = expect(service.start(h.input)).rejects.toThrow(
    "workspace_execution_cancel_unconfirmed"
  );
  await entered;
  const cancelled = await service.cancelStart(h.stop);
  release();
  await starting;
  expect(cancelled).toMatchObject({ confirmed: true });
  expect(h.server.countOperations()).toBe(0);
  expect((await service.recoverCancellations({ locator: h.input.locator })).starts).toEqual([]);
});

it("keeps an existing ownerless unsettled journal unknown", async () => {
  const h = await setupPreAdmissionStop();
  await new WorkspaceExecutionStartIntents(h.sessionsRoot).write({
    input: h.input,
    settled: false,
    cancellationConfirmed: false,
    cancellation: null
  });
  const service = h.create();
  expect(await service.cancelStart(h.stop)).toMatchObject({ confirmed: false });
  expect((await h.create().recoverCancellations({ locator: h.input.locator })).starts).toEqual([
    h.stop
  ]);
  await expect(service.start(h.input)).rejects.toThrow("workspace_execution_cancel_unconfirmed");
  expect(h.server.countOperations()).toBe(0);
});

it("recovers a persisted remote session before confirming a newly sealed missing journal", async () => {
  const h = await setupPreAdmissionStop();
  const service = h.create();
  const view = await service.start(h.input);
  const journal = (await h.journals())[0];
  if (!journal) throw new Error("admitted_journal_required");
  await unlink(journal.path);
  expect(await service.cancelStart(h.stop)).toMatchObject({ confirmed: false });
  const observed = await h.collaboration.withWorkspaceExecutionClient(h.input.locator, (client) =>
    client
      .remoteOperations()
      .observeRemoteOperation(view.handle.target === "remote" ? view.handle.operationId : "invalid")
  );
  expect(["completed", "failed", "cancelled"]).not.toContain(observed.state);
  expect(
    h.requests.some((request) => request.path.endsWith(`/${observed.operationId}/actions`))
  ).toBe(true);
  expect((await service.recoverCancellations({ locator: h.input.locator })).starts).toEqual([
    h.stop
  ]);
  expect(h.server.countOperations()).toBe(1);
});
