import { ArrowLeftIcon, BlocksIcon, BotIcon, GitPullRequestIcon, SettingsIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { createTranslator } from "../i18n";

export type SettingsSection = "general" | "components" | "review" | "agents";

type SettingsNavProps = {
  section: SettingsSection;
  setSection: (section: SettingsSection) => void;
  onBackToApp: () => void;
  t: ReturnType<typeof createTranslator>;
};

export function SettingsNav({ section, setSection, onBackToApp, t }: SettingsNavProps) {
  const navItems = [
    { key: "general", label: t("settingsGeneral"), icon: SettingsIcon },
    { key: "components", label: t("settingsComponents"), icon: BlocksIcon },
    { key: "review", label: t("settingsReview"), icon: GitPullRequestIcon },
    { key: "agents", label: t("settingsAgents"), icon: BotIcon }
  ] satisfies Array<{ key: SettingsSection; label: string; icon: typeof SettingsIcon }>;

  return (
    <aside className="flex w-[260px] shrink-0 flex-col border-r border-border/80 bg-app-sidebar p-3 text-text">
      <Button data-testid="settings-back-to-app" className="mb-4 justify-start text-text-muted hover:bg-surface-muted hover:text-text-strong" variant="ghost" onClick={onBackToApp}>
        <ArrowLeftIcon data-icon="inline-start" />
        {t("backToApp")}
      </Button>
      <nav className="flex flex-col gap-1">
        {navItems.map((item) => {
          const Icon = item.icon;
          return (
            <Button
              data-testid={`settings-nav-${item.key}`}
              className="justify-start data-[variant=secondary]:bg-state-selected-surface data-[variant=secondary]:text-text-strong"
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
  );
}
