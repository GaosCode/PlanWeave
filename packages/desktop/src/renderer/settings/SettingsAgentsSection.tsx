import type { DesktopAgentDetection } from "@planweave-ai/runtime";
import { AgentSettingsPanel } from "../components/AgentSettingsPanel";
import type { createTranslator } from "../i18n";
import type { DesktopUiSettings } from "../types";

type SettingsAgentsSectionProps = {
  agentDetectionRefreshing: boolean;
  agents: DesktopAgentDetection[];
  refreshAgentDetections: () => Promise<void>;
  settings: DesktopUiSettings;
  t: ReturnType<typeof createTranslator>;
  updateSettings: (patch: Partial<DesktopUiSettings>) => void;
};

export function SettingsAgentsSection({ agentDetectionRefreshing, agents, refreshAgentDetections, settings, t, updateSettings }: SettingsAgentsSectionProps) {
  return (
    <section data-testid="settings-section-agents" className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-normal text-text-strong">{t("settingsAgents")}</h1>
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
    </section>
  );
}
