import { useState } from "react";
import type {
  RemoteInteractionView,
  RemoteInteractionResponse
} from "@planweave-ai/collaboration-protocol/remote-run";
import type { createTranslator } from "../../i18n";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import type { RemoteAcpContinuation } from "../useRemoteAcpContinuation";

export function RemoteAcpExecutionControls({
  continuation,
  t
}: {
  continuation: RemoteAcpContinuation;
  t: ReturnType<typeof createTranslator>;
}) {
  return (
    <>
      {continuation.execution?.interactions.map((item) => (
        <ExecutionInteraction
          key={item.request.actionId}
          item={item}
          t={t}
          disabled={continuation.sending}
          respond={(response) => void continuation.respondExecution(response)}
        />
      ))}
    </>
  );
}
function ExecutionInteraction({
  item,
  respond,
  disabled,
  t
}: {
  item: RemoteInteractionView;
  respond: (response: RemoteInteractionResponse) => void;
  disabled: boolean;
  t: ReturnType<typeof createTranslator>;
}) {
  const [draft, setDraft] = useState("");
  const request = item.request;
  const identity = {
    actionId: request.actionId,
    dispatchId: request.dispatchId,
    leaseId: request.leaseId,
    executionAttemptId: request.executionAttemptId,
    acpSessionId: request.acpSessionId
  };
  return (
    <section
      className="space-y-2 rounded-lg border p-3"
      data-testid="remote-acp-execution-interaction"
    >
      {request.type === "interaction.permission_requested" ? (
        <>
          <p className="text-sm">{request.title}</p>
          <p className="whitespace-pre-wrap text-xs">{request.description}</p>
          <Button
            disabled={disabled}
            onClick={() =>
              respond({
                ...identity,
                type: "interaction.permission_response",
                decision: "allow_once"
              })
            }
          >
            {t("remoteRunInteractionAllow")}
          </Button>
          <Button
            disabled={disabled}
            variant="outline"
            onClick={() =>
              respond({ ...identity, type: "interaction.permission_response", decision: "deny" })
            }
          >
            {t("remoteRunInteractionDeny")}
          </Button>
        </>
      ) : request.type === "interaction.elicitation_requested" ? (
        <>
          <p className="text-sm">{request.prompt}</p>
          {request.options.length ? (
            <select
              aria-label={t("acpElicitationResponse")}
              value={draft}
              disabled={disabled}
              onChange={(event) => setDraft(event.target.value)}
            >
              <option value="" />
              {request.options.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          ) : (
            <Textarea
              aria-label={t("acpElicitationResponse")}
              value={draft}
              disabled={disabled}
              onChange={(event) => setDraft(event.target.value)}
            />
          )}
          <Button
            disabled={disabled || !draft.trim()}
            onClick={() =>
              respond({
                ...identity,
                type: "interaction.elicitation_response",
                outcome: "accepted",
                response: draft
              })
            }
          >
            {t("acpSubmitElicitation")}
          </Button>
          <Button
            disabled={disabled}
            variant="outline"
            onClick={() =>
              respond({
                ...identity,
                type: "interaction.elicitation_response",
                outcome: "cancelled"
              })
            }
          >
            {t("acpCancelElicitation")}
          </Button>
        </>
      ) : (
        <>
          <p className="text-sm">{request.hostInstruction}</p>
          <Button
            disabled={disabled}
            onClick={() =>
              respond({
                ...identity,
                type: "interaction.authentication_action",
                action: "retry_after_host_login"
              })
            }
          >
            {t("taskWorkspaceRetryAction")}
          </Button>
          <Button
            disabled={disabled}
            variant="outline"
            onClick={() =>
              respond({ ...identity, type: "interaction.authentication_action", action: "cancel" })
            }
          >
            {t("acpCancelPermission")}
          </Button>
        </>
      )}
    </section>
  );
}
