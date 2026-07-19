import type {
  ArtifactReference,
  DesktopBridgeApi,
  DesktopCanvasReference
} from "@planweave-ai/runtime";
import { ArrowDownIcon, AtomIcon, FileIcon } from "lucide-react";
import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { bridge } from "../../bridge";
import type { createTranslator } from "../../i18n";
import { AcpConversationItems } from "../../inspector/AcpConversationTimeline";
import type { TaskWorkspaceConversationSlotProps } from "../contracts";
import { TaskWorkspaceCliRun } from "./TaskWorkspaceCliRun";
import { TaskWorkspaceInteractionCards } from "./TaskWorkspaceInteractionCards";

const bottomThreshold = 48;

type ConversationApi = Partial<
  Pick<
    DesktopBridgeApi,
    | "cancelAgentRun"
    | "detectTerminalApps"
    | "getTerminalPreferences"
    | "openTerminal"
    | "listPendingRunnerInteractions"
    | "respondToAgentRequest"
    | "respondToRunnerInteraction"
    | "revealRunnerRecordArtifact"
    | "updateTerminalPreferences"
  >
>;

export function TaskWorkspaceConversation(
  props: TaskWorkspaceConversationSlotProps & {
    api?: ConversationApi | null;
    canvasRef: DesktopCanvasReference;
    t: ReturnType<typeof createTranslator>;
  }
) {
  const { api = bridge, runnerModel, selectedRecord, selectedRun, t } = props;
  const { canvasRef } = props;

  if (!selectedRun) {
    return props.liveStatus === "loading" ? (
      <ConversationState
        detailKind="loading"
        message={t("taskWorkspaceLoadingSelectedRun")}
        recordReady={false}
      />
    ) : (
      <ConversationState message={t("taskWorkspaceNoConversation")} />
    );
  }
  if (!selectedRecord) {
    const message =
      props.liveStatus === "loading"
        ? t("taskWorkspaceLoadingSelectedRun")
        : (props.recordError ?? t("taskWorkspaceRecordUnavailable"));
    return (
      <ConversationState
        detailKind={props.recordError ? "error" : "loading"}
        message={message}
        recordId={selectedRun.item.run.record.recordId}
        recordReady={false}
        role={props.recordError ? "alert" : undefined}
      />
    );
  }
  if (selectedRecord.recordId !== selectedRun.item.run.record.recordId) {
    return (
      <ConversationState
        detailKind="error"
        message={t("taskWorkspaceRecordMismatch")}
        recordId={selectedRun.item.run.record.recordId}
        recordReady={false}
        role="alert"
      />
    );
  }
  const runnerKind = selectedRun.item.run.metadata.runnerKind;
  if (runnerKind === "cli") {
    return <TaskWorkspaceCliRun api={api} canvasRef={canvasRef} record={selectedRecord} t={t} />;
  }
  if (runnerKind !== "acp") {
    return (
      <ConversationState
        detailKind="unsupported"
        message={t("taskWorkspaceUnsupportedTransport")}
        recordId={selectedRecord.recordId}
        recordReady
        role="alert"
      />
    );
  }
  if (!runnerModel) {
    return <AcpConversationUnavailable props={props} selectedRun={selectedRun} t={t} />;
  }

  return (
    <AcpRunConversation
      api={api}
      canvasRef={canvasRef}
      model={runnerModel}
      props={props}
      selectedRun={selectedRun}
      t={t}
    />
  );
}

function AcpConversationUnavailable({
  props,
  selectedRun,
  t
}: {
  props: TaskWorkspaceConversationSlotProps;
  selectedRun: NonNullable<TaskWorkspaceConversationSlotProps["selectedRun"]>;
  t: ReturnType<typeof createTranslator>;
}) {
  const recordId = selectedRun.item.run.record.recordId;
  const error = props.recordError ?? props.subscriptionError;
  if (error || props.liveStatus === "error") {
    return (
      <ConversationState
        detailKind="error"
        message={error ?? t("taskWorkspaceAcpLoadFailed")}
        recordId={recordId}
        recordReady={false}
        role="alert"
      />
    );
  }
  if (props.liveStatus === "loading") {
    return (
      <ConversationState
        detailKind="loading"
        message={t("taskWorkspaceAcpLoading")}
        recordId={recordId}
        recordReady={false}
      />
    );
  }
  if (props.liveStatus === "live") {
    return (
      <ConversationState
        detailKind="error"
        message={t("taskWorkspaceAcpLiveModelUnavailable")}
        recordId={recordId}
        recordReady={false}
        role="alert"
      />
    );
  }
  const message =
    props.liveUnavailableReason ??
    selectedRun.item.run.capabilities.prompt.reason ??
    t("taskWorkspaceAcpUnavailable");
  return (
    <ConversationState detailKind="unavailable" message={message} recordId={recordId} recordReady />
  );
}

