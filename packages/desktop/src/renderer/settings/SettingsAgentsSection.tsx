import { useEffect, useMemo, useState } from "react";
import type {
  DesktopAgentDetection,
  DesktopCanvasReference,
  DesktopGraphViewModel,
  DesktopWslEnvironment,
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
import { ExecutorPreflightSummary } from "../components/ExecutorPreflightSummary";
import { buildExecutorOptionViews } from "../executors/executorOptionViewModel";
import { useExecutorPreflight } from "../hooks/useExecutorPreflight";
import type { createTranslator } from "../i18n";
import type { DesktopSettingsUpdate, DesktopUiSettings } from "../types";
import { bridge } from "../bridge";

type SettingsAgentsSectionProps = {
  showHeader?: boolean;
  agentDetectionRefreshing: boolean;
  agents: DesktopAgentDetection[];
  canvasRef?: DesktopCanvasReference | null;
  graph: DesktopGraphViewModel | null;
  refreshAgentDetections: () => Promise<void>;
  persistSettings?: (update: DesktopSettingsUpdate) => Promise<void>;
  setError?: (message: string | null) => void;
  settings: DesktopUiSettings;
  t: ReturnType<typeof createTranslator>;
  updateSettings: (update: DesktopSettingsUpdate) => void;
};

function checkStatusVariant(status: ExecutorPreflightCheck["status"]) {
  return status === "failed" ? "destructive" : status === "passed" ? "secondary" : "outline";
}

function errorMessage(caught: unknown): string {
  return caught instanceof Error ? caught.message : String(caught);
}

function settleSettingsSave(
  save: Promise<void>,
  onSettled: () => void,
  refreshAgentDetections?: () => Promise<void>,
  setError?: (message: string | null) => void
): void {
  void save
    .then(
      () =>
        refreshAgentDetections?.().then(
          () => undefined,
          (caught: unknown) => setError?.(errorMessage(caught))
        ),
      () => undefined
    )
    .finally(onSettled);
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
  showHeader = true,
  agentDetectionRefreshing,
  agents,
  canvasRef,
  graph,
  persistSettings,
  refreshAgentDetections,
  setError,
  settings,
  t,
  updateSettings
}: SettingsAgentsSectionProps) {
  const selectedTransport = settings.execution.agentTransport;
  const selectedHost = settings.execution.agentHost;
  const [hostMode, setHostMode] = useState<"native" | "wsl">(selectedHost.kind);
  const [hostSaving, setHostSaving] = useState(false);
  const [wslEnvironment, setWslEnvironment] = useState<DesktopWslEnvironment | null>(null);
  const transportAgents = useMemo(
    () => agents.filter((agent) => agent.runnerKind === selectedTransport),
    [agents, selectedTransport]
  );
  const executorOptions = useMemo(
    () =>
      buildExecutorOptionViews({
        agentDetections: transportAgents,
        agentTransport: selectedTransport,
        literalExecutorNames: graph?.packageExecutorNames,
        executorOptions: graph?.executorOptions ?? []
      }),
    [graph?.executorOptions, graph?.packageExecutorNames, selectedTransport, transportAgents]
  );
  const selectableExecutorOptions = useMemo(
    () => executorOptions.filter((option) => !option.disabled),
    [executorOptions]
  );
  const [selectedExecutor, setSelectedExecutor] = useState(
    selectableExecutorOptions[0]?.name ?? ""
  );
  const [transportSaving, setTransportSaving] = useState(false);
  const graphPreflightKey = graph
    ? `${graph.graphVersion}:${graph.packageFingerprint}:${selectedTransport}:${JSON.stringify(selectedHost)}`
    : null;
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
  useEffect(() => {
    setHostMode(selectedHost.kind);
  }, [selectedHost.kind]);
  useEffect(() => {
    let cancelled = false;
    if (!bridge || typeof bridge.detectWslEnvironment !== "function") {
      return;
    }
    void bridge.detectWslEnvironment().then((result) => {
      if (!cancelled) setWslEnvironment(result);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  useEffect(() => {
    if (
      selectedExecutor &&
      selectableExecutorOptions.some((option) => option.name === selectedExecutor)
    ) {
      return;
    }
    setSelectedExecutor(selectableExecutorOptions[0]?.name ?? "");
  }, [selectableExecutorOptions, selectedExecutor]);

  return (
    <section data-testid="settings-section-agents" className="flex flex-col gap-6">
      {showHeader ? (
        <div>
          <h1 className="text-2xl font-semibold tracking-normal text-text-strong">
            {t("settingsAgents")}
          </h1>
          <p className="mt-1 text-sm text-text-muted">{t("settingsAgentsHint")}</p>
        </div>
      ) : null}
      {wslEnvironment?.supported ? (
        <div className="rounded-lg border bg-card p-4" data-testid="agent-host-settings">
          <label className="text-sm font-medium text-text-strong" htmlFor="agent-host-select">
            {t("agentHost")}
          </label>
          <p className="mt-1 text-xs text-muted-foreground">{t("agentHostHint")}</p>
          <Select
            disabled={hostSaving}
            value={hostMode}
            onValueChange={(kind: "native" | "wsl") => {
              setHostMode(kind);
              if (kind === "wsl") return;
              setHostSaving(true);
              const save = persistSettings
                ? persistSettings({ execution: { agentHost: { kind: "native" } } })
                : Promise.resolve(updateSettings({ execution: { agentHost: { kind: "native" } } }));
              settleSettingsSave(
                save,
                () => setHostSaving(false),
                refreshAgentDetections,
                setError
              );
            }}
          >
            <SelectTrigger className="mt-3 w-56" id="agent-host-select" aria-label={t("agentHost")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value="native">{t("agentHostNative")}</SelectItem>
                <SelectItem value="wsl" disabled={!wslEnvironment.available}>
                  {t("agentHostWsl")}
                </SelectItem>
              </SelectGroup>
            </SelectContent>
          </Select>
          {hostMode === "wsl" ? (
            <div className="mt-4">
              <label
                className="text-sm font-medium text-text-strong"
                htmlFor="agent-wsl-distribution-select"
              >
                {t("agentWslDistribution")}
              </label>
              <Select
                disabled={hostSaving || !wslEnvironment.available}
                value={selectedHost.kind === "wsl" ? selectedHost.distribution : undefined}
                onValueChange={(distribution) => {
                  setHostSaving(true);
                  const save = persistSettings
                    ? persistSettings({
                        execution: { agentHost: { kind: "wsl", distribution } }
                      })
                    : Promise.resolve(
                        updateSettings({
                          execution: { agentHost: { kind: "wsl", distribution } }
                        })
                      );
                  settleSettingsSave(
                    save,
                    () => setHostSaving(false),
                    refreshAgentDetections,
                    setError
                  );
                }}
              >
                <SelectTrigger
                  className="mt-2 w-72"
                  id="agent-wsl-distribution-select"
                  aria-label={t("agentWslDistribution")}
                >
                  <SelectValue placeholder={t("agentWslDistributionPlaceholder")} />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {wslEnvironment.distributions.map((distribution) => (
                      <SelectItem key={distribution} value={distribution}>
                        {distribution}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </div>
          ) : null}
          {!wslEnvironment.available && wslEnvironment.unavailableReason ? (
            <p className="mt-3 text-xs text-destructive">
              {t("agentWslUnavailable")}: {wslEnvironment.unavailableReason}
            </p>
          ) : null}
        </div>
      ) : null}
      <div className="rounded-lg border bg-card p-4">
        <label className="text-sm font-medium text-text-strong" htmlFor="agent-transport-select">
          {t("agentTransport")}
        </label>
        <p className="mt-1 text-xs text-muted-foreground">{t("agentTransportHint")}</p>
        <Select
          disabled={transportSaving}
          value={selectedTransport}
          onValueChange={(agentTransport: "cli" | "acp") => {
            setTransportSaving(true);
            const save = persistSettings
              ? persistSettings({ execution: { agentTransport } })
              : Promise.resolve(updateSettings({ execution: { agentTransport } }));
            settleSettingsSave(save, () => setTransportSaving(false));
          }}
        >
          <SelectTrigger
            className="mt-3 w-56"
            id="agent-transport-select"
            aria-label={t("agentTransport")}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              <SelectItem value="cli">{t("agentTransportCli")}</SelectItem>
              <SelectItem value="acp">{t("agentTransportAcp")}</SelectItem>
            </SelectGroup>
          </SelectContent>
        </Select>
      </div>
      <AgentSettingsPanel
        agentDetectionRefreshing={agentDetectionRefreshing}
        agents={transportAgents}
        bridgeUnavailableMessage={t("bridgeUnavailable")}
        projectRoot={canvasRef?.projectRoot ?? null}
        labels={{
          agentDetected: t("agentDetected"),
          agentInstallStatus: t("agentInstallStatus"),
          agentRefresh: t("agentRefresh"),
          agentRefreshing: t("agentRefreshing"),
          agentMissing: t("agentMissing"),
          agentMissingCannotEnable: t("agentMissingCannotEnable"),
          agentEnableDescription: t("agentEnableDescription"),
          agentAcpAdapterHint: t("agentAcpAdapterHint"),
          agentInstallCommandLabel: t("agentInstallCommandLabel"),
          agentLoginCommandLabel: t("agentLoginCommandLabel"),
          agentFullAccess: t("agentFullAccess"),
          agentFullAccessDescription: t("agentFullAccessDescription"),
          acpModelManaged: t("acpModelManaged"),
          acpPermissionsManaged: t("acpPermissionsManaged"),
          acpSessionMode: t("acpSessionMode"),
          acpNotProbed: t("acpNotProbed"),
          acpProbing: t("preflightRunning")
        }}
        refreshAgentDetections={refreshAgentDetections}
        settings={settings}
        t={t}
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
                          {executor.custom ? (
                            <span className="text-xs text-muted-foreground">
                              {t("customExecutor")}
                            </span>
                          ) : null}
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
                disabled={!selectedExecutorAvailable || preflight.loading || transportSaving}
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
                    {t("adapter")}: {preflight.result.profileAdapter ?? t("none")} /{" "}
                    {preflight.result.executionIntegration ?? t("none")}
                  </div>
                </div>
                <ExecutorPreflightSummary result={preflight.result} t={t} />
                <ExecutorPreflightCheckList result={preflight.result} t={t} />
              </div>
            ) : null}
          </div>
        )}
      </div>
    </section>
  );
}
