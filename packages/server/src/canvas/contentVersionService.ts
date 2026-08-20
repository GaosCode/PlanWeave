import {
  authorizedContentVersionAcknowledgementSchema,
  authorizedContentVersionFetchSchema,
  contentVersionAcknowledgementRequestSchema,
  contentVersionFetchRequestSchema,
  firstContentVersionPublishRequestSchema,
  firstContentVersionPublishResultSchema,
  type ContentVersionAcknowledgement,
  type FirstContentVersionPublishResult
} from "@planweave-ai/collaboration-protocol/content/version";
import {
  authorizedContentVersionAuthorityDiscoverySchema,
  contentVersionAuthorityDiscoveryRequestSchema,
  type ContentVersionAuthorityDiscoveryResult
} from "@planweave-ai/collaboration-protocol/content/authority";
import type { CollaborationAuthContext } from "../identity/auth.js";
import type { ProjectAccessRepository } from "../projectAccessRepository.js";
import type { WorkspaceIdentityRepository } from "../identity/workspaceRepository.js";
import { authorizeCanvasContent } from "./policy.js";
import type { ContentAuthorityStore } from "./contentAuthorityStore.js";
import type { CanvasScopeKey } from "./repository.js";

function actor(context: CollaborationAuthContext) {
  return { kind: "human" as const, id: context.humanPrincipalId, displayName: context.displayName };
}

function deviceSessionId(context: CollaborationAuthContext): string {
  return "deviceSessionId" in context ? context.deviceSessionId : context.deviceCredentialId;
}

export type ContentVersionServiceOptions = {
  repository: ContentAuthorityStore;
  access: ProjectAccessRepository;
  workspaceIdentity: WorkspaceIdentityRepository;
};

/** Authorization boundary for immutable content publication, fetch, and device acknowledgement. */
export class ContentVersionService {
  constructor(private readonly options: ContentVersionServiceOptions) {}

  publishInitial(
    context: CollaborationAuthContext,
    rawRequest: unknown
  ): FirstContentVersionPublishResult {
    const parsed = firstContentVersionPublishRequestSchema.safeParse(rawRequest);
    if (!parsed.success)
      return this.rejected("content_verification_failed", false, "initial_publish_invalid");
    const request = parsed.data;
    const authorization = authorizeCanvasContent({
      actor: context,
      projectId: request.projectId,
      canvasId: request.canvasId,
      access: this.options.access,
      workspaceIdentity: this.options.workspaceIdentity
    });
    if (!authorization.ok) {
      return this.rejected("authorization_revoked", false, "initial_publish_not_authorized");
    }
    const canvas = this.options.access.registry.canvasInternal(
      authorization.scope.workspaceId,
      request.projectId,
      request.canvasId
    );
    if (!canvas || canvas.ownerHumanPrincipalId !== context.humanPrincipalId) {
      return this.rejected("authorization_revoked", false, "initial_publish_owner_required");
    }
    const head = this.options.repository.head(authorization.scope);
    if (head)
      return this.rejected("head_already_exists", false, "initial_publish_already_completed");
    try {
      const version = this.options.repository.publishInitial({
        scope: authorization.scope,
        content: request.content,
        createdBy: actor(context)
      });
      return firstContentVersionPublishResultSchema.parse({ outcome: "published", ...version });
    } catch (error) {
      const code = error instanceof Error ? error.message : "storage_unavailable";
      return this.rejected(
        code === "content_version_head_cas_conflict"
          ? "head_cas_conflict"
          : code.startsWith("content_version_")
            ? "content_verification_failed"
            : "storage_unavailable",
        code === "content_version_head_cas_conflict" || !code.startsWith("content_version_"),
        code === "content_version_head_cas_conflict"
          ? "initial_publish_conflicted"
          : "initial_publish_failed"
      );
    }
  }

