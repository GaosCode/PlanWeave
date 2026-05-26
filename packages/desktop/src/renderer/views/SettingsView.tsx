import { useState } from "react";
import type { Dispatch, ReactNode, SetStateAction } from "react";
import type { BlockType, DesktopAgentDetection, DesktopGraphViewModel, DesktopRuntimeToolAvailability } from "@planweave/runtime";
import { ArrowLeftIcon, BlocksIcon, BotIcon, GitPullRequestIcon, SettingsIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Field, FieldContent, FieldDescription, FieldLabel } from "@/components/ui/field";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { AgentSettingsPanel } from "../components/AgentSettingsPanel";
import { SettingsSwitchRow } from "../components/SettingsSwitchRow";
import type { createTranslator, Language } from "../i18n";
import type { AppView, DesktopUiSettings, PaletteComponentKey } from "../types";

type SettingsSection = "general" | "components" | "review" | "agents";

type SettingsViewProps = {
  agentDetectionRefreshing: boolean;
  agents: DesktopAgentDetection[];
  graph: DesktopGraphViewModel | null;
  language: Language;
  refreshAgentDetections: () => Promise<void>;
  refreshRuntimeTools: () => Promise<void>;
  runtimeTools: DesktopRuntimeToolAvailability;
  setActiveView: Dispatch<SetStateAction<AppView>>;
  settings: DesktopUiSettings;
  t: ReturnType<typeof createTranslator>;
  updateSettings: (patch: Partial<DesktopUiSettings>) => void;
};

const languageOptions = [
  { value: "zh-CN", label: "简体中文" },
  { value: "en", label: "English" }
] satisfies Array<{ value: Language; label: string }>;

function SettingGroup({ children, title }: { children: ReactNode; title: string }) {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-base font-semibold">{title}</h2>
      <div className="overflow-hidden rounded-lg border bg-background">{children}</div>
    </section>
  );
}

function toggleBlockSet(settings: DesktopUiSettings, blockType: BlockType, checked: boolean): BlockType[] {
  const current = new Set(settings.palette.defaultBlockSet);
  if (checked) {
    current.add(blockType);
  } else {
    current.delete(blockType);
  }
  const ordered = (["implementation", "review"] as BlockType[]).filter((type) => current.has(type));
  return ordered.length > 0 ? ordered : ["implementation"];
}

function updateReviewSettings(settings: DesktopUiSettings, checked: boolean): DesktopUiSettings["review"] {
  if (!checked) {
    return {
      pipelineEnabled: false,
      strictReview: false,
      feedbackLoop: false,
      autoAppendReviewBlock: false
    };
  }
  return {
    ...settings.review,
    pipelineEnabled: true
  };
}

