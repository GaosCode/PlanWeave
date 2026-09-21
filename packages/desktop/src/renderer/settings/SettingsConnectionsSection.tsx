import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { createTranslator } from "../i18n";
import { ManagementDialog } from "../components/ManagementDialog";
import { SettingsServerSection } from "./SettingsServerSection";
import { ServerConnectionList } from "./ServerConnectionList";
import type { SettingsConnectionsTab } from "./settingsEntry";

export function SettingsConnectionsSection({
  initialTab = "server",
  onTabChange,
  t
}: {
  initialTab?: SettingsConnectionsTab;
  onTabChange?: () => void;
  t: ReturnType<typeof createTranslator>;
}) {
  const [tab, setTab] = useState<SettingsConnectionsTab>(initialTab);
  const [adding, setAdding] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const changeTab = (value: string) => {
    if (value !== "server" && value !== "maintenance") return;
    setTab(value);
    onTabChange?.();
  };
  return (
    <section data-testid="settings-connections-section">
      <Tabs value={tab} onValueChange={changeTab}>
        <div className="mb-8 flex flex-wrap items-center justify-between gap-3 border-b border-border/70">
          <TabsList variant="line" aria-label={t("settingsServer")}>
            <TabsTrigger value="server" data-testid="settings-connections-tab-server">
              {t("serverConnections")}
            </TabsTrigger>
            <TabsTrigger value="maintenance" data-testid="settings-connections-tab-maintenance">
              {t("serverMaintenance")}
            </TabsTrigger>
          </TabsList>
          {tab === "server" ? (
            <Button className="mb-2" size="sm" onClick={() => setAdding(true)}>
              {t("serverAddConnection")}
            </Button>
          ) : null}
        </div>
        <TabsContent value="server">
          <ServerConnectionList refreshKey={refreshKey} t={t} />
        </TabsContent>
        <TabsContent value="maintenance">
          <SettingsServerSection showHeader={false} maintenance t={t} />
        </TabsContent>
      </Tabs>
      <ManagementDialog
        open={adding}
        onOpenChange={(open) => {
          setAdding(open);
          if (!open) setRefreshKey((key) => key + 1);
        }}
        title={t("serverAddConnection")}
        t={t}
      >
        <SettingsServerSection showHeader={false} t={t} />
      </ManagementDialog>
    </section>
  );
}
