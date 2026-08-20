import type { IncomingMessage, ServerResponse } from "node:http";
import { handleAccessHttpRequest } from "./accessHttp.js";
import { handleAgentEndpointHttpRequest } from "./agentEndpointHttp.js";
import type { AgentEndpointCatalog } from "./agentEndpointCatalog.js";
import { handleAgentHostArtifactRequest } from "./artifactHttp.js";
import { handleCanvasRuntimeArtifactRequest } from "./canvas/runtimeArtifactHttp.js";
import type { RuntimeArtifactGrantRepository } from "./canvas/runtimeArtifactGrantRepository.js";
import type { ArtifactAuthorizationRepository } from "./artifactAuthorization.js";
import type { ArtifactStore } from "./artifacts.js";
import { handleCommentAttachmentHttpRequest } from "./attachments/index.js";
import type { CommentAttachmentService } from "./attachments/service.js";
import {
  handleCanvasCommandHttpRequest,
  handleContentVersionHttpRequest,
  type CanvasCommandService,
  type CanvasRuntimeAvailabilityService,
  type ContentVersionRepository,
  type ContentVersionService
} from "./canvas/index.js";
import { handleCommentActivityHttpRequest } from "./comments/index.js";
import type { CommentService } from "./comments/service.js";
import type { DispatchService } from "./dispatches.js";
import { handleHostEnrollmentRequest } from "./hostEnrollmentHttp.js";
import { handleHostCredentialRenewalRequest } from "./hostCredentialRenewalHttp.js";
import type { HostEnrollmentService } from "./hostEnrollment.js";
import { handleHumanRemoteHttpRequest } from "./humanRemoteHttp.js";
import type { HumanRemoteControlService } from "./humanRemoteControlService.js";
import {
  handleHumanHttpRequest,
  handleWorkspaceIdentityHttpRequest,
  type HumanIdentityRepository,
  type HumanMembershipService,
  type CollaborationScopeAuthority
} from "./identity/index.js";
import { handleSetupCodeHttpRequest } from "./identity/setupCodeHttp.js";
import type { SetupCodeService } from "./identity/setupCodeService.js";
import { handleWorkspaceConnectionHttpRequest } from "./identity/workspaceConnectionHttp.js";
import type { WorkspaceIdentityRepository } from "./identity/workspaceRepository.js";
import type { TransportAdmissionPolicy } from "./insecureTransport.js";
import type { OperatorTokenRegistry } from "./operatorAuth.js";
import { handleOperatorHttpRequest, type OperatorControlPort } from "./operatorHttp.js";
import { handleRegistryHttpRequest, type RegistryHttpService } from "./registryHttp.js";
import type { ServerReadinessController } from "./readiness.js";
import type { AgentHostRepository } from "./hosts.js";
import type { ProjectAccessRepository } from "./projectAccessRepository.js";
import {
  handleWorkAssignmentHttpRequest,
  type AuthorityService,
  type WorkAssignmentService
} from "./work/index.js";

export type DistributedHttpRequestListenerOptions = {
  readiness: ServerReadinessController;
  inflightRequests: Set<Promise<void>>;
  workspaceIdentity: WorkspaceIdentityRepository;
  projectAccess: ProjectAccessRepository;
  humanIdentity: HumanIdentityRepository;
  collaborationScopeAuthority: CollaborationScopeAuthority;
  transportAdmission: TransportAdmissionPolicy;
  registryService: RegistryHttpService;
  agentEndpointCatalog: AgentEndpointCatalog;
  humanRemoteControl: HumanRemoteControlService;
  resolveAssignmentService(
    workspaceId: string,
    projectId: string
  ): WorkAssignmentService | undefined;
  acquireAuthorityService(
    workspaceId: string,
    projectId: string,
    canvasId: string
  ): { service: AuthorityService; release(): void | Promise<void> } | undefined;
  contentVersionService: ContentVersionService;
  contentVersions: ContentVersionRepository;
  canvasCommandService: CanvasCommandService;
  canvasRuntimeAvailabilityService: CanvasRuntimeAvailabilityService;
  resolveCommentService(workspaceId: string, projectId: string): CommentService | undefined;
  enrollments: HostEnrollmentService;
  setupCodes: SetupCodeService;
  authorization: OperatorTokenRegistry;
  hosts: AgentHostRepository;
  dispatches: DispatchService;
  artifactAuthorization: ArtifactAuthorizationRepository;
  artifacts: ArtifactStore;
  runtimeArtifactGrants: RuntimeArtifactGrantRepository;
  humanMembership: HumanMembershipService;
  commentAttachments: CommentAttachmentService;
  operatorControl: OperatorControlPort;
  serverVersion: string;
  maxArtifactBytes: number;
  maxWebSocketPayloadBytes: number;
  clock: () => Date;
};

