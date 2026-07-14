import type {
  ArtifactReference,
  DesktopBridgeApi,
  DesktopCanvasReference
} from "@planweave-ai/runtime";
import { ArrowDownIcon } from "lucide-react";
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

type ConversationApi = Partial<Pick<
  DesktopBridgeApi,
  | "cancelAgentRun"
  | "detectTerminalApps"
  | "getTerminalPreferences"
  | "openTerminal"
  | "respondToAgentRequest"
  | "revealRunnerRecordArtifact"
  | "updateTerminalPreferences"
>>;

export function TaskWorkspaceConversation(props: TaskWorkspaceConversationSlotProps & {
  api?: ConversationApi | null;
  canvasRef: DesktopCanvasReference;
  t: ReturnType<typeof createTranslator>;
}) {
  const { api = bridge, runnerModel, selectedRecord, selectedRun, t } = props;
  const { canvasRef } = props;

  if (!selectedRun) return <ConversationState message={t("taskWorkspaceNoConversation")} />;
  if (!selectedRecord) {
    const message = props.liveStatus === "loading"
      ? t("taskWorkspaceLoadingSelectedRun")
      : props.recordError ?? t("taskWorkspaceRecordUnavailable");
    return <ConversationState message={message} role={props.recordError ? "alert" : undefined} />;
  }
  if (selectedRecord.recordId !== selectedRun.item.run.record.recordId) {
    return <ConversationState message={t("taskWorkspaceRecordMismatch")} role="alert" />;
  }
  const runnerKind = selectedRun.item.run.metadata.runnerKind;
  if (runnerKind === "cli") {
    return <TaskWorkspaceCliRun api={api} canvasRef={canvasRef} record={selectedRecord} t={t} />;
  }
  if (runnerKind !== "acp") {
    return <ConversationState message={t("taskWorkspaceUnsupportedTransport")} role="alert" />;
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

function AcpConversationUnavailable({ props, selectedRun, t }: {
  props: TaskWorkspaceConversationSlotProps;
  selectedRun: NonNullable<TaskWorkspaceConversationSlotProps["selectedRun"]>;
  t: ReturnType<typeof createTranslator>;
}) {
  const error = props.recordError ?? props.subscriptionError;
  if (error || props.liveStatus === "error") {
    return (
      <ConversationState
        message={error ?? t("taskWorkspaceAcpLoadFailed")}
        role="alert"
      />
    );
  }
  if (props.liveStatus === "loading") {
    return <ConversationState message={t("taskWorkspaceAcpLoading")} />;
  }
  if (props.liveStatus === "live") {
    return <ConversationState message={t("taskWorkspaceAcpLiveModelUnavailable")} role="alert" />;
  }
  const message = props.liveUnavailableReason ??
    selectedRun.item.run.capabilities.prompt.reason ??
    t("taskWorkspaceAcpUnavailable");
  return <ConversationState message={message} />;
}

function AcpRunConversation({ api, canvasRef, model, props, selectedRun, t }: {
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

  const scrollToBottom = useCallback((behavior: ScrollBehavior = "smooth") => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    if (typeof viewport.scrollTo === "function") {
      viewport.scrollTo({ top: viewport.scrollHeight, behavior });
    } else {
      viewport.scrollTop = viewport.scrollHeight;
    }
    props.onRunScrollTopChange(recordId, viewport.scrollHeight);
    setFollowing(true);
  }, [props.onRunScrollTopChange, recordId]);

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
    if (selectedRun.item.active && following) scrollToBottom("auto");
  }, [following, model.cursor.afterSequence, scrollToBottom, selectedRun.item.active]);

  const artifacts = model.events.flatMap((event) =>
    event.body.kind === "artifact"
      ? [{ artifact: event.body.artifact, sequence: event.sequence }]
      : []
  );
  const revealArtifact = api?.revealRunnerRecordArtifact;

  return (
    <section className="flex h-full min-h-0 flex-col overflow-hidden" data-testid="task-workspace-acp-conversation">
      <div className="shrink-0 px-5 pt-5">
        <TaskWorkspaceInteractionCards
          api={api}
          model={model}
          sessionIdentity={selectedRun.item.run.capabilities.cancel.identity}
          t={t}
        />
        {props.subscriptionError ? (
          <p className="mt-3 rounded-md border border-destructive/40 p-3 text-sm text-destructive" role="alert">
            {t("acpSubscriptionError")}: {props.subscriptionError}
          </p>
        ) : null}
        {artifactError ? (
          <p className="mt-3 rounded-md border border-destructive/40 p-3 text-sm text-destructive" role="alert">
            {t("acpArtifactOpenError")}: {artifactError}
          </p>
        ) : null}
      </div>
      <div className="relative min-h-0 flex-1">
        <div
          aria-label={`${t("acpConversation")} · ${selectedRun.block.title}`}
          className="h-full overflow-y-auto px-5 py-5"
          data-testid="task-workspace-conversation-viewport"
          onScroll={(event) => {
            const viewport = event.currentTarget;
            props.onRunScrollTopChange(recordId, viewport.scrollTop);
            setFollowing(
              selectedRun.item.active &&
              viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight <= bottomThreshold
            );
          }}
          ref={viewportRef}
          role="region"
          tabIndex={0}
        >
          <div className="mx-auto w-full max-w-3xl space-y-4" data-testid="task-workspace-conversation-content">
            <AcpConversationItems presentation="workspace" timeline={model.timeline} t={t} />
            {artifacts.map(({ artifact, sequence }) => (
              <ArtifactFileLink
                artifact={artifact}
                fullPath={props.selectedRecord?.reportPath ?? artifact.relativePath}
                key={`${sequence}-${artifact.relativePath}`}
                onReveal={revealArtifact && canvasRef
                  ? async () => {
                      setArtifactError(null);
                      try {
                        await revealArtifact(canvasRef, recordId, artifact);
                      } catch (caught) {
                        setArtifactError(caught instanceof Error ? caught.message : String(caught));
                      }
                    }
                  : null}
              />
            ))}
          </div>
        </div>
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

function ArtifactFileLink({ artifact, fullPath, onReveal }: {
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
              className="font-medium text-primary underline-offset-4 hover:underline focus-visible:rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 aria-disabled:cursor-default"
              onClick={() => void onReveal?.()}
              type="button"
            >
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

function ConversationState({ message, role }: { message: string; role?: "alert" }) {
  return (
    <section className="flex h-full items-center justify-center p-6" role={role}>
      <p className={role === "alert" ? "max-w-xl text-sm text-destructive" : "max-w-xl text-sm text-muted-foreground"}>{message}</p>
    </section>
  );
}
