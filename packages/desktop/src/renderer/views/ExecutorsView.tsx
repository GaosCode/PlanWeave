import { lazy, Suspense, useState, type ComponentProps } from "react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { AppSettingsRoute } from "../AppSettingsRoute";
import { ManagementDialog } from "../components/ManagementDialog";
import { useHostAdministrationController } from "../hooks/useHostAdministrationController";
import { useRemoteAgentManagementController } from "../hooks/useRemoteAgentManagementController";
import { ExecutorInventory } from "../executors/ExecutorInventory";
import { HostAvailabilityCard } from "../settings/HostAvailabilityCard";
import { formatHostAdministrationError } from "../settings/hostAdministrationErrors";

const SettingsAgentsSection = lazy(() =>
  import("../settings/SettingsAgentsSection").then((module) => ({
    default: module.SettingsAgentsSection
  }))
);
const HostAdministrationContent = lazy(() =>
  import("../settings/HostAdministrationSection").then((module) => ({
    default: module.HostAdministrationContent
  }))
);

export function ExecutorsView({
  agents,
  agentDetectionRefreshing,
  graph,
  settings,
  selectedProject,
  selectedCanvasId,
  refreshAgentDetections,
  updateSettings,
  updateSettingsAndWait,
  setError,
  t
}: ComponentProps<typeof AppSettingsRoute>) {
  const [tab, setTab] = useState("agents");
  const [setupOpen, setSetupOpen] = useState(false);
  const [configurationOpen, setConfigurationOpen] = useState(false);
  const hosts = useHostAdministrationController();
  const remote = useRemoteAgentManagementController();
  return (
    <section
      className="h-full min-h-0 overflow-y-auto [scrollbar-gutter:stable]"
      aria-label={t("executorsNavigation")}
      data-testid="executors-view"
    >
      <div className="mx-auto max-w-6xl px-5 pt-1 pb-12 sm:px-7 lg:px-9">
        <Tabs value={tab} onValueChange={setTab}>
          <div className="mb-6 flex flex-wrap items-center justify-between gap-3 border-b border-border/70">
            <TabsList variant="line" aria-label={t("executorsNavigation")}>
              <TabsTrigger value="agents">{t("executorsList")}</TabsTrigger>
              <TabsTrigger value="devices">{t("executorsDevices")}</TabsTrigger>
            </TabsList>
            <Button size="sm" className="mb-2" onClick={() => setSetupOpen(true)}>
              {t("executorsAddDevice")}
            </Button>
          </div>
          {hosts.activeProfile ? (
            <p
              className="mb-5 flex flex-wrap items-center gap-x-2 text-xs text-text-muted"
              data-testid="executors-server-source"
            >
              <span>{t("executorsServerSource")}</span>
              <span className="truncate">{hosts.activeProfile.serverBaseUrl}</span>
            </p>
          ) : null}
          <TabsContent value="agents">
            <ExecutorInventory
              agents={agents}
              transport={settings.execution.agentTransport}
              hosts={hosts.hosts}
              remote={remote}
              refreshing={agentDetectionRefreshing}
              onRefresh={() => {
                void refreshAgentDetections();
                void remote.refresh();
                void hosts.refreshHosts();
              }}
              onConfigure={() => setConfigurationOpen(true)}
              t={t}
            />
          </TabsContent>
          <TabsContent value="devices">
            {hosts.status?.profiles.length ? (
              <Select
                value={hosts.activeProfile?.profileId ?? ""}
                disabled={hosts.busy}
                onValueChange={(profileId) => void hosts.selectProfile(profileId)}
              >
                <SelectTrigger className="mb-4 w-72" aria-label="Server">
                  <SelectValue placeholder="Server" />
                </SelectTrigger>
                <SelectContent>
                  {hosts.status.profiles.map((profile) => (
                    <SelectItem key={profile.profileId} value={profile.profileId}>
                      {profile.displayName}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : null}
            {hosts.error ? (
              <p
                role="status"
                className="mb-4 rounded-md bg-amber-500/10 px-3 py-2 text-sm text-amber-800 dark:text-amber-200"
              >
                {formatHostAdministrationError(hosts.error, t)}
              </p>
            ) : null}
            <HostAvailabilityCard
              busy={hosts.busy}
              hosts={hosts.hosts}
              hasMore={hosts.hostsHasMore}
              inventoryState={hosts.hostInventoryState}
              loading={hosts.hostsLoading}
              onLoadMore={() => void hosts.loadMoreHosts()}
              onRefresh={() => void hosts.refreshHosts()}
              onRevoke={(host) => {
                if (window.confirm(t("hostAdminRevokeConfirm").replace("{name}", host.displayName)))
                  void hosts.revokeHost(host.id);
              }}
              onRenew={(host) => void hosts.renewHostCredential(host.id)}
              t={t}
            />
            <Button
              variant="ghost"
              className="mt-4 text-sky-700 dark:text-sky-400"
              onClick={() => setSetupOpen(true)}
            >
              {t("executorsLocal")} · {t("executorsAddDevice")}
            </Button>
          </TabsContent>
        </Tabs>
        <ManagementDialog
          open={configurationOpen}
          onOpenChange={setConfigurationOpen}
          title={t("executorsLocalConfiguration")}
          t={t}
        >
          <Suspense fallback={<p role="status">{t("peopleWorking")}</p>}>
            <SettingsAgentsSection
              agents={agents}
              agentDetectionRefreshing={agentDetectionRefreshing}
              canvasRef={
                selectedProject
                  ? { projectRoot: selectedProject.rootPath, canvasId: selectedCanvasId }
                  : null
              }
              graph={graph}
              settings={settings}
              refreshAgentDetections={refreshAgentDetections}
              updateSettings={updateSettings}
              persistSettings={updateSettingsAndWait}
              setError={setError}
              showHeader={false}
              t={t}
            />
          </Suspense>
        </ManagementDialog>
        <ManagementDialog
          open={setupOpen}
          onOpenChange={setSetupOpen}
          title={t("executorsAddDevice")}
          t={t}
        >
          <Suspense fallback={<p role="status">{t("peopleWorking")}</p>}>
            <HostAdministrationContent
              controller={hosts}
              showHeader={false}
              showDeploymentConnection={false}
              setupOnly
              diagnosticsEnabled={settings.developerMode}
              t={t}
            />
          </Suspense>
        </ManagementDialog>
      </div>
    </section>
  );
}
