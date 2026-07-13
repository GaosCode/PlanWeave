import { ArrowLeftIcon, BlocksIcon, BotIcon, CableIcon, GitForkIcon, GitPullRequestIcon, SettingsIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { createTranslator } from "../i18n";
import { HistoryNavigationButtons } from "../components/HistoryNavigationButtons";

export type SettingsSection = "general" | "components" | "review" | "agents" | "mcp" | "git";

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
    { key: "agents", label: t("settingsAgents"), icon: BotIcon },
    { key: "mcp", label: t("settingsMcpTunnel"), icon: CableIcon },
    { key: "git", label: t("gitAndGitHub"), icon: GitForkIcon }
  ] satisfies Array<{ key: SettingsSection; label: string; icon: typeof SettingsIcon }>;

  return (
    <aside className="flex w-[260px] shrink-0 flex-col text-text">
      <div className="app-drag-region flex h-11 shrink-0 items-center border-b border-border/80 px-3 pl-[124px]">
        <div className="app-no-drag flex items-center gap-1">
          <HistoryNavigationButtons t={t} />
        </div>
      </div>
      <div className="flex min-h-0 flex-1 flex-col p-3">
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
      </div>
    </aside>
  );
}