function respond(response: ServerResponse, status: number, code: string): void {
  if (response.headersSent) {
    response.destroy();
    return;
  }
  const bytes = Buffer.from(JSON.stringify({ error: code }));
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": bytes.byteLength,
    "cache-control": "no-store"
  });
  response.end(bytes);
}

function requiresAdmission(request: IncomingMessage): boolean {
  if (request.method !== "POST" && request.method !== "PATCH") return false;
  const pathname = new URL(request.url ?? "/", "http://planweave.invalid").pathname;
  return (
    pathname === "/agent-hosts/enrollments/exchange" ||
    /^\/agent-hosts\/[^/]+\/credential-renewal$/.test(pathname) ||
    pathname === "/api/v1/host-enrollments" ||
    pathname === "/api/v1/setup-codes/redeem" ||
    (pathname.startsWith("/api/v1/workspaces/") && pathname.includes("/setup-codes")) ||
    pathname === "/api/v1/remote-operations" ||
    /^\/api\/v1\/remote-operations\/[^/]+\/actions$/.test(pathname) ||
    /^\/api\/v1\/remote-operations\/[^/]+\/interactions\/respond$/.test(pathname) ||
    /^\/api\/v1\/projects\/[^/]+\/human\//.test(pathname) ||
    /^\/api\/v1\/projects\/[^/]+\/assignments(\/|$)/.test(pathname) ||
    /^\/api\/v1\/projects\/[^/]+\/comments(\/|$)/.test(pathname) ||
    /^\/api\/v1\/projects\/[^/]+\/attachments(\/|$)/.test(pathname) ||
    /^\/api\/v1\/projects\/[^/]+\/canvases\/[^/]+\/content\/(initial-publish|acknowledgements)$/.test(
      pathname
    ) ||
    /^\/api\/v1\/registry\/projects\/[^/]+\/canvases\/[^/]+\/snapshots(\/|$)/.test(pathname)
  );
}

