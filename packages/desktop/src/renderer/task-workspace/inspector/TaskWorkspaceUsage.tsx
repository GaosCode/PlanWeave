import type { TaskWorkspace } from "@planweave-ai/runtime";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { useId } from "react";
import type { TaskWorkspaceSelectedRun } from "../contracts";
import { LiveAgentTimeText, LiveRunElapsedText, LiveTaskWallClockText } from "../LiveDurationText";
import { clampedContextUsagePercent, contextUsagePercent } from "./formatters";

export type TaskWorkspaceUsageLabels = {
  agent: string;
  agentTime: string;
  contextSnapshot: string;
  contextUnavailable: string;
  contextUsage: string;
  cost: string;
  currentContext: string;
  currentRun: string;
  formatCost: (amount: number, currency: string) => string;
  formatDateTime: (value: string) => string;
  formatDuration: (milliseconds: number) => string;
  formatNumber: (value: number) => string;
  mode: string;
  model: string;
  noSnapshotCost: string;
  observedAt: string;
  partialAgentTime: (includedRunCount: number, missingRunCount: number) => string;
  permission: string;
  reportedSnapshotCost: string;
  reasoning: string;
  runCost: string;
  runCostUnavailable: string;
  runWallClock: string;
  taskCost: string;
  taskTotal: string;
  taskTokens: string;
  taskWallClock: string;
  tokens: string;
  tokensUsed: (usedTokens: string, contextWindowTokens: string) => string;
  unavailable: string;
  usagePercent: (percent: number) => string;
};

function UnavailableValue({ reason, unavailable }: { reason: string; unavailable: string }) {
  return (
    <span className="block text-text-muted">
      {unavailable}
      <span className="mt-0.5 block max-w-52 text-[10px] font-normal break-words">{reason}</span>
    </span>
  );
}

function Metric({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] gap-3 py-1">
      <dt className="min-w-0 text-text-muted">{label}</dt>
      <dd className="min-w-0 max-w-44 text-right font-medium break-words">{value}</dd>
    </div>
  );
}

function ConfigurationValue({
  reason,
  unavailable,
  value
}: {
  reason: string | null;
  unavailable: string;
  value: string | null;
}) {
  if (value) return <>{value}</>;
  return (
    <span className="block max-w-56 text-right text-text-muted">
      {unavailable}
      {reason ? (
        <span className="mt-0.5 block text-[10px] font-normal break-words">{reason}</span>
      ) : null}
    </span>
  );
}

