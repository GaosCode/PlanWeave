import type { IncomingMessage, Server as HttpServer, ServerResponse } from "node:http";
import { z } from "zod";
import { artifactMediaTypeSchema } from "./artifactMediaType.js";
import { ArtifactAuthorizationRepository } from "./artifactAuthorization.js";
import { ArtifactStore } from "./artifacts.js";
import { DispatchService } from "./dispatches.js";
import { AgentHostRepository } from "./hosts.js";
import { authenticateAgentHostRequest } from "./hostTransportAuth.js";
import type { TransportAdmissionPolicy } from "./insecureTransport.js";

export type ArtifactHttpOptions = {
  hosts: AgentHostRepository;
  dispatches: DispatchService;
  authorization: ArtifactAuthorizationRepository;
  artifacts: ArtifactStore;
  transportAdmission: TransportAdmissionPolicy;
};

export type ArtifactHttpServer = {
  close(): void;
};

type ArtifactRoute = {
  hostId: string;
  dispatchId: string;
  leaseId: string;
  executionAttemptId: string;
  sha256: string;
};

function route(url: string | undefined): ArtifactRoute | undefined {
  if (!url) return undefined;
  const pathname = url.split("?", 1)[0];
  const match =
    /^\/agent-hosts\/([^/]+)\/dispatches\/([^/]+)\/leases\/([^/]+)\/attempts\/([^/]+)\/artifacts\/([a-f0-9]{64})$/.exec(
      pathname
    );
  if (!match) return undefined;
  try {
    return {
      hostId: decodeURIComponent(match[1]),
      dispatchId: decodeURIComponent(match[2]),
      leaseId: decodeURIComponent(match[3]),
      executionAttemptId: decodeURIComponent(match[4]),
      sha256: match[5]
    };
  } catch {
    return undefined;
  }
}

function isArtifactRouteCandidate(url: string | undefined): boolean {
  return /^\/agent-hosts\/[^/]+\/dispatches\//.test(url ?? "");
}

function respond(response: ServerResponse, status: number, body: Record<string, unknown>): void {
  const bytes = Buffer.from(JSON.stringify(body));
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": bytes.byteLength
  });
  response.end(bytes);
}

function requestHeader(value: string | string[] | undefined, name: string): string {
  if (Array.isArray(value) || !value) throw new Error(`${name}_header_required`);
  return value;
}

function forbidden(response: ServerResponse): void {
  respond(response, 403, { error: "artifact_scope_forbidden" });
}

type SafeArtifactHttpError = {
  status: number;
  code:
    | "artifact_scope_forbidden"
    | "artifact_too_large"
    | "artifact_request_invalid"
    | "artifact_integrity_mismatch"
    | "artifact_output_limit_exceeded"
    | "artifact_pending_operation_limit_exceeded"
    | "artifact_request_failed";
};

const safeDomainResponses = {
  artifact_dispatch_not_found: { status: 403, code: "artifact_scope_forbidden" },
  artifact_dispatch_status_invalid: { status: 403, code: "artifact_scope_forbidden" },
  artifact_grant_expired: { status: 403, code: "artifact_scope_forbidden" },
  artifact_grant_host_revoked: { status: 403, code: "artifact_scope_forbidden" },
  artifact_grant_identity_conflict: { status: 403, code: "artifact_scope_forbidden" },
  artifact_grant_lease_expired: { status: 403, code: "artifact_scope_forbidden" },
  artifact_grant_not_found: { status: 403, code: "artifact_scope_forbidden" },
  artifact_grant_not_writable: { status: 403, code: "artifact_scope_forbidden" },
  artifact_grant_revoked: { status: 403, code: "artifact_scope_forbidden" },
  artifact_grant_scope_mismatch: { status: 403, code: "artifact_scope_forbidden" },
  artifact_input_grant_not_found: { status: 403, code: "artifact_scope_forbidden" },
  artifact_operation_id_header_required: { status: 400, code: "artifact_request_invalid" },
  artifact_purpose_header_required: { status: 400, code: "artifact_request_invalid" },
  content_length_header_required: { status: 400, code: "artifact_request_invalid" },
  content_type_header_required: { status: 400, code: "artifact_request_invalid" },
  invalid_artifact_purpose: { status: 400, code: "artifact_request_invalid" },
  invalid_content_length: { status: 400, code: "artifact_request_invalid" },
  artifact_digest_mismatch: { status: 400, code: "artifact_integrity_mismatch" },
  artifact_size_mismatch: { status: 400, code: "artifact_integrity_mismatch" },
  artifact_upload_provenance_mismatch: { status: 400, code: "artifact_integrity_mismatch" },
  artifact_size_out_of_range: { status: 413, code: "artifact_too_large" },
  artifact_grant_size_exceeds_output_contract: { status: 413, code: "artifact_too_large" },
  artifact_grant_count_exceeds_output_contract: {
    status: 409,
    code: "artifact_output_limit_exceeded"
  },
  artifact_pending_operation_limit_exceeded: {
    status: 429,
    code: "artifact_pending_operation_limit_exceeded"
  }
} as const satisfies Record<string, SafeArtifactHttpError>;

