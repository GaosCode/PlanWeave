import type { Server } from "node:http";
import { acpConversationPageSchema } from "@planweave-ai/agent-host-protocol";
import type { AcpConversationService } from "../../../../server/src/acpConversationService.js";
import { HumanIdentityCredentialStore } from "../../../../server/src/identity/humanIdentityCredentialStore.js";
import { OperatorSessionStore } from "../../../../server/src/identity/operatorSessionStore.js";
import { WorkspaceIdentityRepository } from "../../../../server/src/identity/workspaceRepository.js";
import { hashOperatorToken, OperatorTokenRegistry } from "../../../../server/src/operatorAuth.js";
import {
  handleOperatorHttpRequest,
  type OperatorControlPort
} from "../../../../server/src/operatorHttp.js";
import { RemoteOperationRepository } from "../../../../server/src/remoteOperations.js";
import type { SqliteDatabase } from "../../../../server/src/sqlite.js";
import { loopbackHttpTransportAdmission } from "../../../../server/src/__tests__/support/transportAdmission.js";

export function attachConversationHttpFixture(
  http: Server,
  database: SqliteDatabase,
  conversations: AcpConversationService,
  clock: () => Date
) {
  const token = `pw_operator_${"R".repeat(43)}`;
  database
    .prepare(
      "INSERT INTO human_principals(human_principal_id,display_name,created_at) VALUES(?,?,?)"
    )
    .run("fixture-actor", "Retention operator", clock().toISOString());
  const humanIdentityCredentials = new HumanIdentityCredentialStore(
    database,
    clock,
    365 * 24 * 60 * 60 * 1000
  );
  const human = humanIdentityCredentials.issue("fixture-actor");
  const authorization = new OperatorTokenRegistry(database, [
    {
      operatorId: "retention-operator",
      tokenSha256: hashOperatorToken(token),
      projectIds: [],
      serverAdmin: true
    }
  ]);
  new OperatorSessionStore(database).create({
    workspaceId: new WorkspaceIdentityRepository(database).ensureWorkspaceForLegacyProject(
      "project-remote-acp-v2"
    ),
    operatorId: "retention-operator",
    credentialSha256: hashOperatorToken(token),
    issuedAt: clock().toISOString(),
    expiresAt: new Date(clock().getTime() + 365 * 24 * 60 * 60 * 1000).toISOString()
  });
  const unused = () => {
    throw new Error("unused_conversation_http_route");
  };
  const unusedAsync = async () => {
    throw new Error("unused_conversation_http_route");
  };
  const operations = new RemoteOperationRepository(database, clock);
  const service: OperatorControlPort = {
    createEnrollmentGrant: unused,
    listHosts: unused,
    listAgentEndpoints: unused,
    getHost: unused,
    revokeHost: unused,
    requestHostCredentialRenewal: unused,
    dispatch: unusedAsync,
    observeOperation: unusedAsync,
    readOwnerOperationTerminalResult: unusedAsync,
    inspectOwnerCanvasMaterializationHead: unused,
    materializeOwnerCanvas: unused,
    executeAction: unusedAsync,
    replayEvents: unused,
    listPendingInteractions: unused,
    settleInteraction: unused,
    listRemoteAgents: unused,
    setRemoteAgentAccessMode: unused,
    grantRemoteAgentWorkspace: unused,
    revokeRemoteAgentGrant: unused,
    revokeRemoteAgent: unused,
    repairRemoteAgentOwnership: unused,
    conversation(principal, operationId, afterCursor = 0) {
      if (!principal.humanPrincipalId) throw new Error("operator_human_identity_forbidden");
      return conversations.page(
        operations.getRequired(operationId),
        principal.humanPrincipalId,
        afterCursor
      );
    },
    converse(principal, operationId, action) {
      if (!principal.humanPrincipalId) throw new Error("operator_human_identity_forbidden");
      return conversations.act(
        operations.getRequired(operationId),
        principal.humanPrincipalId,
        action
      );
    }
  };
  http.on("request", (request, response) => {
    void handleOperatorHttpRequest(request, response, {
      authorization,
      humanIdentityCredentials,
      service,
      readiness: () => ({ status: "ready", schemaVersion: 1 }),
      serverVersion: "test",
      serverBuildRevision: "development",
      limits: { maxArtifactBytes: 1024, maxWebSocketPayloadBytes: 1024 * 1024 },
      transportAdmission: loopbackHttpTransportAdmission
    });
  });
  const headers = {
    Authorization: `Bearer ${token}`,
    "x-planweave-human-identity": `Bearer ${human.identityToken}`,
    "content-type": "application/json"
  };
  return (origin: string, operationId: string) => {
    const url = `${origin}/api/v1/remote-operations/${operationId}/conversation`;
    return {
      async page(afterCursor = 0) {
        const response = await fetch(`${url}?afterCursor=${afterCursor}`, { headers });
        if (!response.ok)
          throw new Error(`conversation_page_http_${response.status}: ${await response.text()}`);
        return acpConversationPageSchema.parse(await response.json());
      },
      async act(action: unknown) {
        const response = await fetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify(action)
        });
        if (!response.ok)
          throw new Error(`conversation_action_http_${response.status}: ${await response.text()}`);
        return acpConversationPageSchema.parse(await response.json());
      }
    };
  };
}