export function TaskWorkspaceUsageDetails({
  labels,
  selectedRun,
  workspace
}: {
  labels: TaskWorkspaceUsageLabels;
  selectedRun: TaskWorkspaceSelectedRun | null;
  workspace: TaskWorkspace | null;
}) {
  const id = useId();
  const run = selectedRun?.item.run ?? null;
  const snapshot = run?.usage.currentContext ?? null;
  const wallClock = workspace?.duration.wallClock ?? null;
  const agentTime = workspace?.duration.agentTime ?? null;
  const runWallClock =
    selectedRun !== null ? (
      <LiveRunElapsedText
        active={selectedRun.item.active}
        finishedAt={selectedRun.item.run.duration.finishedAt}
        formatDuration={labels.formatDuration}
        startedAt={selectedRun.item.run.duration.startedAt}
        unavailable={labels.unavailable}
        wallClockMs={selectedRun.item.run.duration.wallClockMs}
      />
    ) : (
      <UnavailableValue reason={labels.unavailable} unavailable={labels.unavailable} />
    );
  const runWallClockUnavailable =
    selectedRun === null ||
    (selectedRun.item.run.duration.startedAt === null &&
      selectedRun.item.run.duration.wallClockMs === null);

  return (
    <div className="space-y-3 text-xs">
      <section aria-labelledby={`${id}-current-context`}>
        <h3 id={`${id}-current-context`} className="font-semibold text-text">
          {labels.currentContext}
        </h3>
        <dl className="mt-1 border-l-2 border-primary/50 pl-2">
          <Metric
            label={labels.tokens}
            value={
              snapshot ? (
                labels.tokensUsed(
                  labels.formatNumber(snapshot.usedTokens),
                  labels.formatNumber(snapshot.contextWindowTokens)
                )
              ) : (
                <UnavailableValue
                  reason={labels.contextUnavailable}
                  unavailable={labels.unavailable}
                />
              )
            }
          />
          {snapshot ? (
            <Metric
              label={labels.contextSnapshot}
              value={labels.usagePercent(
                contextUsagePercent(snapshot.usedTokens, snapshot.contextWindowTokens)
              )}
            />
          ) : null}
          <Metric
            label={labels.cost}
            value={
              snapshot?.cost ? (
                <span>
                  {labels.formatCost(snapshot.cost.amount, snapshot.cost.currency)}
                  <span className="mt-0.5 block text-[10px] font-normal text-text-muted">
                    {labels.reportedSnapshotCost}
                  </span>
                </span>
              ) : (
                <UnavailableValue reason={labels.noSnapshotCost} unavailable={labels.unavailable} />
              )
            }
          />
          {snapshot ? (
            <Metric label={labels.observedAt} value={labels.formatDateTime(snapshot.observedAt)} />
          ) : null}
        </dl>
      </section>

      <section aria-labelledby={`${id}-current-run`}>
        <h3 id={`${id}-current-run`} className="font-semibold text-text">
          {labels.currentRun}
        </h3>
        <dl className="mt-1 border-l-2 border-border pl-2">
          <Metric
            label={labels.tokens}
            value={
              run ? (
                <UnavailableValue
                  reason={run.usage.runTokens.reason}
                  unavailable={labels.unavailable}
                />
              ) : (
                <UnavailableValue reason={labels.unavailable} unavailable={labels.unavailable} />
              )
            }
          />
          <Metric
            label={labels.runCost}
            value={
              <UnavailableValue
                reason={labels.runCostUnavailable}
                unavailable={labels.unavailable}
              />
            }
          />
          <Metric
            label={labels.runWallClock}
            value={
              runWallClockUnavailable ? (
                <UnavailableValue
                  reason={run?.duration.unavailableReason ?? labels.unavailable}
                  unavailable={labels.unavailable}
                />
              ) : (
                runWallClock
              )
            }
          />
        </dl>
      </section>

      <section aria-labelledby={`${id}-task-total`}>
        <h3 id={`${id}-task-total`} className="font-semibold text-text">
          {labels.taskTotal}
        </h3>
        <dl className="mt-1 border-l-2 border-border pl-2">
          <Metric
            label={labels.taskTokens}
            value={
              <UnavailableValue
                reason={workspace?.usage.taskTokens.reason ?? labels.unavailable}
                unavailable={labels.unavailable}
              />
            }
          />
          <Metric
            label={labels.taskCost}
            value={
              <UnavailableValue
                reason={workspace?.usage.taskCost.reason ?? labels.unavailable}
                unavailable={labels.unavailable}
              />
            }
          />
          <Metric
            label={labels.taskWallClock}
            value={
              wallClock?.available ||
              (workspace !== null && workspace.activeRecordIds.length > 0) ? (
                <LiveTaskWallClockText
                  formatDuration={labels.formatDuration}
                  unavailable={labels.unavailable}
                  workspace={workspace}
                />
              ) : (
                <UnavailableValue
                  reason={wallClock?.unavailableReason ?? labels.unavailable}
                  unavailable={labels.unavailable}
                />
              )
            }
          />
          <Metric
            label={labels.agentTime}
            value={
              (agentTime && agentTime.availability !== "unavailable") ||
              (workspace !== null && workspace.activeRecordIds.length > 0) ? (
                <LiveAgentTimeText
                  formatDuration={labels.formatDuration}
                  partialLabel={labels.partialAgentTime}
                  unavailable={labels.unavailable}
                  workspace={workspace}
                />
              ) : (
                <UnavailableValue
                  reason={agentTime?.reason ?? labels.unavailable}
                  unavailable={labels.unavailable}
                />
              )
            }
          />
        </dl>
      </section>
    </div>
  );
}

