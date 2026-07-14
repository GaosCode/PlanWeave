import type {
  ArtifactReference,
  NormalizedRunnerEvent,
  TaskWorkspaceRun
} from "@planweave-ai/runtime";
import { ChevronRightIcon, XIcon } from "lucide-react";
import { useState } from "react";
import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { VerticalResizeHandle } from "../../components/VerticalResizeHandle";
import type { TaskWorkspaceInspectorSlotProps } from "../contracts";
import { taskWorkspaceRunStatus } from "../timeline/timelineProjection";
import { taskWorkspacePanelMaxWidth, taskWorkspacePanelMinWidth } from "../useTaskWorkspaceLayout";
import { DeferredInspectorSection } from "./DeferredInspectorSection";
import { displayConfigurationValue } from "./formatters";
import { TaskWorkspaceUsageDetails } from "./TaskWorkspaceUsage";
import type { TaskWorkspaceUsageLabels } from "./TaskWorkspaceUsage";
import { useInspectorResize } from "./useInspectorResize";

type EventKind = NormalizedRunnerEvent["body"]["kind"];
type ArtifactKind = ArtifactReference["kind"];
type AvailableConfiguration = Extract<TaskWorkspaceRun["actualConfiguration"], { available: true }>;
type ActualConfigurationField = AvailableConfiguration["fields"]["model"];
type SessionConfigOption = AvailableConfiguration["protocol"]["configOptions"][number];

export type TaskWorkspaceInspectorLabels = {
  actualConfiguration: string;
  artifactKinds: Record<ArtifactKind, string>;
  artifacts: string;
  block: string;
  closeInspector: string;
  configurationUnavailable: string;
  currentMode: string;
  diagnostics: string;
  emptyDiagnostics: string;
  emptyEvents: string;
  eventKinds: Record<EventKind, string>;
  events: string;
  false: string;
  fileChangesUnavailable: string;
  files: string;
  formatDateTime: (value: string) => string;
  historyUnavailable: string;
  latestTaskArtifact: string;
  metadataFile: string;
  mode: string;
  model: string;
  noArtifact: string;
  noSelection: string;
  observedAt: string;
  options: string;
  overview: string;
  permission: string;
  promptFile: string;
  protocolDetails: string;
  reasoning: string;
  reportFile: string;
  resizeInspector: string;
  run: string;
  runArtifact: string;
  runStatus: {
    cancelled: string;
    completed: string;
    failed: string;
    recorded: string;
    running: string;
  };
  sequence: (sequence: number) => string;
  session: string;
  showingLatest: (visible: number, total: number) => string;
  status: string;
  task: string;
  true: string;
  unavailable: string;
  usage: string;
  usageLabels: TaskWorkspaceUsageLabels;
  workingDirectory: string;
};

function DefinitionRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="grid min-w-0 grid-cols-[minmax(5rem,0.8fr)_minmax(0,1.2fr)] gap-3 py-1.5">
      <dt className="min-w-0 text-xs text-text-muted">{label}</dt>
      <dd className="min-w-0 text-right text-xs font-medium break-words">{value}</dd>
    </div>
  );
}

function PathValue({ value }: { value: string }) {
  return <span className="font-mono text-[11px] break-all">{value}</span>;
}

function ConfigurationField({
  field,
  label,
  labels
}: {
  field: ActualConfigurationField;
  label: string;
  labels: TaskWorkspaceInspectorLabels;
}) {
  return (
    <DefinitionRow
      label={label}
      value={
        field.available ? (
          displayConfigurationValue(field.value, { false: labels.false, true: labels.true })
        ) : (
          <span className="text-text-muted">
            {labels.unavailable}
            <span className="mt-0.5 block text-[10px] font-normal break-words">{field.reason}</span>
          </span>
        )
      }
    />
  );
}

function ProtocolOption({
  option,
  labels
}: {
  labels: TaskWorkspaceInspectorLabels;
  option: SessionConfigOption;
}) {
  return (
    <li className="border-l border-border pl-2">
      <div className="text-xs font-medium">{option.name}</div>
      <div className="font-mono text-[11px] text-text-muted break-all">
        {displayConfigurationValue(option.currentValue, {
          false: labels.false,
          true: labels.true
        })}
      </div>
      {option.description ? (
        <p className="mt-0.5 text-[11px] text-text-muted">{option.description}</p>
      ) : null}
    </li>
  );
}

