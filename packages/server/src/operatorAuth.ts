import { timingSafeEqual } from "node:crypto";
import {
  credentialSha256Schema,
  operatorSessionIdSchema
} from "@planweave-ai/collaboration-protocol/core/primitives";
import { type OperatorSession } from "@planweave-ai/collaboration-protocol/identity/workspace";
import { opaqueIdentifierSchema } from "@planweave-ai/agent-host-protocol";
import { z } from "zod";
import type { SqliteDatabase } from "./sqlite.js";
import { OperatorSessionStore, hashOperatorSessionToken } from "./identity/operatorSessionStore.js";
import type { RemoteInteractionAuthorizationPort } from "./remoteInteractions.js";

const operatorTokenSha256Schema = z.string().regex(/^[a-f0-9]{64}$/);

export const operatorCredentialSchema = z
  .object({
    operatorId: opaqueIdentifierSchema,
    tokenSha256: operatorTokenSha256Schema,
    projectIds: z.array(opaqueIdentifierSchema).max(256),
    serverAdmin: z.boolean().default(false)
  })
  .strict();

const operatorCredentialPrincipalSchema = operatorCredentialSchema.omit({ tokenSha256: true });
export const authenticatedOperatorPrincipalSchema = operatorCredentialPrincipalSchema
  .extend({
    workspaceId: opaqueIdentifierSchema,
    operatorSessionId: operatorSessionIdSchema,
    expiresAt: z.iso.datetime()
  })
  .strict();
export const operatorPrincipalSchema = authenticatedOperatorPrincipalSchema;
export type OperatorPrincipal = z.infer<typeof authenticatedOperatorPrincipalSchema>;
/**
 * Request-scoped Human identity proven independently from the Operator session.
 * Operator credentials select a Server control plane; they do not prove Human ownership.
 */
export type OperatorRequestPrincipal = OperatorPrincipal & {
  humanPrincipalId?: string;
};
export type OperatorCredential = z.input<typeof operatorCredentialSchema>;

export function hashOperatorToken(token: string): string {
  return hashOperatorSessionToken(token);
}

export class OperatorTokenRegistry implements RemoteInteractionAuthorizationPort {
  private readonly credentials: Array<{ credential: OperatorCredential; digest: Buffer }>;
  private readonly principals = new Map<string, Map<string, OperatorPrincipal>>();
  private readonly sessions: OperatorSessionStore;

  constructor(
    database: SqliteDatabase,
    rawCredentials: readonly OperatorCredential[],
    clock: () => Date = () => new Date()
  ) {
    this.sessions = new OperatorSessionStore(database, clock);
    const credentials = z.array(operatorCredentialSchema).min(1).max(1024).parse(rawCredentials);
    const tokenDigests = new Set<string>();
    const operatorIds = new Set<string>();
    this.credentials = credentials.map(({ tokenSha256, ...rawPrincipal }) => {
      const credential = operatorCredentialSchema.parse({ tokenSha256, ...rawPrincipal });
      if (operatorIds.has(credential.operatorId)) {
        throw new Error("operator_id_duplicate");
      }
      if (tokenDigests.has(tokenSha256)) throw new Error("operator_token_duplicate");
      operatorIds.add(credential.operatorId);
      tokenDigests.add(tokenSha256);
      return { credential, digest: Buffer.from(credentialSha256Schema.parse(tokenSha256), "hex") };
    });
  }

  authenticate(authorization: string | string[] | undefined): OperatorPrincipal | undefined {
    if (Array.isArray(authorization)) return undefined;
    const match = /^Bearer (pw_operator_[A-Za-z0-9_-]{43})$/.exec(authorization ?? "");
    if (!match) return undefined;
    let session: OperatorSession | undefined;
    try {
      session = this.sessions.authenticate(match[1]);
    } catch {
      return undefined;
    }
    if (!session) return undefined;
    const digest = Buffer.from(session.credentialSha256, "hex");
    const credential = this.credentials.find(
      (candidate) =>
        candidate.digest.length === digest.length &&
        timingSafeEqual(candidate.digest, digest) &&
        candidate.credential.operatorId === session.operatorId
    )?.credential;
    // Setup-code operator sessions are durable without a static config credential.
    // They receive workspace-scoped, non-admin principals only.
    const principal = authenticatedOperatorPrincipalSchema.parse({
      operatorId: session.operatorId,
      projectIds: credential?.projectIds ?? [],
      serverAdmin: credential?.serverAdmin ?? false,
      workspaceId: session.workspaceId,
      operatorSessionId: session.operatorSessionId,
      expiresAt: session.expiresAt
    });
    const sessions = this.principals.get(principal.operatorId) ?? new Map();
    sessions.set(principal.operatorSessionId, principal);
    this.principals.set(principal.operatorId, sessions);
    return principal;
  }

  authorizeProject(principal: OperatorPrincipal, projectId: string): void {
    if (!principal.serverAdmin && !principal.projectIds.includes(projectId)) {
      throw new Error("operator_project_forbidden");
    }
  }

  authorizeWorkspace(
    principal: OperatorPrincipal,
    workspaceId: string,
    workspaceForProject: (projectId: string) => string | undefined
  ): void {
    if (principal.serverAdmin) return;
    if (principal.workspaceId !== workspaceId) {
      throw new Error("operator_workspace_forbidden");
    }
    const allowed = principal.projectIds.some(
      (projectId) => workspaceForProject(projectId) === workspaceId
    );
    if (!allowed) throw new Error("operator_workspace_forbidden");
  }

  requireServerAdmin(principal: OperatorPrincipal): void {
    if (!principal.serverAdmin) throw new Error("operator_server_admin_required");
  }

  canRespond(input: { responderId: string; workspaceId: string; projectId: string }): boolean {
    const sessions = this.principals.get(input.responderId);
    return Boolean(
      sessions &&
        [...sessions.values()].some(
          (principal) =>
            this.sessions.isActive(principal.workspaceId, principal.operatorSessionId) &&
            (principal.serverAdmin ||
              (principal.workspaceId === input.workspaceId &&
                principal.projectIds.includes(input.projectId)))
        )
    );
  }
}