function AcpRunConversation({
  api,
  canvasRef,
  model,
  props,
  selectedRun,
  t
}: {
  api: ConversationApi | null;
  canvasRef: DesktopCanvasReference;
  model: NonNullable<TaskWorkspaceConversationSlotProps["runnerModel"]>;
  props: TaskWorkspaceConversationSlotProps;
  selectedRun: NonNullable<TaskWorkspaceConversationSlotProps["selectedRun"]>;
  t: ReturnType<typeof createTranslator>;
}) {
  const recordId = selectedRun.item.run.record.recordId;
  const viewportRef = useRef<HTMLDivElement>(null);
  const visitedRecordIds = useRef(new Set<string>());
  const [following, setFollowing] = useState(selectedRun.item.active);
  const [artifactError, setArtifactError] = useState<string | null>(null);

  const scrollToBottom = useCallback(
    (behavior: ScrollBehavior = "smooth") => {
      const viewport = viewportRef.current;
      if (!viewport) return;
      if (typeof viewport.scrollTo === "function") {
        viewport.scrollTo({ top: viewport.scrollHeight, behavior });
      } else {
        viewport.scrollTop = viewport.scrollHeight;
      }
      props.onRunScrollTopChange(recordId, viewport.scrollHeight);
      setFollowing(true);
    },
    [props.onRunScrollTopChange, recordId]
  );

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const firstVisit = !visitedRecordIds.current.has(recordId);
    visitedRecordIds.current.add(recordId);
    const storedTop = props.getRunScrollTop(recordId);
    if (selectedRun.item.active && firstVisit) {
      scrollToBottom("auto");
      return;
    }
    viewport.scrollTop = storedTop;
    setFollowing(
      selectedRun.item.active &&
        viewport.scrollHeight - storedTop - viewport.clientHeight <= bottomThreshold
    );
  }, [props.getRunScrollTop, recordId, scrollToBottom, selectedRun.item.active]);

  useLayoutEffect(() => {
    void model.cursor.afterSequence;
    if (selectedRun.item.active && following) scrollToBottom("auto");
  }, [following, model.cursor.afterSequence, scrollToBottom, selectedRun.item.active]);

  const revealArtifact = api?.revealRunnerRecordArtifact;

  return (
    <section
      className="flex h-full min-h-0 flex-col overflow-hidden"
      data-record-id={recordId}
      data-record-ready="true"
      data-testid="task-workspace-acp-conversation"
    >
      <div className="shrink-0 px-5 pt-5">
        <TaskWorkspaceInteractionCards
          api={api}
          canvasRef={canvasRef}
          model={model}
          recordId={recordId}
          sessionIdentity={selectedRun.item.run.capabilities.cancel.identity}
          t={t}
        />
        {props.subscriptionError ? (
          <p
            className="mt-3 rounded-md border border-destructive/40 p-3 text-sm text-destructive"
            role="alert"
          >
            {t("acpSubscriptionError")}: {props.subscriptionError}
          </p>
        ) : null}
        {artifactError ? (
          <p
            className="mt-3 rounded-md border border-destructive/40 p-3 text-sm text-destructive"
            role="alert"
          >
            {t("acpArtifactOpenError")}: {artifactError}
          </p>
        ) : null}
      </div>
      <div className="relative min-h-0 flex-1">
        <section
          aria-label={`${t("acpConversation")} · ${selectedRun.block.title}`}
          className="h-full overflow-y-auto px-5 pt-5 pb-[calc(var(--task-workspace-composer-height,0px)+1.25rem)] [scrollbar-gutter:stable_both-edges]"
          data-testid="task-workspace-conversation-viewport"
          onScroll={(event) => {
            const viewport = event.currentTarget;
            props.onRunScrollTopChange(recordId, viewport.scrollTop);
            setFollowing(
              selectedRun.item.active &&
                viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight <=
                  bottomThreshold
            );
          }}
          ref={viewportRef}
        >
          <div
            className="mx-auto w-full max-w-3xl space-y-4"
            data-testid="task-workspace-conversation-content"
          >
            <AcpConversationItems
              presentation="workspace"
              renderArtifact={({ artifact, sequence }) => (
                <ArtifactFileLink
                  artifact={artifact}
                  fullPath={props.selectedRecord?.reportPath ?? artifact.relativePath}
                  key={`artifact-${sequence}-${artifact.relativePath}`}
                  onReveal={
                    revealArtifact && canvasRef
                      ? async () => {
                          setArtifactError(null);
                          try {
                            await revealArtifact(canvasRef, recordId, artifact);
                          } catch (caught) {
                            setArtifactError(
                              caught instanceof Error ? caught.message : String(caught)
                            );
                          }
                        }
                      : null
                  }
                />
              )}
              timeline={model.timeline}
              t={t}
            />
          </div>
        </section>
        {!following && selectedRun.item.active ? (
          <Button
            className="absolute bottom-4 left-1/2 -translate-x-1/2 shadow-md"
            onClick={() => scrollToBottom()}
            size="sm"
            type="button"
            variant="secondary"
          >
            <ArrowDownIcon />
            {t("acpJumpToLatest")}
          </Button>
        ) : null}
      </div>
    </section>
  );
}

