import { useState } from "react";
import type { Dispatch, ReactNode, SetStateAction } from "react";
import type { BlockType, DesktopAgentDetection, DesktopGraphViewModel } from "@planweave/runtime";
import { ArrowLeftIcon, BlocksIcon, BotIcon, GitPullRequestIcon, SettingsIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
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
  setActiveView: Dispatch<SetStateAction<AppView>>;
  settings: DesktopUiSettings;
  t: ReturnType<typeof createTranslator>;
  updateSettings: (patch: Partial<DesktopUiSettings>) => void;
};

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
  const ordered = (["implementation", "check", "review"] as BlockType[]).filter((type) => current.has(type));
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
        <Button className="mb-4 justify-start text-muted-foreground" variant="ghost" onClick={() => setActiveView("graph")}>
          <ArrowLeftIcon data-icon="inline-start" />
          {t("backToApp")}
        </Button>
        <nav className="flex flex-col gap-1">
          {navItems.map((item) => {
            const Icon = item.icon;
            return (
              <Button className="justify-start" key={item.key} variant={section === item.key ? "secondary" : "ghost"} onClick={() => setSection(item.key)}>
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
            <section className="flex flex-col gap-6">
              <div>
                <h1 className="text-2xl font-semibold tracking-normal">{t("settingsGeneral")}</h1>
                <p className="mt-1 text-sm text-muted-foreground">{t("settingsGeneralHint")}</p>
              </div>
              <SettingGroup title={t("interfaceSettings")}>
                <SettingsSwitchRow
                  checked={language === "zh-CN"}
                  title={t("useSimplifiedChinese")}
                  description={t("useSimplifiedChineseHint")}
                  onCheckedChange={(checked) => updateSettings({ language: checked ? "zh-CN" : "en" })}
                />
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
            </section>
          ) : null}
          {section === "components" ? (
            <section className="flex flex-col gap-6">
              <div>
                <h1 className="text-2xl font-semibold tracking-normal">{t("settingsComponents")}</h1>
                <p className="mt-1 text-sm text-muted-foreground">{t("settingsComponentsHint")}</p>
              </div>
              <SettingGroup title={t("componentVisibility")}>
                {[
                  { key: "task", title: t("taskNode"), description: t("taskNodeHint") },
                  { key: "context", title: t("contextNode"), description: t("contextNodeHint") },
                  { key: "implementation", title: t("implementationBlock"), description: t("implementationBlockHint") },
                  { key: "check", title: t("checkBlock"), description: t("checkBlockHint") },
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
                  { key: "check", title: t("checkBlock"), description: t("defaultCheckBlockHint") },
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
            <section className="flex flex-col gap-6">
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
            <section className="flex flex-col gap-6">
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
