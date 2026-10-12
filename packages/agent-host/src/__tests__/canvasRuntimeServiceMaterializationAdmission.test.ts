import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  captureAuthorizedCanvasContent,
  initWorkspace,
  readAuthorizedCanvasRuntimeStatus
} from "@planweave-ai/runtime";
import { describe, expect, it } from "vitest";
import { scope } from "./support/canvasRuntimeServiceFixture.js";
import {
  createTimingFixture,
  deferred,
  waitUntilResolved
} from "./support/canvasRuntimeTimingFixture.js";

async function startReplacement() {
  const fixture = await createTimingFixture();
  fixture.state.canvasRuntime.releaseLease(fixture.lease.runtimeLeaseId);
  const promptPath = join(fixture.canvas.packageDir, "nodes/T-001/prompt.md");
  const oldPrompt = await readFile(promptPath, "utf8");
  await writeFile(promptPath, "# New authoritative prompt\n", "utf8");
  const captured = await captureAuthorizedCanvasContent({
    projectRoot: fixture.canvas,
    authorityProjectId: scope.projectId
  });
  const status = await readAuthorizedCanvasRuntimeStatus({
    projectRoot: fixture.canvas,
    canvasId: scope.canvasId,
    expectedPackageDir: fixture.canvas.packageDir,
    scope
  });
  await writeFile(promptPath, oldPrompt, "utf8");
  const target = {
    revision: 2,
    content: {
      versionId: `version-${captured.content.canonicalDigest}`,
      canonicalDigest: captured.content.canonicalDigest,
      verification: "complete" as const
    },
    graphFingerprint: status.packageFingerprint
  };
  const started = deferred();
  const finish = deferred();
  fixture.contentTransfer.fetch.mockImplementation(async () => {
    started.resolve();
    await finish.promise;
    return {
      schemaVersion: "content-version/v1",
      scope,
      content: captured.content,
      completed: target.content,
      createdAt: "2030-01-01T00:00:00.000Z",
      createdBy: { kind: "system", id: "server" }
    };
  });
  const before = await fixture.snapshot();
  const receiptPath = join(fixture.canvas.workspaceRoot, "authority-content-target.json");
  const receiptBefore = await readFile(receiptPath, "utf8");
  return { fixture, target, before, receiptPath, receiptBefore, started, finish };
}

describe("Canvas Runtime materialization admission", () => {
  it.each([
    "resetPackage",
    "resetResults"
  ] as const)("rejects the original resolver owner after a command waits in the scope lane across %s", async (reset) => {
    const fixture = await createTimingFixture();
    const started = deferred();
    const finish = deferred();
    fixture.artifactTransfer.download.mockImplementation(async () => {
      started.resolve();
      await finish.promise;
      return fixture.bytes;
    });
    const blocking = fixture.complete(fixture.firstIdentity, "request-lane-blocker");
    const queued = fixture.command(
      { operation: "availability", contentTarget: fixture.target },
      "request-retired-owner"
    );
    fixture.receive(blocking);
    const first = fixture.service.handle(blocking);
    try {
      await started.promise;
      fixture.receive(queued);
      const second = fixture.service.handle(queued);
      await waitUntilResolved(fixture, 2);
      const fresh = (await initWorkspace({ projectRoot: fixture.canvas.rootPath, [reset]: true }))
        .workspace;
      const manifestBefore = await readFile(fresh.manifestFile, "utf8");
      const stateBefore = await readFile(fresh.stateFile, "utf8");
      const receipt = join(fresh.workspaceRoot, "authority-content-target.json");
      const receiptBefore = await readFile(receipt, "utf8");
      await fixture.invalidate("cancel", blocking.requestId);
      fixture.state.canvasRuntime.releaseLease(fixture.lease.runtimeLeaseId);
      finish.resolve();
      await Promise.all([first, second]);
      expect(fixture.response(queued.requestId)).toMatchObject({ response: { outcome: "error" } });
      expect(fixture.contentTransfer.fetch).not.toHaveBeenCalled();
      expect(await readFile(fresh.manifestFile, "utf8")).toBe(manifestBefore);
      expect(await readFile(fresh.stateFile, "utf8")).toBe(stateBefore);
      expect(await readFile(receipt, "utf8")).toBe(receiptBefore);
    } finally {
      finish.resolve();
      await first;
    }
  });
  it.each([
    "deadline",
    "cancel",
    "disconnect"
  ] as const)("does not materialize or acquire a lease after fetch when %s invalidates the request", async (kind) => {
    const { fixture, target, before, receiptPath, receiptBefore, started, finish } =
      await startReplacement();
    const command = fixture.command(
      { operation: "acquire", contentTarget: target },
      "request-materializing-acquire",
      kind === "deadline" ? "2030-01-01T00:00:01.000Z" : undefined
    );
    fixture.receive(command);
    const run = fixture.service.handle(command);
    await started.promise;
    await fixture.invalidate(kind, command.requestId);
    finish.resolve();
    await run;
    expect(fixture.response(command.requestId)).toMatchObject({
      response: {
        outcome: "error",
        error: {
          code: kind === "deadline" ? "deadline_exceeded" : "request_cancelled",
          retryable: false
        }
      }
    });
    expect(await fixture.snapshot()).toEqual(before);
    expect(await readFile(receiptPath, "utf8")).toBe(receiptBefore);
    expect(fixture.state.canvasRuntime.activeLeases(scope)).toEqual([]);
    expect(fixture.state.canvasRuntime.lease(fixture.lease.runtimeLeaseId)).toEqual({
      ...fixture.lease,
      status: "released"
    });
  });
  it("rechecks live lease authorization after the authoritative fetch", async () => {
    const { fixture, target, before, receiptPath, receiptBefore, started, finish } =
      await startReplacement();
    const command = fixture.command(
      { operation: "availability", contentTarget: target },
      "request-materializing-lease"
    );
    fixture.receive(command);
    const run = fixture.service.handle(command);
    await started.promise;
    const currentLease = { ...fixture.lease, runtimeLeaseId: "runtime-lease-arrived-during-fetch" };
    fixture.state.canvasRuntime.createLease(currentLease);
    finish.resolve();
    await run;
    expect(fixture.response(command.requestId)).toMatchObject({
      response: { outcome: "error", error: { code: "content_out_of_sync", retryable: false } }
    });
    expect(await fixture.snapshot()).toEqual(before);
    expect(await readFile(receiptPath, "utf8")).toBe(receiptBefore);
    expect(fixture.state.canvasRuntime.activeLeases(scope)).toEqual([currentLease]);
  });
});