function ArtifactFileLink({
  artifact,
  fullPath,
  onReveal
}: {
  artifact: ArtifactReference;
  fullPath: string;
  onReveal: (() => Promise<void>) | null;
}) {
  return (
    <div className="text-sm">
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              aria-disabled={!onReveal}
              className="inline-flex items-center gap-1.5 font-medium text-sky-500 underline-offset-4 hover:text-sky-600 hover:underline focus-visible:rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 aria-disabled:cursor-default dark:text-sky-400 dark:hover:text-sky-300"
              onClick={() => void onReveal?.()}
              type="button"
            >
              <ArtifactFileTypeIcon path={artifact.relativePath} />
              {artifact.relativePath}
            </button>
          </TooltipTrigger>
          <TooltipContent className="max-w-md break-all font-mono" side="top">
            {fullPath}
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    </div>
  );
}

function ArtifactFileTypeIcon({ path }: { path: string }) {
  const extension = path.split(".").pop()?.toLowerCase() ?? "";
  if (extension === "tsx" || extension === "jsx") {
    return <AtomIcon aria-hidden="true" className="size-4 shrink-0" data-file-type={extension} />;
  }

  const label =
    extension === "md" || extension === "mdx"
      ? "MD"
      : extension === "ts" || extension === "mts" || extension === "cts"
        ? "TS"
        : extension === "js" || extension === "mjs" || extension === "cjs"
          ? "JS"
          : null;

  return label ? (
    <span
      aria-hidden="true"
      className="inline-flex size-4 shrink-0 items-center justify-center rounded-[3px] bg-sky-500 text-[7px] font-bold leading-none text-white dark:bg-sky-400 dark:text-slate-950"
      data-file-type={extension}
    >
      {label}
    </span>
  ) : (
    <FileIcon aria-hidden="true" className="size-4 shrink-0" data-file-type="file" />
  );
}

function ConversationState({
  detailKind,
  message,
  recordId,
  recordReady,
  role
}: {
  detailKind?: "error" | "loading" | "unavailable" | "unsupported";
  message: string;
  recordId?: string;
  recordReady?: boolean;
  role?: "alert";
}) {
  return (
    <section
      className="flex h-full items-center justify-center p-6"
      data-detail-kind={detailKind}
      data-record-id={recordId}
      data-record-ready={recordReady === undefined ? undefined : recordReady ? "true" : "false"}
      data-testid="task-workspace-run-detail"
      role={role}
    >
      <p
        className={
          role === "alert"
            ? "max-w-xl text-sm text-destructive"
            : "max-w-xl text-sm text-muted-foreground"
        }
      >
        {message}
      </p>
    </section>
  );
}
