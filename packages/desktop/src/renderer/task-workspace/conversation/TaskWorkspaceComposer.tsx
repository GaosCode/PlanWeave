import { AcpComposerSurface } from "./AcpComposerSurface";
import { RemoteAcpComposer } from "./RemoteAcpComposer";
import type { DesktopBridgeApi } from "@planweave-ai/runtime";
import type { ReactNode } from "react";
import { bridge } from "../../bridge";
import type { createTranslator } from "../../i18n";
import {
  useTaskWorkspaceComposerController,
  type TaskWorkspaceComposerController
} from "../useTaskWorkspaceComposerController";
import type { TaskWorkspaceComposerSlotProps } from "../contracts";
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
  composerController,
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
  composerController?: TaskWorkspaceComposerController;
  t: ReturnType<typeof createTranslator>;
}) {
  const localController = useTaskWorkspaceComposerController({
    api: composerController || remoteConversation ? null : api,
    runnerModel: composerController || remoteConversation ? null : runnerModel,
    selectedRun: composerController || remoteConversation ? null : selectedRun
  });
  const controller = composerController ?? localController;
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
  if (runnerKind === null && selectedRun.item.run.metadata.submittedAt !== null) {
    return <ComposerUnavailable accessory={accessory} reason={t("taskWorkspaceReportOnly")} />;
  }
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
        cancelController={cancelController}
        controller={controller}
        model={runnerModel}
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
          cancelController={localCancelController}
          controller={controller}
          model={runnerModel}
          t={t}
        />
      )}
    </TaskWorkspaceCancelRunControllerScope>
  );
}

function AcpComposer({
  accessory,
  cancelController,
  controller,
  model,
  t
}: {
  accessory?: ReactNode;
  cancelController: TaskWorkspaceCancelRunController;
  controller: TaskWorkspaceComposerController;
  model: NonNullable<TaskWorkspaceComposerSlotProps["runnerModel"]>;
  t: ReturnType<typeof createTranslator>;
}) {
  const {
    available: promptAvailable,
    disabled,
    draft,
    identity,
    prompt,
    setDraft,
    submit
  } = controller;
  const unavailableReason =
    model.intervention.prompt.available && !identity
      ? t("taskWorkspacePromptIdentityMismatch")
      : (model.intervention.prompt.reason ?? t("acpPromptUnavailable"));

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
