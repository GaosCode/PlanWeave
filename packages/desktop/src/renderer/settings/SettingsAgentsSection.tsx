import { useEffect, useMemo, useState } from "react";
import type {
  DesktopAgentDetection,
  DesktopCanvasReference,
  DesktopGraphViewModel,
  ExecutorPreflightCheck,
  ExecutorPreflightResult
} from "@planweave-ai/runtime";
import { RefreshCwIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "@/components/ui/select";
import { AgentSettingsPanel } from "../components/AgentSettingsPanel";
import { buildExecutorOptionViews } from "../executors/executorOptionViewModel";
import { useExecutorPreflight } from "../hooks/useExecutorPreflight";
import type { createTranslator } from "../i18n";
import type { DesktopSettingsUpdate, DesktopUiSettings } from "../types";

type SettingsAgentsSectionProps = {
  agentDetectionRefreshing: boolean;
  agents: DesktopAgentDetection[];
  canvasRef?: DesktopCanvasReference | null;
  graph: DesktopGraphViewModel | null;
  refreshAgentDetections: () => Promise<void>;
  settings: DesktopUiSettings;
  t: ReturnType<typeof createTranslator>;
  updateSettings: (update: DesktopSettingsUpdate) => void;
};

function checkStatusVariant(status: ExecutorPreflightCheck["status"]) {
  return status === "failed" ? "destructive" : status === "passed" ? "secondary" : "outline";
}

function ExecutorPreflightCheckList({
  result,
  t
}: {
  result: ExecutorPreflightResult;
  t: ReturnType<typeof createTranslator>;
}) {
  return (
    <div className="flex flex-col gap-2" data-testid="executor-preflight-checks">
      {result.checks.map((check) => (
        <div
          className="rounded-md border border-border/70 bg-background px-3 py-2 text-xs"
          key={check.check}
        >
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <div className="font-medium text-text-strong">{check.check}</div>
              <div className="mt-1 break-words text-muted-foreground">{check.message}</div>
            </div>
            <Badge variant={checkStatusVariant(check.status)}>{check.status}</Badge>
          </div>
          {check.command ||
          check.cwd ||
          check.exitCode !== undefined ||
          check.timedOut !== undefined ||
          check.output ? (
            <div className="mt-2 grid grid-cols-[6rem_minmax(0,1fr)] gap-x-2 gap-y-1 text-text-faint">
              {check.command ? (
                <>
                  <span>{t("suggestedCommand")}</span>
                  <span className="break-all font-mono">{check.command}</span>
                </>
              ) : null}
              {check.cwd ? (
                <>
                  <span>{t("executionCwd")}</span>
                  <span className="break-all font-mono">{check.cwd}</span>
                </>
              ) : null}
              {check.exitCode !== undefined ? (
                <>
                  <span>{t("exitCode")}</span>
                  <span>{check.exitCode}</span>
                </>
              ) : null}
              {check.timedOut !== undefined ? (
                <>
                  <span>{t("timedOut")}</span>
                  <span>{check.timedOut ? t("yes") : t("no")}</span>
                </>
              ) : null}
              {check.output ? (
                <>
                  <span>{t("latestOutput")}</span>
                  <span className="max-h-24 overflow-auto whitespace-pre-wrap break-words font-mono">
                    {check.output}
                  </span>
                </>
              ) : null}
            </div>
          ) : null}
        </div>
      ))}
    </div>
  );
}

export function SettingsAgentsSection({
  agentDetectionRefreshing,
  agents,
  canvasRef,
  graph,
  refreshAgentDetections,
  settings,
  t,
  updateSettings
}: SettingsAgentsSectionProps) {
  const executorOptions = useMemo(
    () =>
      buildExecutorOptionViews({
        agentDetections: agents,
        executorOptions: graph?.executorOptions ?? []
      }),
    [agents, graph?.executorOptions]
  );
  const selectableExecutorOptions = useMemo(
    () => executorOptions.filter((option) => !option.disabled),
    [executorOptions]
  );
  const [selectedExecutor, setSelectedExecutor] = useState(
    selectableExecutorOptions[0]?.name ?? ""
  );
  const graphPreflightKey = graph ? `${graph.graphVersion}:${graph.packageFingerprint}` : null;
  const preflight = useExecutorPreflight({
    bridgeUnavailableMessage: t("bridgeUnavailable"),
    cacheKey: graphPreflightKey,
    canvasRef: canvasRef ?? null,
    executorName: selectedExecutor || null
  });
  const executorSelectDisabled = selectableExecutorOptions.length === 0 || !canvasRef;
  const selectedExecutorAvailable = Boolean(
    selectedExecutor &&
      canvasRef &&
      selectableExecutorOptions.some((option) => option.name === selectedExecutor)
  );
  const resultBadgeVariant = preflight.result?.ok ? "secondary" : "destructive";
  const selectedExecutorLabel = selectedExecutor || t("none");
  const selectableExecutorOptionsKey = useMemo(
    () => selectableExecutorOptions.map((option) => option.name).join("\n"),
    [selectableExecutorOptions]
  );

  useEffect(() => {
    if (
      selectedExecutor &&
      selectableExecutorOptions.some((option) => option.name === selectedExecutor)
    ) {
      return;
    }
    setSelectedExecutor(selectableExecutorOptions[0]?.name ?? "");
  }, [selectableExecutorOptions, selectableExecutorOptionsKey, selectedExecutor]);

  return (
    <section data-testid="settings-section-agents" className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-normal text-text-strong">
          {t("settingsAgents")}
        </h1>
        <p className="mt-1 text-sm text-text-muted">{t("settingsAgentsHint")}</p>
      </div>
      <AgentSettingsPanel
        agentDetectionRefreshing={agentDetectionRefreshing}
        agents={agents}
        labels={{
          agentDetected: t("agentDetected"),
          agentInstallStatus: t("agentInstallStatus"),
          agentRefresh: t("agentRefresh"),
          agentRefreshing: t("agentRefreshing"),
          agentMissing: t("agentMissing"),
          agentEnableDescription: t("agentEnableDescription"),
          agentFullAccess: t("agentFullAccess"),
          agentFullAccessDescription: t("agentFullAccessDescription")
        }}
        refreshAgentDetections={refreshAgentDetections}
        settings={settings}
        updateSettings={updateSettings}
      />
      <div className="rounded-lg border bg-card p-4" data-testid="settings-executor-preflight">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold text-text-strong">{t("executorPreflight")}</h2>
            <p className="mt-1 text-xs text-muted-foreground">
              {t("executorPreflightSettingsHint")}
            </p>
          </div>
          {preflight.result ? (
            <Badge variant={resultBadgeVariant}>
              {preflight.result.ok ? t("preflightPassed") : t("preflightFailed")}
            </Badge>
          ) : null}
        </div>
        {!canvasRef || !graph ? (
          <div className="mt-3 rounded-md border border-border/70 bg-muted/30 px-3 py-2 text-sm text-muted-foreground">
            {t("executorPreflightNoGraph")}
          </div>
        ) : executorOptions.length === 0 ? (
          <div className="mt-3 rounded-md border border-border/70 bg-muted/30 px-3 py-2 text-sm text-muted-foreground">
            {t("executorPreflightNoExecutors")}
          </div>
        ) : (
          <div className="mt-3 flex flex-col gap-3">
            <div className="flex flex-wrap items-center gap-2">
              <Select value={selectedExecutor} onValueChange={setSelectedExecutor}>
                <SelectTrigger
                  className="w-56"
                  disabled={executorSelectDisabled}
                  aria-label={t("executorPreflightSelect")}
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {executorOptions.map((executor) => (
                      <SelectItem
                        disabled={executor.disabled}
                        value={executor.name}
                        key={executor.name}
                      >
                        <span className="flex min-w-0 items-center gap-2">
                          <span>{executor.label}</span>
                          {executor.disabled ? (
                            <span className="text-xs text-muted-foreground">
                              {t("unavailable")}
                            </span>
                          ) : null}
                        </span>
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
              <Button
                data-testid="settings-run-executor-preflight"
                disabled={!selectedExecutorAvailable || preflight.loading}
                size="sm"
                variant="outline"
                onClick={() => void preflight.runPreflight()}
              >
                <RefreshCwIcon
                  className={preflight.loading ? "animate-spin" : undefined}
                  data-icon="inline-start"
                />
                {preflight.loading ? t("preflightRunning") : t("runPreflight")}
              </Button>
            </div>
            {preflight.error ? (
              <div className="rounded-md border border-destructive/60 bg-destructive/5 px-3 py-2 text-sm text-destructive">
                {preflight.error}
              </div>
            ) : null}
            {preflight.result ? (
              <div className="flex flex-col gap-3">
                <div className="rounded-md border border-border/70 bg-muted/30 px-3 py-2 text-sm">
                  <div className="font-medium text-text-strong">
                    {selectedExecutorLabel}: {preflight.result.message}
                  </div>
                  <div className="mt-1 text-xs text-muted-foreground">
                    {t("adapter")}: {preflight.result.adapter ?? t("none")}
                  </div>
                </div>
                <ExecutorPreflightCheckList result={preflight.result} t={t} />
              </div>
            ) : null}
          </div>
        )}
      </div>
    </section>
  );
}
