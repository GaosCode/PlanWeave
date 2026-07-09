import { useState } from "react";
import type { DesktopAgentDetection, DesktopAgentKind } from "@planweave-ai/runtime";
import { ChevronDownIcon, RefreshCwIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import type { DesktopSettingsUpdate, DesktopUiSettings } from "../types";

type AgentSettingsPanelProps = {
  agentDetectionRefreshing: boolean;
  agents: DesktopAgentDetection[];
  labels: {
    agentDetected: string;
    agentMissing: string;
    agentEnableDescription: string;
    agentFullAccessDescription: string;
    agentFullAccess: string;
    agentInstallStatus: string;
    agentRefresh: string;
    agentRefreshing: string;
  };
  refreshAgentDetections: () => Promise<void>;
  settings: DesktopUiSettings;
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

export function AgentSettingsPanel({
  agentDetectionRefreshing,
  agents,
  labels,
  refreshAgentDetections,
  settings,
  updateSettings
}: AgentSettingsPanelProps) {
  const [expandedAgent, setExpandedAgent] = useState<DesktopAgentKind | null>(null);

  return (
    <div className="overflow-hidden rounded-lg border bg-background">
      <div className="flex items-center justify-between gap-4 border-b px-5 py-4">
        <div className="text-sm text-muted-foreground">{labels.agentInstallStatus}</div>
        <Button
          disabled={agentDetectionRefreshing}
          size="sm"
          variant="outline"
          onClick={() => void refreshAgentDetections()}
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
        const expanded = expandedAgent === agent.kind;
        return (
          <div
            key={agent.kind}
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
                  <span>{labels.agentEnableDescription.replace("{command}", command)}</span>
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <Button
                  aria-label={`${agent.name} options`}
                  className="size-7"
                  size="icon-sm"
                  variant="ghost"
                  onClick={() => setExpandedAgent(expanded ? null : agent.kind)}
                >
                  <ChevronDownIcon
                    className={cn("size-4 transition-transform", expanded ? "rotate-180" : "")}
                  />
                </Button>
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
            {expanded ? (
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
          </div>
        );
      })}
    </div>
  );
}