export function SettingsView({
  agentDetectionRefreshing,
  agents,
  graph,
  language,
  refreshAgentDetections,
  refreshRuntimeTools,
  runtimeTools,
  setActiveView,
  settings,
  t,
  updateSettings
}: SettingsViewProps) {
  const [section, setSection] = useState<SettingsSection>("general");
  const reviewDisabled = !settings.review.pipelineEnabled;
  const navItems = [
    { key: "general", label: t("settingsGeneral"), icon: SettingsIcon },
    { key: "components", label: t("settingsComponents"), icon: BlocksIcon },
    { key: "review", label: t("settingsReview"), icon: GitPullRequestIcon },
    { key: "agents", label: t("settingsAgents"), icon: BotIcon }
  ] satisfies Array<{ key: SettingsSection; label: string; icon: typeof SettingsIcon }>;

  return (
    <main className="flex h-full min-h-0 bg-background text-foreground">
      <aside className="flex w-[260px] shrink-0 flex-col border-r bg-sidebar p-3">
        <Button data-testid="settings-back-to-app" className="mb-4 justify-start text-muted-foreground" variant="ghost" onClick={() => setActiveView("graph")}>
          <ArrowLeftIcon data-icon="inline-start" />
          {t("backToApp")}
        </Button>
        <nav className="flex flex-col gap-1">
          {navItems.map((item) => {
            const Icon = item.icon;
            return (
              <Button
                data-testid={`settings-nav-${item.key}`}
                className="justify-start"
                key={item.key}
                variant={section === item.key ? "secondary" : "ghost"}
                onClick={() => setSection(item.key)}
              >
                <Icon data-icon="inline-start" />
                {item.label}
              </Button>
            );
          })}
        </nav>
      </aside>
      <ScrollArea className="min-w-0 flex-1">
        <div className="mx-auto flex w-full max-w-5xl flex-col gap-8 px-12 py-10">
          {section === "general" ? (
            <section data-testid="settings-section-general" className="flex flex-col gap-6">
              <div>
                <h1 className="text-2xl font-semibold tracking-normal">{t("settingsGeneral")}</h1>
                <p className="mt-1 text-sm text-muted-foreground">{t("settingsGeneralHint")}</p>
              </div>
              <SettingGroup title={t("interfaceSettings")}>
                <Field orientation="horizontal" className="items-center justify-between gap-4 border-b px-5 py-4 last:border-b-0">
                  <FieldContent>
                    <FieldLabel className="text-sm font-semibold">{t("language")}</FieldLabel>
                    <FieldDescription>{t("languageSettingHint")}</FieldDescription>
                  </FieldContent>
                  <Select value={language} onValueChange={(value) => updateSettings({ language: value as Language })}>
                    <SelectTrigger aria-label={t("language")} className="w-40">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        {languageOptions.map((option) => (
                          <SelectItem key={option.value} value={option.value}>
                            {option.label}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                </Field>
                <SettingsSwitchRow
                  checked={settings.appearance === "dark"}
                  title={t("useDarkAppearance")}
                  description={t("useDarkAppearanceHint")}
                  onCheckedChange={(checked) => updateSettings({ appearance: checked ? "dark" : "system" })}
                />
              </SettingGroup>
              <SettingGroup title={t("notificationRules")}>
                {[
                  { key: "autoRunFailure", label: t("notifyAutoRun"), description: t("notifyAutoRunHint") },
                  { key: "graphExceptions", label: t("notifyGraphExceptions"), description: t("notifyGraphExceptionsHint") },
                  { key: "dirtyPrompts", label: t("notifyDirtyPrompts"), description: t("notifyDirtyPromptsHint") },
                  { key: "fileSyncConflict", label: t("notifyFileSync"), description: t("notifyFileSyncHint") }
                ].map(({ key, label, description }) => (
                  <SettingsSwitchRow
                    checked={settings.notifications[key as keyof DesktopUiSettings["notifications"]]}
                    key={key}
                    title={label}
                    description={description}
                    onCheckedChange={(checked) =>
                      updateSettings({
                        notifications: {
                          ...settings.notifications,
                          [key]: checked
                        }
                      })
                    }
                  />
                ))}
              </SettingGroup>
              <SettingGroup title={t("executionSettings")}>
                <SettingsSwitchRow
                  checked={runtimeTools.tmux.available && settings.execution.tmuxMonitoring}
                  disabled={!runtimeTools.tmux.available}
                  title={t("tmuxMonitoring")}
                  description={runtimeTools.tmux.available ? t("tmuxMonitoringHint") : t("tmuxMonitoringUnavailableHint")}
                  onCheckedChange={(checked) => updateSettings({ execution: { ...settings.execution, tmuxMonitoring: checked } })}
                />
                <div className="flex justify-end px-5 py-3">
                  <Button size="sm" variant="outline" onClick={() => void refreshRuntimeTools()}>
                    {t("refreshRuntimeTools")}
                  </Button>
                </div>
              </SettingGroup>
            </section>
          ) : null}
          {section === "components" ? (
            <section data-testid="settings-section-components" className="flex flex-col gap-6">
              <div>
                <h1 className="text-2xl font-semibold tracking-normal">{t("settingsComponents")}</h1>
                <p className="mt-1 text-sm text-muted-foreground">{t("settingsComponentsHint")}</p>
              </div>
              <SettingGroup title={t("componentVisibility")}>
                {[
                  { key: "task", title: t("taskNode"), description: t("taskNodeHint") },
                  { key: "implementation", title: t("implementationBlock"), description: t("implementationBlockHint") },
                  { key: "review", title: t("reviewBlock"), description: t("reviewBlockHint") }
                ].map(({ key, title, description }) => (
                  <SettingsSwitchRow
                    checked={settings.palette.visible[key as PaletteComponentKey]}
                    key={key}
                    title={title}
                    description={description}
                    onCheckedChange={(checked) =>
                      updateSettings({
                        palette: {
                          ...settings.palette,
                          visible: {
                            ...settings.palette.visible,
                            [key]: checked
                          }
                        }
                      })
                    }
                  />
                ))}
              </SettingGroup>
              <SettingGroup title={t("defaultBlockSet")}>
                {[
                  { key: "implementation", title: t("implementationBlock"), description: t("defaultImplementationBlockHint") },
                  { key: "review", title: t("reviewBlock"), description: t("defaultReviewBlockHint") }
                ].map(({ key, title, description }) => (
                  <SettingsSwitchRow
                    checked={settings.palette.defaultBlockSet.includes(key as BlockType)}
                    key={key}
                    title={title}
                    description={description}
                    onCheckedChange={(checked) =>
                      updateSettings({
                        palette: {
                          ...settings.palette,
                          defaultBlockSet: toggleBlockSet(settings, key as BlockType, checked)
                        }
                      })
                    }
                  />
                ))}
                <SettingsSwitchRow
                  checked={settings.palette.dragHint}
                  title={t("dragHint")}
                  description={t("dragHintHint")}
                  onCheckedChange={(checked) => updateSettings({ palette: { ...settings.palette, dragHint: checked } })}
                />
              </SettingGroup>
            </section>
          ) : null}
          {section === "review" ? (
            <section data-testid="settings-section-review" className="flex flex-col gap-6">
              <div>
                <h1 className="text-2xl font-semibold tracking-normal">{t("settingsReview")}</h1>
                <p className="mt-1 text-sm text-muted-foreground">{t("settingsReviewHint")}</p>
              </div>
              <SettingGroup title={t("reviewPipeline")}>
                <SettingsSwitchRow
                  checked={settings.review.pipelineEnabled}
                  title={t("reviewPipelineEnabled")}
                  description={t("reviewPipelineEnabledHint")}
                  onCheckedChange={(checked) => updateSettings({ review: updateReviewSettings(settings, checked) })}
                />
                <SettingsSwitchRow
                  checked={!reviewDisabled && settings.review.strictReview}
                  disabled={reviewDisabled}
                  title={t("strictReview")}
                  description={t("strictReviewHint")}
                  onCheckedChange={(checked) => updateSettings({ review: { ...settings.review, strictReview: checked } })}
                />
                <SettingsSwitchRow
                  checked={!reviewDisabled && settings.review.feedbackLoop}
                  disabled={reviewDisabled}
                  title={t("feedbackLoop")}
                  description={t("feedbackLoopHint")}
                  onCheckedChange={(checked) => updateSettings({ review: { ...settings.review, feedbackLoop: checked } })}
                />
                <SettingsSwitchRow
                  checked={!reviewDisabled && settings.review.autoAppendReviewBlock}
                  disabled={reviewDisabled}
                  title={t("autoAppendReviewBlock")}
                  description={t("autoAppendReviewBlockHint")}
                  onCheckedChange={(checked) => updateSettings({ review: { ...settings.review, autoAppendReviewBlock: checked } })}
                />
              </SettingGroup>
              <Separator />
              <p className="text-sm text-muted-foreground">{graph ? t("reviewSettingsProjectScoped") : t("reviewSettingsNoProject")}</p>
            </section>
          ) : null}
          {section === "agents" ? (
            <section data-testid="settings-section-agents" className="flex flex-col gap-6">
              <div>
                <h1 className="text-2xl font-semibold tracking-normal">{t("settingsAgents")}</h1>
                <p className="mt-1 text-sm text-muted-foreground">{t("settingsAgentsHint")}</p>
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
          ) : null}
        </div>
      </ScrollArea>
    </main>
  );
}
