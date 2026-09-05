import { AcpComposerSurface } from "./AcpComposerSurface";
import { RemoteAcpComposer } from "./RemoteAcpComposer";
import type { DesktopBridgeApi } from "@planweave-ai/runtime";
import { useState } from "react";
import type { ReactNode } from "react";
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
import { TaskWorkspaceRetryRunAction } from "./TaskWorkspaceRetryRunAction";
import { TaskWorkspaceRecoverAcpRunAction } from "./TaskWorkspaceRecoverAcpRunAction";

type ComposerApi = Partial<
  Pick<
    DesktopBridgeApi,
    | "cancelAgentRun"
    | "cancelAgentPromptTurn"
    | "getCurrentAgentPromptTurn"
    | "recoverTaskWorkspaceAcpRun"
    | "respondToAgentRequest"
    | "retryTaskWorkspaceRun"
    | "sendAgentPrompt"
  >
>;

export function TaskWorkspaceComposer({
  accessory,
  api = bridge,
  canvasRef = null,
  cancelController,
  liveStatus,
  refresh,
  remoteConversation = null,
  runnerModel,
  selectedRun,
  t
}: Omit<TaskWorkspaceComposerSlotProps, "workspace"> & {
  accessory?: ReactNode;
  api?: ComposerApi | null;
  canvasRef?: import("@planweave-ai/runtime").DesktopCanvasReference | null;
  cancelController?: TaskWorkspaceCancelRunController;
  t: ReturnType<typeof createTranslator>;
}) {
  if (remoteConversation?.continuation)
    return (
      <RemoteAcpComposer
        key={remoteConversation.operationId}
        continuation={remoteConversation.continuation}
        accessory={accessory}
        t={t}
      />
    );
  if (remoteConversation) {
    return (
      <ComposerUnavailable
        accessory={accessory}
        reason={
          remoteConversation.error ??
          (remoteConversation.state === "completed" ||
          remoteConversation.state === "failed" ||
          remoteConversation.state === "cancelled"
            ? t("taskWorkspaceRemoteAcpComposerClosed")
            : t("taskWorkspaceRemoteAcpComposerLive"))
        }
      />
    );
  }
  if (!selectedRun) {
    return <ComposerUnavailable accessory={accessory} reason={t("acpPromptUnavailable")} />;
  }
  const actionAccessory = (
    <>
      {accessory}
      <TaskWorkspaceRecoverAcpRunAction
        api={api}
        buttonLabel={t("taskWorkspaceRecoverAcpAction")}
        errorLabel={t("acpActionError")}
        onRecovered={refresh}
        selectedRun={selectedRun}
      />
      <TaskWorkspaceRetryRunAction
        api={api}
        buttonLabel={t("taskWorkspaceRetryAction")}
        errorLabel={t("acpActionError")}
        onRetried={refresh}
        selectedRun={selectedRun}
      />
    </>
  );
  const runnerKind = selectedRun.item.run.metadata.runnerKind;
  if (runnerKind === "cli") {
    return (
      <ComposerUnavailable
        accessory={actionAccessory}
        reason={t("taskWorkspaceCliComposerUnavailable")}
      />
    );
  }
  if (runnerKind !== "acp") {
    return (
      <ComposerUnavailable
        accessory={actionAccessory}
        reason={t("taskWorkspaceUnsupportedTransport")}
      />
    );
  }
  if (!runnerModel) {
    const reason =
      liveStatus === "loading"
        ? t("taskWorkspaceLoadingSelectedRun")
        : (selectedRun.item.run.capabilities.prompt.reason ?? t("acpPromptUnavailable"));
    return <ComposerUnavailable accessory={actionAccessory} reason={reason} />;
  }

  if (cancelController) {
    return (
      <AcpComposer
        accessory={actionAccessory}
        api={api}
        cancelController={cancelController}
        model={runnerModel}
        selectedRun={selectedRun}
        t={t}
      />
    );
  }
  return (
    <TaskWorkspaceCancelRunControllerScope
      api={api}
      canvasRef={canvasRef}
      model={runnerModel}
      selectedRun={selectedRun}
    >
      {(localCancelController) => (
        <AcpComposer
          accessory={actionAccessory}
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
    runtimeInFlight: model.intervention.prompt.inFlight,
    runtimeVersion: model,
    completedContinuation: model.terminal
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
    <AcpComposerSurface
      accessory={
        <>
          {accessory}
          <TaskWorkspaceCancelRunAction
            buttonLabel={t("acpCancelRun")}
            controller={cancelController}
            errorLabel={t("acpActionError")}
          />
        </>
      }
      draft={draft}
      onDraftChange={setDraft}
      disabled={disabled}
      available={promptAvailable}
      unavailableReason={unavailableReason}
      onSubmit={submit}
      onCancel={prompt.turnCancellable ? () => void prompt.cancel() : undefined}
      cancelling={prompt.cancelling}
      error={prompt.error}
      t={t}
    />
  );
}

function ComposerUnavailable({ accessory, reason }: { accessory?: ReactNode; reason: string }) {
  return (
    <section
      className="pointer-events-auto w-full px-5 pt-2 pb-4"
      data-testid="task-workspace-composer-unavailable"
    >
      <div
        className="mx-auto flex w-full max-w-3xl items-center justify-between gap-3 rounded-lg border bg-background px-3 py-2"
        data-testid="task-workspace-composer-unavailable-surface"
      >
        <p className="text-xs text-muted-foreground">{reason}</p>
        {accessory}
      </div>
    </section>
  );
}
