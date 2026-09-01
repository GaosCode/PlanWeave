import { createHash } from "node:crypto";
import { z } from "zod";
import { artifactMediaTypeSchema } from "@planweave-ai/agent-host-protocol";
import type {
  AgentHostArtifactDownload,
  AgentHostArtifactInput,
  AgentHostArtifactTransfer,
  AgentHostExecuteCommand
} from "../execution/agentHostExecutor.js";
import { parseAgentHostArtifactRef, type ArtifactRef } from "../protocol.js";

export type HttpArtifactTransferOptions = {
  baseUrl: URL;
  hostId: string;
  token: string;
  request?: typeof fetch;
};

export type AgentHostArtifactEvidenceRecorder = (input: {
  operationId: string;
  direction: "input" | "report" | "output";
  artifactRef: ArtifactRef;
  sha256: string;
  sizeBytes: number;
  mediaType: string;
}) => void;

const MAX_INPUT_ARTIFACT_BYTES = 64 * 1_024 * 1_024;

const uploadResponseSchema = z.object({ ref: z.unknown() });
const artifactOperationKeySchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);

export class HttpArtifactClient {
  constructor(private readonly options: HttpArtifactTransferOptions) {}

  forExecution(
    command: AgentHostExecuteCommand,
    recordEvidence: AgentHostArtifactEvidenceRecorder,
    signal: AbortSignal
  ): AgentHostArtifactTransfer {
    return {
      download: (input) => this.download(command, input, recordEvidence, signal),
      upload: (input) => this.upload(command, input, recordEvidence, signal)
    };
  }

  private artifactUrl(command: AgentHostExecuteCommand, sha256: string): URL {
    const url = new URL(this.options.baseUrl.origin);
    url.pathname =
      `/agent-hosts/${encodeURIComponent(this.options.hostId)}` +
      `/dispatches/${encodeURIComponent(command.dispatchId)}` +
      `/leases/${encodeURIComponent(command.leaseId)}` +
      `/attempts/${encodeURIComponent(command.executionAttemptId)}/artifacts/${sha256}`;
    if (
      command.envelope.protocolVersion === 1 ||
      command.envelope.runtimeAuthority === "workspace_canvas"
    ) {
      url.searchParams.set("workspaceId", command.envelope.workspaceId);
    }
    return url;
  }

  private async download(
    command: AgentHostExecuteCommand,
    input: AgentHostArtifactDownload,
    recordEvidence: AgentHostArtifactEvidenceRecorder,
    signal: AbortSignal
  ) {
    const sha256 = input.artifactRef.slice("artifact:sha256:".length);
    const operationId = `artifact-download:${createHash("sha256")
      .update(
        JSON.stringify([
          command.dispatchId,
          command.leaseId,
          command.executionAttemptId,
          input.logicalName,
          input.artifactRef
        ])
      )
      .digest("hex")}`;
    let response: Response;
    try {
      response = await (this.options.request ?? fetch)(this.artifactUrl(command, sha256), {
        headers: { Authorization: `Bearer ${this.options.token}` },
        signal
      });
    } catch (error) {
      throw new Error("artifact_download_failed:transport", { cause: error });
    }
    if (!response.ok) throw new Error(`artifact_download_failed:${response.status}`);
    const sizeBytes = Number(response.headers.get("content-length"));
    if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0 || sizeBytes > MAX_INPUT_ARTIFACT_BYTES) {
      await response.body?.cancel();
      throw new Error("artifact_download_size_invalid");
    }
    const mediaType = artifactMediaTypeSchema.parse(response.headers.get("content-type"));
    if (input.mediaType && mediaType !== input.mediaType) {
      await response.body?.cancel();
      throw new Error("artifact_download_media_type_mismatch");
    }
    let bytes: Buffer;
    try {
      bytes = Buffer.from(await response.arrayBuffer());
    } catch (error) {
      throw new Error("artifact_download_failed:transport", { cause: error });
    }
    if (bytes.byteLength !== sizeBytes) throw new Error("artifact_download_size_mismatch");
    const actualSha256 = createHash("sha256").update(bytes).digest("hex");
    if (actualSha256 !== sha256) throw new Error("artifact_download_hash_mismatch");
    recordEvidence({
      operationId,
      direction: "input",
      artifactRef: input.artifactRef,
      sha256,
      sizeBytes,
      mediaType
    });
    return { bytes, mediaType };
  }

  private async upload(
    command: AgentHostExecuteCommand,
    input: AgentHostArtifactInput,
    recordEvidence: AgentHostArtifactEvidenceRecorder,
    signal: AbortSignal
  ): Promise<ArtifactRef> {
    const bytes = Buffer.from(input.bytes);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const operationKey = artifactOperationKeySchema.parse(input.operationKey);
    const mediaType = artifactMediaTypeSchema.parse(input.mediaType);
    const operationId = `artifact-upload:${createHash("sha256")
      .update(
        JSON.stringify([
          this.options.hostId,
          command.dispatchId,
          command.leaseId,
          command.executionAttemptId,
          input.purpose,
          operationKey,
          sha256,
          bytes.byteLength,
          mediaType
        ])
      )
      .digest("hex")}`;
    const url = this.artifactUrl(command, sha256);

    let response: Response | undefined;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        response = await (this.options.request ?? fetch)(url, {
          method: "PUT",
          headers: {
            Authorization: `Bearer ${this.options.token}`,
            "content-type": mediaType,
            "content-length": String(bytes.byteLength),
            "x-planweave-artifact-operation-id": operationId,
            "x-planweave-artifact-purpose": input.purpose
          },
          body: bytes,
          signal
        });
        break;
      } catch (error) {
        if (attempt === 1) {
          throw new Error("artifact_upload_failed:transport", { cause: error });
        }
      }
    }
    if (!response) throw new Error("artifact_upload_failed:transport");
    if (!response.ok) throw new Error(`artifact_upload_failed:${response.status}`);
    const ref = parseAgentHostArtifactRef(uploadResponseSchema.parse(await response.json()).ref);
    if (ref !== `artifact:sha256:${sha256}`) throw new Error("artifact_upload_ref_mismatch");
    recordEvidence({
      operationId,
      direction: input.purpose,
      artifactRef: ref,
      sha256,
      sizeBytes: bytes.byteLength,
      mediaType
    });
    return ref;
  }
}
