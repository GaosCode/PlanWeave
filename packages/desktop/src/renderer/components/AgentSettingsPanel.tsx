import { useLayoutEffect, useState } from "react";
import type { DesktopAgentDetection, DesktopAgentKind } from "@planweave-ai/runtime";
import { ChevronDownIcon, RefreshCwIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import {
  desktopAgentHostKey,
  type DesktopAcpAgentSettingsPatch,
  type DesktopAgentHost
} from "../../shared/desktopSettings";
import type { RefreshAgentDetections } from "../hooks/useDetectedAgents";
import type { createTranslator } from "../i18n";
import type { DesktopSettingsUpdate, DesktopUiSettings } from "../types";
import { useAgentCapabilityProbeSession } from "./agentCapabilityProbeSessionCache";
import { ExecutorPreflightSummary } from "./ExecutorPreflightSummary";

type AgentSettingsPanelProps = {
  agentDetectionRefreshing: boolean;
  agents: DesktopAgentDetection[];
  labels: {
    agentDetected: string;
    agentMissing: string;
    agentMissingCannotEnable: string;
    agentEnableDescription: string;
    agentAcpOptionsHint: string;
    agentAcpAdapterHint: string;
    agentInstallCommandLabel: string;
    agentLoginCommandLabel: string;
    agentFullAccessDescription: string;
    agentFullAccess: string;
    agentInstallStatus: string;
    agentRefresh: string;
    agentRefreshing: string;
    acpModelManaged: string;
    acpPermissionsManaged: string;
    acpSessionMode: string;
    acpNotProbed: string;
    acpProbing: string;
  };
  bridgeUnavailableMessage?: string;
  projectRoot?: string | null;
  sourceRoot?: string | null;
  hostUnconfirmed?: boolean;
  persistSettings?: (
    update: DesktopSettingsUpdate,
    expectedAgentHost?: DesktopAgentHost
  ) => Promise<void>;
  refreshAgentDetections: RefreshAgentDetections;
  settings: DesktopUiSettings;
  t: ReturnType<typeof createTranslator>;
  updateSettings: (update: DesktopSettingsUpdate) => void;
};

function RemoveSavedAcpOption({
  name,
  onRemove,
  t
}: {
  name: string;
  onRemove: () => void;
  t: AgentSettingsPanelProps["t"];
}) {
  return (
    <Button
      aria-label={t("acpRemoveSavedOption").replace("{option}", name)}
      onClick={onRemove}
      size="sm"
      variant="outline"
    >
      {t("remove")}
    </Button>
  );
}

export function AgentSettingsPanel({
  agentDetectionRefreshing,
  agents,
  bridgeUnavailableMessage = "Desktop bridge unavailable.",
  projectRoot = null,
  sourceRoot = null,
  hostUnconfirmed = false,
  persistSettings,
  labels,
  refreshAgentDetections,
  settings,
  t,
  updateSettings
}: AgentSettingsPanelProps) {
  const [expandedAgents, setExpandedAgents] = useState<ReadonlySet<DesktopAgentKind>>(
    () => new Set()
  );
  const executionHost = settings.execution.agentHost;
  const { probes, probe, refreshProbes, isCurrentProbe } = useAgentCapabilityProbeSession(
    projectRoot,
    sourceRoot,
    executionHost,
    bridgeUnavailableMessage
  );

  useLayoutEffect(() => {
    if (hostUnconfirmed || agentDetectionRefreshing) return;
    for (const agent of agents) {
      if (
        agent.runnerKind === "acp" &&
        agent.installed &&
        !probes[agent.kind] &&
        expandedAgents.has(agent.kind) &&
        (!agent.executionHost ||
          desktopAgentHostKey(agent.executionHost) === desktopAgentHostKey(executionHost))
      ) {
        void probe(agent.kind);
      }
    }
  }, [
    agentDetectionRefreshing,
    agents,
    executionHost,
    expandedAgents,
    hostUnconfirmed,
    probe,
    probes
  ]);

  return (
    <div className="overflow-hidden rounded-lg border bg-background">
      <div className="flex items-center justify-between gap-4 border-b px-5 py-4">
        <div className="text-sm text-muted-foreground">{labels.agentInstallStatus}</div>
        <Button
          disabled={agentDetectionRefreshing}
          size="sm"
          variant="outline"
          onClick={() => {
            void refreshAgentDetections(refreshProbes);
          }}
        >
          <RefreshCwIcon
            className={cn("size-4", agentDetectionRefreshing ? "animate-spin" : "")}
            data-icon="inline-start"
          />
          <span aria-live="polite">
            {agentDetectionRefreshing ? labels.agentRefreshing : labels.agentRefresh}
          </span>
        </Button>
      </div>
      {agents.map((agent) => {
        const agentSettings = settings.agents[agent.kind];
        const command = `${agent.command} ${agent.execArgs.join(" ")}`;
        const fullAccessCommand = `${agent.command} ${agent.fullAccessArgs.join(" ")}`;
        const supportsFullAccess = agent.runnerKind === "cli";
        const supportsAcpOptions = agent.runnerKind === "acp";
        const expanded = expandedAgents.has(agent.kind);
        const acpProbe = probes[agent.kind];
        const acpProbeReady = acpProbe?.result?.ok === true;
        const sessionConfig =
          !hostUnconfirmed && agent.installed && supportsAcpOptions && acpProbe?.result?.ok
            ? acpProbe.result.sessionConfig
            : null;
        const acpSettings = agentSettings.acp;
        const legacyModes = sessionConfig?.modes;
        const configuredMode = acpSettings.modeId;
        const protocolModeOptions =
          sessionConfig?.configOptions.filter((option) => option.category === "mode") ?? [];
        const configuredProtocolMode = protocolModeOptions.some((option) =>
          Object.hasOwn(acpSettings.configOptions, option.id)
        );
        const incompatibleMode = Boolean(
          sessionConfig &&
            configuredMode &&
            !configuredProtocolMode &&
            !legacyModes?.availableModes.some(({ id }) => id === configuredMode)
        );
        const showLegacyModes =
          legacyModes &&
          legacyModes.availableModes.length > 0 &&
          (protocolModeOptions.length === 0 || (configuredMode && !configuredProtocolMode));
        const missingOptionIds = sessionConfig
          ? Object.keys(acpSettings.configOptions).filter(
              (id) => !sessionConfig.configOptions.some((option) => option.id === id)
            )
          : [];
        const defaultChoiceLabel = (label: string, isDefault: boolean) =>
          isDefault ? t("acpHostDefaultChoice").replace("{value}", label) : label;
        const incompatibleValueMessage = (value: string | boolean) =>
          t("acpSavedValueUnavailable").replace("{value}", String(value));
        const saveAcpSelection = (acp: DesktopAcpAgentSettingsPatch) => {
          if (!sessionConfig || !acpProbe || !isCurrentProbe(agent.kind, acpProbe)) return;
          const update = () => ({ agents: { [agent.kind]: { acp } } });
          if (persistSettings) void persistSettings(update, executionHost).catch(() => undefined);
          else updateSettings(update);
        };
        return (
          <div
            key={`${agent.runnerKind}:${agent.kind}`}
            className={cn("border-b last:border-b-0", !agent.installed ? "opacity-50" : "")}
          >
            <div className="flex min-h-24 items-start justify-between gap-4 px-5 py-5">
              <div className="min-w-0">
                <div className="font-semibold">{agent.name}</div>
                <div className="mt-1 flex flex-col gap-1 text-sm text-muted-foreground">
                  <span>
                    {agent.installed ? labels.agentDetected : labels.agentMissing}
                    {agent.version ? `: ${agent.version}` : ""}
                  </span>
                  {!agent.installed ? <span>{labels.agentMissingCannotEnable}</span> : null}
                  <span>{labels.agentEnableDescription.replace("{command}", command)}</span>
                  {supportsAcpOptions && agent.installed ? (
                    <span className="text-xs text-muted-foreground/90">
                      {labels.agentAcpOptionsHint}
                    </span>
                  ) : null}
                  {!agent.installed && agent.runnerKind === "acp" && agent.installCommand ? (
                    <div
                      className="mt-2 rounded-md border border-border/70 bg-muted/20 px-3 py-2 text-xs"
                      data-testid={`agent-install-hint-${agent.kind}`}
                    >
                      <div className="text-text-strong">{labels.agentAcpAdapterHint}</div>
                      <div className="mt-2 text-text-faint">{labels.agentInstallCommandLabel}</div>
                      <code className="mt-1 block select-all break-all rounded bg-background px-2 py-1.5 font-mono text-[11px] text-text-strong">
                        {agent.installCommand}
                      </code>
                    </div>
                  ) : null}
                  {!agent.installed && agent.unavailableReason ? (
                    <span className="text-xs text-muted-foreground/90">
                      {agent.unavailableReason}
                    </span>
                  ) : null}
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                {supportsFullAccess || supportsAcpOptions ? (
                  <Button
                    aria-label={`${agent.name} options`}
                    aria-expanded={expanded}
                    className="size-7"
                    size="icon-sm"
                    variant="ghost"
                    onClick={() => {
                      setExpandedAgents((current) => {
                        const next = new Set(current);
                        if (next.has(agent.kind)) {
                          next.delete(agent.kind);
                        } else {
                          next.add(agent.kind);
                        }
                        return next;
                      });
                    }}
                  >
                    <ChevronDownIcon
                      className={cn("size-4 transition-transform", expanded ? "rotate-180" : "")}
                    />
                  </Button>
                ) : null}
                <Switch
                  aria-label={agent.name}
                  checked={agent.installed && agentSettings.enabled}
                  disabled={!agent.installed}
                  onCheckedChange={(checked) =>
                    updateSettings((current) => ({
                      agents: {
                        [agent.kind]: {
                          enabled: checked,
                          fullAccess: checked ? current.agents[agent.kind].fullAccess : false
                        }
                      }
                    }))
                  }
                />
              </div>
            </div>
            {supportsFullAccess && expanded ? (
              <div className="border-t bg-muted/20 px-8 py-3">
                <div className="flex items-center justify-between gap-4">
                  <div className="min-w-0">
                    <div className="text-sm font-medium">{labels.agentFullAccess}</div>
                    <div className="mt-1 text-xs text-muted-foreground">
                      {labels.agentFullAccessDescription.replace("{command}", fullAccessCommand)}
                    </div>
                  </div>
                  <Switch
                    aria-label={labels.agentFullAccess}
                    checked={agent.installed && agentSettings.enabled && agentSettings.fullAccess}
                    disabled={!agent.installed || !agentSettings.enabled}
                    size="sm"
                    onCheckedChange={(checked) =>
                      updateSettings({ agents: { [agent.kind]: { fullAccess: checked } } })
                    }
                  />
                </div>
              </div>
            ) : null}
            {supportsAcpOptions && expanded ? (
              <div className="flex flex-col gap-4 border-t bg-muted/20 px-8 py-4">
                {acpProbe?.loading ? (
                  <div className="text-xs text-muted-foreground">{labels.acpProbing}</div>
                ) : null}
                {acpProbe?.error ? (
                  <div className="text-xs text-destructive">{acpProbe.error}</div>
                ) : null}
                {!acpProbe && !sessionConfig ? (
                  <div className="text-xs text-muted-foreground">{labels.acpNotProbed}</div>
                ) : null}
                {acpProbe?.result ? (
                  <ExecutorPreflightSummary
                    result={acpProbe.result}
                    t={t}
                    loginCommands={agent.loginCommands ?? null}
                  />
                ) : null}
                {missingOptionIds.map((id) => (
                  <div className="flex items-center justify-between gap-4" key={id}>
                    <p className="min-w-0 break-words text-sm text-destructive">
                      {t("acpSavedOptionUnavailable").replace("{option}", id)}
                    </p>
                    <RemoveSavedAcpOption
                      name={id}
                      onRemove={() => saveAcpSelection({ configOptions: { [id]: null } })}
                      t={t}
                    />
                  </div>
                ))}
                {sessionConfig?.configOptions.map((option) => {
                  const configured = Object.hasOwn(acpSettings.configOptions, option.id)
                    ? acpSettings.configOptions[option.id]
                    : undefined;
                  const incompatible =
                    configured !== undefined &&
                    (option.type === "boolean"
                      ? typeof configured !== "boolean"
                      : !option.options.some(({ value }) => value === configured));
                  const chooseValue =
                    incompatible ||
                    (incompatibleMode && configured === undefined && option.category === "mode");
                  return (
                    <div className="flex items-center justify-between gap-4" key={option.id}>
                      <div className="min-w-0">
                        <div className="text-sm font-medium">{option.name}</div>
                        {option.description ? (
                          <div className="mt-1 text-xs text-muted-foreground">
                            {option.description}
                          </div>
                        ) : null}
                        {incompatible ? (
                          <p className="mt-1 break-words text-xs text-destructive">
                            {incompatibleValueMessage(configured)}
                          </p>
                        ) : null}
                      </div>
                      {option.type === "boolean" && !chooseValue ? (
                        <Switch
                          aria-label={option.name}
                          checked={
                            typeof configured === "boolean" ? configured : option.currentValue
                          }
                          size="sm"
                          onCheckedChange={(checked) =>
                            saveAcpSelection({ configOptions: { [option.id]: checked } })
                          }
                        />
                      ) : option.type === "select" &&
                        incompatible &&
                        option.options.length === 0 ? (
                        <RemoveSavedAcpOption
                          name={option.name}
                          onRemove={() =>
                            saveAcpSelection({ configOptions: { [option.id]: null } })
                          }
                          t={t}
                        />
                      ) : (
                        <Select
                          value={chooseValue ? "" : String(configured ?? option.currentValue)}
                          onValueChange={(value) => {
                            if (
                              option.type === "boolean"
                                ? value === "true" || value === "false"
                                : option.options.some((candidate) => candidate.value === value)
                            ) {
                              const choice = option.type === "boolean" ? value === "true" : value;
                              saveAcpSelection({ configOptions: { [option.id]: choice } });
                            }
                          }}
                        >
                          <SelectTrigger
                            className="w-56"
                            aria-label={option.name}
                            aria-invalid={incompatible || undefined}
                          >
                            <SelectValue placeholder={t("acpChooseSupportedValue")} />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectGroup>
                              {option.type === "boolean"
                                ? [true, false].map((value) => (
                                    <SelectItem value={String(value)} key={String(value)}>
                                      {defaultChoiceLabel(
                                        t(value ? "enabled" : "disabled"),
                                        option.currentValue === value
                                      )}
                                    </SelectItem>
                                  ))
                                : option.options.map((value) => (
                                    <SelectItem value={value.value} key={value.value}>
                                      {defaultChoiceLabel(
                                        value.group ? `${value.group} · ${value.name}` : value.name,
                                        chooseValue && value.value === option.currentValue
                                      )}
                                    </SelectItem>
                                  ))}
                            </SelectGroup>
                          </SelectContent>
                        </Select>
                      )}
                    </div>
                  );
                })}
                {showLegacyModes || incompatibleMode ? (
                  <div className="flex items-center justify-between gap-4">
                    <div className="min-w-0">
                      <div className="text-sm font-medium">{labels.acpSessionMode}</div>
                      {incompatibleMode && configuredMode ? (
                        <p className="mt-1 break-words text-xs text-destructive">
                          {incompatibleValueMessage(configuredMode)}
                        </p>
                      ) : null}
                    </div>
                    {showLegacyModes ? (
                      <Select
                        value={incompatibleMode ? "" : configuredMode || legacyModes.currentModeId}
                        onValueChange={(modeId) => {
                          if (legacyModes.availableModes.some(({ id }) => id === modeId)) {
                            saveAcpSelection({ modeId });
                          }
                        }}
                      >
                        <SelectTrigger
                          className="w-56"
                          aria-label={labels.acpSessionMode}
                          aria-invalid={incompatibleMode || undefined}
                        >
                          <SelectValue placeholder={t("acpChooseSupportedValue")} />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectGroup>
                            {legacyModes.availableModes.map((mode) => (
                              <SelectItem value={mode.id} key={mode.id}>
                                {defaultChoiceLabel(
                                  mode.name,
                                  incompatibleMode && mode.id === legacyModes.currentModeId
                                )}
                              </SelectItem>
                            ))}
                          </SelectGroup>
                        </SelectContent>
                      </Select>
                    ) : (
                      <RemoveSavedAcpOption
                        name={labels.acpSessionMode}
                        onRemove={() => saveAcpSelection({ modeId: null })}
                        t={t}
                      />
                    )}
                  </div>
                ) : null}
                {!acpProbe?.loading &&
                !acpProbe?.error &&
                acpProbeReady &&
                !sessionConfig?.configOptions.some((option) => option.category === "model") ? (
                  <div className="text-xs text-muted-foreground">{labels.acpModelManaged}</div>
                ) : null}
                {acpProbeReady ? (
                  <div className="text-xs text-muted-foreground">
                    {labels.acpPermissionsManaged}
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
