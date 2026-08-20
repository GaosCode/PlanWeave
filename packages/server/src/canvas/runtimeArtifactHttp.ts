import type { IncomingMessage, ServerResponse } from "node:http";
import { canvasRuntimeArtifactMetadataSchema } from "@planweave-ai/agent-host-protocol";
import { z } from "zod";
import type { ArtifactStore } from "../artifacts.js";
import { artifactMediaTypeSchema } from "../artifactMediaType.js";
import type { AgentHostRepository } from "../hosts.js";
import { authenticateAgentHostRequest } from "../hostTransportAuth.js";
import type { TransportAdmissionPolicy } from "../insecureTransport.js";
import type { RuntimeArtifactGrantRepository } from "./runtimeArtifactGrantRepository.js";

type RuntimeArtifactRoute = {
  hostId: string;
  runtimeLeaseId: string;
  sha256: string;
};

export type RuntimeArtifactHttpOptions = {
  hosts: AgentHostRepository;
  grants: RuntimeArtifactGrantRepository;
  artifacts: ArtifactStore;
  transportAdmission: TransportAdmissionPolicy;
};

function route(url: string | undefined): RuntimeArtifactRoute | undefined {
  const pathname = url?.split("?", 1)[0];
  if (!pathname) return undefined;
  const match =
    /^\/agent-hosts\/([^/]+)\/canvas-runtime\/leases\/([^/]+)\/artifacts\/([a-f0-9]{64})$/.exec(
      pathname
    );
  if (!match) return undefined;
  try {
    return {
      hostId: decodeURIComponent(match[1]),
      runtimeLeaseId: decodeURIComponent(match[2]),
      sha256: match[3]
    };
  } catch {
    return undefined;
  }
}

function candidate(url: string | undefined): boolean {
  return /^\/agent-hosts\/[^/]+\/canvas-runtime\//.test(url ?? "");
}

function respond(response: ServerResponse, status: number, error: string): void {
  const bytes = Buffer.from(JSON.stringify({ error }));
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": bytes.byteLength
  });
  response.end(bytes);
}

function header(value: string | string[] | undefined): string {
  if (!value || Array.isArray(value)) throw new Error("runtime_artifact_request_invalid");
  return value;
}

function safeError(error: unknown): { status: number; code: string } {
  if (error instanceof z.ZodError) return { status: 400, code: "runtime_artifact_request_invalid" };
  if (!(error instanceof Error)) return { status: 500, code: "runtime_artifact_request_failed" };
  if (
    error.message === "runtime_artifact_scope_forbidden" ||
    error.message === "runtime_artifact_grant_not_found"
  ) {
    return { status: 403, code: "runtime_artifact_scope_forbidden" };
  }
  if (
    error.message === "runtime_artifact_upload_evidence_mismatch" ||
    error.message === "runtime_artifact_grant_identity_conflict" ||
    error.message === "artifact_digest_mismatch" ||
    error.message === "artifact_size_mismatch"
  ) {
    return { status: 409, code: "runtime_artifact_integrity_mismatch" };
  }
  if (error.message === "artifact_size_out_of_range") {
    return { status: 413, code: "runtime_artifact_too_large" };
  }
  return { status: 500, code: "runtime_artifact_request_failed" };
}

export async function handleCanvasRuntimeArtifactRequest(
  request: IncomingMessage,
  response: ServerResponse,
  options: RuntimeArtifactHttpOptions
): Promise<boolean> {
  const matched = route(request.url);
  if (!matched || (request.method !== "GET" && request.method !== "PUT")) {
    if (candidate(request.url)) {
      respond(response, 404, "runtime_artifact_route_not_found");
      return true;
    }
    return false;
  }
  const lease = options.grants.lease(matched.runtimeLeaseId);
  const authentication = authenticateAgentHostRequest(
    request,
    options.hosts,
    matched.hostId,
    options.transportAdmission,
    lease?.workspaceId
  );
  if (!authentication.ok) {
    respond(
      response,
      authentication.status === 403 ? 403 : authentication.status,
      authentication.status === 403 ? "runtime_artifact_scope_forbidden" : authentication.message
    );
    request.resume();
    return true;
  }
  if (!lease) {
    respond(response, 403, "runtime_artifact_scope_forbidden");
    request.resume();
    return true;
  }
  try {
    const grantId = header(request.headers["x-planweave-runtime-artifact-grant-id"]);
    if (request.method === "GET") {
      const grant = options.grants.authorizeDownload({ ...matched, grantId });
      const { metadata, stream } = await options.artifacts.openRead(grant.artifactRef);
      if (metadata.sizeBytes !== grant.sizeBytes || metadata.mediaType !== grant.mediaType) {
        throw new Error("runtime_artifact_upload_evidence_mismatch");
      }
      response.writeHead(200, {
        "content-type": metadata.mediaType,
        "content-length": metadata.sizeBytes,
        etag: `"sha256:${metadata.sha256}"`,
        "cache-control": "private, immutable"
      });
      stream.on("error", () => response.destroy());
      stream.pipe(response);
      return true;
    }
    const contentLengthText = header(request.headers["content-length"]);
    const contentLength = Number(contentLengthText);
    if (!/^\d+$/.test(contentLengthText) || !Number.isSafeInteger(contentLength)) {
      throw new Error("runtime_artifact_request_invalid");
    }
    const mediaType = artifactMediaTypeSchema.parse(header(request.headers["content-type"]));
    options.grants.authorizeUpload({
      ...matched,
      grantId,
      sizeBytes: contentLength,
      mediaType
    });
    const artifact = await options.artifacts.put({
      expectedSha256: matched.sha256,
      expectedSizeBytes: contentLength,
      mediaType,
      chunks: request
    });
    options.grants.acceptUpload({ ...matched, grantId }, artifact);
    const bytes = Buffer.from(
      JSON.stringify(
        canvasRuntimeArtifactMetadataSchema.parse({
          artifactRef: artifact.ref,
          sha256: artifact.sha256,
          sizeBytes: artifact.sizeBytes,
          mediaType: artifact.mediaType
        })
      )
    );
    response.writeHead(201, {
      "content-type": "application/json; charset=utf-8",
      "content-length": bytes.byteLength
    });
    response.end(bytes);
    return true;
  } catch (error) {
    const safe = safeError(error);
    respond(response, safe.status, safe.code);
    request.resume();
    return true;
  }
}
