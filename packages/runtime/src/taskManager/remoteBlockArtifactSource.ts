import { dirname } from "node:path";
import {
  OUTPUT_MAX_ARTIFACT_BYTES,
  blockRefSchema,
  dispatchInputArtifactSchema,
  executionEnvelopeFieldSchemas
} from "@planweave-ai/agent-host-protocol/browser";
import { z } from "zod";
import { withCanvasLock } from "../fs/withCanvasLock.js";
import { loadPackage } from "../package/loadPackage.js";
import type { PackageWorkspaceRef } from "../types.js";
import { remoteBlockSourceSnapshotWithArtifacts } from "./remoteBlockSourceSnapshot.js";
import { loadRuntime } from "./runtimeContext.js";

export const remoteBlockArtifactReadInputSchema = z
  .object({
    targetBlockRef: blockRefSchema,
    sourceRevision: executionEnvelopeFieldSchemas.sourceRevision,
    artifactRef: dispatchInputArtifactSchema.shape.artifactRef,
    logicalName: dispatchInputArtifactSchema.shape.logicalName,
    mediaType: dispatchInputArtifactSchema.shape.mediaType.unwrap()
  })
  .strict();

export type RemoteBlockArtifactReadInput = z.infer<typeof remoteBlockArtifactReadInputSchema>;

export const verifiedRemoteBlockArtifactSchema = dispatchInputArtifactSchema
  .extend({
    mediaType: dispatchInputArtifactSchema.shape.mediaType.unwrap(),
    bytes: z
      .instanceof(Uint8Array)
      .refine((bytes) => bytes.byteLength > 0, "artifact bytes must not be empty")
      .refine(
        (bytes) => bytes.byteLength <= OUTPUT_MAX_ARTIFACT_BYTES,
        `artifact bytes must not exceed ${OUTPUT_MAX_ARTIFACT_BYTES} bytes`
      )
  })
  .strict();

export type VerifiedRemoteBlockArtifact = z.infer<typeof verifiedRemoteBlockArtifactSchema>;

export interface RemoteBlockArtifactSource {
  read(input: RemoteBlockArtifactReadInput): Promise<VerifiedRemoteBlockArtifact>;
}

export function createRemoteBlockArtifactSource(options: {
  projectRoot: PackageWorkspaceRef;
}): RemoteBlockArtifactSource {
  return {
    read: async (rawInput) => {
      const input = remoteBlockArtifactReadInputSchema.parse(rawInput);
      const { workspace } = await loadPackage(options.projectRoot);
      return withCanvasLock(dirname(workspace.stateFile), async () => {
        const context = await loadRuntime({ projectRoot: options.projectRoot });
        const { snapshot, materializedInputArtifacts } =
          await remoteBlockSourceSnapshotWithArtifacts(context, input.targetBlockRef);
        if (snapshot.sourceRevision !== input.sourceRevision) {
          throw new Error("remote_block_artifact_source_revision_mismatch");
        }
        const declared = snapshot.inputArtifacts.find(
          (artifact) =>
            artifact.artifactRef === input.artifactRef &&
            artifact.logicalName === input.logicalName &&
            artifact.mediaType === input.mediaType
        );
        if (!declared) throw new Error("remote_block_artifact_not_declared");
        const materialized = materializedInputArtifacts.find(
          (artifact) =>
            artifact.artifactRef === declared.artifactRef &&
            artifact.logicalName === declared.logicalName &&
            artifact.mediaType === declared.mediaType
        );
        if (!materialized) throw new Error("remote_block_artifact_not_verified");
        return verifiedRemoteBlockArtifactSchema.parse({
          artifactRef: materialized.artifactRef,
          logicalName: materialized.logicalName,
          mediaType: materialized.mediaType,
          bytes: new Uint8Array(materialized.bytes)
        });
      });
    }
  };
}
