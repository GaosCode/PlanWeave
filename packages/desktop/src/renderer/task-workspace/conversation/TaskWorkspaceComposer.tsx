import type { DesktopBridgeApi } from "@planweave-ai/runtime";
import { SendIcon, SquareIcon } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { bridge } from "../../bridge";
import type { createTranslator } from "../../i18n";
import { useAgentPrompt } from "../../hooks/useAgentPrompt";
import { useRunnerInterventions } from "../../hooks/useRunnerInterventions";
import type { TaskWorkspaceComposerSlotProps } from "../contracts";
import { samePromptIdentity, sameSessionActionIdentity } from "./actionIdentity";

type ComposerApi = Partial<Pick<
  DesktopBridgeApi,
  "cancelAgentRun" | "respondToAgentRequest" | "sendAgentPrompt"
>>;

export function TaskWorkspaceComposer({
  api = bridge,
  liveStatus,
  runnerModel,
  selectedRun,
  t
}: TaskWorkspaceComposerSlotProps & {
  api?: ComposerApi | null;
  t: ReturnType<typeof createTranslator>;
}) {
  if (!selectedRun) {
    return <ComposerUnavailable reason={t("acpPromptUnavailable")} />;
  }
  const runnerKind = selectedRun.item.run.metadata.runnerKind;
  if (runnerKind === "cli") {
    return <ComposerUnavailable reason="CLI runs do not provide an ACP composer. Use Open terminal to continue in the CLI." />;
  }
  if (runnerKind !== "acp") {
    return <ComposerUnavailable reason="The selected run does not declare a supported conversation transport." />;
  }
  if (!runnerModel) {
    const reason = liveStatus === "loading"
      ? "Loading the selected run…"
      : selectedRun.item.run.capabilities.prompt.reason ?? t("acpPromptUnavailable");
    return <ComposerUnavailable reason={reason} />;
  }

  return <AcpComposer api={api} model={runnerModel} selectedRun={selectedRun} t={t} />;
}

function AcpComposer({ api, model, selectedRun, t }: {
  api: ComposerApi | null;
  model: NonNullable<TaskWorkspaceComposerSlotProps["runnerModel"]>;
  selectedRun: NonNullable<TaskWorkspaceComposerSlotProps["selectedRun"]>;
  t: ReturnType<typeof createTranslator>;
}) {
  const [draft, setDraft] = useState("");
  const selectedPromptCapability = selectedRun.item.run.capabilities.prompt;
  const selectedCancelCapability = selectedRun.item.run.capabilities.cancel;
  const promptIdentity = samePromptIdentity(
    model.intervention.prompt.identity,
    selectedPromptCapability.identity
  )
    ? model.intervention.prompt.identity
    : null;
  const cancelIdentity = sameSessionActionIdentity(
    model.intervention.cancel.identity,
    selectedCancelCapability.identity
  )
    ? model.intervention.cancel.identity
    : null;
  const prompt = useAgentPrompt({
    api,
    identity: promptIdentity,
    runtimeInFlight: model.intervention.prompt.inFlight
  });
  const interventions = useRunnerInterventions({ api, model });

  const promptAvailable = model.intervention.prompt.available &&
    selectedPromptCapability.available &&
    promptIdentity !== null;
  const cancelAvailable = model.intervention.cancel.available &&
    selectedCancelCapability.available &&
    cancelIdentity !== null;
  const disabled = !promptAvailable || prompt.inFlight;
  const unavailableReason = model.intervention.prompt.available && !promptIdentity
    ? "The prompt identity does not match the selected run."
    : model.intervention.prompt.reason ?? t("acpPromptUnavailable");
  const submit = () => {
    const text = draft.trim();
    if (!text || disabled) return;
    void prompt.send(text).then((sent) => {
      if (sent) setDraft("");
    });
  };

  return (
    <section className="mx-auto w-full max-w-5xl p-3" data-testid="task-workspace-composer">
      <div className="rounded-xl border bg-background p-2 shadow-sm">
        <Textarea
          aria-label={t("acpPromptLabel")}
          className="min-h-16 max-h-40 resize-y border-0 bg-transparent shadow-none focus-visible:ring-0"
          disabled={disabled}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              submit();
            }
          }}
          placeholder={promptAvailable ? t("acpPromptPlaceholder") : unavailableReason}
          value={draft}
        />
        <div className="flex items-center justify-between gap-3 px-1 pt-1 text-[11px] text-muted-foreground">
          <span>{promptAvailable ? t("acpPromptHint") : unavailableReason}</span>
          <div className="flex items-center gap-2">
            {cancelAvailable ? (
              <Button
                aria-label={t("acpCancelRun")}
                disabled={interventions.cancelInFlight}
                onClick={() => interventions.cancel(cancelIdentity)}
                size="icon-sm"
                type="button"
                variant="destructive"
              >
                <SquareIcon />
              </Button>
            ) : null}
            <Button
              aria-label={t("acpSendPrompt")}
              disabled={disabled || !draft.trim()}
              onClick={submit}
              size="icon-sm"
              type="button"
            >
              <SendIcon />
            </Button>
          </div>
        </div>
        {prompt.inFlight ? <p className="px-1 pt-1 text-[11px] text-muted-foreground">{t("acpPromptSending")}</p> : null}
        {prompt.error ? <p className="px-1 pt-1 text-xs text-destructive" role="alert">{t("acpPromptFailed")}: {prompt.error}</p> : null}
        {interventions.actionError ? <p className="px-1 pt-1 text-xs text-destructive" role="alert">{t("acpActionError")}: {interventions.actionError}</p> : null}
      </div>
    </section>
  );
}

function ComposerUnavailable({ reason }: { reason: string }) {
  return (
    <section className="mx-auto w-full max-w-5xl p-3" data-testid="task-workspace-composer-unavailable">
      <p className="rounded-lg border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">{reason}</p>
    </section>
  );
}
