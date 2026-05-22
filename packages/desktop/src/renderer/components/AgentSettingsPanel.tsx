import type { DesktopAgentDetection, DesktopAgentKind } from "@planweave/runtime";
import { SettingsSwitchRow } from "./SettingsSwitchRow";
import type { DesktopUiSettings } from "../types";

type AgentSettingsPanelProps = {
  agents: DesktopAgentDetection[];
  labels: {
    agentDetected: string;
    agentMissing: string;
    agentEnableDescription: string;
    agentFullAccessDescription: string;
    agentFullAccess: string;
  };
  settings: DesktopUiSettings;
  updateSettings: (patch: Partial<DesktopUiSettings>) => void;
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

export function AgentSettingsPanel({ agents, labels, settings, updateSettings }: AgentSettingsPanelProps) {
  return (
    <div className="overflow-hidden rounded-lg border bg-background">
      {agents.map((agent) => {
        const agentSettings = settings.agents[agent.kind] ?? { enabled: false, fullAccess: false };
        const command = `${agent.command} ${agent.execArgs.join(" ")}`;
        const fullAccessCommand = `${agent.command} ${agent.fullAccessArgs.join(" ")}`;
        return (
          <div key={agent.kind} className="border-b last:border-b-0">
            <SettingsSwitchRow
              checked={agent.installed && agentSettings.enabled}
              disabled={!agent.installed}
              title={agent.name}
              description={
                <span className="flex flex-col gap-1">
                  <span>
                    {agent.installed ? labels.agentDetected : labels.agentMissing}
                    {agent.version ? `: ${agent.version}` : ""}
                  </span>
                  <span>{labels.agentEnableDescription.replace("{command}", command)}</span>
                </span>
              }
              onCheckedChange={(checked) =>
                updateSettings({
                  agents: updateAgentSettings(settings, agent.kind, {
                    enabled: checked,
                    fullAccess: checked ? agentSettings.fullAccess : false
                  })
                })
              }
            />
            <SettingsSwitchRow
              checked={agent.installed && agentSettings.enabled && agentSettings.fullAccess}
              disabled={!agent.installed || !agentSettings.enabled}
              title={labels.agentFullAccess}
              description={labels.agentFullAccessDescription.replace("{command}", fullAccessCommand)}
              onCheckedChange={(checked) =>
                updateSettings({
                  agents: updateAgentSettings(settings, agent.kind, {
                    fullAccess: checked
                  })
                })
              }
            />
          </div>
        );
      })}
    </div>
  );
}
