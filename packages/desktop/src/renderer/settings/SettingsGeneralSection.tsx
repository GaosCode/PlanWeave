import { useEffect, useState, type ReactNode } from "react";
import type { DesktopRuntimeToolAvailability, ProjectPromptPolicy } from "@planweave-ai/runtime";
import { Button } from "@/components/ui/button";
import { Field, FieldContent, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { AppUpdateSettingsRow } from "./AppUpdateSettingsRow";
import { SettingsSwitchRow } from "../components/SettingsSwitchRow";
import type { createTranslator, Language } from "../i18n";
import type { AppearanceMode, DesktopUiSettings } from "../types";
import type { WindowMaterialCapabilities } from "../../shared/windowAppearance";

type SettingsProjectOption = {
  projectId: string;
  name: string;
};

type SettingsGeneralSectionProps = {
  language: Language;
  onProjectPromptDraftChange: (value: string) => void;
  onProjectPromptSave: () => void;
  onProjectSelect: (projectId: string) => void;
  projectPromptAvailable: boolean;
  projectPromptDraft: string;
  projectPromptPolicy: ProjectPromptPolicy | null | undefined;
  projectPromptPolicyAvailable: boolean;
  projectPromptSaving: boolean;
  projectSelectorAvailable: boolean;
  projects: SettingsProjectOption[];
  refreshRuntimeTools: () => Promise<void>;
  runtimeTools: DesktopRuntimeToolAvailability;
  selectedProjectId?: string;
  settings: DesktopUiSettings;
  t: ReturnType<typeof createTranslator>;
  updateProjectPromptPolicy?: (patch: Partial<ProjectPromptPolicy>) => Promise<void>;
  updateSettings: (patch: Partial<DesktopUiSettings>) => void;
};

const languageOptions = [
  { value: "zh-CN", label: "简体中文" },
  { value: "en", label: "English" }
] satisfies Array<{ value: Language; label: string }>;

const appearanceOptions = [
  { value: "system", labelKey: "appearanceSystem" },
  { value: "light", labelKey: "appearanceLight" },
  { value: "dark", labelKey: "appearanceDark" }
] satisfies Array<{ value: AppearanceMode; labelKey: "appearanceSystem" | "appearanceLight" | "appearanceDark" }>;

function isAppearanceMode(value: string): value is AppearanceMode {
  return appearanceOptions.some((option) => option.value === value);
}

function SettingGroup({ children, title }: { children: ReactNode; title: string }) {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-base font-semibold text-text-strong">{title}</h2>
      <FieldGroup className="gap-0 overflow-hidden rounded-md border border-border/80 bg-surface-raised shadow-sm">{children}</FieldGroup>
    </section>
  );
}

