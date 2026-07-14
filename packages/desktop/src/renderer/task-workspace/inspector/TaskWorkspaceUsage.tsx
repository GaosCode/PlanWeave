import type { TaskWorkspace } from "@planweave-ai/runtime";
import {
  Popover,
  PopoverContent,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger
} from "@/components/ui/popover";
import { useId } from "react";
import type { TaskWorkspaceSelectedRun } from "../contracts";
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
                <UnavailableValue reason={run.usage.runTokens.reason} unavailable={labels.unavailable} />
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
              run?.duration.wallClockMs !== null && run?.duration.wallClockMs !== undefined ? (
                labels.formatDuration(run.duration.wallClockMs)
              ) : (
                <UnavailableValue
                  reason={run?.duration.unavailableReason ?? labels.unavailable}
                  unavailable={labels.unavailable}
                />
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
              wallClock?.available ? (
                labels.formatDuration(wallClock.totalMs)
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
              agentTime && agentTime.availability !== "unavailable" ? (
                <span>
                  {labels.formatDuration(agentTime.totalMs)}
                  {agentTime.availability === "partial" ? (
                    <span className="mt-0.5 block text-[10px] font-normal text-text-muted">
                      {labels.partialAgentTime(
                        agentTime.includedRunCount,
                        agentTime.missingRunCount
                      )}
                    </span>
                  ) : null}
                </span>
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
  workspace
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
  const configurationValue = (field: "mode" | "model" | "permission" | "reasoning") => {
    if (!configuration?.available) return null;
    const value = configuration.fields[field];
    return value.available ? String(value.value) : null;
  };
  const run = selectedRun?.item.run ?? null;
  const agent = run?.metadata.agentId ?? run?.metadata.executor ?? run?.metadata.adapter ?? null;
  const sessionMetadata = [
    agent ? { key: "agent", label: labels.agent, value: agent } : null,
    ...(["model", "reasoning", "mode", "permission"] as const).map((field) => {
      const value = configurationValue(field);
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
              {value}
            </dd>
          </div>
        ))}
      </dl>
      <Popover>
        <PopoverTrigger asChild>
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
        </PopoverTrigger>
        <PopoverContent align="end" className="w-80 max-w-[calc(100vw-1rem)] p-3">
          <PopoverHeader>
            <PopoverTitle>{labels.contextUsage}</PopoverTitle>
          </PopoverHeader>
          <TaskWorkspaceUsageDetails labels={labels} selectedRun={selectedRun} workspace={workspace} />
        </PopoverContent>
      </Popover>
    </div>
  );
}