/** Own HTTP admission, route precedence, uniform fallback, and in-flight tracking. */
export function createDistributedHttpRequestListener(
  options: DistributedHttpRequestListenerOptions
): (request: IncomingMessage, response: ServerResponse) => void {
  return (request, response) => {
    const operation = (async () => {
      if (requiresAdmission(request) && options.readiness.readiness().status !== "ready") {
        request.resume();
        respond(response, 503, "server_not_accepting_mutations");
        return;
      }
      if (
        await handleWorkspaceConnectionHttpRequest(request, response, {
          workspaceIdentity: options.workspaceIdentity,
          transportAdmission: options.transportAdmission
        })
      )
        return;
      if (
        await handleAccessHttpRequest(request, response, {
          access: options.projectAccess,
          repository: options.humanIdentity,
          workspaceIdentity: options.workspaceIdentity,
          collaborationScopeAuthority: options.collaborationScopeAuthority,
          transportAdmission: options.transportAdmission
        })
      )
        return;
      if (
        await handleRegistryHttpRequest(request, response, {
          repository: options.humanIdentity,
          workspaceIdentity: options.workspaceIdentity,
          service: options.registryService,
          readiness: () => options.readiness.readiness(),
          transportAdmission: options.transportAdmission
        })
      )
        return;
      if (
        await handleAgentEndpointHttpRequest(request, response, {
          catalog: options.agentEndpointCatalog,
          repository: options.humanIdentity,
          workspaceIdentity: options.workspaceIdentity,
          collaborationScopeAuthority: options.collaborationScopeAuthority,
          transportAdmission: options.transportAdmission
        })
      )
        return;
      if (
        await handleHumanRemoteHttpRequest(request, response, {
          service: options.humanRemoteControl,
          repository: options.humanIdentity,
          workspaceIdentity: options.workspaceIdentity,
          collaborationScopeAuthority: options.collaborationScopeAuthority,
          readiness: () => options.readiness.readiness(),
          transportAdmission: options.transportAdmission
        })
      )
        return;
      if (
        await handleWorkAssignmentHttpRequest(request, response, {
          resolveService: options.resolveAssignmentService,
          acquireAuthorityService: options.acquireAuthorityService,
          repository: options.humanIdentity,
          workspaceIdentity: options.workspaceIdentity,
          access: options.projectAccess,
          collaborationScopeAuthority: options.collaborationScopeAuthority,
          transportAdmission: options.transportAdmission,
          clock: options.clock
        })
      )
        return;
      if (
        await handleContentVersionHttpRequest(request, response, {
          service: options.contentVersionService,
          contentVersions: options.contentVersions,
          repository: options.humanIdentity,
          workspaceIdentity: options.workspaceIdentity,
          collaborationScopeAuthority: options.collaborationScopeAuthority,
          transportAdmission: options.transportAdmission
        })
      )
        return;
      if (
        await handleCanvasCommandHttpRequest(request, response, {
          service: options.canvasCommandService,
          runtimeAvailabilityService: options.canvasRuntimeAvailabilityService,
          repository: options.humanIdentity,
          workspaceIdentity: options.workspaceIdentity,
          collaborationScopeAuthority: options.collaborationScopeAuthority,
          transportAdmission: options.transportAdmission,
          clock: options.clock
        })
      )
        return;
      if (
        await handleCommentActivityHttpRequest(request, response, {
          resolveService: options.resolveCommentService,
          repository: options.humanIdentity,
          workspaceIdentity: options.workspaceIdentity,
          collaborationScopeAuthority: options.collaborationScopeAuthority,
          transportAdmission: options.transportAdmission,
          clock: options.clock
        })
      )
        return;
      if (
        await handleHostCredentialRenewalRequest(request, response, {
          hosts: options.hosts,
          transportAdmission: options.transportAdmission,
          clock: options.clock
        })
      )
        return;
      if (
        await handleHostEnrollmentRequest(request, response, {
          service: options.enrollments,
          transportAdmission: options.transportAdmission
        })
      )
        return;
      if (
        await handleSetupCodeHttpRequest(request, response, {
          service: options.setupCodes,
          authorization: options.authorization,
          transportAdmission: options.transportAdmission
        })
      )
        return;
      if (
        await handleCanvasRuntimeArtifactRequest(request, response, {
          hosts: options.hosts,
          grants: options.runtimeArtifactGrants,
          artifacts: options.artifacts,
          transportAdmission: options.transportAdmission
        })
      )
        return;
      if (
        await handleAgentHostArtifactRequest(request, response, {
          hosts: options.hosts,
          dispatches: options.dispatches,
          authorization: options.artifactAuthorization,
          artifacts: options.artifacts,
          transportAdmission: options.transportAdmission
        })
      )
        return;
      if (
        await handleHumanHttpRequest(request, response, {
          service: options.humanMembership,
          repository: options.humanIdentity,
          collaborationScopeAuthority: options.collaborationScopeAuthority,
          transportAdmission: options.transportAdmission,
          clock: options.clock
        })
      )
        return;
      if (
        await handleCommentAttachmentHttpRequest(request, response, {
          service: options.commentAttachments,
          repository: options.humanIdentity,
          workspaceIdentity: options.workspaceIdentity,
          collaborationScopeAuthority: options.collaborationScopeAuthority,
          transportAdmission: options.transportAdmission,
          clock: options.clock
        })
      )
        return;
      if (
        await handleWorkspaceIdentityHttpRequest(request, response, {
          authorization: options.authorization,
          repository: options.workspaceIdentity,
          transportAdmission: options.transportAdmission
        })
      )
        return;
      if (
        await handleOperatorHttpRequest(request, response, {
          authorization: options.authorization,
          service: options.operatorControl,
          readiness: () => options.readiness.readiness(),
          serverVersion: options.serverVersion,
          limits: {
            maxArtifactBytes: options.maxArtifactBytes,
            maxWebSocketPayloadBytes: options.maxWebSocketPayloadBytes
          },
          transportAdmission: options.transportAdmission
        })
      )
        return;
      respond(response, 404, "route_not_found");
    })().catch(() => respond(response, 500, "request_failed"));
    options.inflightRequests.add(operation);
    void operation.finally(() => options.inflightRequests.delete(operation));
  };
}
