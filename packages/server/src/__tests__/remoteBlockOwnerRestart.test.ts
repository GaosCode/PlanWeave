import {
  canonicalizeExecutionEnvelope,
  executionEnvelopeSchema,
  hashExecutionEnvelope,
  ownerPackageLocatorForRun
} from "@planweave-ai/agent-host-protocol";
import { describe, expect, it } from "vitest";
import {
  RemoteCoordinatorCheckpointCrash,
  type RemoteCoordinatorCheckpoint,
  type RemoteCoordinatorCheckpointPort
} from "../remoteBlockCoordinatorPorts.js";
import { buildRemoteBlockExecutionEnvelope } from "../remoteBlockDispatchPreparation.js";
import { SqliteRemoteOperationCandidateRepository } from "../remoteCoordinatorPersistence.js";
import { OwnerCanvasRestartHarness } from "./support/remoteBlockCoordinatorFixture.js";

class CrashOnce implements RemoteCoordinatorCheckpointPort {
  private crashed = false;

  constructor(readonly target: RemoteCoordinatorCheckpoint) {}

  reached(checkpoint: RemoteCoordinatorCheckpoint): void {
    if (checkpoint === this.target && !this.crashed) {
      this.crashed = true;
      throw new RemoteCoordinatorCheckpointCrash(checkpoint);
    }
  }
}

