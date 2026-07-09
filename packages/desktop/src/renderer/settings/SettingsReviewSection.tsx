import type { ReactNode } from "react";
import type { DesktopGraphViewModel } from "@planweave-ai/runtime";
import { FieldGroup } from "@/components/ui/field";
import { Separator } from "@/components/ui/separator";
import { SettingsSwitchRow } from "../components/SettingsSwitchRow";
import type { createTranslator } from "../i18n";
import type { DesktopSettingsUpdate, DesktopUiSettings } from "../types";

type SettingsReviewSectionProps = {
  graph: DesktopGraphViewModel | null;
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

function updateReviewSettings(
  settings: DesktopUiSettings,
  checked: boolean
): DesktopUiSettings["review"] {
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

export function SettingsReviewSection({
  graph,
  settings,
  t,
  updateSettings
}: SettingsReviewSectionProps) {
  const reviewDisabled = !settings.review.pipelineEnabled;

  return (
    <section data-testid="settings-section-review" className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-normal text-text-strong">
          {t("settingsReview")}
        </h1>
        <p className="mt-1 text-sm text-text-muted">{t("settingsReviewHint")}</p>
      </div>
      <SettingGroup title={t("reviewPipeline")}>
        <SettingsSwitchRow
          checked={settings.review.pipelineEnabled}
          title={t("reviewPipelineEnabled")}
          description={t("reviewPipelineEnabledHint")}
          onCheckedChange={(checked) =>
            updateSettings((current) => ({ review: updateReviewSettings(current, checked) }))
          }
        />
        <SettingsSwitchRow
          checked={!reviewDisabled && settings.review.strictReview}
          disabled={reviewDisabled}
          title={t("strictReview")}
          description={t("strictReviewHint")}
          onCheckedChange={(checked) => updateSettings({ review: { strictReview: checked } })}
        />
        <SettingsSwitchRow
          checked={!reviewDisabled && settings.review.feedbackLoop}
          disabled={reviewDisabled}
          title={t("feedbackLoop")}
          description={t("feedbackLoopHint")}
          onCheckedChange={(checked) => updateSettings({ review: { feedbackLoop: checked } })}
        />
        <SettingsSwitchRow
          checked={!reviewDisabled && settings.review.autoAppendReviewBlock}
          disabled={reviewDisabled}
          title={t("autoAppendReviewBlock")}
          description={t("autoAppendReviewBlockHint")}
          onCheckedChange={(checked) =>
            updateSettings({ review: { autoAppendReviewBlock: checked } })
          }
        />
      </SettingGroup>
      <Separator />
      <p className="text-sm text-text-muted">
        {graph ? t("reviewSettingsProjectScoped") : t("reviewSettingsNoProject")}
      </p>
    </section>
  );
}