function ProtocolDetails({
  labels,
  protocol
}: {
  labels: TaskWorkspaceInspectorLabels;
  protocol: AvailableConfiguration["protocol"];
}) {
  const [open, setOpen] = useState(false);

  return (
    <details
      className="group mt-2 rounded-md border border-border/80"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary className="flex cursor-pointer list-none items-center gap-1.5 px-2 py-1.5 text-xs font-medium outline-none hover:bg-app-hover focus-visible:ring-2 focus-visible:ring-ring/40 [&::-webkit-details-marker]:hidden">
        <ChevronRightIcon
          aria-hidden="true"
          className="size-3.5 transition-transform group-open:rotate-90"
        />
        {labels.protocolDetails}
      </summary>
      {open ? (
        <div className="space-y-3 border-t border-border/80 p-2">
          <div>
            <div className="text-[11px] font-semibold text-text-muted uppercase">
              {labels.currentMode}
            </div>
            <p className="mt-1 font-mono text-[11px] break-all">
              {protocol.modes?.currentModeId ?? labels.unavailable}
            </p>
          </div>
          <div>
            <div className="text-[11px] font-semibold text-text-muted uppercase">
              {labels.options}
            </div>
            {protocol.configOptions.length > 0 ? (
              <ul className="mt-1 space-y-2">
                {protocol.configOptions.map((option) => (
                  <ProtocolOption key={option.id} labels={labels} option={option} />
                ))}
              </ul>
            ) : (
              <p className="mt-1 text-xs text-text-muted">{labels.unavailable}</p>
            )}
          </div>
        </div>
      ) : null}
    </details>
  );
}

function runStatus(
  selectedRun: TaskWorkspaceInspectorSlotProps["selectedRun"],
  labels: TaskWorkspaceInspectorLabels
) {
  if (!selectedRun) return labels.runStatus.recorded;
  switch (taskWorkspaceRunStatus(selectedRun.item)) {
    case "active":
    case "waiting":
      return labels.runStatus.running;
    case "cancelled":
      return labels.runStatus.cancelled;
    case "completed":
      return labels.runStatus.completed;
    case "failed":
      return labels.runStatus.failed;
  }
}

function artifactPath(
  reference: ArtifactReference | null,
  reportPath: string | null
): string | null {
  return reference?.relativePath ?? reportPath;
}

const historyLimit = 100;