describe("RemoteBlockCoordinator owner Canvas restart", () => {
  it("rejects a legacy owner locator when the authorized Host is Workspace-bound", async () => {
    const harness = await OwnerCanvasRestartHarness.create();
    await harness.start(new CrashOnce("after_operation_commit"));
    const hostId = harness.registerHost(false, true);
    harness.reportHostOnline(hostId, true);
    const request = harness.request("bound-legacy-owner");

    await expect(harness.requireCoordination().coordinator.dispatch(request)).rejects.toThrowError(
      "injected_crash:after_operation_commit"
    );
    const operation = harness.requireCoordination().operations.findByCallerIdentity({
      ...harness.locator,
      blockRef: request.blockRef,
      idempotencyKey: request.idempotencyKey
    });
    if (!operation) throw new Error("bound_legacy_owner_operation_missing");
    harness
      .requireServer()
      .database.prepare("UPDATE remote_operations SET required_capabilities_json=? WHERE id=?")
      .run(JSON.stringify(["acp.codex"]), operation.id);
    harness.reportHostOnline(hostId, false);

    await expect(
      harness.requireCoordination().coordinator.reenter(operation.id)
    ).rejects.toThrowError("owner_package_locator_unavailable");
    expect(harness.requireCoordination().mailbox.listAfter(hostId, 0)).toEqual([]);
  });

  it("rebuilds a leased envelope from Runtime materialization", async () => {
    const harness = await OwnerCanvasRestartHarness.create();
    await harness.start(new CrashOnce("after_dispatch_persistence"));
    const hostId = harness.registerHost();
    const request = harness.request("owner-leased-restart");

    await expect(harness.requireCoordination().coordinator.dispatch(request)).rejects.toThrowError(
      "injected_crash:after_dispatch_persistence"
    );
    const operation = harness.requireCoordination().operations.findByCallerIdentity({
      ...harness.locator,
      blockRef: request.blockRef,
      idempotencyKey: request.idempotencyKey
    });
    expect(operation).toMatchObject({
      state: "reserved",
      endpointSelection: { authority: { kind: "owner_canvas" } },
      envelopeDigest: expect.any(String)
    });
    const originalDigest = operation?.envelopeDigest;

    const restarted = await harness.start();
    expect(restarted.operations.getRequired(operation!.id)).toMatchObject({
      state: "activated",
      envelopeDigest: originalDigest
    });
    const delivery = restarted.mailbox.listAfter(hostId, 0)[0];
    expect(delivery?.command).toMatchObject({
      type: "execute_block",
      envelopeDigest: originalDigest,
      envelope: {
        runtimeMaterialization: {
          sourceRevision: expect.any(String),
          graphFingerprint: expect.any(String)
        }
      }
    });
    expect(delivery?.command.envelope).not.toHaveProperty("ownerPackageLocator");
  });

  it("preserves a pre-upgrade leased Owner envelope and digest", async () => {
    const harness = await OwnerCanvasRestartHarness.create();
    await harness.start(new CrashOnce("after_dispatch_persistence"));
    const hostId = harness.registerHost();
    const request = harness.request("legacy-owner-leased-restart");

    await expect(harness.requireCoordination().coordinator.dispatch(request)).rejects.toThrowError(
      "injected_crash:after_dispatch_persistence"
    );
    const operation = harness.requireCoordination().operations.findByCallerIdentity({
      ...harness.locator,
      blockRef: request.blockRef,
      idempotencyKey: request.idempotencyKey
    });
    expect(operation).toMatchObject({
      state: "reserved",
      endpointSelection: { authority: { kind: "owner_canvas" } },
      envelopeDigest: expect.any(String)
    });

    const database = harness.requireServer().database;
    const candidate = new SqliteRemoteOperationCandidateRepository(database).get(operation!.id);
    if (!candidate) throw new Error("legacy_owner_candidate_missing");
    const legacyCapabilities = ["acp.codex"];
    const legacyOperation = { ...operation!, requiredCapabilities: legacyCapabilities };
    const currentEnvelope = buildRemoteBlockExecutionEnvelope(
      legacyOperation,
      candidate,
      ownerPackageLocatorForRun({
        projectId: harness.locator.projectId,
        canvasId: harness.locator.canvasId
      })
    );
    if (currentEnvelope.protocolVersion !== 2) {
      throw new Error("current_execution_envelope_v2_expected");
    }
    const { runtimeAuthority: _runtimeAuthority, ...commonEnvelope } = currentEnvelope;
    const legacyEnvelope = executionEnvelopeSchema.parse({
      ...commonEnvelope,
      protocolVersion: 1
    });
    const legacyDigest = hashExecutionEnvelope(legacyEnvelope);
    database
      .prepare(
        "UPDATE remote_operations SET required_capabilities_json=?,envelope_digest=? WHERE id=?"
      )
      .run(JSON.stringify(legacyCapabilities), legacyDigest, operation!.id);
    database
      .prepare("UPDATE dispatches SET required_capabilities_json=? WHERE id=?")
      .run(JSON.stringify(legacyCapabilities), operation!.dispatchId);
    database
      .prepare(
        "UPDATE dispatch_execution_envelopes SET envelope_digest=?,canonical_json=? WHERE dispatch_id=?"
      )
      .run(legacyDigest, canonicalizeExecutionEnvelope(legacyEnvelope), operation!.dispatchId);
    harness.reportHostOnline(hostId, false);

    const restarted = await harness.start();
    expect(restarted.operations.getRequired(operation!.id)).toMatchObject({
      state: "activated",
      envelopeDigest: legacyDigest,
      requiredCapabilities: ["acp.codex"]
    });
    const delivery = restarted.mailbox.listAfter(hostId, 0)[0];
    expect(delivery?.command).toMatchObject({
      type: "execute_block",
      envelopeDigest: legacyDigest,
      envelope: {
        ownerPackageLocator: {
          strategy: "host_relative_package",
          relativePackagePath: expect.any(String)
        }
      }
    });
    expect(delivery?.command.envelope.ownerPackageLocator).toEqual(
      legacyEnvelope.ownerPackageLocator
    );
    expect(delivery?.command.envelope).not.toHaveProperty("runtimeMaterialization");
    expect(delivery?.command.envelope).not.toHaveProperty("runtimeAuthority");
    expect(delivery?.command.envelope.protocolVersion).toBe(1);
  });
});
