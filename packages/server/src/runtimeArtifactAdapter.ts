import { createHash } from "node:crypto";
import {
  remoteBlockDispatchCandidateSchema,
  verifiedRemoteBlockArtifactSchema,
  type RemoteBlockArtifactSource,
  type RemoteBlockDispatchCandidate
} from "@planweave-ai/runtime";
import { ArtifactStore } from "./artifacts.js";
import type {
  RemoteArtifactContentPort,
  RemoteInputArtifactPort
} from "./remoteBlockCoordinatorPorts.js";

function digestFromRef(ref: string): string {
  return ref.slice("artifact:sha256:".length);
}

export class RuntimeInputArtifactMaterializer implements RemoteInputArtifactPort {
  constructor(private readonly artifacts: ArtifactStore) {}

  async materialize(
    rawCandidate: RemoteBlockDispatchCandidate,
    source: RemoteBlockArtifactSource
  ): Promise<void> {
    const candidate = remoteBlockDispatchCandidateSchema.parse(rawCandidate);
    for (const declared of candidate.inputArtifacts) {
      if (!declared.mediaType) throw new Error("remote_input_artifact_media_type_required");
      const artifact = verifiedRemoteBlockArtifactSchema.parse(
        await source.read({
          targetBlockRef: candidate.blockRef,
          sourceRevision: candidate.sourceRevision,
          artifactRef: declared.artifactRef,
          logicalName: declared.logicalName,
          mediaType: declared.mediaType
        })
      );
      if (
        artifact.artifactRef !== declared.artifactRef ||
        artifact.logicalName !== declared.logicalName ||
        artifact.mediaType !== declared.mediaType
      ) {
        throw new Error("remote_input_artifact_identity_mismatch");
      }
      const digest = createHash("sha256").update(artifact.bytes).digest("hex");
      if (digest !== digestFromRef(declared.artifactRef)) {
        throw new Error("remote_input_artifact_digest_mismatch");
      }
      const stored = await this.artifacts.put({
        expectedSha256: digest,
        expectedSizeBytes: artifact.bytes.byteLength,
        mediaType: artifact.mediaType,
        chunks: (async function* () {
          yield artifact.bytes;
        })()
      });
      if (stored.ref !== declared.artifactRef || stored.mediaType !== declared.mediaType) {
        throw new Error("remote_input_artifact_store_conflict");
      }
    }
  }
}

export class ArtifactStoreRemoteContent implements RemoteArtifactContentPort {
  constructor(private readonly artifacts: ArtifactStore) {}

  async readReport(artifactRef: string): Promise<Uint8Array> {
    return new Uint8Array(await this.artifacts.read(artifactRef));
  }
}
