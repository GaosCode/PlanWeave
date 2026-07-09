import type { ReactNode } from "react";
import type { BlockType } from "@planweave-ai/runtime";
import { FieldGroup } from "@/components/ui/field";
import { SettingsSwitchRow } from "../components/SettingsSwitchRow";
import type { createTranslator } from "../i18n";
import type { DesktopSettingsUpdate, DesktopUiSettings, PaletteComponentKey } from "../types";

type SettingsComponentsSectionProps = {
  settings: DesktopUiSettings;
  t: ReturnType<typeof createTranslator>;
  updateSettings: (update: DesktopSettingsUpdate) => void;
};

function SettingGroup({ children, title }: { children: ReactNode; title: string }) {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-base font-semibold text-text-strong">{title}</h2>
      <FieldGroup className="gap-0 overflow-hidden rounded-md border border-border/80 bg-surface-raised shadow-sm">
        {children}
      </FieldGroup>
    </section>
  );
}

function toggleBlockSet(
  settings: DesktopUiSettings,
  blockType: BlockType,
  checked: boolean
): BlockType[] {
  const current = new Set(settings.palette.defaultBlockSet);
  if (checked) {
    current.add(blockType);
  } else {
    current.delete(blockType);
  }
  const ordered = (["implementation", "review"] as BlockType[]).filter((type) => current.has(type));
  return ordered.length > 0 ? ordered : ["implementation"];
}

export function SettingsComponentsSection({
  settings,
  t,
  updateSettings
}: SettingsComponentsSectionProps) {
  return (
    <section data-testid="settings-section-components" className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-normal text-text-strong">
          {t("settingsComponents")}
        </h1>
        <p className="mt-1 text-sm text-text-muted">{t("settingsComponentsHint")}</p>
      </div>
      <SettingGroup title={t("componentVisibility")}>
        {[
          { key: "task", title: t("taskNode"), description: t("taskNodeHint") },
          {
            key: "implementation",
            title: t("implementationBlock"),
            description: t("implementationBlockHint")
          },
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
                  visible: {
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
          {
            key: "implementation",
            title: t("implementationBlock"),
            description: t("defaultImplementationBlockHint")
          },
          { key: "review", title: t("reviewBlock"), description: t("defaultReviewBlockHint") }
        ].map(({ key, title, description }) => (
          <SettingsSwitchRow
            checked={settings.palette.defaultBlockSet.includes(key as BlockType)}
            key={key}
            title={title}
            description={description}
            onCheckedChange={(checked) =>
              updateSettings((current) => ({
                palette: {
                  defaultBlockSet: toggleBlockSet(current, key as BlockType, checked)
                }
              }))
            }
          />
        ))}
        <SettingsSwitchRow
          checked={settings.palette.dragHint}
          title={t("dragHint")}
          description={t("dragHintHint")}
          onCheckedChange={(checked) => updateSettings({ palette: { dragHint: checked } })}
        />
      </SettingGroup>
    </section>
  );
}