export function TaskWorkspaceUsage({
  labels,
  selectedRun,
  workspace: _workspace
}: {
  labels: TaskWorkspaceUsageLabels;
  selectedRun: TaskWorkspaceSelectedRun | null;
  workspace: TaskWorkspace | null;
}) {
  const snapshot = selectedRun?.item.run.usage.currentContext ?? null;
  const percent = snapshot
    ? contextUsagePercent(snapshot.usedTokens, snapshot.contextWindowTokens)
    : null;
  const ringPercent = snapshot
    ? clampedContextUsagePercent(snapshot.usedTokens, snapshot.contextWindowTokens)
    : 0;
  const configuration = selectedRun?.item.run.actualConfiguration;
  const configurationField = (field: "mode" | "model" | "permission" | "reasoning") => {
    if (!configuration) return { reason: null, value: null };
    if (!configuration.available) return { reason: configuration.reason, value: null };
    const value = configuration.fields[field];
    return value.available
      ? { reason: null, value: String(value.value) }
      : { reason: value.reason, value: null };
  };
  const run = selectedRun?.item.run ?? null;
  const agent = run?.metadata.agentId ?? run?.metadata.executor ?? run?.metadata.adapter ?? null;
  const model = configurationField("model");
  const reasoning = configurationField("reasoning");
  const sessionMetadata = [
    agent ? { key: "agent", label: labels.agent, value: agent } : null,
    ...(["model", "reasoning", "mode", "permission"] as const).map((field) => {
      const value = configurationField(field).value;
      return value ? { key: field, label: labels[field], value } : null;
    })
  ].filter((item): item is { key: string; label: string; value: string } => item !== null);
  const triggerLabel = snapshot
    ? `${labels.contextUsage}: ${labels.tokensUsed(
        labels.formatNumber(snapshot.usedTokens),
        labels.formatNumber(snapshot.contextWindowTokens)
      )}; ${labels.usagePercent(percent ?? 0)}; ${labels.contextSnapshot}`
    : `${labels.contextUsage}: ${labels.unavailable}`;

  return (
    <TooltipProvider>
      <div className="flex min-w-0 items-center gap-2">
        <dl className="flex min-w-0 items-center gap-1 text-[11px] text-text-muted">
          {sessionMetadata.map(({ key, label, value }, index) => (
            <div className="flex min-w-0 items-center gap-1" key={key}>
              {index > 0 ? (
                <span aria-hidden="true" className="text-border">
                  ·
                </span>
              ) : null}
              <dt className="sr-only">{label}</dt>
              <dd
                className="max-w-20 truncate font-medium text-text sm:max-w-28"
                title={`${label}: ${value}`}
              >
                {key === "agent" ? (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        aria-label={`${label}: ${value}`}
                        className="max-w-full truncate rounded-sm outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
                        type="button"
                      >
                        {value}
                      </button>
                    </TooltipTrigger>
                    <TooltipContent align="end" side="top">
                      <dl className="grid grid-cols-[auto_auto] gap-x-3 gap-y-1 text-xs">
                        <dt className="text-text-muted">{labels.model}</dt>
                        <dd className="text-right font-medium text-text">
                          <ConfigurationValue
                            reason={model.reason}
                            unavailable={labels.unavailable}
                            value={model.value}
                          />
                        </dd>
                        <dt className="text-text-muted">{labels.reasoning}</dt>
                        <dd className="text-right font-medium text-text">
                          <ConfigurationValue
                            reason={reasoning.reason}
                            unavailable={labels.unavailable}
                            value={reasoning.value}
                          />
                        </dd>
                      </dl>
                    </TooltipContent>
                  </Tooltip>
                ) : (
                  value
                )}
              </dd>
            </div>
          ))}
        </dl>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              aria-label={triggerLabel}
              className="relative grid size-9 shrink-0 place-items-center rounded-full outline-none hover:bg-app-hover focus-visible:ring-2 focus-visible:ring-ring/50"
              type="button"
            >
              <svg aria-hidden="true" className="size-8 -rotate-90" viewBox="0 0 36 36">
                <circle
                  className="stroke-border"
                  cx="18"
                  cy="18"
                  fill="none"
                  pathLength="100"
                  r="15"
                  strokeWidth="3"
                />
                <circle
                  className="stroke-primary transition-[stroke-dashoffset]"
                  cx="18"
                  cy="18"
                  fill="none"
                  pathLength="100"
                  r="15"
                  strokeDasharray="100"
                  strokeDashoffset={100 - ringPercent}
                  strokeLinecap="round"
                  strokeWidth="3"
                />
              </svg>
              <span className="absolute font-mono text-[9px] font-semibold tabular-nums">
                {percent === null ? "—" : `${percent}%`}
              </span>
            </button>
          </TooltipTrigger>
          <TooltipContent align="end" className="space-y-0.5 text-center" side="top">
            <div className="text-text-muted">{labels.contextUsage}</div>
            {snapshot ? (
              <>
                <div className="text-text-muted">{labels.usagePercent(percent ?? 0)}</div>
                <div className="text-sm font-medium text-text">
                  {labels.tokensUsed(
                    labels.formatNumber(snapshot.usedTokens),
                    labels.formatNumber(snapshot.contextWindowTokens)
                  )}
                </div>
              </>
            ) : (
              <div className="text-sm font-medium text-text">{labels.unavailable}</div>
            )}
          </TooltipContent>
        </Tooltip>
      </div>
    </TooltipProvider>
  );
}
