import { useEffect, useRef, useState } from "react";
import type {
  DesktopAgentCapabilityProbeResult,
  DesktopAgentDetection,
  DesktopAgentKind
} from "@planweave-ai/runtime";
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
import { bridge } from "../bridge";
import type { createTranslator } from "../i18n";
import type { DesktopSettingsUpdate, DesktopUiSettings } from "../types";
import {
  clearAgentCapabilityProbeSession,
  readAgentCapabilityProbeSession,
  writeAgentCapabilityProbeSession,
  type AcpProbeState
} from "./agentCapabilityProbeSessionCache";
import { ExecutorPreflightSummary } from "./ExecutorPreflightSummary";

type AgentSettingsPanelProps = {
  agentDetectionRefreshing: boolean;
  agents: DesktopAgentDetection[];
  labels: {
    agentDetected: string;
    agentMissing: string;
    agentMissingCannotEnable: string;
    agentEnableDescription: string;
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
  refreshAgentDetections: () => Promise<void>;
  settings: DesktopUiSettings;
  t: ReturnType<typeof createTranslator>;
  updateSettings: (update: DesktopSettingsUpdate) => void;
};

function updateAgentSettings(
  settings: DesktopUiSettings,
  kind: DesktopAgentKind,
  patch: Partial<DesktopUiSettings["agents"][DesktopAgentKind]>
): DesktopUiSettings["agents"] {
  return {
    ...settings.agents,
    [kind]: {
      ...settings.agents[kind],
      ...patch
    }
  };
}

function hasSettledAcpProbe(probe: AcpProbeState | undefined) {
  if (!probe) {
    return false;
  }
  return probe.loading || probe.result !== null || probe.error !== null;
}

function getCompletedProbeError(result: DesktopAgentCapabilityProbeResult) {
  if (result.ok) {
    return null;
  }
  if (result.authentication?.status === "action_required") {
    return null;
  }
  return result.message;
}

function getCaughtProbeError(caught: unknown) {
  if (caught instanceof Error) {
    return caught.message;
  }
  return String(caught);
}

export function AgentSettingsPanel({
  agentDetectionRefreshing,
  agents,
  bridgeUnavailableMessage = "Desktop bridge unavailable.",
  projectRoot = null,
  labels,
  refreshAgentDetections,
  settings,
  t,
  updateSettings
}: AgentSettingsPanelProps) {
  const [expandedAgents, setExpandedAgents] = useState<ReadonlySet<DesktopAgentKind>>(
    () => new Set()
  );
  const [acpProbes, setAcpProbes] = useState<Partial<Record<DesktopAgentKind, AcpProbeState>>>(() =>
    readAgentCapabilityProbeSession(projectRoot)
  );
  const probeGenerationRef = useRef(0);

  useEffect(() => {
    probeGenerationRef.current += 1;
    setAcpProbes(readAgentCapabilityProbeSession(projectRoot));
  }, [projectRoot]);

  const probeAcpAgent = async (agentKind: DesktopAgentKind, force = false) => {
    const currentProbe = acpProbes[agentKind];
    if (!force && hasSettledAcpProbe(currentProbe)) {
      return;
    }
    if (!bridge) {
      const completedProbe = {
        error: bridgeUnavailableMessage,
        loading: false,
        result: null
      } satisfies AcpProbeState;
      writeAgentCapabilityProbeSession(projectRoot, agentKind, completedProbe);
      setAcpProbes((current) => ({
        ...current,
        [agentKind]: completedProbe
      }));
      return;
    }
    const generation = probeGenerationRef.current;
    setAcpProbes((current) => ({
      ...current,
      [agentKind]: { error: null, loading: true, result: null }
    }));
    try {
      const result = await bridge.probeDesktopAgentCapabilities({ agentKind, projectRoot });
      if (probeGenerationRef.current !== generation) {
        return;
      }
      const completedProbe = {
        error: getCompletedProbeError(result),
        loading: false,
        result
      } satisfies AcpProbeState;
      writeAgentCapabilityProbeSession(projectRoot, agentKind, completedProbe);
      setAcpProbes((current) => ({
        ...current,
        [agentKind]: completedProbe
      }));
    } catch (caught) {
      if (probeGenerationRef.current !== generation) {
        return;
      }
      const completedProbe = {
        error: getCaughtProbeError(caught),
        loading: false,
        result: null
      } satisfies AcpProbeState;
      writeAgentCapabilityProbeSession(projectRoot, agentKind, completedProbe);
      setAcpProbes((current) => ({
        ...current,
        [agentKind]: completedProbe
      }));
    }
  };

  return (
    <div className="overflow-hidden rounded-lg border bg-background">
      <div className="flex items-center justify-between gap-4 border-b px-5 py-4">
        <div className="text-sm text-muted-foreground">{labels.agentInstallStatus}</div>
        <Button
          disabled={agentDetectionRefreshing}
          size="sm"
          variant="outline"
          onClick={() => {
            void refreshAgentDetections().then(() => {
              probeGenerationRef.current += 1;
              clearAgentCapabilityProbeSession(projectRoot);
              setAcpProbes({});
              for (const agent of agents) {
                if (
                  expandedAgents.has(agent.kind) &&
                  agent.runnerKind === "acp" &&
                  agent.installed
                ) {
                  void probeAcpAgent(agent.kind, true);
                }
              }
            });
          }}
        >
          <RefreshCwIcon
            className={cn("size-4", agentDetectionRefreshing ? "animate-spin" : "")}
            data-icon="inline-start"
          />
          {agentDetectionRefreshing ? labels.agentRefreshing : labels.agentRefresh}
        </Button>
      </div>
      {agents.map((agent) => {
        const agentSettings = settings.agents[agent.kind] ?? { enabled: false, fullAccess: false };
        const command = `${agent.command} ${agent.execArgs.join(" ")}`;
        const fullAccessCommand = `${agent.command} ${agent.fullAccessArgs.join(" ")}`;
        const supportsFullAccess = agent.runnerKind === "cli";
        const supportsAcpOptions = agent.runnerKind === "acp";
        const expanded = expandedAgents.has(agent.kind);
        const acpProbe = acpProbes[agent.kind];
        const acpProbeReady = acpProbe?.result?.ok === true;
        const sessionConfig =
          supportsAcpOptions && acpProbe?.result?.agentKind === agent.kind
            ? acpProbe.result.sessionConfig
            : null;
        const acpSettings = agentSettings.acp ?? { modeId: null, configOptions: {} };
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
                  {!agent.installed ? (
                    <span>{labels.agentMissingCannotEnable}</span>
                  ) : null}
                  <span>{labels.agentEnableDescription.replace("{command}", command)}</span>
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
                    <span className="text-xs text-muted-foreground/90">{agent.unavailableReason}</span>
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
                      if (!expanded && supportsAcpOptions && agent.installed) {
                        void probeAcpAgent(agent.kind);
                      }
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
                      agents: updateAgentSettings(current, agent.kind, {
                        enabled: checked,
                        fullAccess: checked ? current.agents[agent.kind].fullAccess : false
                      })
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
                      updateSettings((current) => ({
                        agents: updateAgentSettings(current, agent.kind, {
                          fullAccess: checked
                        })
                      }))
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
                {sessionConfig?.configOptions.map((option) => (
                  <div className="flex items-center justify-between gap-4" key={option.id}>
                    <div className="min-w-0">
                      <div className="text-sm font-medium">{option.name}</div>
                      {option.description ? (
                        <div className="mt-1 text-xs text-muted-foreground">
                          {option.description}
                        </div>
                      ) : null}
                    </div>
                    {option.type === "boolean" ? (
                      <Switch
                        aria-label={option.name}
                        checked={
                          typeof acpSettings.configOptions[option.id] === "boolean"
                            ? Boolean(acpSettings.configOptions[option.id])
                            : option.currentValue
                        }
                        size="sm"
                        onCheckedChange={(checked) =>
                          updateSettings((current) => ({
                            agents: updateAgentSettings(current, agent.kind, {
                              acp: {
                                ...(current.agents[agent.kind].acp ?? {
                                  modeId: null,
                                  configOptions: {}
                                }),
                                configOptions: {
                                  ...(current.agents[agent.kind].acp?.configOptions ?? {}),
                                  [option.id]: checked
                                }
                              }
                            })
                          }))
                        }
                      />
                    ) : (
                      <Select
                        value={
                          typeof acpSettings.configOptions[option.id] === "string"
                            ? String(acpSettings.configOptions[option.id])
                            : option.currentValue
                        }
                        onValueChange={(value) =>
                          updateSettings((current) => ({
                            agents: updateAgentSettings(current, agent.kind, {
                              acp: {
                                ...(current.agents[agent.kind].acp ?? {
                                  modeId: null,
                                  configOptions: {}
                                }),
                                configOptions: {
                                  ...(current.agents[agent.kind].acp?.configOptions ?? {}),
                                  [option.id]: value
                                }
                              }
                            })
                          }))
                        }
                      >
                        <SelectTrigger className="w-56" aria-label={option.name}>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectGroup>
                            {option.options.map((value) => (
                              <SelectItem value={value.value} key={value.value}>
                                {value.group ? `${value.group} · ${value.name}` : value.name}
                              </SelectItem>
                            ))}
                          </SelectGroup>
                        </SelectContent>
                      </Select>
                    )}
                  </div>
                ))}
                {sessionConfig?.modes &&
                !sessionConfig.configOptions.some((option) => option.category === "mode") ? (
                  <div className="flex items-center justify-between gap-4">
                    <div className="text-sm font-medium">{labels.acpSessionMode}</div>
                    <Select
                      value={acpSettings.modeId ?? sessionConfig.modes.currentModeId}
                      onValueChange={(modeId) =>
                        updateSettings((current) => ({
                          agents: updateAgentSettings(current, agent.kind, {
                            acp: {
                              ...(current.agents[agent.kind].acp ?? { configOptions: {} }),
                              modeId
                            }
                          })
                        }))
                      }
                    >
                      <SelectTrigger className="w-56" aria-label={labels.acpSessionMode}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectGroup>
                          {sessionConfig.modes.availableModes.map((mode) => (
                            <SelectItem value={mode.id} key={mode.id}>
                              {mode.name}
                            </SelectItem>
                          ))}
                        </SelectGroup>
                      </SelectContent>
                    </Select>
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
