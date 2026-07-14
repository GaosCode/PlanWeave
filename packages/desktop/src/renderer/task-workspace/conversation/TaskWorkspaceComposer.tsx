import type { DesktopBridgeApi } from "@planweave-ai/runtime";
import { SendIcon } from "lucide-react";
import { useState } from "react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { bridge } from "../../bridge";
import type { createTranslator } from "../../i18n";
import { useAgentPrompt } from "../../hooks/useAgentPrompt";
import type { TaskWorkspaceComposerSlotProps } from "../contracts";
import { samePromptIdentity } from "./actionIdentity";
import {
  TaskWorkspaceCancelRunAction,
  type TaskWorkspaceCancelRunController,
  TaskWorkspaceCancelRunControllerScope
} from "./TaskWorkspaceCancelRunAction";

type ComposerApi = Partial<
  Pick<DesktopBridgeApi, "cancelAgentRun" | "respondToAgentRequest" | "sendAgentPrompt">
>;

export function TaskWorkspaceComposer({
  accessory,
  api = bridge,
  cancelController,
  liveStatus,
  runnerModel,
  selectedRun,
  t
}: Omit<TaskWorkspaceComposerSlotProps, "workspace"> & {
  accessory?: ReactNode;
  api?: ComposerApi | null;
  cancelController?: TaskWorkspaceCancelRunController;
  t: ReturnType<typeof createTranslator>;
}) {
  if (!selectedRun) {
    return <ComposerUnavailable accessory={accessory} reason={t("acpPromptUnavailable")} />;
  }
  const runnerKind = selectedRun.item.run.metadata.runnerKind;
  if (runnerKind === "cli") {
    return (
      <ComposerUnavailable
        accessory={accessory}
        reason={t("taskWorkspaceCliComposerUnavailable")}
      />
    );
  }
  if (runnerKind !== "acp") {
    return (
      <ComposerUnavailable accessory={accessory} reason={t("taskWorkspaceUnsupportedTransport")} />
    );
  }
  if (!runnerModel) {
    const reason =
      liveStatus === "loading"
        ? t("taskWorkspaceLoadingSelectedRun")
        : (selectedRun.item.run.capabilities.prompt.reason ?? t("acpPromptUnavailable"));
    return <ComposerUnavailable accessory={accessory} reason={reason} />;
  }

  if (cancelController) {
    return (
      <AcpComposer
        accessory={accessory}
        api={api}
        cancelController={cancelController}
        model={runnerModel}
        selectedRun={selectedRun}
        t={t}
      />
    );
  }
  return (
    <TaskWorkspaceCancelRunControllerScope api={api} model={runnerModel} selectedRun={selectedRun}>
      {(localCancelController) => (
        <AcpComposer
          accessory={accessory}
          api={api}
          cancelController={localCancelController}
          model={runnerModel}
          selectedRun={selectedRun}
          t={t}
        />
      )}
    </TaskWorkspaceCancelRunControllerScope>
  );
}

function AcpComposer({
  accessory,
  api,
  cancelController,
  model,
  selectedRun,
  t
}: {
  accessory?: ReactNode;
  api: ComposerApi | null;
  cancelController: TaskWorkspaceCancelRunController;
  model: NonNullable<TaskWorkspaceComposerSlotProps["runnerModel"]>;
  selectedRun: NonNullable<TaskWorkspaceComposerSlotProps["selectedRun"]>;
  t: ReturnType<typeof createTranslator>;
}) {
  const [draft, setDraft] = useState("");
  const selectedPromptCapability = selectedRun.item.run.capabilities.prompt;
  const promptIdentity = samePromptIdentity(
    model.intervention.prompt.identity,
    selectedPromptCapability.identity
  )
    ? model.intervention.prompt.identity
    : null;
  const prompt = useAgentPrompt({
    api,
    identity: promptIdentity,
    runtimeInFlight: model.intervention.prompt.inFlight
  });

  const promptAvailable =
    model.intervention.prompt.available &&
    selectedPromptCapability.available &&
    promptIdentity !== null;
  const disabled = !promptAvailable || prompt.inFlight;
  const unavailableReason =
    model.intervention.prompt.available && !promptIdentity
      ? t("taskWorkspacePromptIdentityMismatch")
      : (model.intervention.prompt.reason ?? t("acpPromptUnavailable"));
  const submit = () => {
    const text = draft.trim();
    if (!text || disabled) return;
    void prompt.send(text).then((sent) => {
      if (sent) setDraft("");
    });
  };

  return (
    <section
      className="pointer-events-auto relative w-full px-5 pt-2 pb-4 before:absolute before:inset-x-0 before:top-2 before:bottom-0 before:bg-app-canvas"
      data-testid="task-workspace-composer"
    >
      <div
        className="relative z-10 mx-auto w-full max-w-3xl rounded-2xl border bg-background p-2 shadow-lg shadow-black/5"
        data-testid="task-workspace-composer-surface"
      >
        <Textarea
          aria-label={t("acpPromptLabel")}
          className="min-h-20 max-h-40 resize-none border-0 bg-transparent shadow-none focus-visible:ring-0"
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
          <div className="flex min-w-0 items-center gap-2">
            {accessory}
            <TaskWorkspaceCancelRunAction
              buttonLabel={t("acpCancelRun")}
              controller={cancelController}
              errorLabel={t("acpActionError")}
            />
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
        {prompt.inFlight ? (
          <p className="px-1 pt-1 text-[11px] text-muted-foreground">{t("acpPromptSending")}</p>
        ) : null}
        {prompt.error ? (
          <p className="px-1 pt-1 text-xs text-destructive" role="alert">
            {t("acpPromptFailed")}: {prompt.error}
          </p>
        ) : null}
      </div>
    </section>
  );
}

function ComposerUnavailable({ accessory, reason }: { accessory?: ReactNode; reason: string }) {
  return (
    <section
      className="pointer-events-auto relative w-full px-5 pt-2 pb-4 before:absolute before:inset-x-0 before:top-2 before:bottom-0 before:bg-app-canvas"
      data-testid="task-workspace-composer-unavailable"
    >
      <div className="relative z-10 mx-auto flex w-full max-w-3xl items-center justify-between gap-3 rounded-lg border bg-muted/30 px-3 py-2">
        <p className="text-xs text-muted-foreground">{reason}</p>
        {accessory}
      </div>
    </section>
  );
}