export function TaskWorkspaceInspector({
  inspectorCollapsed,
  inspectorWidth,
  labels,
  runnerModel,
  selectedRecord,
  selectedRun,
  setInspectorCollapsed,
  setInspectorWidth,
  workspace
}: TaskWorkspaceInspectorSlotProps & { labels: TaskWorkspaceInspectorLabels }) {
  const resize = useInspectorResize({ inspectorWidth, setInspectorWidth });

  if (inspectorCollapsed) {
    return null;
  }

  const selectedRecordId = selectedRun?.item.run.record.recordId ?? null;
  const authoritativeRecord = selectedRecord?.recordId === selectedRecordId ? selectedRecord : null;
  const diagnostics = runnerModel?.diagnostics ?? [];
  const visibleDiagnostics = diagnostics.slice(-historyLimit);
  const configuration = selectedRun?.item.run.actualConfiguration ?? null;
  const latestArtifact = workspace?.latestArtifact ?? null;
  const latestArtifactDisplay = latestArtifact
    ? artifactPath(latestArtifact.reference, latestArtifact.reportPath)
    : null;

  return (
    <aside className="relative min-h-full min-w-0" aria-label={labels.overview}>
      <VerticalResizeHandle
        aria-label={labels.resizeInspector}
        aria-orientation="vertical"
        aria-valuemax={taskWorkspacePanelMaxWidth}
        aria-valuemin={taskWorkspacePanelMinWidth}
        aria-valuenow={inspectorWidth}
        onKeyDown={resize.resizeWithKeyboard}
        onPointerDown={resize.startResize}
        role="separator"
        side="left"
        tabIndex={0}
      />

      <header className="sticky top-0 z-[1] flex min-w-0 items-center gap-2 border-b border-border bg-app-panel/95 px-3 py-2 backdrop-blur">
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-xs font-semibold tracking-wide uppercase">
            {labels.overview}
          </h2>
          <p className="truncate font-mono text-[10px] text-text-muted">
            {selectedRun?.item.run.record.runId ?? labels.noSelection}
          </p>
        </div>
        <Button
          aria-label={labels.closeInspector}
          onClick={() => setInspectorCollapsed(true)}
          size="icon-sm"
          type="button"
          variant="ghost"
        >
          <XIcon />
        </Button>
      </header>

      {!selectedRun || !workspace ? (
        <p className="p-4 text-center text-xs text-text-muted">{labels.noSelection}</p>
      ) : (
        <div className="min-w-0">
          <section
            className="space-y-3 border-b border-border/80 p-3"
            aria-labelledby="inspector-overview"
          >
            <h3
              id="inspector-overview"
              className="text-xs font-semibold tracking-wide text-text-muted uppercase"
            >
              {labels.overview}
            </h3>
            <dl>
              <DefinitionRow label={labels.task} value={workspace.task.title} />
              <DefinitionRow label={labels.block} value={selectedRun.block.title} />
              <DefinitionRow
                label={labels.run}
                value={<PathValue value={selectedRun.item.run.record.runId} />}
              />
              <DefinitionRow
                label={labels.status}
                value={
                  <Badge variant="outline">
                    {runStatus(selectedRun, labels)}
                  </Badge>
                }
              />
            </dl>

            <div className="border-t border-border/70 pt-2">
              <h4 className="mb-1 text-xs font-semibold">{labels.actualConfiguration}</h4>
              {configuration?.available ? (
                <>
                  <dl>
                    <ConfigurationField
                      field={configuration.fields.model}
                      label={labels.model}
                      labels={labels}
                    />
                    <ConfigurationField
                      field={configuration.fields.reasoning}
                      label={labels.reasoning}
                      labels={labels}
                    />
                    <ConfigurationField
                      field={configuration.fields.mode}
                      label={labels.mode}
                      labels={labels}
                    />
                    <ConfigurationField
                      field={configuration.fields.permission}
                      label={labels.permission}
                      labels={labels}
                    />
                    <DefinitionRow
                      label={labels.session}
                      value={<PathValue value={configuration.sessionId} />}
                    />
                    <DefinitionRow
                      label={labels.observedAt}
                      value={labels.formatDateTime(configuration.observedAt)}
                    />
                  </dl>
                  <ProtocolDetails labels={labels} protocol={configuration.protocol} />
                </>
              ) : (
                <div className="text-xs text-text-muted">
                  <p>{labels.configurationUnavailable}</p>
                  {configuration ? (
                    <p className="mt-1 text-[10px]">{configuration.reason}</p>
                  ) : null}
                </div>
              )}
            </div>
          </section>

          <section className="border-b border-border/80 p-3" aria-labelledby="inspector-files">
            <h3
              id="inspector-files"
              className="text-xs font-semibold tracking-wide text-text-muted uppercase"
            >
              {labels.files}
            </h3>
            {authoritativeRecord ? (
              <dl className="mt-2">
                {authoritativeRecord.promptPath ? (
                  <DefinitionRow
                    label={labels.promptFile}
                    value={<PathValue value={authoritativeRecord.promptPath} />}
                  />
                ) : null}
                {authoritativeRecord.reportPath ? (
                  <DefinitionRow
                    label={labels.reportFile}
                    value={<PathValue value={authoritativeRecord.reportPath} />}
                  />
                ) : null}
                <DefinitionRow
                  label={labels.metadataFile}
                  value={<PathValue value={authoritativeRecord.metadataPath} />}
                />
                {authoritativeRecord.executionCwd ? (
                  <DefinitionRow
                    label={labels.workingDirectory}
                    value={<PathValue value={authoritativeRecord.executionCwd} />}
                  />
                ) : null}
              </dl>
            ) : (
              <p className="mt-2 text-xs text-text-muted">{labels.historyUnavailable}</p>
            )}
            <p className="mt-2 border-l-2 border-border pl-2 text-[11px] text-text-muted">
              {labels.fileChangesUnavailable}
            </p>
          </section>

          <section className="border-b border-border/80 p-3" aria-labelledby="inspector-artifacts">
            <h3
              id="inspector-artifacts"
              className="text-xs font-semibold tracking-wide text-text-muted uppercase"
            >
              {labels.artifacts}
            </h3>
            <dl className="mt-2">
              {authoritativeRecord?.reportPath ? (
                <DefinitionRow
                  label={labels.runArtifact}
                  value={<PathValue value={authoritativeRecord.reportPath} />}
                />
              ) : null}
              {latestArtifactDisplay ? (
                <DefinitionRow
                  label={labels.latestTaskArtifact}
                  value={
                    <span>
                      <PathValue value={latestArtifactDisplay} />
                      {latestArtifact?.reference ? (
                        <span className="mt-0.5 block text-[10px] text-text-muted">
                          {labels.artifactKinds[latestArtifact.reference.kind]}
                        </span>
                      ) : null}
                    </span>
                  }
                />
              ) : null}
            </dl>
            {!authoritativeRecord?.reportPath && !latestArtifactDisplay ? (
              <p className="mt-2 text-xs text-text-muted">{labels.noArtifact}</p>
            ) : null}
          </section>

          <section className="border-b border-border/80 p-3" aria-labelledby="inspector-usage">
            <h3
              id="inspector-usage"
              className="mb-3 text-xs font-semibold tracking-wide text-text-muted uppercase"
            >
              {labels.usage}
            </h3>
            <TaskWorkspaceUsageDetails
              labels={labels.usageLabels}
              selectedRun={selectedRun}
              workspace={workspace}
            />
          </section>

          <DeferredInspectorSection
            count={diagnostics.length}
            empty={runnerModel ? labels.emptyDiagnostics : labels.historyUnavailable}
            label={labels.diagnostics}
            renderContent={() => (
              <div className="space-y-2">
                {diagnostics.length > visibleDiagnostics.length ? (
                  <p className="text-[11px] text-text-muted">
                    {labels.showingLatest(visibleDiagnostics.length, diagnostics.length)}
                  </p>
                ) : null}
                <ul className="space-y-2">
                  {visibleDiagnostics.map((diagnostic, index) => (
                    <li
                      className="border-l-2 border-destructive/60 pl-2"
                      key={`${diagnostic.code}:${diagnostic.line ?? "none"}:${index}`}
                    >
                      <div className="font-mono text-[10px] text-destructive">
                        {diagnostic.code}
                      </div>
                      <p className="mt-0.5 text-xs break-words">{diagnostic.message}</p>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          />
        </div>
      )}
    </aside>
  );
}
