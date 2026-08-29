import type { RemoteWorkspaceAuthorityBinding } from "../workspaceExecution/contracts.js";
import type {
  RemoteDispatchIntentV3,
  RemoteInteractionResponse
} from "@planweave-ai/collaboration-protocol/remote-run";
import type {
  RemoteAgentCatalogPort,
  RemoteOperationCommandPort,
  RemoteOperationQueryPort,
  WorkAuthorityPort,
  WorkspaceExecutionInteractionPort
} from "../workspaceExecution/ports.js";

declare const plainBinding: RemoteWorkspaceAuthorityBinding;
declare const catalog: RemoteAgentCatalogPort;
declare const authority: WorkAuthorityPort;
declare const command: RemoteOperationCommandPort;
declare const query: RemoteOperationQueryPort;
declare const interaction: WorkspaceExecutionInteractionPort;
declare const intent: RemoteDispatchIntentV3;
declare const response: RemoteInteractionResponse;

// @ts-expect-error Plain DTOs must be revalidated by WorkspaceAuthorityBindingPort.
void catalog.list({ binding: plainBinding, executor: { name: "codex", agentId: "codex" } });
// @ts-expect-error Authority reads require the resolver brand.
void authority.ensure({ binding: plainBinding });
// @ts-expect-error Dispatch ports cannot receive an unvalidated binding.
void command.dispatch({ binding: plainBinding, intent });
// @ts-expect-error Observation ports cannot receive an unvalidated binding.
void query.observe({ binding: plainBinding, operationId: "operation-1" });
// @ts-expect-error Interaction ports cannot receive an unvalidated binding.
void interaction.respond({ binding: plainBinding, operationId: "operation-1", response });