type SafeDomainErrorCode = keyof typeof safeDomainResponses;

function isSafeDomainErrorCode(value: string): value is SafeDomainErrorCode {
  return Object.hasOwn(safeDomainResponses, value);
}

function safeArtifactHttpError(error: unknown): SafeArtifactHttpError {
  if (error instanceof z.ZodError) return { status: 400, code: "artifact_request_invalid" };
  if (!(error instanceof Error)) return { status: 500, code: "artifact_request_failed" };
  if (isSafeDomainErrorCode(error.message)) return safeDomainResponses[error.message];
  return { status: 500, code: "artifact_request_failed" };
}

export async function handleAgentHostArtifactRequest(
  request: IncomingMessage,
  response: ServerResponse,
  options: ArtifactHttpOptions
): Promise<boolean> {
  const matched = route(request.url);
  if (!matched || (request.method !== "PUT" && request.method !== "GET")) {
    if (isArtifactRouteCandidate(request.url)) {
      respond(response, 404, { error: "artifact_route_not_found" });
      return true;
    }
    return false;
  }
  const dispatch = options.dispatches.get(matched.dispatchId);
  const workspaceId = dispatch?.workspaceId;
  const authentication = authenticateAgentHostRequest(
    request,
    options.hosts,
    matched.hostId,
    options.transportAdmission,
    workspaceId
  );
  if (!authentication.ok) {
    if (authentication.status === 403) {
      forbidden(response);
      return true;
    }
    respond(response, authentication.status, { error: authentication.message });
    return true;
  }

  if (!dispatch) {
    forbidden(response);
    request.resume();
    return true;
  }
  const scope = {
    workspaceId: dispatch.workspaceId,
    projectId: dispatch.projectId,
    hostId: authentication.host.id,
    dispatchId: matched.dispatchId,
    leaseId: matched.leaseId,
    executionAttemptId: matched.executionAttemptId
  };
  const ref = `artifact:sha256:${matched.sha256}`;

  try {
    if (request.method === "GET") {
      options.authorization.authorizeInputRead({ ...scope, artifactRef: ref });
      const { metadata, stream } = await options.artifacts.openRead(ref);
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

    const contentLengthText = requestHeader(request.headers["content-length"], "content_length");
    const contentLength = Number(contentLengthText);
    if (!/^\d+$/.test(contentLengthText) || !Number.isSafeInteger(contentLength)) {
      throw new Error("invalid_content_length");
    }
    if (contentLength > options.artifacts.maxArtifactBytes) {
      respond(response, 413, { error: "artifact_too_large" });
      request.resume();
      return true;
    }
    const mediaType = artifactMediaTypeSchema.parse(
      requestHeader(request.headers["content-type"], "content_type")
    );
    const operationId = requestHeader(
      request.headers["x-planweave-artifact-operation-id"],
      "artifact_operation_id"
    );
    const purpose = requestHeader(
      request.headers["x-planweave-artifact-purpose"],
      "artifact_purpose"
    );
    if (purpose !== "report" && purpose !== "output") {
      throw new Error("invalid_artifact_purpose");
    }

    const grant = options.authorization.createOutputGrant({
      ...scope,
      operationId,
      permission: purpose === "report" ? "report_write" : "output_write",
      expectedSha256: matched.sha256,
      expectedSizeBytes: contentLength,
      expectedMediaType: mediaType
    });
    const artifact = await options.artifacts.put({
      expectedSha256: matched.sha256,
      expectedSizeBytes: contentLength,
      mediaType,
      chunks: request
    });
    options.authorization.acceptOutputUpload({ ...scope, grantId: grant.grantId }, artifact);
    respond(response, 201, artifact);
    return true;
  } catch (error) {
    const safe = safeArtifactHttpError(error);
    respond(response, safe.status, { error: safe.code });
    request.resume();
    return true;
  }
}

export function attachAgentHostArtifactHttp(
  server: HttpServer,
  options: ArtifactHttpOptions
): ArtifactHttpServer {
  const listener = (request: IncomingMessage, response: ServerResponse) => {
    void handleAgentHostArtifactRequest(request, response, options).catch(() => {
      if (!response.headersSent) respond(response, 500, { error: "artifact_request_failed" });
      else response.destroy();
    });
  };
  server.on("request", listener);
  return { close: () => server.off("request", listener) };
}
