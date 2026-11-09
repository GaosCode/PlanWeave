import { remoteBlockClaimInputSchema, remoteBlockRefIdentitySchema } from "@planweave-ai/runtime";
import { describe, expect, it, vi } from "vitest";
import { canvasRuntimeContentTargetSchema } from "../../../collaboration-protocol/src/contentVersion.js";
import { scope, setup, storeReport } from "./support/canvasRuntimeArtifactLoopbackFixture.js";

describe("Canvas Runtime artifact loopback", () => {
  it("moves complete and artifact_read bytes through one authenticated HTTP listener", async () => {
    const fixture = await setup();
    const firstLease = await fixture.adapter.acquire(scope);
    const firstRef = "T-001#B-001";
    const candidate = await firstLease.runtime.inspect({ ref: firstRef });
    const identity = remoteBlockRefIdentitySchema.parse({
      ref: firstRef,
      operationId: "operation-loopback-complete",
      controlPlane: "collaboration" as const,
      sourceRevision: candidate.sourceRevision,
      graphFingerprint: candidate.graphFingerprint,
      dispatchId: "dispatch-loopback",
      executionAttemptId: "attempt-loopback"
    });
    const {
      dispatchId: _dispatchId,
      executionAttemptId: _attemptId,
      ref: _ref,
      ...claimIdentity
    } = identity;
    await firstLease.runtime.claim(
      remoteBlockClaimInputSchema.parse({ ref: firstRef, ...claimIdentity })
    );
    await firstLease.runtime.activate(identity);
    const reportBytes = Buffer.from("# Runtime loopback report\n");
    const report = await storeReport(fixture.artifacts, reportBytes);
    await firstLease.runtime.complete({
      ...identity,
      reportArtifactRef: report.ref,
      reportBytes,
      transcript: {
        sessionId: "session-loopback",
        executor: "codex-acp",
        agentId: "codex",
        events: []
      }
    });
    const oldGrant = fixture.server.database
      .prepare(
        "SELECT grant_id,runtime_lease_id,sha256 FROM canvas_runtime_artifact_grants WHERE direction='download'"
      )
      .get();
    if (!oldGrant) throw new Error("test_download_grant_required");
    await firstLease.release();
    const denied = await fetch(
      `${fixture.origin}/agent-hosts/${fixture.hostRegistration.host.id}/canvas-runtime/leases/${oldGrant.runtime_lease_id}/artifacts/${oldGrant.sha256}`,
      {
        headers: {
          Authorization: `Bearer ${fixture.hostRegistration.token}`,
          "x-planweave-runtime-artifact-grant-id": String(oldGrant.grant_id)
        }
      }
    );
    expect(denied.status).toBe(403);

    const secondLease = await fixture.adapter.acquire(scope);
    const dependent = await secondLease.runtime.inspect({ ref: "T-001#B-002" });
    const declared = dependent.inputArtifacts[0];
    if (!declared) throw new Error("test_input_artifact_required");
    if (!declared.mediaType) throw new Error("test_input_artifact_media_type_required");
    const uploaded = await secondLease.artifacts.read({
      targetBlockRef: dependent.blockRef,
      sourceRevision: dependent.sourceRevision,
      artifactRef: declared.artifactRef,
      logicalName: declared.logicalName,
      mediaType: declared.mediaType
    });
    expect(Buffer.from(uploaded.bytes)).toEqual(reportBytes);
    expect(uploaded.artifactRef).toBe(report.ref);
    expect(await fixture.artifacts.read(report.ref)).toEqual(reportBytes);
    await secondLease.release();
  });

  it("protects authoritative content downloads by Host credential, scope, binding, and head", async () => {
    const fixture = await setup();
    const contentPath =
      `${fixture.origin}/agent-hosts/${fixture.hostRegistration.host.id}/canvas-runtime/content/` +
      `${scope.projectId}/${scope.canvasId}/${fixture.contentTarget.content.versionId}`;
    const contentUrl = new URL(contentPath);
    contentUrl.searchParams.set("workspaceId", scope.workspaceId);
    contentUrl.searchParams.set("canonicalDigest", fixture.contentTarget.content.canonicalDigest);

    const badToken = await fetch(contentUrl, {
      headers: { Authorization: `Bearer pw_host_${"x".repeat(43)}` }
    });
    expect(badToken.status).toBe(401);
    expect(await badToken.json()).toEqual({ error: "runtime_content_unauthorized" });

    const wrongWorkspace = new URL(contentUrl);
    wrongWorkspace.searchParams.set("workspaceId", "workspace-other");
    const crossScope = await fetch(wrongWorkspace, {
      headers: { Authorization: `Bearer ${fixture.hostRegistration.token}` }
    });
    expect(crossScope.status).toBe(403);
    expect(await crossScope.json()).toEqual({ error: "runtime_content_scope_forbidden" });

    const currentHead = fixture.contentVersions.head(scope);
    if (!currentHead) throw new Error("test_content_head_required");
    const staleHead = vi.spyOn(fixture.contentVersions, "head").mockReturnValueOnce({
      ...currentHead,
      revision: currentHead.revision + 1,
      content: canvasRuntimeContentTargetSchema.parse({
        revision: fixture.contentTarget.revision + 1,
        content: {
          versionId: `version-${"f".repeat(64)}`,
          canonicalDigest: "f".repeat(64),
          verification: "complete"
        },
        graphFingerprint: fixture.contentTarget.graphFingerprint
      }).content
    });
    await expect(fixture.adapter.acquire(scope)).rejects.toThrow(
      "runtime_content_download_failed_409"
    );
    staleHead.mockRestore();

    const failedHead = vi.spyOn(fixture.contentVersions, "head").mockImplementationOnce(() => {
      throw new Error("simulated_repository_failure");
    });
    await expect(fixture.adapter.acquire(scope)).rejects.toThrow(
      "runtime_content_download_failed_500"
    );
    failedHead.mockRestore();

    fixture.coordination.hosts.runtimeBindings.synchronizeReadiness(
      fixture.hostRegistration.host.id,
      []
    );
    const unbound = await fetch(contentUrl, {
      headers: { Authorization: `Bearer ${fixture.hostRegistration.token}` }
    });
    expect(unbound.status).toBe(403);
    expect(await unbound.json()).toEqual({ error: "runtime_content_scope_forbidden" });
  });
});
