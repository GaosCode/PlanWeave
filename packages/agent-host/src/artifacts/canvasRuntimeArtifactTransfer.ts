import { createHash } from "node:crypto";
import {
  canvasRuntimeArtifactMetadataSchema,
  canvasRuntimeArtifactTransferDescriptorSchema,
  type CanvasRuntimeArtifactTransferDescriptor
} from "@planweave-ai/agent-host-protocol";

export interface CanvasRuntimeArtifactTransferPort {
  updateCredentialToken(token: string): void;
  synchronizeServerTime(serverTime: string, localNow?: Date): void;
  download(
    descriptor: CanvasRuntimeArtifactTransferDescriptor,
    signal: AbortSignal
  ): Promise<Uint8Array>;
  upload(
    descriptor: CanvasRuntimeArtifactTransferDescriptor,
    bytes: Uint8Array,
    mediaType: string,
    signal: AbortSignal
  ): Promise<void>;
}

export type CanvasRuntimeArtifactTransferOptions = {
  baseUrl: URL;
  hostId: string;
  token: string;
  request?: typeof fetch;
  now?: () => Date;
};

export class CanvasRuntimeArtifactTransfer implements CanvasRuntimeArtifactTransferPort {
  private token: string;
  private readonly now: () => Date;
  private serverClockOffsetMs = 0;

  constructor(private readonly options: CanvasRuntimeArtifactTransferOptions) {
    this.token = options.token;
    this.now = options.now ?? (() => new Date());
  }

  updateCredentialToken(token: string): void {
    if (token.length === 0) throw new Error("host_credential_invalid");
    this.token = token;
  }

  synchronizeServerTime(serverTime: string, localNow = this.now()): void {
    const serverTimeMs = Date.parse(serverTime);
    if (!Number.isFinite(serverTimeMs)) throw new Error("server_time_invalid");
    this.serverClockOffsetMs = serverTimeMs - localNow.getTime();
  }

  private url(descriptor: CanvasRuntimeArtifactTransferDescriptor): URL {
    const url = new URL(this.options.baseUrl.origin);
    url.pathname =
      `/agent-hosts/${encodeURIComponent(this.options.hostId)}` +
      `/canvas-runtime/leases/${encodeURIComponent(descriptor.runtimeLeaseId)}` +
      `/artifacts/${descriptor.sha256}`;
    return url;
  }

  async download(
    rawDescriptor: CanvasRuntimeArtifactTransferDescriptor,
    signal: AbortSignal
  ): Promise<Uint8Array> {
    const descriptor = canvasRuntimeArtifactTransferDescriptorSchema.parse(rawDescriptor);
    if (descriptor.direction !== "download") throw new Error("runtime_artifact_direction_invalid");
    this.assertOpen(descriptor);
    const response = await this.fetch(descriptor, { signal });
    if (!response.ok) throw new Error(`runtime_artifact_download_failed_${response.status}`);
    const contentLength = Number(response.headers.get("content-length"));
    if (contentLength !== descriptor.sizeBytes) {
      await response.body?.cancel();
      throw new Error("runtime_artifact_size_mismatch");
    }
    if (response.headers.get("content-type") !== descriptor.mediaType) {
      await response.body?.cancel();
      throw new Error("runtime_artifact_media_type_mismatch");
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength !== descriptor.sizeBytes)
      throw new Error("runtime_artifact_size_mismatch");
    if (createHash("sha256").update(bytes).digest("hex") !== descriptor.sha256) {
      throw new Error("runtime_artifact_digest_mismatch");
    }
    return bytes;
  }

  async upload(
    rawDescriptor: CanvasRuntimeArtifactTransferDescriptor,
    bytes: Uint8Array,
    mediaType: string,
    signal: AbortSignal
  ): Promise<void> {
    const descriptor = canvasRuntimeArtifactTransferDescriptorSchema.parse(rawDescriptor);
    if (descriptor.direction !== "upload") throw new Error("runtime_artifact_direction_invalid");
    this.assertOpen(descriptor);
    if (mediaType !== descriptor.mediaType) throw new Error("runtime_artifact_media_type_mismatch");
    if (bytes.byteLength < 1 || bytes.byteLength > descriptor.maxSizeBytes) {
      throw new Error("runtime_artifact_size_mismatch");
    }
    if (createHash("sha256").update(bytes).digest("hex") !== descriptor.sha256) {
      throw new Error("runtime_artifact_digest_mismatch");
    }
    const response = await this.fetch(descriptor, {
      method: "PUT",
      headers: {
        "content-type": descriptor.mediaType,
        "content-length": String(bytes.byteLength)
      },
      body: Buffer.from(bytes),
      signal
    });
    if (!response.ok) throw new Error(`runtime_artifact_upload_failed_${response.status}`);
    const metadata = canvasRuntimeArtifactMetadataSchema.parse(await response.json());
    if (
      metadata.artifactRef !== descriptor.artifactRef ||
      metadata.sha256 !== descriptor.sha256 ||
      metadata.sizeBytes !== bytes.byteLength ||
      metadata.mediaType !== descriptor.mediaType
    ) {
      throw new Error("runtime_artifact_upload_response_mismatch");
    }
  }

  private fetch(
    descriptor: CanvasRuntimeArtifactTransferDescriptor,
    init: RequestInit
  ): Promise<Response> {
    return (this.options.request ?? fetch)(this.url(descriptor), {
      ...init,
      headers: {
        Authorization: `Bearer ${this.token}`,
        "x-planweave-runtime-artifact-grant-id": descriptor.grantId,
        ...init.headers
      }
    });
  }

  private assertOpen(descriptor: CanvasRuntimeArtifactTransferDescriptor): void {
    if (Date.parse(descriptor.expiresAt) <= this.now().getTime() + this.serverClockOffsetMs) {
      throw new Error("runtime_artifact_grant_expired");
    }
  }
}