  fetch(context: CollaborationAuthContext, rawRequest: unknown) {
    const authorized = this.authorizeFetch(context, rawRequest);
    return this.options.repository.readVersion(authorized.scope, authorized.content);
  }

  /** Validates the request and ACL before a transport adapter starts a content stream. */
  authorizeFetch(
    context: CollaborationAuthContext,
    rawRequest: unknown
  ): {
    scope: CanvasScopeKey;
    content: ReturnType<typeof contentVersionFetchRequestSchema.parse>["content"];
  } {
    const parsed = contentVersionFetchRequestSchema.safeParse(rawRequest);
    if (!parsed.success) throw new Error("content_fetch_invalid");
    const request = parsed.data;
    const authorization = authorizeCanvasContent({
      actor: context,
      projectId: request.projectId,
      canvasId: request.canvasId,
      access: this.options.access,
      workspaceIdentity: this.options.workspaceIdentity
    });
    if (!authorization.ok) throw new Error("content_fetch_forbidden");
    authorizedContentVersionFetchSchema.parse({
      request,
      scope: authorization.scope,
      deviceSessionId: deviceSessionId(context),
      aclRevision: authorization.aclRevision
    });
    return { scope: authorization.scope, content: request.content };
  }

  discoverAuthority(
    context: CollaborationAuthContext,
    rawRequest: unknown
  ): ContentVersionAuthorityDiscoveryResult {
    const parsed = contentVersionAuthorityDiscoveryRequestSchema.safeParse(rawRequest);
    if (!parsed.success) throw new Error("content_authority_invalid");
    const request = parsed.data;
    const authorization = authorizeCanvasContent({
      actor: context,
      projectId: request.projectId,
      canvasId: request.canvasId,
      access: this.options.access,
      workspaceIdentity: this.options.workspaceIdentity
    });
    if (!authorization.ok) throw new Error("content_authority_forbidden");
    authorizedContentVersionAuthorityDiscoverySchema.parse({
      request,
      scope: authorization.scope,
      deviceSessionId: deviceSessionId(context),
      aclRevision: authorization.aclRevision
    });
    const canvas = this.options.access.registry.canvasInternal(
      authorization.scope.workspaceId,
      request.projectId,
      request.canvasId
    );
    if (!canvas) throw new Error("content_authority_forbidden");
    return this.options.repository.discoverAuthority({
      scope: authorization.scope,
      deviceSessionId: deviceSessionId(context),
      localReplica: request.localReplica,
      knownRevision: request.knownRevision,
      isCanvasOwner: canvas.ownerHumanPrincipalId === context.humanPrincipalId
    });
  }

  acknowledge(
    context: CollaborationAuthContext,
    projectId: string,
    canvasId: string,
    rawRequest: unknown
  ): ContentVersionAcknowledgement {
    const parsed = contentVersionAcknowledgementRequestSchema.safeParse(rawRequest);
    if (!parsed.success) throw new Error("content_ack_invalid");
    const authorization = authorizeCanvasContent({
      actor: context,
      projectId,
      canvasId,
      access: this.options.access,
      workspaceIdentity: this.options.workspaceIdentity
    });
    if (!authorization.ok) throw new Error("content_ack_forbidden");
    const acknowledgement = this.options.repository.acknowledge({
      scope: authorization.scope,
      deviceSessionId: deviceSessionId(context),
      content: parsed.data.content
    });
    authorizedContentVersionAcknowledgementSchema.parse({ request: parsed.data, acknowledgement });
    return acknowledgement;
  }

  private rejected(
    reason:
      | "head_already_exists"
      | "head_cas_conflict"
      | "content_verification_failed"
      | "authorization_revoked"
      | "device_revoked"
      | "storage_unavailable",
    retryable: boolean,
    detail: string
  ): FirstContentVersionPublishResult {
    return firstContentVersionPublishResultSchema.parse({
      outcome: "rejected",
      reason,
      retryable,
      detail,
      head: null
    });
  }
}