export function SettingsGeneralSection({
  language,
  onProjectPromptDraftChange,
  onProjectPromptSave,
  onProjectSelect,
  projectPromptAvailable,
  projectPromptDraft,
  projectPromptPolicy,
  projectPromptPolicyAvailable,
  projectPromptSaving,
  projectSelectorAvailable,
  projects,
  refreshRuntimeTools,
  runtimeTools,
  selectedProjectId,
  settings,
  t,
  updateProjectPromptPolicy,
  updateSettings
}: SettingsGeneralSectionProps) {
  const [windowMaterialCapabilities, setWindowMaterialCapabilities] = useState<WindowMaterialCapabilities | null>(null);

  useEffect(() => {
    let cancelled = false;
    const windowApi = window.planweaveWindow;
    if (!windowApi?.getWindowMaterialCapabilities) {
      setWindowMaterialCapabilities({ platform: "browser", reason: "supported", supported: true });
      return;
    }
    void windowApi.getWindowMaterialCapabilities().then((capabilities) => {
      if (!cancelled) {
        setWindowMaterialCapabilities(capabilities);
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const windowMaterialSupported = windowMaterialCapabilities?.supported !== false;

  return (
    <section data-testid="settings-section-general" className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-normal text-text-strong">{t("settingsGeneral")}</h1>
        <p className="mt-1 text-sm text-text-muted">{t("settingsGeneralHint")}</p>
      </div>
      <SettingGroup title={t("interfaceSettings")}>
        <AppUpdateSettingsRow t={t} />
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
        <Field orientation="horizontal" className="items-center justify-between gap-4 border-b px-5 py-4 last:border-b-0">
          <FieldContent>
            <FieldLabel className="text-sm font-semibold">{t("useDarkAppearance")}</FieldLabel>
            <FieldDescription>{t("useDarkAppearanceHint")}</FieldDescription>
          </FieldContent>
          <Select
            value={settings.appearance}
            onValueChange={(value) => {
              if (!isAppearanceMode(value)) {
                throw new Error(`Unsupported appearance mode: ${value}`);
              }
              updateSettings({ appearance: value });
            }}
          >
            <SelectTrigger aria-label={t("useDarkAppearance")} className="w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {appearanceOptions.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {t(option.labelKey)}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </Field>
        <SettingsSwitchRow
          checked={windowMaterialSupported && settings.windowMaterial.enabled}
          disabled={!windowMaterialSupported}
          title={t("enhancedWindowMaterial")}
          description={windowMaterialSupported ? t("enhancedWindowMaterialHint") : t("enhancedWindowMaterialUnavailableHint")}
          onCheckedChange={(checked) => updateSettings({ windowMaterial: { ...settings.windowMaterial, enabled: checked } })}
        />
        <SettingsSwitchRow
          checked={settings.reducedMotion}
          title={t("reducedMotion")}
          description={t("reducedMotionHint")}
          onCheckedChange={(checked) => updateSettings({ reducedMotion: checked })}
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
        <div className="flex justify-end border-b border-border/80 px-5 py-3 last:border-b-0">
          <Button size="sm" variant="outline" onClick={() => void refreshRuntimeTools()}>
            {t("refreshRuntimeTools")}
          </Button>
        </div>
      </SettingGroup>
      <SettingGroup title={t("promptSettings")}>
        <Field orientation="horizontal" className="items-center justify-between gap-4 border-b px-5 py-4 last:border-b-0">
          <FieldContent>
            <FieldLabel className="text-sm font-semibold">{t("projectPromptProject")}</FieldLabel>
            <FieldDescription>{t("projectPromptProjectHint")}</FieldDescription>
          </FieldContent>
          <Select value={selectedProjectId ?? ""} disabled={!projectSelectorAvailable} onValueChange={onProjectSelect}>
            <SelectTrigger aria-label={t("projectPromptProject")} className="w-72">
              <SelectValue placeholder={t("projectMissing")} />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {projects.map((project) => (
                  <SelectItem key={project.projectId} value={project.projectId}>
                    {project.name}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </Field>
        <SettingsSwitchRow
          checked={projectPromptPolicy?.includeGlobalPrompt ?? false}
          disabled={!projectPromptPolicyAvailable}
          title={t("inheritGlobalPrompt")}
          description={projectPromptPolicyAvailable ? t("inheritGlobalPromptHint") : t("inheritGlobalPromptUnavailableHint")}
          onCheckedChange={(checked) => {
            void updateProjectPromptPolicy?.({ includeGlobalPrompt: checked });
          }}
        />
        <Field data-disabled={!projectPromptAvailable} orientation="vertical" className="border-b px-5 py-4 last:border-b-0">
          <FieldContent>
            <FieldLabel htmlFor="project-canvas-prompt" className="text-sm font-semibold">{t("projectCanvasPrompt")}</FieldLabel>
            <FieldDescription>{projectPromptAvailable ? t("projectCanvasPromptHint") : t("projectCanvasPromptUnavailableHint")}</FieldDescription>
          </FieldContent>
          <Textarea
            aria-label={t("projectCanvasPrompt")}
            id="project-canvas-prompt"
            className="min-h-44 resize-y font-mono text-xs"
            disabled={!projectPromptAvailable}
            value={projectPromptDraft}
            onChange={(event) => onProjectPromptDraftChange(event.target.value)}
          />
          <div className="flex justify-end">
            <Button size="sm" variant="outline" disabled={!projectPromptAvailable || projectPromptSaving} onClick={onProjectPromptSave}>
              {t("saveProjectCanvasPrompt")}
            </Button>
          </div>
        </Field>
      </SettingGroup>
    </section>
  );
}
