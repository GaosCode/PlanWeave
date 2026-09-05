import { RemoteAcpExecutionControls } from "./RemoteAcpExecutionControls";
import { useState, type ReactNode } from "react";
import { AcpComposerSurface } from "./AcpComposerSurface";
import { StructuredElicitation } from "./StructuredElicitation";
import { Button } from "@/components/ui/button";
import type { createTranslator } from "../../i18n";
import type { RemoteAcpContinuation } from "../useRemoteAcpContinuation";

type Translator = ReturnType<typeof createTranslator>;
export function RemoteAcpComposer({
  continuation,
  accessory,
  t
}: {
  continuation: RemoteAcpContinuation;
  accessory?: ReactNode;
  t: Translator;
}) {
  const [draft, setDraft] = useState("");
  const disabled = !continuation.available || continuation.sending || continuation.active !== null;
  const submit = () => {
    if (disabled || !draft.trim()) return;
    void continuation.send(draft.trim()).then((sent) => {
      if (sent) setDraft("");
    });
  };
  return (
    <AcpComposerSurface
      accessory={accessory}
      draft={draft}
      onDraftChange={setDraft}
      disabled={disabled}
      available={continuation.available}
      unavailableReason={continuation.reason ?? t("acpPromptUnavailable")}
      onSubmit={submit}
      onCancel={continuation.active ? () => void continuation.cancel() : undefined}
      cancelling={continuation.sending}
      inFlight={continuation.active !== null}
      error={continuation.error}
      t={t}
    >
      <RemoteAcpExecutionControls continuation={continuation} t={t} />
      {continuation.interactions.map(({ turnId, request }) => (
        <section key={`${turnId}:${request.requestId}`} className="space-y-2 rounded-md border p-3">
          <p className="text-sm">
            {request.kind === "permission" ? request.summary : request.message}
          </p>
          {request.kind === "permission" ? (
            <div className="flex flex-wrap gap-2">
              {request.options.map((option) => (
                <Button
                  key={option.optionId}
                  disabled={continuation.sending}
                  onClick={() =>
                    void continuation.respond(turnId, request.requestId, {
                      kind: "permission",
                      optionId: option.optionId
                    })
                  }
                >
                  {option.label}
                </Button>
              ))}
              <Button
                variant="outline"
                disabled={continuation.sending}
                onClick={() =>
                  void continuation.respond(turnId, request.requestId, {
                    kind: "permission",
                    optionId: null
                  })
                }
              >
                {t("acpCancelPermission")}
              </Button>
            </div>
          ) : (
            <StructuredElicitation
              disabled={continuation.sending}
              schema={request.requestedSchema}
              onSubmit={(content) =>
                void continuation.respond(turnId, request.requestId, {
                  kind: "elicitation",
                  action: "accept",
                  content
                })
              }
              onCancel={() =>
                void continuation.respond(turnId, request.requestId, {
                  kind: "elicitation",
                  action: "cancel"
                })
              }
              t={t}
            />
          )}
        </section>
      ))}
    </AcpComposerSurface>
  );
}
